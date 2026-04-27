import { supabase } from './supabase'

const RESERVED_LABELS = new Set(['you'])

function normalizeName(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
}

function isReservedLabel(value) {
  const normalized = normalizeName(value).toLowerCase()
  if (!normalized) return true
  if (RESERVED_LABELS.has(normalized)) return true
  if (/^person\s*\d+$/i.test(normalized)) return true
  return false
}

function collectUniqueNamesFromLabelMap(labelMap) {
  const seen = new Set()
  const names = []

  for (const raw of Object.values(labelMap || {})) {
    const cleaned = normalizeName(raw)
    const key = cleaned.toLowerCase()
    if (!cleaned || isReservedLabel(cleaned) || seen.has(key)) continue
    seen.add(key)
    names.push(cleaned)
  }

  return names
}

export async function getSpeakerNameSuggestions(userId, limit = 8) {
  if (!userId) return []

  const { data, error } = await supabase
    .from('speaker_profiles')
    .select('display_name, updated_at')
    .eq('owner_user_id', userId)
    .eq('profile_type', 'contact')
    .order('updated_at', { ascending: false })
    .limit(limit * 3)

  if (error) {
    throw new Error(error.message || 'Could not load saved speaker names')
  }

  const seen = new Set()
  const suggestions = []

  for (const row of data || []) {
    const cleaned = normalizeName(row?.display_name)
    const key = cleaned.toLowerCase()
    if (!cleaned || seen.has(key)) continue
    seen.add(key)
    suggestions.push(cleaned)
    if (suggestions.length >= limit) break
  }

  return suggestions
}

export async function rememberSpeakerLabels(userId, labelMap) {
  if (!userId) return

  const namesToRemember = collectUniqueNamesFromLabelMap(labelMap)
  if (namesToRemember.length === 0) return

  const { data: existingRows, error: existingError } = await supabase
    .from('speaker_profiles')
    .select('id, display_name')
    .eq('owner_user_id', userId)
    .eq('profile_type', 'contact')

  if (existingError) {
    throw new Error(existingError.message || 'Could not read speaker profiles')
  }

  const existingByName = new Map()
  for (const row of existingRows || []) {
    const cleaned = normalizeName(row?.display_name).toLowerCase()
    if (!cleaned) continue
    existingByName.set(cleaned, row)
  }

  const nowIso = new Date().toISOString()
  const inserts = []
  const updates = []

  for (const name of namesToRemember) {
    const key = name.toLowerCase()
    const existing = existingByName.get(key)

    if (existing?.id) {
      updates.push({ id: existing.id, display_name: name })
      continue
    }

    inserts.push({
      owner_user_id: userId,
      display_name: name,
      profile_type: 'contact',
      enrollment_status: 'NotEnrolled',
      sample_count: 0,
      updated_at: nowIso,
    })
  }

  if (inserts.length > 0) {
    const { error } = await supabase.from('speaker_profiles').insert(inserts)
    if (error) throw new Error(error.message || 'Could not save new speaker names')
  }

  if (updates.length > 0) {
    await Promise.all(
      updates.map(async (item) => {
        const { error } = await supabase
          .from('speaker_profiles')
          .update({
            display_name: item.display_name,
            updated_at: nowIso,
          })
          .eq('id', item.id)
        if (error) {
          throw new Error(error.message || 'Could not update saved speaker name')
        }
      }),
    )
  }
}
