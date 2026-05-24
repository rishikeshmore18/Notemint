import express from 'express'
import { requireAuth } from '../middleware/auth.js'

export const summarizeRouter = express.Router()

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

Grounding rules:
- Use only transcript evidence. Do not infer missing facts.
- Do not invent names, dates, deadlines, decisions, or action owners.
- If ownership/timeframe is unclear, write "unspecified" instead of guessing.
- If a statement appears uncertain or contradictory, mark it as unclear.

Be direct. No filler. No repetition. When speaker label is "You", refer to them as "you".`

summarizeRouter.post('/', requireAuth, async (req, res) => {
  const { transcript } = req.body || {}
  const meetingContext = sanitizeMeetingContext(req.body?.meeting_context)

  if (!transcript || transcript.trim().length < 20) {
    return res.status(400).json({ error: 'Transcript too short to summarize' })
  }

  if (!process.env.ANTHROPIC_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_KEY is not configured on server' })
  }

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()

  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        stream: true,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: buildSummaryUserMessage(transcript, meetingContext),
          },
        ],
      }),
    })

    if (!claudeRes.ok) {
      const err = await claudeRes.text()
      res.write(`data: ${JSON.stringify({ error: `Claude API failed: ${err}` })}\n\n`)
      res.end()
      return
    }

    const reader = claudeRes.body?.getReader()
    if (!reader) {
      res.write(`data: ${JSON.stringify({ error: 'Claude stream unavailable' })}\n\n`)
      res.end()
      return
    }

    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('event:') || !trimmed.startsWith('data:')) continue
        const jsonStr = trimmed.slice(5).trim()
        if (!jsonStr || jsonStr === '[DONE]') continue
        try {
          const parsed = JSON.parse(jsonStr)
          const text = parsed.delta?.text || ''
          if (text) {
            res.write(`data: ${JSON.stringify({ text })}\n\n`)
          }
        } catch {
          // Skip malformed chunks from upstream SSE.
        }
      }
    }

    res.write('data: [DONE]\n\n')
    res.end()
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message || 'Summarization failed' })}\n\n`)
    res.end()
  }
})

function buildSummaryUserMessage(transcript, meetingContext) {
  if (!meetingContext) {
    return `Meeting transcript:\n\n${transcript}`
  }

  const lines = []
  if (meetingContext.topic) lines.push(`Topic: ${meetingContext.topic}`)
  if (meetingContext.goal) lines.push(`Goal: ${meetingContext.goal}`)
  if (meetingContext.meetingType) lines.push(`Meeting type: ${meetingContext.meetingType}`)
  if (meetingContext.expectedParticipants.length > 0) {
    lines.push(`Expected participants: ${meetingContext.expectedParticipants.join(', ')}`)
  }
  if (meetingContext.importantTerms.length > 0) {
    lines.push(`Important terms: ${meetingContext.importantTerms.join(', ')}`)
  }
  if (meetingContext.summaryContext) {
    lines.push(`Context note: ${meetingContext.summaryContext}`)
  }
  if (meetingContext.doNotInfer.length > 0) {
    lines.push(`Do-not-infer reminders: ${meetingContext.doNotInfer.join(' | ')}`)
  }
  if (meetingContext.confusionPairs.length > 0) {
    const hints = meetingContext.confusionPairs
      .map((pair) => `${pair.original} -> ${pair.corrected}`)
      .join(' | ')
    lines.push(`Known transcription confusions (hint only): ${hints}`)
  }

  if (lines.length === 0) {
    return `Meeting transcript:\n\n${transcript}`
  }

  return `Meeting context (use only for terminology disambiguation, not as evidence):
${lines.join('\n')}

Meeting transcript:

${transcript}`
}

function sanitizeMeetingContext(input) {
  if (!input || typeof input !== 'object') return null

  const context = {
    topic: cleanOneLine(input.topic, 120),
    goal: cleanOneLine(input.goal, 180),
    meetingType: cleanOneLine(input.meetingType, 48),
    expectedParticipants: normalizeTerms(input.expectedParticipants, { maxItems: 20, maxLen: 60, maxWords: 8 }),
    importantTerms: normalizeTerms(input.importantTerms, { maxItems: 40, maxLen: 60, maxWords: 8 }),
    summaryContext: cleanOneLine(input.summaryContext, 280),
    doNotInfer: normalizeTerms(input.doNotInfer, { maxItems: 12, maxLen: 120, maxWords: 16 }),
    confusionPairs: normalizeConfusionPairs(input.confusionPairs),
  }

  const hasData =
    context.topic ||
    context.goal ||
    context.meetingType ||
    context.expectedParticipants.length > 0 ||
    context.importantTerms.length > 0 ||
    context.summaryContext ||
    context.doNotInfer.length > 0 ||
    context.confusionPairs.length > 0

  return hasData ? context : null
}

function normalizeConfusionPairs(input) {
  const list = Array.isArray(input) ? input : []
  const out = []
  const seen = new Set()

  for (const item of list) {
    const original = cleanOneLine(item?.original, 80)
    const corrected = cleanOneLine(item?.corrected, 80)
    if (!original || !corrected) continue
    if (original.toLowerCase() === corrected.toLowerCase()) continue
    const key = `${original.toLowerCase()}=>${corrected.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ original, corrected })
    if (out.length >= 15) break
  }

  return out
}

function normalizeTerms(input, options = {}) {
  const maxItems = Number.isFinite(options.maxItems) ? options.maxItems : 40
  const maxLen = Number.isFinite(options.maxLen) ? options.maxLen : 60
  const maxWords = Number.isFinite(options.maxWords) ? options.maxWords : 8
  const out = []
  const seen = new Set()
  const list = Array.isArray(input) ? input : []

  for (const raw of list) {
    const value = cleanOneLine(raw, maxLen)
    if (!value) continue
    if (value.split(' ').length > maxWords) continue
    const key = value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(value)
    if (out.length >= maxItems) break
  }

  return out
}

function cleanOneLine(value, maxLen) {
  const cleaned = String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return ''
  return cleaned.slice(0, maxLen)
}
