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
    const segments = await transcribeAudio(req.file, provider)
    return res.json({ segments })
  } catch (err) {
    const status = Number(err.status || 500)
    return res.status(status).json({ error: err.message || 'Transcription failed' })
  }
})

async function transcribeAudio(file, provider) {
  if (provider === 'deepgram') return transcribeWithDeepgram(file)
  if (provider === 'assemblyai') return transcribeWithAssemblyAI(file)
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
    throw httpError(response.status, `xAI STT failed: ${text}`)
  }

  const result = await response.json()
  return parseGrokResponse(result)
}

async function transcribeWithDeepgram(file) {
  if (!process.env.DEEPGRAM_KEY) {
    throw httpError(500, 'DEEPGRAM_KEY is not configured on server')
  }

  const url = `https://api.deepgram.com/v1/listen?${new URLSearchParams({
    model: 'nova-3',
    diarize_model: 'latest',
    utterances: 'true',
    utt_split: '1.2',
    punctuate: 'true',
    smart_format: 'true',
    language: 'en',
  }).toString()}`

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Token ${process.env.DEEPGRAM_KEY}`,
      'Content-Type': file.mimetype || 'audio/webm',
    },
    body: file.buffer,
    signal: AbortSignal.timeout(120000),
  })

  if (!response.ok) {
    const text = await response.text()
    throw httpError(response.status, `Deepgram STT failed: ${text}`)
  }

  const result = await response.json()
  return parseDeepgramResponse(result)
}

async function transcribeWithAssemblyAI(file) {
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
    throw httpError(uploadResponse.status, `AssemblyAI upload failed: ${text}`)
  }

  const uploadPayload = await uploadResponse.json()
  if (!uploadPayload?.upload_url) {
    throw httpError(502, 'AssemblyAI upload did not return an upload_url')
  }

  const transcriptResponse = await fetch('https://api.assemblyai.com/v2/transcript', {
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

  if (!transcriptResponse.ok) {
    const text = await transcriptResponse.text()
    throw httpError(transcriptResponse.status, `AssemblyAI transcript request failed: ${text}`)
  }

  const transcriptPayload = await transcriptResponse.json()
  if (!transcriptPayload?.id) {
    throw httpError(502, 'AssemblyAI transcript request did not return an id')
  }

  const result = await pollAssemblyAITranscript(transcriptPayload.id)
  return parseAssemblyAIResponse(result)
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
      throw httpError(response.status, `AssemblyAI polling failed: ${text}`)
    }

    const payload = await response.json()
    if (payload.status === 'completed') return payload
    if (payload.status === 'error') {
      throw httpError(502, `AssemblyAI transcription failed: ${payload.error || 'unknown error'}`)
    }

    await delay(pollIntervalMs)
  }

  throw httpError(504, 'AssemblyAI transcription timed out')
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
      return {
        speaker: normalizeSpeaker(seg?.speaker),
        text,
        startTime: toNumber(seg?.start ?? seg?.start_time),
        endTime: toNumber(seg?.end ?? seg?.end_time),
        confidence: toConfidence(seg?.confidence ?? seg?.avg_logprob),
        source: 'grok',
        isFinal: true,
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
      start: toNumber(word?.start),
      end: toNumber(word?.end),
      confidence: toConfidence(word?.confidence),
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
        return {
          speaker: normalizeSpeaker(utterance?.speaker),
          text,
          startTime: toNumber(utterance?.start),
          endTime: toNumber(utterance?.end),
          confidence: toConfidence(utterance?.confidence),
          source: 'deepgram',
          isFinal: true,
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
        start: toNumber(word?.start),
        end: toNumber(word?.end),
        confidence: toConfidence(word?.confidence),
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
        return {
          speaker: normalizeSpeaker(assemblySpeakerToNumber(utterance?.speaker)),
          text,
          startTime: toNumber(utterance?.start) / 1000,
          endTime: toNumber(utterance?.end) / 1000,
          confidence: toConfidence(utterance?.confidence),
          source: 'assemblyai',
          isFinal: true,
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
        start: toNumber(word?.start) / 1000,
        end: toNumber(word?.end) / 1000,
        confidence: toConfidence(word?.confidence),
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
        confidenceSum: word.confidence,
        confidenceCount: 1,
      }
      continue
    }

    const gap = word.start - current.endTime
    if (word.speaker !== current.speaker || gap > 1.5) {
      segments.push(finalizeWordSegment(current, source))
      current = {
        speaker: word.speaker,
        words: [word.token],
        startTime: word.start,
        endTime: word.end,
        confidenceSum: word.confidence,
        confidenceCount: 1,
      }
      continue
    }

    current.words.push(word.token)
    current.endTime = word.end
    current.confidenceSum += word.confidence
    current.confidenceCount += 1
  }

  if (current) {
    segments.push(finalizeWordSegment(current, source))
  }

  return segments
}

function finalizeWordSegment(segment, source) {
  return {
    speaker: segment.speaker,
    text: segment.words.join(' '),
    startTime: segment.startTime,
    endTime: segment.endTime,
    confidence: segment.confidenceCount > 0 ? clamp(segment.confidenceSum / segment.confidenceCount, 0, 1) : 1,
    source,
    isFinal: true,
  }
}

function transcriptToFallbackSegment(transcript, source) {
  if (!transcript) return []
  return [
    {
      speaker: 0,
      text: transcript,
      startTime: 0,
      endTime: 0,
      confidence: 1,
      source,
      isFinal: true,
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
