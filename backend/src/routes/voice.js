import express from 'express'
import multer from 'multer'
import { createClient } from '@supabase/supabase-js'
import { requireAuth } from '../middleware/auth.js'

export const voiceRouter = express.Router()

const ENROLLMENT_TARGET_SAMPLES = 5
const CONTACT_ENROLLMENT_TARGET_SAMPLES = 3
const CONTACT_MIN_IDENTIFY_SAMPLES = 2
const GENERIC_PERSON_PATTERN = /^person\s*\d+$/i
const MIN_ENROLLMENT_DURATION_SEC = 2.2
const MIN_ENROLLMENT_RMS = 0.008
const MIN_ENROLLMENT_ACTIVE_RATIO = 0.2
const MAX_ENROLLMENT_CLIPPED_RATIO = 0.05
const MIN_PHRASE_TOKEN_RECALL = 0.72
const MIN_PHRASE_TEXT_SIMILARITY = 0.55

const ENROLLMENT_PHRASES = [
  'Today I am recording my voice so Notemint can recognize me clearly',
  'The meeting notes should label my speech accurately during future conversations',
  'I will speak naturally in a quiet room with steady volume',
  'This voice profile helps separate my words from other people in meetings',
  'Please use this sample to identify me when I speak again later',
]

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
    const statusPayload = await enrollUserVoiceSample(supabase, req.user.id, req.file)
    return res.json(statusPayload)
  } catch (err) {
    return res.status(500).json({ error: `Voice enrollment failed: ${err.message}` })
  }
})

voiceRouter.post('/enroll-phrase', requireAuth, upload.single('audio'), async (req, res) => {
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
  if (!process.env.XAI_KEY) {
    return res.status(500).json({ error: 'XAI_KEY is not configured on server' })
  }

  const phraseIndex = Number(req.body?.phrase_index)
  const expectedPhrase = normalizeExpectedPhrase(req.body?.expected_phrase)
  const serverPhrase = ENROLLMENT_PHRASES[phraseIndex]

  if (!Number.isInteger(phraseIndex) || phraseIndex < 0 || phraseIndex >= ENROLLMENT_PHRASES.length) {
    return res.status(400).json({ error: 'Invalid phrase_index' })
  }
  if (expectedPhrase !== normalizeExpectedPhrase(serverPhrase)) {
    return res.status(400).json({ error: 'Enrollment phrase mismatch' })
  }

  const quality = analyzePcmWavQuality(req.file.buffer)
  if (!quality.accepted) {
    return res.json({
      accepted: false,
      reason: quality.reason,
      message: quality.message,
      transcript: '',
      phrase_score: 0,
      audio_quality: quality.metrics,
    })
  }

  try {
    const transcript = await transcribeEnrollmentClip(req.file)
    const phraseMatch = scorePhraseMatch(transcript, serverPhrase)

    if (!phraseMatch.accepted) {
      return res.json({
        accepted: false,
        reason: 'incomplete_phrase',
        message: 'say the full phrase',
        transcript,
        phrase_score: phraseMatch.score,
        audio_quality: quality.metrics,
      })
    }

    const statusPayload = await enrollUserVoiceSample(supabase, req.user.id, req.file)
    return res.json({
      accepted: true,
      reason: 'accepted',
      message: 'phrase accepted',
      transcript,
      phrase_score: phraseMatch.score,
      audio_quality: quality.metrics,
      ...statusPayload,
    })
  } catch (err) {
    return res.status(500).json({ error: `Phrase enrollment failed: ${err.message}` })
  }
})

voiceRouter.post('/validate-phrase', requireAuth, upload.single('audio'), async (req, res) => {
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
  if (!process.env.XAI_KEY) {
    return res.status(500).json({ error: 'XAI_KEY is not configured on server' })
  }

  try {
    const result = await validateAndStoreEnrollmentSample(supabase, req.user.id, req.file, req.body)
    return res.json(result)
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message || 'Phrase validation failed' })
  }
})

voiceRouter.post('/finalize-enrollment', requireAuth, async (req, res) => {
  const supabase = getSupabaseClient()
  if (!supabase) {
    return res.status(500).json({ error: 'Supabase is not configured on server' })
  }

  const enrollmentRunId = normalizeEnrollmentRunId(req.body?.enrollment_run_id)
  if (!enrollmentRunId) {
    return res.status(400).json({ error: 'enrollment_run_id is required' })
  }

  try {
    const { data, error } = await supabase
      .from('voice_enrollment_samples')
      .select('phrase_index, embedding')
      .eq('user_id', req.user.id)
      .eq('enrollment_run_id', enrollmentRunId)
      .eq('accepted', true)
      .order('phrase_index', { ascending: true })

    if (error) {
      return res.status(500).json({ error: `Could not load enrollment samples: ${error.message}` })
    }

    const acceptedSamples = dedupeAcceptedSamples(data || [])
    if (acceptedSamples.length < ENROLLMENT_TARGET_SAMPLES) {
      return res.status(400).json({
        error: 'Not enough accepted enrollment phrases',
        accepted_count: acceptedSamples.length,
        remaining_clips_needed: Math.max(0, ENROLLMENT_TARGET_SAMPLES - acceptedSamples.length),
      })
    }

    const mergedEmbedding = averageEmbeddings(acceptedSamples.map((sample) => sample.embedding))
    const status = 'Enrolled'
    const sampleCount = acceptedSamples.length

    const { error: upsertError } = await supabase.from('user_voice_profiles').upsert(
      {
        user_id: req.user.id,
        embedding: mergedEmbedding,
        sample_count: sampleCount,
        enrollment_status: status,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' },
    )

    if (upsertError) {
      return res.status(500).json({ error: `Could not save voice profile: ${upsertError.message}` })
    }

    await supabase
      .from('voice_enrollment_samples')
      .delete()
      .eq('user_id', req.user.id)
      .eq('enrollment_run_id', enrollmentRunId)

    return res.json({
      finalized: true,
      ...buildStatusPayload(status, sampleCount),
    })
  } catch (err) {
    return res.status(500).json({ error: `Finalize enrollment failed: ${err.message}` })
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

voiceRouter.post('/reset', requireAuth, async (req, res) => {
  const supabase = getSupabaseClient()
  if (!supabase) {
    return res.status(500).json({ error: 'Could not reset voice profile' })
  }

  try {
    const userId = req.user.id
    const { error } = await supabase.from('user_voice_profiles').delete().eq('user_id', userId)
    if (error) {
      return res.status(500).json({ error: 'Could not reset voice profile' })
    }
    await supabase.from('voice_enrollment_samples').delete().eq('user_id', userId)

    console.log('[Voice reset] user:', userId)
    return res.json({ ok: true, reset: true })
  } catch {
    return res.status(500).json({ error: 'Could not reset voice profile' })
  }
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

async function enrollUserVoiceSample(supabase, userId, file) {
  const incomingEmbedding = await createEmbedding(file)

  const { data: existingRow, error: fetchError } = await supabase
    .from('user_voice_profiles')
    .select('embedding, sample_count')
    .eq('user_id', userId)
    .maybeSingle()

  if (fetchError) {
    throw new Error(`Could not load voice profile: ${fetchError.message}`)
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
    throw new Error(`Could not save voice profile: ${upsertError.message}`)
  }

  return buildStatusPayload(status, nextSampleCount)
}

async function validateAndStoreEnrollmentSample(supabase, userId, file, body = {}) {
  const enrollmentRunId = normalizeEnrollmentRunId(body?.enrollment_run_id)
  if (!enrollmentRunId) {
    throw makeHttpError(400, 'enrollment_run_id is required')
  }

  const phraseIndex = Number(body?.phrase_index)
  const expectedPhrase = normalizeExpectedPhrase(body?.expected_phrase)
  const serverPhrase = ENROLLMENT_PHRASES[phraseIndex]

  if (!Number.isInteger(phraseIndex) || phraseIndex < 0 || phraseIndex >= ENROLLMENT_PHRASES.length) {
    throw makeHttpError(400, 'Invalid phrase_index')
  }
  if (expectedPhrase !== normalizeExpectedPhrase(serverPhrase)) {
    throw makeHttpError(400, 'Enrollment phrase mismatch')
  }

  const quality = analyzePcmWavQuality(file.buffer)
  if (!quality.accepted) {
    await saveEnrollmentSampleValidation(supabase, {
      userId,
      enrollmentRunId,
      phraseIndex,
      expectedPhrase: serverPhrase,
      transcript: '',
      phraseScore: 0,
      audioQuality: quality.metrics,
      embedding: null,
      accepted: false,
      rejectionReason: quality.reason,
    })

    return {
      accepted: false,
      reason: quality.reason,
      message: quality.message,
      phrase_index: phraseIndex,
      transcript: '',
      phrase_score: 0,
      audio_quality: quality.metrics,
      ...(await buildPendingEnrollmentStatus(supabase, userId, enrollmentRunId)),
    }
  }

  const transcript = await transcribeEnrollmentClip(file)
  const phraseMatch = scorePhraseMatch(transcript, serverPhrase)

  if (!phraseMatch.accepted) {
    await saveEnrollmentSampleValidation(supabase, {
      userId,
      enrollmentRunId,
      phraseIndex,
      expectedPhrase: serverPhrase,
      transcript,
      phraseScore: phraseMatch.score,
      audioQuality: quality.metrics,
      embedding: null,
      accepted: false,
      rejectionReason: 'incomplete_phrase',
    })

    return {
      accepted: false,
      reason: 'incomplete_phrase',
      message: 'say the full phrase',
      phrase_index: phraseIndex,
      transcript,
      phrase_score: phraseMatch.score,
      audio_quality: quality.metrics,
      ...(await buildPendingEnrollmentStatus(supabase, userId, enrollmentRunId)),
    }
  }

  const embedding = await createEmbedding(file)
  await saveEnrollmentSampleValidation(supabase, {
    userId,
    enrollmentRunId,
    phraseIndex,
    expectedPhrase: serverPhrase,
    transcript,
    phraseScore: phraseMatch.score,
    audioQuality: quality.metrics,
    embedding,
    accepted: true,
    rejectionReason: null,
  })

  return {
    accepted: true,
    reason: 'accepted',
    message: 'phrase accepted',
    phrase_index: phraseIndex,
    transcript,
    phrase_score: phraseMatch.score,
    audio_quality: quality.metrics,
    ...(await buildPendingEnrollmentStatus(supabase, userId, enrollmentRunId)),
  }
}

async function saveEnrollmentSampleValidation(
  supabase,
  { userId, enrollmentRunId, phraseIndex, expectedPhrase, transcript, phraseScore, audioQuality, embedding, accepted, rejectionReason },
) {
  const { error } = await supabase.from('voice_enrollment_samples').upsert(
    {
      user_id: userId,
      enrollment_run_id: enrollmentRunId,
      phrase_index: phraseIndex,
      expected_phrase: expectedPhrase,
      transcript,
      phrase_score: phraseScore,
      audio_quality: audioQuality,
      embedding,
      accepted,
      rejection_reason: rejectionReason,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,enrollment_run_id,phrase_index' },
  )

  if (error) {
    throw makeHttpError(500, `Could not save enrollment sample: ${error.message}`)
  }
}

async function buildPendingEnrollmentStatus(supabase, userId, enrollmentRunId) {
  const { data, error } = await supabase
    .from('voice_enrollment_samples')
    .select('phrase_index')
    .eq('user_id', userId)
    .eq('enrollment_run_id', enrollmentRunId)
    .eq('accepted', true)

  if (error) {
    throw makeHttpError(500, `Could not load enrollment progress: ${error.message}`)
  }

  const acceptedCount = new Set((data || []).map((row) => Number(row.phrase_index))).size
  return {
    finalized: false,
    enrolled: false,
    status: acceptedCount >= ENROLLMENT_TARGET_SAMPLES ? 'ReadyToFinalize' : 'Enrolling',
    sample_count: acceptedCount,
    remaining_clips_needed: Math.max(0, ENROLLMENT_TARGET_SAMPLES - acceptedCount),
  }
}

async function transcribeEnrollmentClip(file) {
  const formData = new FormData()
  const fileBlob = new Blob([file.buffer], { type: file.mimetype || 'audio/wav' })
  formData.append('file', fileBlob, file.originalname || 'enrollment.wav')
  formData.append('model', 'grok-stt')
  formData.append('language', 'en')
  formData.append('diarize', 'false')
  formData.append('timestamps', 'false')

  const response = await fetch('https://api.x.ai/v1/stt', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.XAI_KEY}`,
    },
    body: formData,
  })

  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(payload?.error || payload?.message || 'Enrollment transcript failed')
  }

  return String(payload?.text || payload?.transcript || payload?.segments?.map((s) => s?.text || '').join(' ') || '')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeExpectedPhrase(value) {
  return normalizePhraseText(value)
}

function normalizeEnrollmentRunId(value) {
  const normalized = String(value || '').trim()
  if (!normalized || normalized.length > 120) return ''
  return normalized.replace(/[^a-zA-Z0-9_-]/g, '')
}

function scorePhraseMatch(transcript, expectedPhrase) {
  const normalizedTranscript = normalizePhraseText(transcript)
  const normalizedExpected = normalizePhraseText(expectedPhrase)
  const transcriptWords = normalizePhraseWords(transcript)
  const expectedWords = normalizePhraseWords(expectedPhrase)

  if (!normalizedTranscript || transcriptWords.length < 4 || expectedWords.length === 0) {
    return {
      accepted: false,
      score: 0,
      token_recall: 0,
      text_similarity: 0,
    }
  }

  const transcriptWordSet = new Set(transcriptWords)
  const matchedTokens = expectedWords.filter((word) => transcriptWordSet.has(word)).length
  const tokenRecall = matchedTokens / expectedWords.length
  const maxLen = Math.max(normalizedTranscript.length, normalizedExpected.length, 1)
  const textSimilarity = 1 - editDistance(normalizedTranscript, normalizedExpected) / maxLen
  const score = (tokenRecall * 0.7 + textSimilarity * 0.3)

  return {
    accepted: tokenRecall >= MIN_PHRASE_TOKEN_RECALL && textSimilarity >= MIN_PHRASE_TEXT_SIMILARITY,
    score: Number(score.toFixed(3)),
    token_recall: Number(tokenRecall.toFixed(3)),
    text_similarity: Number(textSimilarity.toFixed(3)),
  }
}

function normalizePhraseText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizePhraseWords(value) {
  return normalizePhraseText(value).split(' ').filter(Boolean)
}

function editDistance(a, b) {
  const rows = a.length + 1
  const cols = b.length + 1
  const previous = Array.from({ length: cols }, (_, index) => index)
  const current = Array(cols).fill(0)

  for (let i = 1; i < rows; i += 1) {
    current[0] = i

    for (let j = 1; j < cols; j += 1) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + substitutionCost,
      )
    }

    for (let j = 0; j < cols; j += 1) {
      previous[j] = current[j]
    }
  }

  return previous[cols - 1]
}

function analyzePcmWavQuality(buffer) {
  const fallbackAccepted = {
    accepted: true,
    reason: 'unverified_format',
    message: 'audio accepted',
    metrics: {
      duration_sec: null,
      active_duration_sec: null,
      rms: null,
      active_ratio: null,
      clipped_ratio: null,
    },
  }

  const parsed = parsePcm16Wav(buffer)
  if (!parsed) return fallbackAccepted

  const { samples, sampleRate } = parsed
  const durationSec = samples.length / sampleRate
  if (durationSec < MIN_ENROLLMENT_DURATION_SEC) {
    return rejectAudio('too_short', 'say the full phrase', durationSec, 0, 0, 0, 0)
  }

  let sumSquares = 0
  let clipped = 0
  for (const sample of samples) {
    sumSquares += sample * sample
    if (Math.abs(sample) > 0.98) clipped += 1
  }

  const rms = Math.sqrt(sumSquares / samples.length)
  const clippedRatio = clipped / samples.length
  const frameSize = Math.max(1, Math.floor(sampleRate * 0.03))
  let activeFrames = 0
  let totalFrames = 0

  for (let start = 0; start < samples.length; start += frameSize) {
    const end = Math.min(samples.length, start + frameSize)
    let frameSquares = 0
    for (let i = start; i < end; i += 1) {
      frameSquares += samples[i] * samples[i]
    }
    const frameRms = Math.sqrt(frameSquares / (end - start))
    if (frameRms >= MIN_ENROLLMENT_RMS) activeFrames += 1
    totalFrames += 1
  }

  const activeRatio = totalFrames > 0 ? activeFrames / totalFrames : 0
  const activeDurationSec = (activeFrames * frameSize) / sampleRate
  if (activeDurationSec < MIN_ENROLLMENT_DURATION_SEC) {
    return rejectAudio(
      'too_short',
      'say the full phrase',
      durationSec,
      rms,
      activeRatio,
      clippedRatio,
      activeDurationSec,
    )
  }
  if (rms < MIN_ENROLLMENT_RMS || activeRatio < MIN_ENROLLMENT_ACTIVE_RATIO) {
    return rejectAudio('too_quiet', 'too quiet, try again', durationSec, rms, activeRatio, clippedRatio, activeDurationSec)
  }
  if (clippedRatio > MAX_ENROLLMENT_CLIPPED_RATIO) {
    return rejectAudio('clipped', 'too loud, try again', durationSec, rms, activeRatio, clippedRatio, activeDurationSec)
  }

  return {
    accepted: true,
    reason: 'accepted',
    message: 'audio accepted',
    metrics: buildAudioMetrics(durationSec, rms, activeRatio, clippedRatio, activeDurationSec),
  }
}

function rejectAudio(reason, message, durationSec, rms, activeRatio, clippedRatio, activeDurationSec = null) {
  return {
    accepted: false,
    reason,
    message,
    metrics: buildAudioMetrics(durationSec, rms, activeRatio, clippedRatio, activeDurationSec),
  }
}

function buildAudioMetrics(durationSec, rms, activeRatio, clippedRatio, activeDurationSec = null) {
  return {
    duration_sec: Number.isFinite(durationSec) ? Number(durationSec.toFixed(3)) : null,
    active_duration_sec: Number.isFinite(activeDurationSec) ? Number(activeDurationSec.toFixed(3)) : null,
    rms: Number.isFinite(rms) ? Number(rms.toFixed(5)) : null,
    active_ratio: Number.isFinite(activeRatio) ? Number(activeRatio.toFixed(3)) : null,
    clipped_ratio: Number.isFinite(clippedRatio) ? Number(clippedRatio.toFixed(5)) : null,
  }
}

function parsePcm16Wav(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) return null
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') return null

  let offset = 12
  let channels = 1
  let sampleRate = 16000
  let bitsPerSample = 16
  let dataStart = -1
  let dataSize = 0

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4)
    const chunkSize = buffer.readUInt32LE(offset + 4)
    const chunkStart = offset + 8

    if (chunkId === 'fmt ' && chunkStart + chunkSize <= buffer.length) {
      channels = buffer.readUInt16LE(chunkStart + 2)
      sampleRate = buffer.readUInt32LE(chunkStart + 4)
      bitsPerSample = buffer.readUInt16LE(chunkStart + 14)
    }

    if (chunkId === 'data') {
      dataStart = chunkStart
      dataSize = Math.min(chunkSize, buffer.length - chunkStart)
      break
    }

    offset = chunkStart + chunkSize + (chunkSize % 2)
  }

  if (dataStart < 0 || dataSize <= 0 || bitsPerSample !== 16 || channels < 1 || sampleRate <= 0) return null

  const frameCount = Math.floor(dataSize / (channels * 2))
  if (frameCount <= 0) return null

  const samples = new Array(frameCount)
  for (let frame = 0; frame < frameCount; frame += 1) {
    let mono = 0
    for (let channel = 0; channel < channels; channel += 1) {
      const sampleOffset = dataStart + (frame * channels + channel) * 2
      mono += buffer.readInt16LE(sampleOffset) / 32768
    }
    samples[frame] = mono / channels
  }

  return { samples, sampleRate }
}

function dedupeAcceptedSamples(samples) {
  const byPhrase = new Map()
  for (const sample of samples) {
    if (!Array.isArray(sample?.embedding)) continue
    const phraseIndex = Number(sample.phrase_index)
    if (!Number.isInteger(phraseIndex)) continue
    byPhrase.set(phraseIndex, sample)
  }
  return Array.from(byPhrase.values()).sort((a, b) => Number(a.phrase_index) - Number(b.phrase_index))
}

function averageEmbeddings(embeddings) {
  const validEmbeddings = embeddings.filter((embedding) => Array.isArray(embedding) && embedding.length > 0)
  if (validEmbeddings.length === 0) {
    throw new Error('No accepted enrollment embeddings found')
  }

  const maxLength = Math.max(...validEmbeddings.map((embedding) => embedding.length))
  const averaged = Array.from({ length: maxLength }, (_, index) => {
    const sum = validEmbeddings.reduce((acc, embedding) => acc + Number(embedding[index] || 0), 0)
    return sum / validEmbeddings.length
  })

  return normalizeVector(averaged)
}

function makeHttpError(status, message) {
  const error = new Error(message)
  error.status = status
  return error
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
