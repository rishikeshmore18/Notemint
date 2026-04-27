import express from 'express'
import multer from 'multer'
import { createClient } from '@supabase/supabase-js'
import { requireAuth } from '../middleware/auth.js'

export const voiceRouter = express.Router()

const ENROLLMENT_TARGET_SAMPLES = 5
const CONTACT_ENROLLMENT_TARGET_SAMPLES = 3
const CONTACT_MIN_IDENTIFY_SAMPLES = 2
const GENERIC_PERSON_PATTERN = /^person\s*\d+$/i

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
})

voiceRouter.post('/enroll', requireAuth, upload.single('audio'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No audio file provided' })
  }
  const supabase = getSupabaseClient()
  if (!supabase) {
    return res.status(500).json({ error: 'Supabase is not configured on server' })
  }
  if (!process.env.VOICE_SERVICE_URL) {
    return res.status(500).json({ error: 'VOICE_SERVICE_URL is not configured on server' })
  }

  try {
    const incomingEmbedding = await createEmbedding(req.file)
    const userId = req.user.id

    const { data: existingRow, error: fetchError } = await supabase
      .from('user_voice_profiles')
      .select('embedding, sample_count')
      .eq('user_id', userId)
      .maybeSingle()

    if (fetchError) {
      return res.status(500).json({ error: `Could not load voice profile: ${fetchError.message}` })
    }

    const existingCount = Number(existingRow?.sample_count || 0)
    const mergedEmbedding =
      existingRow?.embedding && Array.isArray(existingRow.embedding)
        ? mergeEmbeddings(existingRow.embedding, existingCount, incomingEmbedding)
        : normalizeVector(incomingEmbedding)

    const nextSampleCount = existingCount + 1
    const status = nextSampleCount >= ENROLLMENT_TARGET_SAMPLES ? 'Enrolled' : 'Enrolling'

    const { error: upsertError } = await supabase.from('user_voice_profiles').upsert(
      {
        user_id: userId,
        embedding: mergedEmbedding,
        sample_count: nextSampleCount,
        enrollment_status: status,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' },
    )

    if (upsertError) {
      return res.status(500).json({ error: `Could not save voice profile: ${upsertError.message}` })
    }

    return res.json(buildStatusPayload(status, nextSampleCount))
  } catch (err) {
    return res.status(500).json({ error: `Voice enrollment failed: ${err.message}` })
  }
})

voiceRouter.get('/status', requireAuth, async (req, res) => {
  const supabase = getSupabaseClient()
  if (!supabase) {
    return res.status(500).json({ error: 'Supabase is not configured on server' })
  }

  const { data, error } = await supabase
    .from('user_voice_profiles')
    .select('enrollment_status, sample_count')
    .eq('user_id', req.user.id)
    .maybeSingle()

  if (error) {
    return res.status(500).json({ error: `Could not load voice status: ${error.message}` })
  }

  const status = data?.enrollment_status || 'NotEnrolled'
  const sampleCount = Number(data?.sample_count || 0)
  return res.json(buildStatusPayload(status, sampleCount))
})

voiceRouter.post('/identify', requireAuth, upload.single('audio'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No audio file provided' })
  }
  const supabase = getSupabaseClient()
  if (!supabase) {
    return res.status(500).json({ error: 'Supabase is not configured on server' })
  }
  if (!process.env.VOICE_SERVICE_URL) {
    return res.status(500).json({ error: 'VOICE_SERVICE_URL is not configured on server' })
  }

  const { data, error } = await supabase
    .from('user_voice_profiles')
    .select('embedding, enrollment_status')
    .eq('user_id', req.user.id)
    .maybeSingle()

  if (error) {
    return res.status(500).json({ error: `Could not load voice profile: ${error.message}` })
  }

  if (!data?.embedding || !Array.isArray(data.embedding) || data.enrollment_status !== 'Enrolled') {
    return res.json({ identified_profile: null, confidence: 0, is_confident: false })
  }

  try {
    const confidence = await scoreEmbedding(req.file, data.embedding)
    const threshold = Number(process.env.VOICE_MATCH_THRESHOLD || 0.72)
    const isConfident = confidence >= threshold

    return res.json({
      identified_profile: isConfident ? 'self' : null,
      confidence,
      is_confident: isConfident,
    })
  } catch {
    return res.json({ identified_profile: null, confidence: 0, is_confident: false })
  }
})

voiceRouter.get('/contacts', requireAuth, async (req, res) => {
  const supabase = getSupabaseClient()
  if (!supabase) {
    return res.status(500).json({ error: 'Supabase is not configured on server' })
  }

  const { data, error } = await supabase
    .from('speaker_profiles')
    .select('id, display_name, sample_count, enrollment_status, updated_at')
    .eq('owner_user_id', req.user.id)
    .eq('profile_type', 'contact')
    .order('updated_at', { ascending: false })
    .limit(100)

  if (error) {
    return res.status(500).json({ error: `Could not load contacts: ${error.message}` })
  }

  return res.json({ contacts: data || [] })
})

voiceRouter.post('/remember-contact', requireAuth, upload.single('audio'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No audio file provided' })
  }

  const displayName = normalizeDisplayName(req.body?.display_name)
  if (!displayName) {
    return res.status(400).json({ error: 'display_name is required' })
  }
  if (isReservedDisplayName(displayName)) {
    return res.status(400).json({ error: 'display_name cannot be "You" or a generic person label' })
  }

  const supabase = getSupabaseClient()
  if (!supabase) {
    return res.status(500).json({ error: 'Supabase is not configured on server' })
  }
  if (!process.env.VOICE_SERVICE_URL) {
    return res.status(500).json({ error: 'VOICE_SERVICE_URL is not configured on server' })
  }

  try {
    const incomingEmbedding = await createEmbedding(req.file)

    const { data: existingRows, error: fetchError } = await supabase
      .from('speaker_profiles')
      .select('id, display_name, embedding, sample_count')
      .eq('owner_user_id', req.user.id)
      .eq('profile_type', 'contact')

    if (fetchError) {
      return res.status(500).json({ error: `Could not load contact profiles: ${fetchError.message}` })
    }

    const existing = (existingRows || []).find(
      (row) => normalizeDisplayName(row.display_name).toLowerCase() === displayName.toLowerCase(),
    )

    const existingCount = Number(existing?.sample_count || 0)
    const existingEmbedding = Array.isArray(existing?.embedding) ? existing.embedding : null
    const mergedEmbedding = existingEmbedding
      ? mergeEmbeddings(existingEmbedding, existingCount, incomingEmbedding)
      : normalizeVector(incomingEmbedding)

    const nextSampleCount = existingCount + 1
    const status = nextSampleCount >= CONTACT_ENROLLMENT_TARGET_SAMPLES ? 'Enrolled' : 'Enrolling'
    const nowIso = new Date().toISOString()

    if (existing?.id) {
      const { error: updateError } = await supabase
        .from('speaker_profiles')
        .update({
          display_name: displayName,
          embedding: mergedEmbedding,
          sample_count: nextSampleCount,
          enrollment_status: status,
          updated_at: nowIso,
        })
        .eq('id', existing.id)

      if (updateError) {
        return res.status(500).json({ error: `Could not update contact profile: ${updateError.message}` })
      }

      return res.json(buildContactStatusPayload(existing.id, displayName, status, nextSampleCount))
    }

    const { data: inserted, error: insertError } = await supabase
      .from('speaker_profiles')
      .insert({
        owner_user_id: req.user.id,
        display_name: displayName,
        profile_type: 'contact',
        embedding: mergedEmbedding,
        sample_count: nextSampleCount,
        enrollment_status: status,
        updated_at: nowIso,
      })
      .select('id')
      .single()

    if (insertError) {
      return res.status(500).json({ error: `Could not create contact profile: ${insertError.message}` })
    }

    return res.json(buildContactStatusPayload(inserted?.id, displayName, status, nextSampleCount))
  } catch (err) {
    return res.status(500).json({ error: `Contact memory failed: ${err.message}` })
  }
})

voiceRouter.post('/identify-contact', requireAuth, upload.single('audio'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No audio file provided' })
  }

  const supabase = getSupabaseClient()
  if (!supabase) {
    return res.status(500).json({ error: 'Supabase is not configured on server' })
  }
  if (!process.env.VOICE_SERVICE_URL) {
    return res.status(500).json({ error: 'VOICE_SERVICE_URL is not configured on server' })
  }

  const { data, error } = await supabase
    .from('speaker_profiles')
    .select('id, display_name, embedding, sample_count, enrollment_status')
    .eq('owner_user_id', req.user.id)
    .eq('profile_type', 'contact')

  if (error) {
    return res.status(500).json({ error: `Could not load contact profiles: ${error.message}` })
  }

  const candidates = (data || []).filter(
    (row) =>
      Array.isArray(row?.embedding) &&
      row.embedding.length > 0 &&
      Number(row?.sample_count || 0) >= CONTACT_MIN_IDENTIFY_SAMPLES &&
      String(row?.enrollment_status || '') !== 'NotEnrolled',
  )

  if (candidates.length === 0) {
    return res.json(buildContactNoMatchPayload())
  }

  try {
    let best = null

    for (const candidate of candidates) {
      const score = await scoreEmbedding(req.file, candidate.embedding)
      if (!Number.isFinite(score)) continue

      if (!best || score > best.score) {
        best = {
          id: candidate.id,
          displayName: candidate.display_name,
          score,
        }
      }
    }

    if (!best) {
      return res.json(buildContactNoMatchPayload())
    }

    const threshold = Number(process.env.VOICE_CONTACT_MATCH_THRESHOLD || process.env.VOICE_MATCH_THRESHOLD || 0.74)
    const isConfident = best.score >= threshold

    return res.json({
      identified_profile: isConfident ? best.id : null,
      display_name: isConfident ? best.displayName : null,
      confidence: best.score,
      is_confident: isConfident,
    })
  } catch {
    return res.json(buildContactNoMatchPayload())
  }
})

async function createEmbedding(file) {
  const formData = new FormData()
  const audioBlob = new Blob([file.buffer], { type: file.mimetype || 'audio/wav' })
  formData.append('audio', audioBlob, file.originalname || 'enroll.wav')

  const response = await fetch(`${process.env.VOICE_SERVICE_URL}/embed`, {
    method: 'POST',
    body: formData,
  })

  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(payload?.error || payload?.detail || 'Voice service embed request failed')
  }
  if (!Array.isArray(payload?.embedding)) {
    throw new Error('Voice service returned invalid embedding payload')
  }

  return normalizeVector(payload.embedding)
}

function buildStatusPayload(status, sampleCount) {
  return {
    enrolled: status === 'Enrolled',
    status,
    sample_count: sampleCount,
    remaining_clips_needed: Math.max(0, ENROLLMENT_TARGET_SAMPLES - sampleCount),
  }
}

function buildContactStatusPayload(profileId, displayName, status, sampleCount) {
  return {
    profile_id: profileId || null,
    display_name: displayName,
    enrolled: status === 'Enrolled',
    status,
    sample_count: sampleCount,
    remaining_clips_needed: Math.max(0, CONTACT_ENROLLMENT_TARGET_SAMPLES - sampleCount),
  }
}

function buildContactNoMatchPayload() {
  return {
    identified_profile: null,
    display_name: null,
    confidence: 0,
    is_confident: false,
  }
}

function getSupabaseClient() {
  const supabaseUrl = process.env.SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceRoleKey) return null
  return createClient(supabaseUrl, serviceRoleKey)
}

function normalizeVector(vec) {
  const nums = vec.map((v) => Number(v) || 0)
  const magnitude = Math.sqrt(nums.reduce((acc, value) => acc + value * value, 0))
  if (!magnitude) return nums
  return nums.map((value) => value / magnitude)
}

function mergeEmbeddings(existing, count, incoming) {
  const safeCount = Number.isFinite(count) && count > 0 ? count : 0
  const len = Math.max(existing.length, incoming.length)
  const merged = Array.from({ length: len }, (_, i) => {
    const oldVal = Number(existing[i] || 0)
    const newVal = Number(incoming[i] || 0)
    return safeCount === 0 ? newVal : (oldVal * safeCount + newVal) / (safeCount + 1)
  })
  return normalizeVector(merged)
}

function normalizeDisplayName(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
}

function isReservedDisplayName(displayName) {
  if (!displayName) return true
  if (displayName.toLowerCase() === 'you') return true
  if (GENERIC_PERSON_PATTERN.test(displayName)) return true
  return false
}

async function scoreEmbedding(file, referenceEmbedding) {
  const formData = new FormData()
  const fileBlob = new Blob([file.buffer], { type: file.mimetype || 'audio/wav' })
  formData.append('audio', fileBlob, file.originalname || 'snippet.wav')
  formData.append('reference_embedding_json', JSON.stringify(referenceEmbedding))

  const scoreResponse = await fetch(`${process.env.VOICE_SERVICE_URL}/score`, {
    method: 'POST',
    body: formData,
  })

  const payload = await scoreResponse.json().catch(() => ({}))
  if (!scoreResponse.ok) {
    throw new Error(payload?.error || payload?.detail || 'Voice service score failed')
  }

  return Number(payload?.score || 0)
}
