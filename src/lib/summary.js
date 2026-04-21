const FILLER_REGEX = /\b(um+|uh+|er+|erm|hmm+|ah+|like|you know|so um|ok so|mhm|yeah right)\b/gi

export function compressTranscript(segments, labelMap) {
  if (!segments || segments.length === 0) return ''

  let finals = segments.filter((s) => s.isFinal === true)
  if (finals.length === 0) finals = segments

  const seen = new Set()
  const cleaned = []

  for (const seg of finals) {
    const text = seg.text.replace(FILLER_REGEX, '').replace(/\s+/g, ' ').trim()
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

  return merged.map((m) => `[${m.label}]: ${m.text.trim()}`).join('\n')
}

export async function getSummary(compressedTranscript, onChunk, onComplete, onError) {
  if (!compressedTranscript || compressedTranscript.length < 30) {
    onError('Recording too short to summarize — try at least 30 seconds.')
    return
  }

  const SYSTEM_PROMPT = `You are a meeting notes assistant. Output EXACTLY this structure. Use these exact bold headers. No intro, no preamble, no closing remarks.

**TL;DR**
Two sentences max. Plain English. What happened and what matters.

**Decisions made**
Bullet list with "- " prefix. Only firm decisions. If none: - None recorded.

**Action items**
Each line starts with →
Format: → [Person] will [action] [by timeframe if mentioned]
If none: → None recorded.

**Key discussion points**
3 to 5 bullets with "- " prefix. Specific content, not vague descriptions.

**Needs follow-up**
Bullets of unresolved items or open questions.
If none: - None.

Be direct. No filler. No repetition. When speaker label is "You", refer to them as "you".`

  try {
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
      const body = await response.json().catch(() => ({}))
      onError('Summary failed: ' + (body.error?.message || 'HTTP ' + response.status))
      return
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let fullText = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      const raw = decoder.decode(value, { stream: true })
      const lines = raw.split('\n')

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const jsonStr = line.slice(6).trim()
        if (jsonStr === '[DONE]' || jsonStr === '') continue

        try {
          const parsed = JSON.parse(jsonStr)
          const text = parsed.delta?.text
          if (text) {
            fullText += text
            onChunk(text)
          }
        } catch {
          continue
        }
      }
    }

    onComplete(fullText)
  } catch (err) {
    if (err.name === 'AbortError') return
    if (
      err.message.includes('fetch') ||
      err.message.includes('network') ||
      err.message.includes('Failed')
    ) {
      onError('No internet — summary unavailable')
    } else {
      onError('Summary error: ' + err.message)
    }
  }
}

export async function saveMeeting(supabase, userId, meetingData) {
  let title = meetingData.title

  if (!title) {
    const now = new Date()
    const dateStr = now.toLocaleDateString('en-GB', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    })
    const timeStr = now.toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
    })
    title = dateStr + ' · ' + timeStr
  }

  try {
    const { data, error } = await supabase
      .from('meetings')
      .insert({
        user_id: userId,
        title: title,
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
      return null
    }

    return data.id
  } catch (err) {
    console.error('saveMeeting error:', err)
    return null
  }
}

