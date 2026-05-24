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
  const { data, error } = await supabase
    .from('user_context_profiles')
    .select(
      'industry, role, meeting_types, participant_names, organization_terms, custom_terms, correction_terms, summary_context',
    )
    .eq('user_id', userId)
    .maybeSingle()

  if (error) {
    throw new Error(error.message || 'Could not load context profile')
  }

  return data || null
}

export async function upsertContextProfile(supabase, userId, profile) {
  if (!userId) throw new Error('Missing user id')

  const payload = {
    user_id: userId,
    industry: emptyToNull(profile.industry),
    role: emptyToNull(profile.role),
    meeting_types: normalizeList(profile.meetingTypes),
    participant_names: normalizeList(profile.participantNames),
    organization_terms: normalizeList(profile.organizationTerms),
    custom_terms: normalizeList(profile.customTerms),
    correction_terms: normalizeList(profile.correctionTerms),
    updated_at: new Date().toISOString(),
  }

  const { data, error } = await supabase
    .from('user_context_profiles')
    .upsert(payload, { onConflict: 'user_id' })
    .select('id')
    .single()

  if (error) {
    throw new Error(error.message || 'Could not save context profile')
  }

  setContextOnboardingCompleted(userId)
  return data
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

function normalizeList(values) {
  const list = Array.isArray(values) ? values : []
  const deduped = []
  const seen = new Set()

  for (const raw of list) {
    const value = String(raw || '').replace(/\s+/g, ' ').trim()
    if (!value) continue
    if (value.length > 60) continue
    if (value.split(' ').length > 8) continue
    const key = value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(value)
    if (deduped.length >= 200) break
  }

  return deduped
}

function emptyToNull(value) {
  const cleaned = String(value || '').trim()
  return cleaned || null
}
