import { streamSummary } from './api.js'

const FILLER_REGEX = /\b(um+|uh+|er+|erm|hmm+|ah+|like|you know|so um|ok so|mhm|yeah right)\b/gi
const LOCAL_MEETINGS_KEY_PREFIX = 'local_meetings_'

export function compressTranscript(segments, labelMap) {
  if (!segments || segments.length === 0) {
    console.warn('[Summary] compressTranscript called with empty segments')
    return ''
  }

  let finals = segments.filter((s) => s.isFinal === true)
  if (finals.length === 0) finals = segments

  const seen = new Set()
  const cleaned = []
  for (const seg of finals) {
    const text = (seg.text || '').replace(FILLER_REGEX, '').replace(/\s+/g, ' ').trim()
    if (text.length < 2) continue
    if (seen.has(text)) continue
    seen.add(text)
    cleaned.push({ speaker: seg.speaker, text })
  }

  const merged = []
  for (const item of cleaned) {
    let label = labelMap[item.speaker]
    if (label === undefined || label === null) {
      label = 'Person ' + (item.speaker + 1)
    }

    const last = merged[merged.length - 1]
    if (last && last.label === label) {
      last.text = last.text + ' ' + item.text
    } else {
      merged.push({ label, text: item.text })
    }
  }

  const result = merged.map((m) => `[${m.label}]: ${m.text.trim()}`).join('\n')
  console.log('[Summary] Compressed transcript preview:', result.slice(0, 200))
  return result
}

export async function getSummary(compressedTranscript, onChunk, onComplete, onError) {
  if (!compressedTranscript || compressedTranscript.length < 10) {
    onError('Recording too short to summarize - try at least 10 seconds.')
    return
  }

  try {
    console.log('[Summary] Calling backend summary stream. Transcript chars:', compressedTranscript.length)
    await streamSummary(compressedTranscript, onChunk, onComplete, onError)
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
