import { getMeetingAudioSignedUrl, setMeetingAudioUploadStatus, uploadMeetingAudio } from './summary'

const DB_NAME = 'notemint-audio-backups'
const DB_VERSION = 1
const STORE_NAME = 'pendingAudioUploads'

export async function saveAudioUploadBackup({ userId, meetingId, audioBlob, durationSeconds = null, retentionDays = null }) {
  if (!userId || !meetingId || !audioBlob || audioBlob.size === 0) return false

  const db = await openAudioDb()
  const now = new Date().toISOString()
  await putRecord(db, {
    id: buildBackupId(userId, meetingId),
    userId,
    meetingId,
    audioBlob,
    durationSeconds,
    retentionDays,
    attempts: 0,
    status: 'pending',
    lastError: '',
    createdAt: now,
    updatedAt: now,
  })
  return true
}

export async function removeAudioUploadBackup(userId, meetingId) {
  if (!userId || !meetingId) return false
  const db = await openAudioDb()
  await deleteRecord(db, buildBackupId(userId, meetingId))
  return true
}

export async function hasAudioUploadBackup(userId, meetingId) {
  if (!userId || !meetingId) return false
  try {
    const db = await openAudioDb()
    const record = await getRecord(db, buildBackupId(userId, meetingId))
    return Boolean(record?.audioBlob && record?.status !== 'verified')
  } catch {
    return false
  }
}

export async function getPendingAudioUploadBackups(userId) {
  if (!userId) return []
  try {
    const db = await openAudioDb()
    return (await getAllRecords(db)).filter(
      (record) => record?.userId === userId && record?.audioBlob && record?.status !== 'verified',
    )
  } catch {
    return []
  }
}

export async function verifyAndRemoveAudioUploadBackup(supabase, { userId, meetingId, path }) {
  if (!supabase || !userId || !meetingId || !path) {
    return { ok: false, error: 'Missing audio verification data.' }
  }

  let db = null
  let record = null
  try {
    db = await openAudioDb()
    record = await getRecord(db, buildBackupId(userId, meetingId))
  } catch {}

  try {
    await verifyUploadedMeetingAudio(supabase, { userId, meetingId, path })
    if (db) {
      try {
        await deleteRecord(db, buildBackupId(userId, meetingId))
      } catch (deleteErr) {
        if (record) {
          await markRecordVerified(db, record, deleteErr?.message || 'Local backup cleanup failed')
        }
      }
    }
    return { ok: true, path }
  } catch (err) {
    if (db && record) {
      try {
        await markRecordFailed(db, record, err?.message || 'Audio verification failed')
      } catch {}
    }
    await setMeetingAudioUploadStatus(supabase, {
      userId,
      meetingId,
      status: 'pending',
    }).catch(() => {})
    return { ok: false, path, error: err?.message || 'Audio verification failed' }
  }
}

export async function retryPendingAudioUploads(supabase, userId, callbacks = {}) {
  if (!supabase || !userId) return []

  const db = await openAudioDb()
  const records = (await getAllRecords(db)).filter(
    (record) => record?.userId === userId && record?.audioBlob && record?.status !== 'verified',
  )
  const results = []

  for (const record of records) {
    callbacks.onItemStatus?.(record, 'uploading')
    try {
      const result = await uploadMeetingAudio(supabase, {
        userId: record.userId,
        meetingId: record.meetingId,
        audioBlob: record.audioBlob,
        durationSeconds: record.durationSeconds,
        retentionDays: record.retentionDays,
        onProgress: (progress) => callbacks.onItemProgress?.(record, progress),
      })

      if (result?.ok) {
        callbacks.onItemStatus?.(record, 'uploaded', result)
        const verified = await verifyAndRemoveAudioUploadBackup(supabase, {
          userId: record.userId,
          meetingId: record.meetingId,
          path: result.path,
        })
        if (verified.ok) {
          callbacks.onItemStatus?.(record, 'uploaded_verified', verified)
          results.push({ meetingId: record.meetingId, ok: true, path: result.path, verified: true })
        } else {
          callbacks.onItemStatus?.(record, 'pending', verified)
          results.push({ meetingId: record.meetingId, ok: false, path: result.path, error: verified.error })
        }
      } else {
        await markRecordFailed(db, record, result?.error || 'Upload did not complete')
        callbacks.onItemStatus?.(record, 'pending', result)
        results.push({ meetingId: record.meetingId, ok: false, error: result?.error || 'Upload did not complete' })
      }
    } catch (err) {
      await markRecordFailed(db, record, err?.message || 'Upload failed')
      callbacks.onItemStatus?.(record, 'pending', { error: err?.message || 'Upload failed' })
      results.push({ meetingId: record.meetingId, ok: false, error: err?.message || 'Upload failed' })
    }
  }

  return results
}

export async function uploadAudioWithBackup(
  supabase,
  { userId, meetingId, audioBlob, durationSeconds = null, retentionDays = null },
  callbacks = {},
) {
  if (!supabase || !userId || !meetingId || !audioBlob || audioBlob.size === 0) {
    return { ok: false, path: null, error: 'No audio captured.' }
  }

  let backupAvailable = false
  try {
    backupAvailable = await saveAudioUploadBackup({ userId, meetingId, audioBlob, durationSeconds, retentionDays })
    if (backupAvailable) {
      callbacks.onStatus?.('backed_up')
    } else {
      callbacks.onStatus?.('backup_failed', { error: 'Local backup was not created' })
    }
  } catch (err) {
    callbacks.onStatus?.('backup_failed', { error: err?.message || 'Local backup failed' })
  }

  try {
    callbacks.onStatus?.(backupAvailable ? 'uploading' : 'uploading_unbacked')
    const result = await uploadMeetingAudio(supabase, {
      userId,
      meetingId,
      audioBlob,
      durationSeconds,
      retentionDays,
      onProgress: (progress) => callbacks.onProgress?.(progress),
    })

    if (result?.ok) {
      callbacks.onStatus?.('uploaded', result)
      const verified = await verifyAndRemoveAudioUploadBackup(supabase, {
        userId,
        meetingId,
        path: result.path,
      })
      if (verified.ok) {
        callbacks.onStatus?.('uploaded_verified', verified)
        return { ...result, verified: true }
      }

      callbacks.onStatus?.(backupAvailable ? 'pending_retry' : 'pending_retry_unbacked', verified)
      return { ok: false, path: result.path, error: verified.error || 'Upload could not be verified' }
    }

    callbacks.onStatus?.(backupAvailable ? 'pending_retry' : 'pending_retry_unbacked', result)
    return { ok: false, path: null, error: result?.error || 'Upload did not complete' }
  } catch (err) {
    callbacks.onStatus?.(backupAvailable ? 'pending_retry' : 'pending_retry_unbacked', { error: err?.message || 'Upload failed' })
    return { ok: false, path: null, error: err?.message || 'Upload failed' }
  }
}

function buildBackupId(userId, meetingId) {
  return `${userId}:${meetingId}`
}

function openAudioDb() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error('IndexedDB is not available'))
      return
    }

    const request = window.indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' })
        store.createIndex('userId', 'userId', { unique: false })
        store.createIndex('meetingId', 'meetingId', { unique: false })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('Could not open audio backup store'))
  })
}

function putRecord(db, record) {
  return runStoreRequest(db, 'readwrite', (store) => store.put(record))
}

function getRecord(db, id) {
  return runStoreRequest(db, 'readonly', (store) => store.get(id))
}

function deleteRecord(db, id) {
  return runStoreRequest(db, 'readwrite', (store) => store.delete(id))
}

function getAllRecords(db) {
  return runStoreRequest(db, 'readonly', (store) => store.getAll())
}

async function markRecordFailed(db, record, error) {
  await putRecord(db, {
    ...record,
    attempts: Number(record?.attempts || 0) + 1,
    status: 'pending',
    lastError: String(error || '').slice(0, 500),
    updatedAt: new Date().toISOString(),
  })
}

async function markRecordVerified(db, record, note) {
  await putRecord(db, {
    ...record,
    status: 'verified',
    lastError: String(note || '').slice(0, 500),
    updatedAt: new Date().toISOString(),
  })
}

async function verifyUploadedMeetingAudio(supabase, { userId, meetingId, path }) {
  const { data, error } = await supabase
    .from('meetings')
    .select('audio_storage_path, audio_upload_status')
    .eq('id', meetingId)
    .eq('user_id', userId)
    .maybeSingle()

  if (error) throw new Error(error.message || 'Could not verify meeting audio metadata')
  if (!data || data.audio_storage_path !== path) {
    throw new Error('Meeting audio metadata is not saved yet')
  }

  const signedUrl = await getMeetingAudioSignedUrl(supabase, {
    audioStoragePath: path,
    userId,
    meetingId,
    expiresInSeconds: 120,
  })
  if (!signedUrl) throw new Error('Could not create playback URL')

  const response = await fetch(signedUrl, {
    method: 'GET',
    headers: {
      Range: 'bytes=0-0',
    },
  })
  if (!response.ok) {
    throw new Error('Playback URL could not be verified')
  }

  return true
}

function runStoreRequest(db, mode, action) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode)
    const store = tx.objectStore(STORE_NAME)
    const request = action(store)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'))
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'))
  })
}
