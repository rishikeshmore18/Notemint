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

  const SYSTEM_PROMPT = `You are a meeting notes assistant. Output EXACTLY this structure. Use these exact bold headers. No intro, no preamble, no closing remarks.

**TL;DR**
Two sentences max. Plain English. What happened and what matters.

**Decisions made**
Bullet list with "- " prefix. Only firm decisions. If none: - None recorded.

**Action items**
Each line starts with ->
Format: -> [Person] will [action] [by timeframe if mentioned]
If none: -> None recorded.

**Key discussion points**
3 to 5 bullets with "- " prefix. Specific content, not vague descriptions.

**Needs follow-up**
Bullets of unresolved items or open questions.
If none: - None.

Be direct. No filler. No repetition. When speaker label is "You", refer to them as "you".`

  try {
    console.log('[Summary] Calling Claude. Transcript chars:', compressedTranscript.length)
    console.log('[Summary] Using key starting with:', import.meta.env.VITE_CLAUDE_KEY?.slice(0, 10))

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': import.meta.env.VITE_CLAUDE_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        stream: true,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: 'Meeting transcript:\n\n' + compressedTranscript,
          },
        ],
      }),
    })

    if (!response.ok) {
      let errorDetail = 'HTTP ' + response.status
      try {
        const body = await response.json()
        errorDetail = body.error?.message || errorDetail
        console.error('[Summary] Claude API error body:', body)
      } catch {}
      console.error('[Summary] Claude API failed:', response.status, errorDetail)
      onError('Summary failed (' + response.status + '): ' + errorDetail)
      return
    }

    console.log('[Summary] Claude API OK, reading stream...')

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let fullText = ''
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        if (trimmed.startsWith('event:')) continue
        if (!trimmed.startsWith('data:')) continue

        const jsonStr = trimmed.slice(5).trim()
        if (!jsonStr || jsonStr === '[DONE]') continue

        try {
          const parsed = JSON.parse(jsonStr)
          const chunkText = parsed.delta?.text || ''
          if (chunkText) {
            fullText += chunkText
            onChunk(chunkText)
          }
        } catch {
          continue
        }
      }
    }

    if (!fullText || fullText.trim().length < 5) {
      onError('Summary returned empty. Check your Claude API key in GitHub Secrets (VITE_CLAUDE_KEY).')
      return
    }

    onComplete(fullText)
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
