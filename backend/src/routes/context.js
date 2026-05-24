import express from 'express'
import { requireAuth } from '../middleware/auth.js'

export const contextRouter = express.Router()

const GENERIC_TERMS = new Set([
  'meeting',
  'meetings',
  'team',
  'customer',
  'customers',
  'client',
  'clients',
  'discussion',
  'project',
  'company',
  'business',
  'work',
  'task',
  'tasks',
  'update',
  'updates',
  'notes',
  'call',
  'calls',
])

contextRouter.post('/generate-keyterms', requireAuth, async (req, res) => {
  if (!process.env.ANTHROPIC_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_KEY is not configured on server' })
  }

  try {
    const cleaned = normalizeProfileInput(req.body || {})
    const generated = await generateKeytermSuggestions(cleaned)
    return res.json(generated)
  } catch (err) {
    console.warn('[Context] Keyterm generation failed:', err?.message || err)
    return res.status(502).json({ error: 'Could not generate keyterm suggestions' })
  }
})

async function generateKeytermSuggestions(profile) {
  const promptPayload = JSON.stringify(
    {
      industry: profile.industry || null,
      role: profile.role || null,
      meeting_types: profile.meetingTypes,
      participant_names: profile.participantNames,
      organization_terms: profile.organizationTerms,
      custom_terms: profile.customTerms,
      correction_terms: profile.correctionTerms,
    },
    null,
    2,
  )

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 900,
      temperature: 0.1,
      system: `You generate high-signal speech transcription context.
Return STRICT JSON only, no markdown, no commentary.
Schema:
{
  "keyterms": string[],
  "summary_context": string,
  "do_not_infer": string[]
}
Rules:
- Keep keyterms specific and useful for speech recognition.
- Prefer names, acronyms, product terms, domain phrases.
- Avoid generic words like meeting, team, customer.
- Max 200 keyterms.
- Each keyterm max 6 words.
- summary_context max 280 characters.
- do_not_infer max 12 short instructions.`,
      messages: [
        {
          role: 'user',
          content: `Generate suggestions from this onboarding profile:\n${promptPayload}`,
        },
      ],
    }),
    signal: AbortSignal.timeout(45000),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Claude API failed: ${text}`)
  }

  const payload = await response.json()
  const rawText = extractTextBlocks(payload)
  const parsed = parseStrictJson(rawText)

  return sanitizeGeneratedPayload(parsed)
}

function normalizeProfileInput(input) {
  return {
    industry: cleanOneLine(input.industry, 64),
    role: cleanOneLine(input.role, 64),
    meetingTypes: normalizeArray(input.meetingTypes, { maxItems: 24, maxLen: 48 }),
    participantNames: normalizeArray(input.participantNames, { maxItems: 120, maxLen: 64 }),
    organizationTerms: normalizeArray(input.organizationTerms, { maxItems: 160, maxLen: 64 }),
    customTerms: normalizeArray(input.customTerms, { maxItems: 160, maxLen: 64 }),
    correctionTerms: normalizeArray(input.correctionTerms, { maxItems: 160, maxLen: 64 }),
  }
}

function sanitizeGeneratedPayload(parsed) {
  const keyterms = normalizeArray(parsed?.keyterms, { maxItems: 200, maxLen: 50 })
    .filter((term) => term.split(' ').length <= 6)
    .filter((term) => !GENERIC_TERMS.has(term.toLowerCase()))
    .filter((term) => !looksSensitive(term))

  const summaryContext = cleanOneLine(parsed?.summary_context, 280)
  const doNotInfer = normalizeArray(parsed?.do_not_infer, { maxItems: 12, maxLen: 120 }).filter(
    (entry) => !looksSensitive(entry),
  )

  return {
    keyterms,
    summary_context: summaryContext || '',
    do_not_infer: doNotInfer,
  }
}

function extractTextBlocks(payload) {
  const content = Array.isArray(payload?.content) ? payload.content : []
  const text = content
    .filter((block) => block?.type === 'text')
    .map((block) => String(block.text || ''))
    .join('\n')
    .trim()

  if (!text) throw new Error('Claude returned empty content')
  return text
}

function parseStrictJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) throw new Error('No JSON object found in Claude response')
    return JSON.parse(match[0])
  }
}

function normalizeArray(input, { maxItems = 50, maxLen = 60 } = {}) {
  const list = Array.isArray(input) ? input : []
  const out = []
  const seen = new Set()

  for (const raw of list) {
    const cleaned = cleanOneLine(raw, maxLen)
    if (!cleaned) continue
    const key = cleaned.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(cleaned)
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

function looksSensitive(value) {
  const text = String(value || '').trim()
  if (!text) return false
  if (/@/.test(text)) return true
  if (/\b(?:\+?\d[\d\s().-]{8,}\d)\b/.test(text)) return true
  if (/\b\d{9,}\b/.test(text)) return true
  return false
}
