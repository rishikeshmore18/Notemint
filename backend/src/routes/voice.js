import express from 'express'
import multer from 'multer'
import { createClient } from '@supabase/supabase-js'
import { requireAuth } from '../middleware/auth.js'

export const voiceRouter = express.Router()

const ENROLLMENT_TARGET_SAMPLES = 5

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
    const formData = new FormData()
    const fileBlob = new Blob([req.file.buffer], { type: req.file.mimetype || 'audio/wav' })
    formData.append('audio', fileBlob, 'snippet.wav')
    formData.append('reference_embedding_json', JSON.stringify(data.embedding))

    const scoreResponse = await fetch(`${process.env.VOICE_SERVICE_URL}/score`, {
      method: 'POST',
      body: formData,
    })

    const payload = await scoreResponse.json().catch(() => ({}))
    if (!scoreResponse.ok) {
      return res.json({ identified_profile: null, confidence: 0, is_confident: false })
    }

    const confidence = Number(payload?.score || 0)
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
