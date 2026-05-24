import express from 'express'
import multer from 'multer'
import { requireAuth } from '../middleware/auth.js'

export const grokRouter = express.Router()

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 },
})

const SUPPORTED_PROVIDERS = new Set(['grok', 'deepgram', 'assemblyai'])

grokRouter.post('/', requireAuth, upload.single('audio'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No audio file provided' })
  }

  const provider = normalizeProvider(req.body?.provider)
  if (!SUPPORTED_PROVIDERS.has(provider)) {
    return res.status(400).json({ error: 'Unsupported transcription provider' })
  }

  try {
    const startedAt = Date.now()
    const transcriptionHints = extractTranscriptionHints(req.body)
    const result = await transcribeAudio(req.file, provider, transcriptionHints)
    const durationMs = Date.now() - startedAt
    const segments = ensureSegments(result.segments, provider)

    return res.json({
      segments,
      provider: result.provider,
      model: result.model,
      usedKeyterms: Boolean(result.usedKeyterms),
      keytermCount: Number(result.keytermCount || 0),
      durationMs: Math.max(0, Math.floor(durationMs)),
      compareMode: Boolean(transcriptionHints.compareMode),
    })
  } catch (err) {
    const status = normalizeErrorStatus(err?.status)
    const safeMessage = sanitizeErrorMessage(status)
    console.warn('[STT] provider request failed:', {
      provider,
      status,
      detail: err?.message || 'unknown error',
    })
    return res.status(status).json({ error: safeMessage })
  }
})

async function transcribeAudio(file, provider, hints = {}) {
  if (provider === 'deepgram') return transcribeWithDeepgram(file, hints)
  if (provider === 'assemblyai') return transcribeWithAssemblyAI(file, hints)
  return transcribeWithGrok(file)
}

async function transcribeWithGrok(file) {
  if (!process.env.XAI_KEY) {
    throw httpError(500, 'XAI_KEY is not configured on server')
  }

  const formData = new FormData()
  const fileBlob = new Blob([file.buffer], { type: file.mimetype || 'audio/webm' })
  const extension = guessExtension(file.mimetype)
  formData.append('file', fileBlob, `meeting.${extension}`)
  formData.append('model', 'grok-stt')
  formData.append('diarize', 'true')
  formData.append('timestamps', 'true')
  // English-only product path for higher consistency on in-person meetings.
  formData.append('language', 'en')

  const response = await fetch('https://api.x.ai/v1/stt', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.XAI_KEY}`,
    },
    body: formData,
  })

  if (!response.ok) {
    const text = await response.text()
    throw providerError('grok', response.status, `xAI STT failed: ${text}`)
  }

  const result = await response.json()
  return {
    provider: 'grok',
    model: 'grok-stt',
    usedKeyterms: false,
    keytermCount: 0,
    segments: parseGrokResponse(result),
  }
}

async function transcribeWithDeepgram(file, hints = {}) {
  if (!process.env.DEEPGRAM_KEY) {
    throw httpError(500, 'DEEPGRAM_KEY is not configured on server')
  }

  const baseParams = {
    model: 'nova-3',
    diarize_model: 'latest',
    utterances: 'true',
    utt_split: '1.2',
    punctuate: 'true',
    smart_format: 'true',
    language: 'en',
  }

  const selectedKeyterms = buildProviderKeyterms(hints.contextTerms, 'deepgram')
  let usedKeyterms = selectedKeyterms.length > 0
  let keytermCount = selectedKeyterms.length
  const withHintsUrl = buildDeepgramUrl(baseParams, selectedKeyterms)

  let response = await fetch(withHintsUrl, {
    method: 'POST',
    headers: {
      Authorization: `Token ${process.env.DEEPGRAM_KEY}`,
      'Content-Type': file.mimetype || 'audio/webm',
    },
    body: file.buffer,
    signal: AbortSignal.timeout(120000),
  })

  if (!response.ok && selectedKeyterms.length > 0 && response.status >= 400 && response.status < 500) {
    usedKeyterms = false
    keytermCount = 0
    response = await fetch(buildDeepgramUrl(baseParams, []), {
      method: 'POST',
      headers: {
        Authorization: `Token ${process.env.DEEPGRAM_KEY}`,
        'Content-Type': file.mimetype || 'audio/webm',
      },
      body: file.buffer,
      signal: AbortSignal.timeout(120000),
    })
  }

  if (!response.ok) {
    const text = await response.text()
    throw providerError('deepgram', response.status, `Deepgram STT failed: ${text}`)
  }

  const result = await response.json()
  return {
    provider: 'deepgram',
    model: 'nova-3',
    usedKeyterms,
    keytermCount,
    segments: parseDeepgramResponse(result),
  }
}

async function transcribeWithAssemblyAI(file, hints = {}) {
  if (!process.env.ASSEMBLYAI_KEY) {
    throw httpError(500, 'ASSEMBLYAI_KEY is not configured on server')
  }

  const uploadResponse = await fetch('https://api.assemblyai.com/v2/upload', {
    method: 'POST',
    headers: {
      Authorization: process.env.ASSEMBLYAI_KEY,
      'Content-Type': file.mimetype || 'application/octet-stream',
    },
    body: file.buffer,
    signal: AbortSignal.timeout(120000),
  })

  if (!uploadResponse.ok) {
    const text = await uploadResponse.text()
    throw providerError('assemblyai', uploadResponse.status, `AssemblyAI upload failed: ${text}`)
  }

  const uploadPayload = await uploadResponse.json()
  if (!uploadPayload?.upload_url) {
    throw providerError('assemblyai', 502, 'AssemblyAI upload did not return an upload_url')
  }

  const selectedKeyterms = buildProviderKeyterms(hints.contextTerms, 'assemblyai')
  let usedKeyterms = selectedKeyterms.length > 0
  let keytermCount = selectedKeyterms.length
  const transcriptBodyWithHints = {
    audio_url: uploadPayload.upload_url,
    speech_models: ['universal-3-pro', 'universal-2'],
    language_code: 'en_us',
    speaker_labels: true,
    punctuate: true,
    format_text: true,
    ...(selectedKeyterms.length > 0 ? { keyterms_prompt: selectedKeyterms } : {}),
  }

  let transcriptResponse = await fetch('https://api.assemblyai.com/v2/transcript', {
    method: 'POST',
    headers: {
      Authorization: process.env.ASSEMBLYAI_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(transcriptBodyWithHints),
    signal: AbortSignal.timeout(30000),
  })

  if (
    !transcriptResponse.ok &&
    selectedKeyterms.length > 0 &&
    transcriptResponse.status >= 400 &&
    transcriptResponse.status < 500
  ) {
    usedKeyterms = false
    keytermCount = 0
    transcriptResponse = await fetch('https://api.assemblyai.com/v2/transcript', {
      method: 'POST',
      headers: {
        Authorization: process.env.ASSEMBLYAI_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        audio_url: uploadPayload.upload_url,
        speech_models: ['universal-3-pro', 'universal-2'],
        language_code: 'en_us',
        speaker_labels: true,
        punctuate: true,
        format_text: true,
      }),
      signal: AbortSignal.timeout(30000),
    })
  }

  if (!transcriptResponse.ok) {
    const text = await transcriptResponse.text()
    throw providerError('assemblyai', transcriptResponse.status, `AssemblyAI transcript request failed: ${text}`)
  }

  const transcriptPayload = await transcriptResponse.json()
  if (!transcriptPayload?.id) {
    throw providerError('assemblyai', 502, 'AssemblyAI transcript request did not return an id')
  }

  const result = await pollAssemblyAITranscript(transcriptPayload.id)
  return {
    provider: 'assemblyai',
    model: 'universal-3-pro,universal-2',
    usedKeyterms,
    keytermCount,
    segments: parseAssemblyAIResponse(result),
  }
}

async function pollAssemblyAITranscript(transcriptId) {
  const startedAt = Date.now()
  const timeoutMs = 180000
  const pollIntervalMs = 2500

  while (Date.now() - startedAt < timeoutMs) {
    const response = await fetch(`https://api.assemblyai.com/v2/transcript/${transcriptId}`, {
      method: 'GET',
      headers: {
        Authorization: process.env.ASSEMBLYAI_KEY,
      },
      signal: AbortSignal.timeout(30000),
    })

    if (!response.ok) {
      const text = await response.text()
      throw providerError('assemblyai', response.status, `AssemblyAI polling failed: ${text}`)
    }

    const payload = await response.json()
    if (payload.status === 'completed') return payload
    if (payload.status === 'error') {
      throw providerError('assemblyai', 502, `AssemblyAI transcription failed: ${payload.error || 'unknown error'}`)
    }

    await delay(pollIntervalMs)
  }

  throw providerError('assemblyai', 504, 'AssemblyAI transcription timed out')
}

function parseGrokResponse(result) {
  const segmentLevel = parseGrokSegmentLevel(result)
  if (segmentLevel.length > 0) return segmentLevel

  const wordLevel = parseGrokWordLevel(result)
  if (wordLevel.length > 0) return wordLevel

  const transcript =
    String(result?.text || result?.transcript || result?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '')
      .trim()
  return transcriptToFallbackSegment(transcript, 'grok')
}

function parseGrokSegmentLevel(result) {
  const segments = result?.segments
  if (!Array.isArray(segments) || segments.length === 0) return []

  return segments
    .map((seg) => {
      const text = String(seg?.text || seg?.transcript || '').trim()
      if (!text) return null
      const confidence = toConfidenceOrNull(seg?.confidence ?? seg?.avg_logprob)
      const startTime = toNumberOrNull(seg?.start ?? seg?.start_time)
      const endTime = toNumberOrNull(seg?.end ?? seg?.end_time)
      return {
        speaker: normalizeSpeaker(seg?.speaker),
        text,
        startTime,
        endTime,
        confidence,
        source: 'grok',
        isFinal: true,
        speakerConfidence: toConfidenceOrNull(seg?.speaker_confidence),
        wordConfidence: confidence,
        uncertain: isUncertainSegment({
          text,
          confidence,
          startTime,
          endTime,
        }),
      }
    })
    .filter(Boolean)
}

function parseGrokWordLevel(result) {
  const words = result?.words
  if (!Array.isArray(words) || words.length === 0) return []

  return groupWordsBySpeaker(
    words.map((word) => ({
      speaker: normalizeSpeaker(word?.speaker),
      token: String(word?.word || word?.text || '').trim(),
      start: toNumberOrNull(word?.start),
      end: toNumberOrNull(word?.end),
      confidence: toConfidenceOrNull(word?.confidence),
    })),
    'grok',
  )
}

function parseDeepgramResponse(result) {
  const utterances = result?.results?.utterances
  if (Array.isArray(utterances) && utterances.length > 0) {
    return utterances
      .map((utterance) => {
        const text = String(utterance?.transcript || '').trim()
        if (!text) return null
        const confidence = toConfidenceOrNull(utterance?.confidence)
        const startTime = toNumberOrNull(utterance?.start)
        const endTime = toNumberOrNull(utterance?.end)
        return {
          speaker: normalizeSpeaker(utterance?.speaker),
          text,
          startTime,
          endTime,
          confidence,
          source: 'deepgram',
          isFinal: true,
          speakerConfidence: toConfidenceOrNull(utterance?.speaker_confidence),
          wordConfidence: confidence,
          uncertain: isUncertainSegment({
            text,
            confidence,
            startTime,
            endTime,
          }),
        }
      })
      .filter(Boolean)
  }

  const words = result?.results?.channels?.[0]?.alternatives?.[0]?.words
  if (Array.isArray(words) && words.length > 0) {
    return groupWordsBySpeaker(
      words.map((word) => ({
        speaker: normalizeSpeaker(word?.speaker),
        token: String(word?.punctuated_word || word?.word || '').trim(),
        start: toNumberOrNull(word?.start),
        end: toNumberOrNull(word?.end),
        confidence: toConfidenceOrNull(word?.confidence),
      })),
      'deepgram',
    )
  }

  const transcript = String(result?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '').trim()
  return transcriptToFallbackSegment(transcript, 'deepgram')
}

function parseAssemblyAIResponse(result) {
  const utterances = result?.utterances
  if (Array.isArray(utterances) && utterances.length > 0) {
    return utterances
      .map((utterance) => {
        const text = String(utterance?.text || '').trim()
        if (!text) return null
        const confidence = toConfidenceOrNull(utterance?.confidence)
        const startTime = toSecondsOrNull(utterance?.start)
        const endTime = toSecondsOrNull(utterance?.end)
        return {
          speaker: normalizeSpeaker(assemblySpeakerToNumber(utterance?.speaker)),
          text,
          startTime,
          endTime,
          confidence,
          source: 'assemblyai',
          isFinal: true,
          speakerConfidence: toConfidenceOrNull(utterance?.speaker_confidence),
          wordConfidence: confidence,
          uncertain: isUncertainSegment({
            text,
            confidence,
            startTime,
            endTime,
          }),
        }
      })
      .filter(Boolean)
  }

  const words = result?.words
  if (Array.isArray(words) && words.length > 0) {
    return groupWordsBySpeaker(
      words.map((word) => ({
        speaker: normalizeSpeaker(assemblySpeakerToNumber(word?.speaker)),
        token: String(word?.text || '').trim(),
        start: toSecondsOrNull(word?.start),
        end: toSecondsOrNull(word?.end),
        confidence: toConfidenceOrNull(word?.confidence),
      })),
      'assemblyai',
    )
  }

  const transcript = String(result?.text || '').trim()
  return transcriptToFallbackSegment(transcript, 'assemblyai')
}

function groupWordsBySpeaker(words, source) {
  const normalized = words.filter((word) => word.token.length > 0)
  if (normalized.length === 0) return []

  const segments = []
  let current = null

  for (const word of normalized) {
    if (!current) {
      current = {
        speaker: word.speaker,
        words: [word.token],
        startTime: word.start,
        endTime: word.end,
        confidenceSum: Number.isFinite(word.confidence) ? word.confidence : 0,
        confidenceCount: Number.isFinite(word.confidence) ? 1 : 0,
      }
      continue
    }

    const gap = computeGapSeconds(current.endTime, word.start)
    if (word.speaker !== current.speaker || (Number.isFinite(gap) && gap > 1.5)) {
      segments.push(finalizeWordSegment(current, source))
      current = {
        speaker: word.speaker,
        words: [word.token],
        startTime: word.start,
        endTime: word.end,
        confidenceSum: Number.isFinite(word.confidence) ? word.confidence : 0,
        confidenceCount: Number.isFinite(word.confidence) ? 1 : 0,
      }
      continue
    }

    current.words.push(word.token)
    current.endTime = word.end
    if (Number.isFinite(word.confidence)) {
      current.confidenceSum += word.confidence
      current.confidenceCount += 1
    }
  }

  if (current) {
    segments.push(finalizeWordSegment(current, source))
  }

  return segments
}

function finalizeWordSegment(segment, source) {
  const confidence =
    segment.confidenceCount > 0 && Number.isFinite(segment.confidenceSum)
      ? clamp(segment.confidenceSum / segment.confidenceCount, 0, 1)
      : null
  const startTime = toNumberOrNull(segment.startTime)
  const endTime = toNumberOrNull(segment.endTime)
  const text = segment.words.join(' ')

  return {
    speaker: segment.speaker,
    text,
    startTime,
    endTime,
    confidence,
    source,
    isFinal: true,
    speakerConfidence: null,
    wordConfidence: confidence,
    uncertain: isUncertainSegment({
      text,
      confidence,
      startTime,
      endTime,
    }),
  }
}

function transcriptToFallbackSegment(transcript, source) {
  if (!transcript) return []
  return [
    {
      speaker: 0,
      text: transcript,
      startTime: null,
      endTime: null,
      confidence: null,
      source,
      isFinal: true,
      speakerConfidence: null,
      wordConfidence: null,
      uncertain: true,
    },
  ]
}

function normalizeProvider(value) {
  const provider = String(value || 'grok').trim().toLowerCase()
  if (provider === 'xai') return 'grok'
  if (provider === 'deepgram-nova-3') return 'deepgram'
  if (provider === 'assembly') return 'assemblyai'
  return provider
}

function extractTranscriptionHints(body) {
  const contextTerms = [
    ...parseTermsPayload(body?.context_terms),
    ...extractTermsFromMeetingContext(parseJsonPayload(body?.meeting_context)),
  ]

  return {
    contextTerms: dedupeTerms(contextTerms).slice(0, 200),
    compareMode: parseBoolean(body?.compare_mode),
  }
}

function parseJsonPayload(raw) {
  if (raw && typeof raw === 'object') return raw
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    return null
  }
}

function parseTermsPayload(raw) {
  if (Array.isArray(raw)) return raw
  if (typeof raw === 'string') {
    const parsed = parseJsonPayload(raw)
    if (Array.isArray(parsed)) return parsed
    return raw
      .split(/[\n,]/g)
      .map((item) => item.trim())
      .filter(Boolean)
  }
  return []
}

function extractTermsFromMeetingContext(context) {
  if (!context || typeof context !== 'object') return []
  const terms = []

  const topic = String(context.topic || '').trim()
  if (topic) terms.push(topic)

  const goal = String(context.goal || '').trim()
  if (goal) terms.push(goal)

  const expectedParticipants = parseTermsPayload(context.expectedParticipants)
  const importantTerms = parseTermsPayload(context.importantTerms)
  const meetingType = String(context.meetingType || '').trim()
  if (meetingType) terms.push(meetingType)

  return [...terms, ...expectedParticipants, ...importantTerms]
}

function dedupeTerms(rawTerms) {
  const out = []
  const seen = new Set()

  for (const raw of rawTerms) {
    const cleaned = String(raw || '')
      .replace(/\s+/g, ' ')
      .trim()
    if (!cleaned) continue
    if (cleaned.length > 50) continue
    if (cleaned.split(' ').length > 6) continue
    const key = cleaned.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(cleaned)
  }

  return out
}

function buildProviderKeyterms(contextTerms, provider) {
  const deduped = dedupeTerms(contextTerms)
  if (deduped.length === 0) return []

  if (provider === 'deepgram') {
    const out = []
    let words = 0
    for (const term of deduped) {
      const nextWords = term.split(' ').length
      if (out.length >= 100) break
      if (words + nextWords > 450) break
      out.push(term)
      words += nextWords
    }
    return out
  }

  if (provider === 'assemblyai') {
    return deduped.slice(0, 200)
  }

  return []
}

function buildDeepgramUrl(baseParams, keyterms) {
  const params = new URLSearchParams(baseParams)
  for (const term of keyterms) {
    params.append('keyterm', term)
  }
  return `https://api.deepgram.com/v1/listen?${params.toString()}`
}

function normalizeSpeaker(value) {
  const parsed = Number(value)
  if (Number.isNaN(parsed) || parsed < 0) return 0
  return Math.floor(parsed)
}

function assemblySpeakerToNumber(value) {
  if (typeof value === 'number') return value
  const str = String(value || '').trim()
  if (!str) return 0
  if (/^\d+$/.test(str)) return Number(str)

  const upper = str.toUpperCase()
  const letter = upper.match(/[A-Z]/)?.[0]
  if (!letter) return 0
  return letter.charCodeAt(0) - 65
}

function toNumber(value) {
  const parsed = Number(value)
  if (Number.isNaN(parsed) || parsed < 0) return 0
  return parsed
}

function toConfidence(value) {
  const parsed = Number(value)
  if (Number.isNaN(parsed)) return 1
  if (parsed < 0) return clamp(Math.exp(parsed), 0, 1)
  return clamp(parsed, 0, 1)
}

function toNumberOrNull(value) {
  const parsed = Number(value)
  if (Number.isNaN(parsed) || parsed < 0) return null
  return parsed
}

function toSecondsOrNull(value) {
  const parsed = Number(value)
  if (Number.isNaN(parsed) || parsed < 0) return null
  return parsed / 1000
}

function toConfidenceOrNull(value) {
  if (value === null || typeof value === 'undefined') return null
  const parsed = Number(value)
  if (Number.isNaN(parsed)) return null
  if (parsed < 0) return clamp(Math.exp(parsed), 0, 1)
  return clamp(parsed, 0, 1)
}

function computeGapSeconds(end, start) {
  if (!Number.isFinite(end) || !Number.isFinite(start)) return null
  return start - end
}

function isUncertainSegment({ text, confidence, startTime, endTime }) {
  const cleanedText = String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleanedText) return true

  const wordCount = cleanedText.split(' ').filter(Boolean).length
  const duration = Number.isFinite(startTime) && Number.isFinite(endTime) ? Math.max(0, endTime - startTime) : null

  if (confidence !== null && confidence < 0.6) return true
  if (wordCount <= 1) return true
  if (duration !== null && duration < 0.7 && wordCount <= 3) return true

  return false
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function guessExtension(mimeType = '') {
  if (mimeType.includes('mp4')) return 'mp4'
  if (mimeType.includes('ogg')) return 'ogg'
  if (mimeType.includes('mpeg') || mimeType.includes('mp3')) return 'mp3'
  if (mimeType.includes('wav')) return 'wav'
  return 'webm'
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function httpError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

function providerError(provider, status, detail) {
  const err = httpError(status, detail)
  err.provider = provider
  return err
}

function normalizeErrorStatus(status) {
  const parsed = Number(status)
  if (!Number.isFinite(parsed)) return 500
  if (parsed < 400) return 500
  if (parsed > 599) return 500
  return Math.floor(parsed)
}

function sanitizeErrorMessage(status) {
  if (status === 400) return 'Transcription request was rejected. Check audio format or meeting terms.'
  if (status === 401 || status === 403) return 'Transcription provider authentication failed.'
  if (status === 408 || status === 504) return 'Transcription timed out. Please retry.'
  if (status === 413) return 'Audio file is too large.'
  if (status === 415) return 'Unsupported audio format.'
  if (status === 429) return 'Transcription rate limit reached. Please try again shortly.'
  if (status >= 500) return 'Transcription provider is temporarily unavailable.'
  return 'Transcription failed.'
}

function ensureSegments(segments, provider) {
  if (Array.isArray(segments) && segments.length > 0) {
    return segments
  }
  return transcriptToFallbackSegment('', provider)
}

function parseBoolean(value) {
  if (typeof value === 'boolean') return value
  const str = String(value || '')
    .trim()
    .toLowerCase()
  return str === '1' || str === 'true' || str === 'yes' || str === 'on'
}
