import express from 'express'
import { requireAuth } from '../middleware/auth.js'
import { createClient } from '@supabase/supabase-js'

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
    const correctionMemory = await loadCorrectionMemory(req.user?.id)
    const generated = await generateKeytermSuggestions(cleaned, correctionMemory)
    return res.json(generated)
  } catch (err) {
    console.warn('[Context] Keyterm generation failed:', err?.message || err)
    return res.status(502).json({ error: 'Could not generate keyterm suggestions' })
  }
})

contextRouter.post('/save-profile', requireAuth, async (req, res) => {
  try {
    const supabase = getServiceRoleClient()
    const payload = normalizeProfileForStorage(req.body || {}, req.user.id)

    let { data, error } = await supabase
      .from('user_context_profiles')
      .upsert(payload, { onConflict: 'user_id' })
      .select('id')
      .single()

    if (error && isMissingColumnError(error, 'do_not_infer')) {
      const { do_not_infer: _omit, ...legacyPayload } = payload
      ;({ data, error } = await supabase
        .from('user_context_profiles')
        .upsert(legacyPayload, { onConflict: 'user_id' })
        .select('id')
        .single())
    }

    if (error) {
      console.warn('[Context] save-profile failed:', error.message)
      return res.status(500).json({ error: 'Could not save context profile' })
    }

    return res.json({ ok: true, id: data?.id || null })
  } catch (err) {
    console.warn('[Context] save-profile exception:', err?.message || err)
    return res.status(500).json({ error: 'Could not save context profile' })
  }
})

async function generateKeytermSuggestions(profile, correctionMemory) {
  const promptPayload = JSON.stringify(
    {
      industry: profile.industry || null,
      role: profile.role || null,
      meeting_types: profile.meetingTypes,
      participant_names: profile.participantNames,
      organization_terms: profile.organizationTerms,
      custom_terms: profile.customTerms,
      correction_terms: profile.correctionTerms,
      correction_memory_pairs: correctionMemory.confusionPairs,
      correction_memory_boost_terms: correctionMemory.boostTerms,
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

  return sanitizeGeneratedPayload(parsed, correctionMemory)
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

function sanitizeGeneratedPayload(parsed, correctionMemory = { boostTerms: [] }) {
  const keyterms = normalizeArray(
    [...normalizeArray(parsed?.keyterms, { maxItems: 200, maxLen: 50 }), ...normalizeArray(correctionMemory?.boostTerms, { maxItems: 120, maxLen: 50 })],
    { maxItems: 200, maxLen: 50 },
  )
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

async function loadCorrectionMemory(userId) {
  if (!userId) {
    return {
      boostTerms: [],
      confusionPairs: [],
    }
  }

  const supabaseUrl = process.env.SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceRoleKey) {
    return {
      boostTerms: [],
      confusionPairs: [],
    }
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey)
  const { data, error } = await supabase
    .from('transcript_corrections')
    .select('original_text, corrected_text, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(250)

  if (error) {
    console.warn('[Context] Could not load correction memory:', error.message)
    return {
      boostTerms: [],
      confusionPairs: [],
    }
  }

  return buildCorrectionMemory(data)
}

function buildCorrectionMemory(rows) {
  const list = Array.isArray(rows) ? rows : []
  const pairCounts = new Map()
  const originalTotals = new Map()
  const correctedTotals = new Map()

  for (const row of list) {
    const original = sanitizeCorrectionTerm(row?.original_text)
    const corrected = sanitizeCorrectionTerm(row?.corrected_text)
    if (!original || !corrected) continue
    if (looksSensitive(original) || looksSensitive(corrected)) continue
    if (original.toLowerCase() === corrected.toLowerCase()) continue

    const pairKey = `${original.toLowerCase()}=>${corrected.toLowerCase()}`
    pairCounts.set(pairKey, (pairCounts.get(pairKey) || 0) + 1)
    originalTotals.set(original.toLowerCase(), (originalTotals.get(original.toLowerCase()) || 0) + 1)
    correctedTotals.set(corrected, (correctedTotals.get(corrected) || 0) + 1)
  }

  const confusionPairs = []
  const boostTerms = []
  const bestPerOriginal = new Map()

  for (const [pairKey, count] of pairCounts.entries()) {
    const [originalKey, correctedKey] = pairKey.split('=>')
    if (!originalKey || !correctedKey) continue
    const totalForOriginal = originalTotals.get(originalKey) || count
    const confidence = clamp(count / totalForOriginal, 0, 1)
    const original = restoreFromKey(list, 'original_text', originalKey)
    const corrected = restoreFromKey(list, 'corrected_text', correctedKey)
    if (!original || !corrected) continue

    confusionPairs.push({
      original,
      corrected,
      count,
      confidence,
      ambiguous: totalForOriginal >= 2 && confidence < 0.65,
    })

    const previous = bestPerOriginal.get(originalKey)
    if (!previous || previous.count < count) {
      bestPerOriginal.set(originalKey, { corrected, count, confidence, totalForOriginal })
    }
  }

  for (const pair of bestPerOriginal.values()) {
    if (pair.totalForOriginal >= 2 && pair.confidence < 0.65) continue
    if (pair.corrected.length < 3) continue
    boostTerms.push(pair.corrected)
  }

  for (const [term, count] of correctedTotals.entries()) {
    if (count < 2) continue
    if (term.length < 3) continue
    boostTerms.push(term)
  }

  return {
    boostTerms: normalizeArray(boostTerms, { maxItems: 120, maxLen: 50 }),
    confusionPairs: confusionPairs
      .sort((a, b) => b.count - a.count)
      .slice(0, 40),
  }
}

function sanitizeCorrectionTerm(value) {
  const cleaned = String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return ''
  if (cleaned.length > 80) return ''
  if (cleaned.split(' ').length > 10) return ''
  return cleaned
}

function restoreFromKey(rows, field, key) {
  const list = Array.isArray(rows) ? rows : []
  for (const row of list) {
    const value = sanitizeCorrectionTerm(row?.[field])
    if (value && value.toLowerCase() === key) return value
  }
  return ''
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

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function getServiceRoleClient() {
  const supabaseUrl = process.env.SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Supabase service role is not configured on server')
  }
  return createClient(supabaseUrl, serviceRoleKey)
}

function normalizeProfileForStorage(input, userId) {
  const cleaned = normalizeProfileInput(input)
  return {
    user_id: userId,
    industry: cleaned.industry || null,
    role: cleaned.role || null,
    meeting_types: cleaned.meetingTypes,
    participant_names: cleaned.participantNames,
    organization_terms: cleaned.organizationTerms,
    custom_terms: cleaned.customTerms,
    generated_keyterms: normalizeArray(input.generatedKeyterms, { maxItems: 200, maxLen: 60 }),
    correction_terms: cleaned.correctionTerms,
    summary_context: cleanOneLine(input.summaryContext, 280) || null,
    do_not_infer: normalizeArray(input.doNotInfer, { maxItems: 24, maxLen: 120 }),
    updated_at: new Date().toISOString(),
  }
}

function isMissingColumnError(error, columnName) {
  const message = String(error?.message || '').toLowerCase()
  return message.includes(String(columnName || '').toLowerCase()) && message.includes('column')
}
