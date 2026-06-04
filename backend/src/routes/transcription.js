import express from 'express'
import { createClient } from '@supabase/supabase-js'
import { requireAuth } from '../middleware/auth.js'
import {
  extractTranscriptionHints,
  getAssemblyAITranscript,
  parseAssemblyAIResponse,
  startAssemblyAITranscriptFromUrl,
} from './grok.js'

export const transcriptionRouter = express.Router()

const MEETING_AUDIO_BUCKET = 'meeting-audio'
const SIGNED_AUDIO_URL_TTL_SECONDS = 60 * 60

transcriptionRouter.post('/start', requireAuth, async (req, res) => {
  const supabase = getSupabaseClient()
  if (!supabase) {
    return res.status(500).json({ error: 'Supabase is not configured on server' })
  }

  const meetingId = normalizeUuidish(req.body?.meeting_id)
  if (!meetingId) {
    return res.status(400).json({ error: 'meeting_id is required' })
  }

  try {
    const meeting = await loadUserMeeting(supabase, req.user.id, meetingId)
    if (!meeting) {
      return res.status(404).json({ error: 'Meeting not found' })
    }

    const audioPath = String(meeting.audio_storage_path || '').trim()
    if (!audioPath) {
      return res.status(400).json({ error: 'Meeting audio is not uploaded yet' })
    }

    if (!isSafeMeetingAudioPath(audioPath, req.user.id, meetingId)) {
      return res.status(400).json({ error: 'Meeting audio path is invalid' })
    }

    const requestedPath = String(req.body?.audio_storage_path || '').trim()
    if (requestedPath && requestedPath !== audioPath) {
      return res.status(400).json({ error: 'Meeting audio path mismatch' })
    }

    if (meeting.transcription_status === 'completed' && Array.isArray(meeting.segments) && meeting.segments.length > 0) {
      return res.json({
        status: 'completed',
        meetingId,
        provider: meeting.transcription_provider || 'assemblyai',
        model: meeting.transcription_model || '',
        segments: meeting.segments,
        durationMs: Number(meeting.transcription_duration_ms || 0),
      })
    }

    if (meeting.assemblyai_transcript_id && meeting.transcription_status === 'processing') {
      return res.json({
        status: 'processing',
        meetingId,
        transcriptId: meeting.assemblyai_transcript_id,
        provider: 'assemblyai',
        model: meeting.transcription_model || '',
      })
    }

    const signedUrl = await createAudioSignedUrl(supabase, audioPath)
    const startedAt = Date.now()
    const hints = extractTranscriptionHints(req.body || {})
    const request = await startAssemblyAITranscriptFromUrl(signedUrl, hints)

    await updateMeetingTranscription(supabase, req.user.id, meetingId, {
      transcription_status: 'processing',
      transcription_provider: 'assemblyai',
      transcription_model: request.model,
      assemblyai_transcript_id: request.transcriptId,
      transcription_started_at: new Date().toISOString(),
      transcription_completed_at: null,
      transcription_duration_ms: null,
      transcription_error: null,
      transcription_keyterm_count: request.keytermCount,
      transcription_used_keyterms: request.usedKeyterms,
    })

    return res.json({
      status: 'processing',
      meetingId,
      transcriptId: request.transcriptId,
      provider: 'assemblyai',
      model: request.model,
      usedKeyterms: request.usedKeyterms,
      keytermCount: request.keytermCount,
      startDurationMs: Date.now() - startedAt,
    })
  } catch (err) {
    console.warn('[Transcription] Could not start job:', {
      meetingId,
      userId: req.user.id,
      error: err?.message || err,
    })
    return res.status(normalizeStatus(err?.status)).json({ error: safeTranscriptionError(err) })
  }
})

transcriptionRouter.get('/status/:meetingId', requireAuth, async (req, res) => {
  const supabase = getSupabaseClient()
  if (!supabase) {
    return res.status(500).json({ error: 'Supabase is not configured on server' })
  }

  const meetingId = normalizeUuidish(req.params.meetingId)
  if (!meetingId) {
    return res.status(400).json({ error: 'meeting_id is required' })
  }

  try {
    const meeting = await loadUserMeeting(supabase, req.user.id, meetingId)
    if (!meeting) {
      return res.status(404).json({ error: 'Meeting not found' })
    }

    if (meeting.transcription_status === 'completed' && Array.isArray(meeting.segments) && meeting.segments.length > 0) {
      return res.json({
        status: 'completed',
        provider: meeting.transcription_provider || 'assemblyai',
        model: meeting.transcription_model || '',
        segments: meeting.segments,
        durationMs: Number(meeting.transcription_duration_ms || 0),
      })
    }

    if (meeting.transcription_status === 'failed') {
      return res.json({
        status: 'failed',
        error: meeting.transcription_error || 'Transcription failed',
      })
    }

    const transcriptId = String(meeting.assemblyai_transcript_id || '').trim()
    if (!transcriptId) {
      return res.json({
        status: meeting.transcription_status || 'idle',
        segments: Array.isArray(meeting.segments) ? meeting.segments : [],
      })
    }

    const payload = await getAssemblyAITranscript(transcriptId)

    if (payload.status === 'completed') {
      const segments = parseAssemblyAIResponse(payload)
      const completedAt = Date.now()
      const startedAt = meeting.transcription_started_at ? new Date(meeting.transcription_started_at).getTime() : null
      const durationMs = Number.isFinite(startedAt) ? Math.max(0, completedAt - startedAt) : null

      await updateMeetingTranscription(supabase, req.user.id, meetingId, {
        transcription_status: 'completed',
        transcription_completed_at: new Date(completedAt).toISOString(),
        transcription_duration_ms: durationMs,
        transcription_error: null,
        segments,
        duration_segments: segments.length,
      })

      return res.json({
        status: 'completed',
        provider: 'assemblyai',
        model: meeting.transcription_model || 'universal-3-pro,universal-2',
        segments,
        durationMs,
      })
    }

    if (payload.status === 'error') {
      const message = String(payload.error || 'Transcription failed').slice(0, 500)
      await updateMeetingTranscription(supabase, req.user.id, meetingId, {
        transcription_status: 'failed',
        transcription_completed_at: new Date().toISOString(),
        transcription_error: message,
      })
      return res.json({ status: 'failed', error: message })
    }

    return res.json({
      status: 'processing',
      provider: 'assemblyai',
      model: meeting.transcription_model || 'universal-3-pro,universal-2',
    })
  } catch (err) {
    console.warn('[Transcription] Could not poll job:', {
      meetingId,
      userId: req.user.id,
      error: err?.message || err,
    })
    return res.status(normalizeStatus(err?.status)).json({ error: safeTranscriptionError(err) })
  }
})

function getSupabaseClient() {
  const supabaseUrl = process.env.SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceRoleKey) return null
  return createClient(supabaseUrl, serviceRoleKey)
}

async function loadUserMeeting(supabase, userId, meetingId) {
  const { data, error } = await supabase
    .from('meetings')
    .select(
      'id, user_id, audio_storage_path, audio_upload_status, transcription_status, transcription_provider, transcription_model, transcription_duration_ms, transcription_started_at, transcription_error, assemblyai_transcript_id, segments',
    )
    .eq('id', meetingId)
    .eq('user_id', userId)
    .maybeSingle()

  if (error) {
    throw new Error(`Could not load meeting: ${error.message}`)
  }

  return data || null
}

async function createAudioSignedUrl(supabase, path) {
  const { data, error } = await supabase.storage
    .from(MEETING_AUDIO_BUCKET)
    .createSignedUrl(path, SIGNED_AUDIO_URL_TTL_SECONDS)

  if (error || !data?.signedUrl) {
    throw new Error(error?.message || 'Could not create signed audio URL')
  }

  return data.signedUrl
}

async function updateMeetingTranscription(supabase, userId, meetingId, payload) {
  const { error } = await supabase
    .from('meetings')
    .update(payload)
    .eq('id', meetingId)
    .eq('user_id', userId)

  if (error) {
    throw new Error(`Could not update transcription metadata: ${error.message}`)
  }
}

function isSafeMeetingAudioPath(path, userId, meetingId) {
  const value = String(path || '').trim()
  if (!value || value.includes('\\') || value.includes('..')) return false
  if (value.startsWith('/') || value.endsWith('/')) return false
  return value.startsWith(`${userId}/${meetingId}/`)
}

function normalizeUuidish(value) {
  const text = String(value || '').trim()
  if (!text) return ''
  if (!/^[a-zA-Z0-9-]+$/.test(text)) return ''
  return text
}

function normalizeStatus(status) {
  const parsed = Number(status)
  if (!Number.isFinite(parsed)) return 500
  if (parsed < 400 || parsed > 599) return 500
  return Math.floor(parsed)
}

function safeTranscriptionError(err) {
  const status = normalizeStatus(err?.status)
  if (status === 400) return 'Transcription request was rejected.'
  if (status === 401 || status === 403) return 'Transcription authentication failed.'
  if (status === 404) return 'Meeting audio was not found.'
  if (status === 408 || status === 504) return 'Transcription timed out.'
  if (status === 429) return 'Transcription rate limit reached.'
  return 'Transcription failed.'
}
