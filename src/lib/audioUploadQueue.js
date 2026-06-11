import { uploadMeetingAudio } from './summary'

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

export async function retryPendingAudioUploads(supabase, userId, callbacks = {}) {
  if (!supabase || !userId) return []

  const db = await openAudioDb()
  const records = (await getAllRecords(db)).filter((record) => record?.userId === userId && record?.audioBlob)
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
        await deleteRecord(db, record.id)
        callbacks.onItemStatus?.(record, 'uploaded', result)
        results.push({ meetingId: record.meetingId, ok: true, path: result.path })
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

  await saveAudioUploadBackup({ userId, meetingId, audioBlob, durationSeconds, retentionDays })
  callbacks.onStatus?.('backed_up')

  try {
    callbacks.onStatus?.('uploading')
    const result = await uploadMeetingAudio(supabase, {
      userId,
      meetingId,
      audioBlob,
      durationSeconds,
      retentionDays,
      onProgress: (progress) => callbacks.onProgress?.(progress),
    })

    if (result?.ok) {
      await removeAudioUploadBackup(userId, meetingId)
      callbacks.onStatus?.('uploaded', result)
      return result
    }

    callbacks.onStatus?.('pending_retry', result)
    return { ok: false, path: null, error: result?.error || 'Upload did not complete' }
  } catch (err) {
    callbacks.onStatus?.('pending_retry', { error: err?.message || 'Upload failed' })
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
