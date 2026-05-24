const CONTEXT_ONBOARDING_KEY_PREFIX = 'context_onboarding_done_'

export const INDUSTRY_OPTIONS = [
  'banking',
  'school',
  'sales',
  'healthcare',
  'legal',
  'internal ops',
  'software',
  'other',
]

export const ROLE_OPTIONS = [
  'manager',
  'teacher',
  'founder',
  'sales rep',
  'advisor',
  'clinician',
  'student support',
  'other',
]

export const MEETING_TYPE_OPTIONS = [
  'staff sync',
  'client meeting',
  'parent meeting',
  'operations review',
  'sales call',
  '1:1',
  'planning',
]

export async function hasContextProfile(supabase, userId) {
  if (!userId) return false

  const locallyCompleted = getContextOnboardingCompleted(userId)

  try {
    const { data, error } = await supabase
      .from('user_context_profiles')
      .select('id')
      .eq('user_id', userId)
      .maybeSingle()

    if (error) {
      console.warn('[ContextProfile] Could not read context profile:', error.message)
      return locallyCompleted
    }

    if (data?.id) {
      setContextOnboardingCompleted(userId)
      return true
    }
    return locallyCompleted
  } catch (err) {
    console.warn('[ContextProfile] Context profile check failed:', err?.message || err)
    return locallyCompleted
  }
}

export async function getContextProfile(supabase, userId) {
  if (!userId) return null
  const baseSelect =
    'industry, role, meeting_types, participant_names, organization_terms, custom_terms, generated_keyterms, correction_terms, summary_context'

  const { data, error } = await supabase
    .from('user_context_profiles')
    .select(`${baseSelect}, do_not_infer`)
    .eq('user_id', userId)
    .maybeSingle()

  if (!error) {
    return data || null
  }

  if (!isMissingColumnError(error, 'do_not_infer')) {
    throw new Error(error.message || 'Could not load context profile')
  }

  const fallback = await supabase
    .from('user_context_profiles')
    .select(baseSelect)
    .eq('user_id', userId)
    .maybeSingle()

  if (fallback.error) {
    throw new Error(fallback.error.message || 'Could not load context profile')
  }

  return fallback.data ? { ...fallback.data, do_not_infer: [] } : null
}

export async function upsertContextProfile(supabase, userId, profile) {
  if (!userId) throw new Error('Missing user id')

  const userTerms = normalizeList([
    ...normalizeList(profile.organizationTerms),
    ...normalizeList(profile.customTerms),
    ...normalizeList(profile.participantNames),
    ...normalizeList(profile.correctionTerms),
  ])

  const generatedTerms = normalizeList(profile.generatedKeyterms)
  const mergedGeneratedTerms = normalizeList([...generatedTerms, ...userTerms]).slice(0, 200)

  const payload = {
    user_id: userId,
    industry: emptyToNull(profile.industry),
    role: emptyToNull(profile.role),
    meeting_types: normalizeList(profile.meetingTypes),
    participant_names: normalizeList(profile.participantNames),
    organization_terms: normalizeList(profile.organizationTerms),
    custom_terms: normalizeList(profile.customTerms),
    generated_keyterms: mergedGeneratedTerms,
    correction_terms: normalizeList(profile.correctionTerms),
    summary_context: emptyToNull(profile.summaryContext),
    do_not_infer: normalizeList(profile.doNotInfer, { maxWords: 16, maxLength: 120, maxItems: 24 }),
    updated_at: new Date().toISOString(),
  }

  const { data, error } = await supabase
    .from('user_context_profiles')
    .upsert(payload, { onConflict: 'user_id' })
    .select('id')
    .single()

  if (!error) {
    setContextOnboardingCompleted(userId)
    return data
  }

  if (!isMissingColumnError(error, 'do_not_infer')) {
    throw new Error(error.message || 'Could not save context profile')
  }

  // Backward compatibility while the new migration is being applied.
  const { do_not_infer: _omit, ...legacyPayload } = payload

  const { data: fallbackData, error: fallbackError } = await supabase
    .from('user_context_profiles')
    .upsert(legacyPayload, { onConflict: 'user_id' })
    .select('id')
    .single()

  if (fallbackError) {
    throw new Error(fallbackError.message || 'Could not save context profile')
  }

  setContextOnboardingCompleted(userId)
  return fallbackData
}

export async function getCorrectionMemory(supabase, userId, options = {}) {
  if (!userId) {
    return {
      boostTerms: [],
      confusionPairs: [],
    }
  }

  const limit = Number.isFinite(options.limit) ? Math.max(20, Math.min(500, options.limit)) : 200
  const { data, error } = await supabase
    .from('transcript_corrections')
    .select('original_text, corrected_text, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) {
    throw new Error(error.message || 'Could not load correction memory')
  }

  return buildCorrectionMemory(data)
}

export function parseTerms(value) {
  return normalizeList(
    String(value || '')
      .split(/[\n,]/g)
      .map((part) => part.trim()),
  )
}

export function getContextOnboardingCompleted(userId) {
  if (!userId || typeof window === 'undefined') return false
  return localStorage.getItem(CONTEXT_ONBOARDING_KEY_PREFIX + userId) === 'true'
}

export function setContextOnboardingCompleted(userId) {
  if (!userId || typeof window === 'undefined') return
  localStorage.setItem(CONTEXT_ONBOARDING_KEY_PREFIX + userId, 'true')
}

function normalizeList(values, options = {}) {
  const maxWords = Number.isFinite(options.maxWords) ? options.maxWords : 8
  const maxLength = Number.isFinite(options.maxLength) ? options.maxLength : 60
  const maxItems = Number.isFinite(options.maxItems) ? options.maxItems : 200
  const list = Array.isArray(values) ? values : []
  const deduped = []
  const seen = new Set()

  for (const raw of list) {
    const value = String(raw || '').replace(/\s+/g, ' ').trim()
    if (!value) continue
    if (value.length > maxLength) continue
    if (value.split(' ').length > maxWords) continue
    const key = value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(value)
    if (deduped.length >= maxItems) break
  }

  return deduped
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
      bestPerOriginal.set(originalKey, { original, corrected, count, confidence, totalForOriginal })
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
    boostTerms: normalizeList(boostTerms, { maxWords: 8, maxLength: 60, maxItems: 120 }),
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

function emptyToNull(value) {
  const cleaned = String(value || '').trim()
  return cleaned || null
}

function isMissingColumnError(error, columnName) {
  const message = String(error?.message || '').toLowerCase()
  return message.includes(columnName.toLowerCase()) && message.includes('column')
}
