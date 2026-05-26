import express from 'express'
import { createClient } from '@supabase/supabase-js'

export const cleanupRouter = express.Router()

const MEETING_AUDIO_BUCKET = 'meeting-audio'
const DEFAULT_LIMIT = 500
const MAX_LIMIT = 1000
const STORAGE_REMOVE_BATCH_SIZE = 100

cleanupRouter.post('/expired-audio', async (req, res) => {
  if (!process.env.CLEANUP_JOB_SECRET) {
    return res.status(500).json({ error: 'CLEANUP_JOB_SECRET is not configured on server' })
  }

  if (!isAuthorizedCleanupRequest(req)) {
    return res.status(401).json({ error: 'Unauthorized cleanup request' })
  }

  const supabase = getSupabaseClient()
  if (!supabase) {
    return res.status(500).json({ error: 'Supabase is not configured on server' })
  }

  const limit = normalizeLimit(req.body?.limit ?? req.query?.limit)
  const dryRun = parseBoolean(req.body?.dry_run ?? req.query?.dry_run)

  try {
    const expiredMeetings = await loadExpiredAudioMeetings(supabase, limit)
    const validMeetings = expiredMeetings.filter(isSafeAudioMeeting)
    const skippedInvalid = expiredMeetings.length - validMeetings.length

    if (dryRun || validMeetings.length === 0) {
      console.log('[Cleanup] Expired audio dry run:', {
        candidates: expiredMeetings.length,
        valid: validMeetings.length,
        skippedInvalid,
      })

      return res.json({
        ok: true,
        dry_run: dryRun,
        candidates: expiredMeetings.length,
        valid_candidates: validMeetings.length,
        skipped_invalid: skippedInvalid,
        deleted_files: 0,
        metadata_cleared: 0,
        failed_files: 0,
      })
    }

    const removal = await removeAudioFiles(supabase, validMeetings)
    const metadataCleared = await clearDeletedAudioMetadata(supabase, removal.deletedMeetings)

    console.log('[Cleanup] Expired audio cleanup finished:', {
      candidates: expiredMeetings.length,
      deletedFiles: removal.deletedMeetings.length,
      failedFiles: removal.failed.length,
      metadataCleared,
      skippedInvalid,
    })

    return res.json({
      ok: removal.failed.length === 0,
      dry_run: false,
      candidates: expiredMeetings.length,
      valid_candidates: validMeetings.length,
      skipped_invalid: skippedInvalid,
      deleted_files: removal.deletedMeetings.length,
      metadata_cleared: metadataCleared,
      failed_files: removal.failed.length,
    })
  } catch (err) {
    console.error('[Cleanup] Expired audio cleanup failed:', err)
    return res.status(500).json({ error: 'Expired audio cleanup failed' })
  }
})

function getSupabaseClient() {
  const supabaseUrl = process.env.SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceRoleKey) return null
  return createClient(supabaseUrl, serviceRoleKey)
}

function isAuthorizedCleanupRequest(req) {
  const expected = process.env.CLEANUP_JOB_SECRET
  if (!expected) return false

  const authHeader = String(req.headers.authorization || '')
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
  const headerToken = String(req.headers['x-cleanup-secret'] || '').trim()
  return safeTokenEqual(bearerToken, expected) || safeTokenEqual(headerToken, expected)
}

function safeTokenEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

async function loadExpiredAudioMeetings(supabase, limit) {
  const { data, error } = await supabase.rpc('cleanup_expired_meeting_audio', { p_limit: limit })

  if (!error) {
    return normalizeExpiredRows(data)
  }

  console.warn('[Cleanup] cleanup_expired_meeting_audio RPC failed, falling back to direct metadata query:', error.message)

  const fallback = await supabase
    .from('meetings')
    .select('id, user_id, audio_storage_path, audio_expires_at')
    .not('audio_storage_path', 'is', null)
    .is('audio_deleted_at', null)
    .not('audio_expires_at', 'is', null)
    .lte('audio_expires_at', new Date().toISOString())
    .order('audio_expires_at', { ascending: true })
    .limit(limit)

  if (fallback.error) {
    throw new Error(`Could not load expired audio metadata: ${fallback.error.message}`)
  }

  return normalizeExpiredRows(fallback.data)
}

function normalizeExpiredRows(rows) {
  const list = Array.isArray(rows) ? rows : []
  return list.map((row) => ({
    meetingId: String(row?.meeting_id || row?.id || '').trim(),
    userId: String(row?.user_id || '').trim(),
    path: String(row?.audio_storage_path || '').trim(),
    expiresAt: String(row?.audio_expires_at || '').trim(),
  }))
}

function isSafeAudioMeeting(meeting) {
  if (!meeting.meetingId || !meeting.userId || !meeting.path) return false
  if (meeting.path.includes('..')) return false
  if (meeting.path.startsWith('/') || meeting.path.endsWith('/')) return false
  return meeting.path.startsWith(`${meeting.userId}/${meeting.meetingId}/`)
}

async function removeAudioFiles(supabase, meetings) {
  const deletedMeetings = []
  const failed = []

  for (let start = 0; start < meetings.length; start += STORAGE_REMOVE_BATCH_SIZE) {
    const batch = meetings.slice(start, start + STORAGE_REMOVE_BATCH_SIZE)
    const paths = batch.map((meeting) => meeting.path)
    const { error } = await supabase.storage.from(MEETING_AUDIO_BUCKET).remove(paths)

    if (error) {
      console.warn('[Cleanup] Storage remove batch failed:', error.message)
      failed.push(...batch.map((meeting) => meeting.meetingId))
      continue
    }

    deletedMeetings.push(...batch)
  }

  return { deletedMeetings, failed }
}

async function clearDeletedAudioMetadata(supabase, meetings) {
  let cleared = 0
  const nowIso = new Date().toISOString()

  for (const meeting of meetings) {
    const { data, error } = await supabase
      .from('meetings')
      .update({
        audio_storage_path: null,
        audio_mime_type: null,
        audio_size_bytes: null,
        audio_duration_seconds: null,
        audio_uploaded_at: null,
        audio_expires_at: null,
        audio_deleted_at: nowIso,
      })
      .eq('id', meeting.meetingId)
      .eq('user_id', meeting.userId)
      .eq('audio_storage_path', meeting.path)
      .select('id')

    if (error) {
      console.warn('[Cleanup] Could not clear audio metadata:', {
        meetingId: meeting.meetingId,
        error: error.message,
      })
      continue
    }

    cleared += Array.isArray(data) ? data.length : 0
  }

  return cleared
}

function normalizeLimit(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT
  return Math.max(1, Math.min(MAX_LIMIT, Math.round(parsed)))
}

function parseBoolean(value) {
  if (typeof value === 'boolean') return value
  const normalized = String(value || '').trim().toLowerCase()
  return ['1', 'true', 'yes', 'y'].includes(normalized)
}
