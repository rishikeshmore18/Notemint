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

Be direct. No filler. No repetition. When speaker label is "You", refer to them as "you".`

summarizeRouter.post('/', requireAuth, async (req, res) => {
  const { transcript } = req.body || {}

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
        messages: [{ role: 'user', content: `Meeting transcript:\n\n${transcript}` }],
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
