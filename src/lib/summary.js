import * as tus from 'tus-js-client'
import { streamSummary } from './api.js'

const LIGHT_FILLER_REGEX = /\b(um+|uh+|er+|erm|hmm+|ah+)\b/gi
const LOCAL_MEETINGS_KEY_PREFIX = 'local_meetings_'
const MEETING_AUDIO_BUCKET = 'meeting-audio'
const DEFAULT_AUDIO_RETENTION_DAYS = 7
const KEEP_MEETING_AUDIO_FOREVER = import.meta.env.VITE_KEEP_MEETING_AUDIO_FOREVER !== 'false'
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY

export function compressTranscript(segments, labelMap) {
  if (!segments || segments.length === 0) {
    console.warn('[Summary] compressTranscript called with empty segments')
    return ''
  }

  let finals = segments.filter((s) => s.isFinal === true)
  if (finals.length === 0) finals = segments

  const lines = []
  for (const seg of finals) {
    const text = String(seg.text || '').replace(LIGHT_FILLER_REGEX, '').replace(/\s+/g, ' ').trim()
    if (text.length < 2) continue

    let label = labelMap?.[seg.speaker]
    if (label === undefined || label === null) {
      label = 'Person ' + (Number(seg.speaker) + 1)
    }

    lines.push(`[${label}]: ${text}`)
  }

  const result = lines.join('\n')
  console.log('[Summary] Compressed transcript preview:', result.slice(0, 200))
  return result
}

export async function getSummary(compressedTranscript, onChunk, onComplete, onError, options = {}) {
  if (!compressedTranscript || compressedTranscript.length < 10) {
    onError('Recording too short to summarize - try at least 10 seconds.')
    return
  }

  try {
    console.log('[Summary] Calling backend summary stream. Transcript chars:', compressedTranscript.length)
    await streamSummary(compressedTranscript, onChunk, onComplete, onError, options)
  } catch (err) {
    if (err.name === 'AbortError') return
    if (
      err.message.includes('fetch') ||
      err.message.includes('network') ||
      err.message.includes('Failed')
    ) {
      onError('No internet - summary unavailable')
    } else {
      onError('Summary error: ' + err.message)
    }
  }
}

export async function saveMeeting(supabase, userId, meetingData) {
  let title = meetingData.title
  if (!title) {
    const now = new Date()
    const dateStr = now.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
    const timeStr = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    title = dateStr + ' - ' + timeStr
  }

  try {
    const { data, error } = await supabase
      .from('meetings')
      .insert({
        user_id: userId,
        title,
        transcript_compressed: meetingData.transcript,
        summary: meetingData.summary,
        segments: meetingData.segments,
        label_map: meetingData.labelMap,
        duration_segments: meetingData.segments?.length || 0,
        created_at: new Date().toISOString(),
      })
      .select('id')
      .single()

    if (error) {
      console.error('saveMeeting error:', error)
      return saveMeetingLocally(userId, title, meetingData)
    }

    return data.id
  } catch (err) {
    console.error('saveMeeting error:', err)
    return saveMeetingLocally(userId, title, meetingData)
  }
}

export async function createMeetingDraft(supabase, userId, title = null) {
  if (!supabase || !userId) return null

  const finalTitle = title || buildDefaultMeetingTitle()

  const payload = {
    user_id: userId,
    title: finalTitle,
    created_at: new Date().toISOString(),
    audio_upload_status: 'pending',
  }

  let { data, error } = await supabase
    .from('meetings')
    .insert(payload)
    .select('id')
    .single()

  // Backward compatibility if audio_upload_status column is not yet present.
  if (error && isMissingColumnError(error, 'audio_upload_status')) {
    ;({ data, error } = await supabase
      .from('meetings')
      .insert({
        user_id: userId,
        title: finalTitle,
        created_at: new Date().toISOString(),
      })
      .select('id')
      .single())
  }

  if (error) {
    throw new Error(error.message || 'Could not create meeting')
  }

  return data?.id || null
}

export async function uploadMeetingAudio(
  supabase,
  {
    userId,
    meetingId,
    audioBlob,
    durationSeconds = null,
    retentionDays = DEFAULT_AUDIO_RETENTION_DAYS,
    onProgress = null,
  },
) {
  if (!supabase || !userId || !meetingId || !audioBlob || audioBlob.size === 0) {
    return { ok: false, path: null, error: 'No audio captured.' }
  }

  const mimeType = String(audioBlob.type || 'audio/webm').split(';')[0] || 'audio/webm'
  const extension = getAudioExtension(mimeType, audioBlob?.name)
  const path = buildMeetingAudioPath(userId, meetingId, extension)
  const safeRetentionDays = normalizeRetentionDays(retentionDays)
  const expiresAt = KEEP_MEETING_AUDIO_FOREVER
    ? null
    : new Date(Date.now() + safeRetentionDays * 24 * 60 * 60 * 1000).toISOString()

  await uploadMeetingAudioObject(supabase, {
    path,
    audioBlob,
    mimeType,
    onProgress,
  })

  const { error: updateError } = await supabase
    .from('meetings')
    .update({
      audio_storage_path: path,
      audio_mime_type: mimeType,
      audio_size_bytes: audioBlob.size,
      audio_duration_seconds: toIntOrNull(durationSeconds),
      audio_uploaded_at: new Date().toISOString(),
      audio_retention_days: safeRetentionDays,
      audio_expires_at: expiresAt,
      audio_deleted_at: null,
      audio_upload_status: 'uploaded',
    })
    .eq('id', meetingId)
    .eq('user_id', userId)

  if (updateError && isMissingColumnError(updateError, 'audio_upload_status')) {
    const fallback = await supabase
      .from('meetings')
      .update({
        audio_storage_path: path,
        audio_mime_type: mimeType,
        audio_size_bytes: audioBlob.size,
        audio_duration_seconds: toIntOrNull(durationSeconds),
        audio_uploaded_at: new Date().toISOString(),
        audio_retention_days: safeRetentionDays,
        audio_expires_at: expiresAt,
        audio_deleted_at: null,
      })
      .eq('id', meetingId)
      .eq('user_id', userId)

    if (fallback.error) {
      throw new Error(fallback.error.message || 'Could not save meeting audio metadata')
    }

    return { ok: true, path, error: null }
  }

  if (updateError) {
    throw new Error(updateError.message || 'Could not save meeting audio metadata')
  }

  return { ok: true, path, error: null }
}

async function uploadMeetingAudioObject(supabase, { path, audioBlob, mimeType, onProgress }) {
  try {
    await uploadMeetingAudioResumable(supabase, {
      path,
      audioBlob,
      mimeType,
      onProgress,
    })
    return true
  } catch (err) {
    console.warn('[AudioUpload] Resumable upload failed, falling back to standard upload:', err?.message || err)
  }

  onProgress?.({ bytesUploaded: 0, bytesTotal: audioBlob.size || 0, percentage: 5 })
  const upload = await supabase.storage.from(MEETING_AUDIO_BUCKET).upload(path, audioBlob, {
    contentType: mimeType,
    cacheControl: '3600',
    upsert: true,
  })

  if (upload.error) {
    throw new Error(upload.error.message || 'Could not upload meeting audio')
  }
  onProgress?.({ bytesUploaded: audioBlob.size || 0, bytesTotal: audioBlob.size || 0, percentage: 100 })
  return true
}

async function uploadMeetingAudioResumable(supabase, { path, audioBlob, mimeType, onProgress }) {
  const endpoint = getSupabaseTusEndpoint()
  if (!endpoint) throw new Error('Missing Supabase upload endpoint')

  const {
    data: { session },
  } = await supabase.auth.getSession()

  const accessToken = session?.access_token
  if (!accessToken) throw new Error('Missing Supabase session')

  return new Promise((resolve, reject) => {
    const upload = new tus.Upload(audioBlob, {
      endpoint,
      retryDelays: [0, 3000, 5000, 10000, 20000],
      headers: {
        authorization: `Bearer ${accessToken}`,
        apikey: SUPABASE_ANON_KEY || '',
        'x-upsert': 'true',
      },
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      chunkSize: 6 * 1024 * 1024,
      metadata: {
        bucketName: MEETING_AUDIO_BUCKET,
        objectName: path,
        contentType: mimeType,
        cacheControl: '3600',
      },
      onError: (error) => {
        reject(error)
      },
      onProgress: (bytesUploaded, bytesTotal) => {
        const total = Number(bytesTotal || audioBlob.size || 0)
        const uploaded = Number(bytesUploaded || 0)
        const percentage = total > 0 ? Math.min(100, Math.max(0, Math.round((uploaded / total) * 100))) : 0
        onProgress?.({ bytesUploaded: uploaded, bytesTotal: total, percentage })
      },
      onSuccess: () => {
        onProgress?.({ bytesUploaded: audioBlob.size || 0, bytesTotal: audioBlob.size || 0, percentage: 100 })
        resolve(true)
      },
    })

    upload.start()
  })
}

export async function deleteMeetingAudio(supabase, { userId, meetingId, audioStoragePath }) {
  const path = String(audioStoragePath || '').trim()
  if (!supabase || !userId || !meetingId || !path) {
    return false
  }

  if (!isSafeMeetingAudioPath(path, userId, meetingId)) {
    throw new Error('Audio path does not match this meeting.')
  }

  const removal = await supabase.storage.from(MEETING_AUDIO_BUCKET).remove([path])
  if (removal.error) {
    throw new Error(removal.error.message || 'Could not delete meeting audio')
  }

  const { error } = await supabase
    .from('meetings')
    .update({
      audio_storage_path: null,
      audio_mime_type: null,
      audio_size_bytes: null,
      audio_duration_seconds: null,
      audio_uploaded_at: null,
      audio_expires_at: null,
      audio_deleted_at: new Date().toISOString(),
      audio_upload_status: 'failed',
    })
    .eq('id', meetingId)
    .eq('user_id', userId)

  if (error && isMissingColumnError(error, 'audio_upload_status')) {
    const fallback = await supabase
      .from('meetings')
      .update({
        audio_storage_path: null,
        audio_mime_type: null,
        audio_size_bytes: null,
        audio_duration_seconds: null,
        audio_uploaded_at: null,
        audio_expires_at: null,
        audio_deleted_at: new Date().toISOString(),
      })
      .eq('id', meetingId)
      .eq('user_id', userId)

    if (fallback.error) {
      throw new Error(fallback.error.message || 'Could not update meeting audio metadata')
    }

    return true
  }

  if (error) {
    throw new Error(error.message || 'Could not update meeting audio metadata')
  }

  return true
}

export async function setMeetingAudioUploadStatus(supabase, { userId, meetingId, status }) {
  const nextStatus = normalizeAudioUploadStatus(status)
  if (!supabase || !userId || !meetingId || !nextStatus) return false

  const { error } = await supabase
    .from('meetings')
    .update({ audio_upload_status: nextStatus })
    .eq('id', meetingId)
    .eq('user_id', userId)

  if (error && isMissingColumnError(error, 'audio_upload_status')) {
    return false
  }

  if (error) {
    throw new Error(error.message || 'Could not update audio upload status')
  }

  return true
}

export async function getMeetingAudioSignedUrl(
  supabase,
  { audioStoragePath, userId, meetingId = null, expiresInSeconds = 3600 },
) {
  const path = String(audioStoragePath || '').trim()
  if (!path) return ''
  if (!userId) throw new Error('Missing user for signed URL request.')
  if (!isSafeMeetingAudioPath(path, userId, meetingId)) {
    throw new Error('Audio path is not allowed for this user.')
  }

  const { data, error } = await supabase.storage
    .from(MEETING_AUDIO_BUCKET)
    .createSignedUrl(path, expiresInSeconds)

  if (error) {
    throw new Error(error.message || 'Could not load meeting audio')
  }

  return data?.signedUrl || ''
}

export async function updateMeetingResults(supabase, meetingId, meetingData) {
  if (!meetingId) return false

  let query = supabase
    .from('meetings')
    .update({
      transcript_compressed: meetingData.transcript,
      summary: meetingData.summary,
      segments: meetingData.segments,
      label_map: meetingData.labelMap,
      duration_segments: meetingData.segments?.length || 0,
    })
    .eq('id', meetingId)

  if (meetingData.userId) {
    query = query.eq('user_id', meetingData.userId)
  }

  const { error } = await query

  if (error) {
    throw new Error(error.message || 'Could not update meeting results')
  }

  return true
}

export async function saveMeetingSpeakers(
  supabase,
  { userId, meetingId, segments, labelMap, confirmedByUser = false },
) {
  if (!meetingId || !userId) return false
  const list = Array.isArray(segments) ? segments : []
  if (list.length === 0) return false

  const finalSegments = list.filter((segment) => segment?.isFinal === true)
  const source = finalSegments.length > 0 ? finalSegments : list

  const uniqueSpeakerIds = [...new Set(source.map((segment) => Number(segment?.speaker)).filter(Number.isFinite))]
  if (uniqueSpeakerIds.length === 0) return false

  let profileIdByName = new Map()

  try {
    const { data: profiles, error: profileError } = await supabase
      .from('speaker_profiles')
      .select('id, display_name')
      .eq('owner_user_id', userId)
      .eq('profile_type', 'contact')

    if (!profileError && Array.isArray(profiles)) {
      profileIdByName = new Map(
        profiles
          .filter((profile) => profile?.display_name)
          .map((profile) => [String(profile.display_name).trim().toLowerCase(), profile.id]),
      )
    }
  } catch (err) {
    console.warn('[Summary] speaker_profiles lookup failed:', err?.message || err)
  }

  const rows = uniqueSpeakerIds.map((speakerId) => {
    const rawLabel = labelMap?.[speakerId]
    const displayName = String(rawLabel || `Person ${speakerId + 1}`).trim()
    const lookupKey = displayName.toLowerCase()
    const isContactName = displayName && displayName.toLowerCase() !== 'you' && !/^person\s*\d+$/i.test(displayName)

    return {
      meeting_id: meetingId,
      raw_speaker_id: speakerId,
      display_name: displayName,
      speaker_profile_id: isContactName ? profileIdByName.get(lookupKey) || null : null,
      confirmed_by_user: Boolean(confirmedByUser),
    }
  })

  const { error } = await supabase.from('meeting_speakers').upsert(rows, {
    onConflict: 'meeting_id,raw_speaker_id',
  })

  if (error) {
    throw new Error(error.message || 'Could not save meeting speaker mappings')
  }

  return true
}

export async function updateMeetingTranscriptAndSummary(supabase, meetingId, transcript, summary) {
  if (!meetingId) return false

  const { error } = await supabase
    .from('meetings')
    .update({
      transcript_compressed: transcript,
      summary,
    })
    .eq('id', meetingId)

  if (error) {
    throw new Error(error.message || 'Could not update meeting transcript/summary')
  }

  return true
}

export async function saveTranscriptCorrections(
  supabase,
  { userId, meetingId = null, provider = null, corrections = [], contextTermsUsed = [] },
) {
  const list = Array.isArray(corrections) ? corrections : []
  if (!userId || list.length === 0) return false

  const terms = normalizeContextTerms(contextTermsUsed)
  const rows = list
    .map((item) => {
      const originalText = String(item?.originalText || '').trim()
      const correctedText = String(item?.correctedText || '').trim()
      if (!originalText || !correctedText || originalText === correctedText) return null

      const correctionContext = buildCorrectionContext(item)
      return {
        user_id: userId,
        meeting_id: meetingId || null,
        provider: provider ? String(provider) : null,
        original_text: originalText,
        corrected_text: correctedText,
        correction_context: correctionContext,
        context_terms_used: terms,
        created_at: new Date().toISOString(),
      }
    })
    .filter(Boolean)

  if (rows.length === 0) return false

  const { error } = await supabase.from('transcript_corrections').insert(rows)
  if (!error) {
    return true
  }

  if (!isMissingColumnError(error, 'correction_context')) {
    throw new Error(error.message || 'Could not save transcript corrections')
  }

  const fallbackRows = rows.map(({ correction_context, ...row }) => row)
  const fallback = await supabase.from('transcript_corrections').insert(fallbackRows)
  if (fallback.error) {
    throw new Error(fallback.error.message || 'Could not save transcript corrections')
  }

  return true
}

export async function saveTranscriptionEvaluations(
  supabase,
  { userId, meetingId = null, evaluations = [], compareRunId = null },
) {
  const list = Array.isArray(evaluations) ? evaluations : []
  if (!userId || list.length === 0) return 0

  const rows = list
    .map((item) => {
      const provider = String(item?.provider || '').trim()
      if (!provider) return null
      const segments = Array.isArray(item?.segments) ? item.segments : []

      return {
        user_id: userId,
        meeting_id: meetingId || null,
        provider,
        model: String(item?.model || '').trim() || null,
        segments: segments.slice(0, 500),
        summary: String(item?.summary || '').trim() || null,
        duration_ms: toIntOrNull(item?.durationMs),
        speaker_count: toIntOrNull(item?.speakerCount),
        segment_count: toIntOrNull(item?.segmentCount),
        correction_count: toIntOrZero(item?.correctionCount),
        transcript_rating: normalizeRating(item?.transcriptRating),
        summary_rating: normalizeRating(item?.summaryRating),
        notes: String(item?.notes || '').trim() || null,
        manual_speaker_fixes: toIntOrZero(item?.manualSpeakerFixes),
        best_transcript: Boolean(item?.bestTranscript),
        best_summary: Boolean(item?.bestSummary),
        compare_run_id: compareRunId ? String(compareRunId) : null,
        created_at: new Date().toISOString(),
      }
    })
    .filter(Boolean)

  if (rows.length === 0) return 0

  const { error } = await supabase.from('transcription_evaluations').insert(rows)
  if (!error) {
    return rows.length
  }

  // Backward compatibility for the base schema without extended columns.
  const fallbackRows = rows.map((row) => ({
    user_id: row.user_id,
    meeting_id: row.meeting_id,
    provider: row.provider,
    model: row.model,
    segments: row.segments,
    summary: row.summary,
    duration_ms: row.duration_ms,
    speaker_count: row.speaker_count,
    segment_count: row.segment_count,
    correction_count: row.correction_count,
    transcript_rating: row.transcript_rating,
    summary_rating: row.summary_rating,
    notes:
      row.notes ||
      JSON.stringify({
        best_transcript: row.best_transcript,
        best_summary: row.best_summary,
        manual_speaker_fixes: row.manual_speaker_fixes,
        compare_run_id: row.compare_run_id,
      }),
    created_at: row.created_at,
  }))

  const fallback = await supabase.from('transcription_evaluations').insert(fallbackRows)
  if (fallback.error) {
    throw new Error(fallback.error.message || 'Could not save transcription evaluations')
  }

  return fallbackRows.length
}

export async function getRecentTranscriptionEvaluations(supabase, userId, limit = 60) {
  if (!userId) return []

  const safeLimit = Math.max(10, Math.min(200, Number(limit) || 60))
  const selectWithExtended =
    'id, provider, model, duration_ms, speaker_count, segment_count, correction_count, transcript_rating, summary_rating, notes, manual_speaker_fixes, best_transcript, best_summary, compare_run_id, created_at'

  const primary = await supabase
    .from('transcription_evaluations')
    .select(selectWithExtended)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(safeLimit)

  if (!primary.error) return Array.isArray(primary.data) ? primary.data : []

  const fallback = await supabase
    .from('transcription_evaluations')
    .select('id, provider, model, duration_ms, speaker_count, segment_count, correction_count, transcript_rating, summary_rating, notes, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(safeLimit)

  if (fallback.error) {
    throw new Error(fallback.error.message || 'Could not load transcription evaluations')
  }

  return Array.isArray(fallback.data) ? fallback.data : []
}

export async function getMeetingProviderOutputs(supabase, { userId, meetingId }) {
  if (!userId || !meetingId) return []

  const { data, error } = await supabase
    .from('transcription_evaluations')
    .select('provider, model, segments, summary, duration_ms, speaker_count, segment_count, created_at')
    .eq('user_id', userId)
    .eq('meeting_id', meetingId)
    .order('created_at', { ascending: false })
    .limit(60)

  if (error) {
    throw new Error(error.message || 'Could not load provider outputs')
  }

  const latestByProvider = new Map()
  for (const row of Array.isArray(data) ? data : []) {
    const provider = String(row?.provider || '').trim()
    if (!provider || latestByProvider.has(provider)) continue
    latestByProvider.set(provider, row)
  }

  return Array.from(latestByProvider.values())
}

export function getLocalMeetings(userId) {
  try {
    const raw = localStorage.getItem(LOCAL_MEETINGS_KEY_PREFIX + userId)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function deleteLocalMeeting(userId, meetingId) {
  if (!userId || !meetingId) return false
  try {
    const meetings = getLocalMeetings(userId)
    const next = meetings.filter((meeting) => meeting?.id !== meetingId)
    localStorage.setItem(LOCAL_MEETINGS_KEY_PREFIX + userId, JSON.stringify(next))
    return true
  } catch {
    return false
  }
}

export async function deleteMeetingRecord(supabase, { userId, meetingId, audioStoragePath = '' }) {
  if (!supabase || !userId || !meetingId) {
    throw new Error('Missing meeting delete parameters')
  }

  const path = String(audioStoragePath || '').trim()
  if (path) {
    try {
      await supabase.storage.from(MEETING_AUDIO_BUCKET).remove([path])
    } catch (err) {
      console.warn('[Summary] Could not delete meeting audio object:', err?.message || err)
    }
  }

  const { error } = await supabase
    .from('meetings')
    .delete()
    .eq('id', meetingId)
    .eq('user_id', userId)

  if (error) {
    throw new Error(error.message || 'Could not delete meeting')
  }

  return true
}

function saveMeetingLocally(userId, title, meetingData) {
  try {
    const meetings = getLocalMeetings(userId)
    const localMeeting = {
      id: 'local_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      user_id: userId,
      title,
      transcript_compressed: meetingData.transcript || '',
      summary: meetingData.summary || '',
      segments: meetingData.segments || [],
      label_map: meetingData.labelMap || {},
      duration_segments: meetingData.segments?.length || 0,
      created_at: new Date().toISOString(),
    }

    const next = [localMeeting, ...meetings].slice(0, 100)
    localStorage.setItem(LOCAL_MEETINGS_KEY_PREFIX + userId, JSON.stringify(next))
    return localMeeting.id
  } catch (err) {
    console.error('saveMeeting local fallback error:', err)
    return null
  }
}

function buildDefaultMeetingTitle() {
  const now = new Date()
  const dateStr = now.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
  const timeStr = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  return dateStr + ' - ' + timeStr
}

function getAudioExtension(mimeType, fileName = '') {
  const nameExtension = String(fileName || '')
    .split('.')
    .pop()
    ?.toLowerCase()
  if (['aac', 'aif', 'aiff', 'flac', 'm4a', 'mp3', 'mp4', 'oga', 'ogg', 'opus', 'wav', 'webm'].includes(nameExtension)) {
    return nameExtension
  }

  const type = String(mimeType || '').toLowerCase()
  if (type.includes('flac')) return 'flac'
  if (type.includes('aac')) return 'aac'
  if (type.includes('m4a') || type.includes('x-m4a')) return 'm4a'
  if (type.includes('mp4')) return 'mp4'
  if (type.includes('mpeg') || type.includes('mp3')) return 'mp3'
  if (type.includes('wav')) return 'wav'
  if (type.includes('ogg')) return 'ogg'
  if (type.includes('opus')) return 'opus'
  return 'webm'
}

function normalizeRetentionDays(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return DEFAULT_AUDIO_RETENTION_DAYS
  return Math.max(1, Math.min(365, Math.round(parsed)))
}

function getSupabaseTusEndpoint() {
  const rawUrl = String(SUPABASE_URL || '').trim()
  if (!rawUrl) return ''

  try {
    const url = new URL(rawUrl)
    const host = url.hostname
    if (host.endsWith('.supabase.co')) {
      return `${url.protocol}//${host.replace('.supabase.co', '.storage.supabase.co')}/storage/v1/upload/resumable`
    }
    return `${url.origin}/storage/v1/upload/resumable`
  } catch {
    return ''
  }
}

function buildMeetingAudioPath(userId, meetingId, extension) {
  const cleanUserId = sanitizePathSegment(userId, 'user id')
  const cleanMeetingId = sanitizePathSegment(meetingId, 'meeting id')
  const cleanExt = sanitizeExtension(extension)
  return `${cleanUserId}/${cleanMeetingId}/recording.${cleanExt}`
}

function isSafeMeetingAudioPath(path, userId, meetingId = null) {
  const value = String(path || '').trim()
  if (!value || value.includes('\\') || value.includes('..')) return false

  const parts = value.split('/')
  if (parts.length < 3) return false

  const cleanUserId = sanitizePathSegment(userId, 'user id')
  if (parts[0] !== cleanUserId) return false

  if (meetingId) {
    const cleanMeetingId = sanitizePathSegment(meetingId, 'meeting id')
    if (parts[1] !== cleanMeetingId) return false
  }

  return /^recording\.[a-z0-9]+$/i.test(parts[2])
}

function sanitizePathSegment(value, label) {
  const text = String(value || '').trim()
  if (!text) throw new Error(`Missing ${label}.`)
  if (!/^[a-zA-Z0-9-]+$/.test(text)) {
    throw new Error(`Invalid ${label}.`)
  }
  return text
}

function sanitizeExtension(value) {
  const ext = String(value || '').toLowerCase().trim()
  if (!/^[a-z0-9]+$/.test(ext)) return 'webm'
  return ext
}

function normalizeContextTerms(values) {
  const list = Array.isArray(values) ? values : []
  const out = []
  const seen = new Set()

  for (const raw of list) {
    const value = String(raw || '')
      .replace(/\s+/g, ' ')
      .trim()
    if (!value) continue
    if (value.length > 60) continue
    if (value.split(' ').length > 8) continue
    const key = value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(value)
    if (out.length >= 200) break
  }

  return out
}

function normalizeRating(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return null
  const rounded = Math.round(parsed)
  if (rounded < 1 || rounded > 5) return null
  return rounded
}

function toIntOrNull(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return null
  return Math.max(0, Math.round(parsed))
}

function toIntOrZero(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return 0
  return Math.max(0, Math.round(parsed))
}

function normalizeAudioUploadStatus(value) {
  const text = String(value || '').toLowerCase().trim()
  if (text === 'pending' || text === 'uploaded' || text === 'failed') return text
  return null
}

function isMissingColumnError(error, columnName) {
  const code = String(error?.code || '')
  const message = String(error?.message || '').toLowerCase()
  const needle = String(columnName || '').toLowerCase()
  return code === '42703' || (needle && message.includes(needle) && message.includes('column'))
}

function buildCorrectionContext(item) {
  const originalSentence = String(item?.originalSentence || '').replace(/\s+/g, ' ').trim()
  const correctedSentence = String(item?.correctedSentence || '').replace(/\s+/g, ' ').trim()
  const speakerRaw = item?.speaker
  const speaker = Number.isFinite(Number(speakerRaw)) ? Number(speakerRaw) : null
  const startTime = toNumberOrNull(item?.startTime)
  const endTime = toNumberOrNull(item?.endTime)

  if (!originalSentence && !correctedSentence && speaker === null && startTime === null && endTime === null) {
    return null
  }

  return {
    original_sentence: originalSentence || null,
    corrected_sentence: correctedSentence || null,
    speaker,
    start_time: startTime,
    end_time: endTime,
  }
}

function toNumberOrNull(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return null
  return Math.max(0, parsed)
}
