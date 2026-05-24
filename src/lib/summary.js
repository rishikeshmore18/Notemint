import { streamSummary } from './api.js'

const LIGHT_FILLER_REGEX = /\b(um+|uh+|er+|erm|hmm+|ah+)\b/gi
const LOCAL_MEETINGS_KEY_PREFIX = 'local_meetings_'

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

      return {
        user_id: userId,
        meeting_id: meetingId || null,
        provider: provider ? String(provider) : null,
        original_text: originalText,
        corrected_text: correctedText,
        context_terms_used: terms,
        created_at: new Date().toISOString(),
      }
    })
    .filter(Boolean)

  if (rows.length === 0) return false

  const { error } = await supabase.from('transcript_corrections').insert(rows)
  if (error) {
    throw new Error(error.message || 'Could not save transcript corrections')
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
