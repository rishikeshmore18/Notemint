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

function emptyToNull(value) {
  const cleaned = String(value || '').trim()
  return cleaned || null
}

function isMissingColumnError(error, columnName) {
  const message = String(error?.message || '').toLowerCase()
  return message.includes(columnName.toLowerCase()) && message.includes('column')
}
