import express from 'express'
import multer from 'multer'
import { requireAuth } from '../middleware/auth.js'

export const grokRouter = express.Router()

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 },
})

grokRouter.post('/', requireAuth, upload.single('audio'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No audio file provided' })
  }

  if (!process.env.XAI_KEY) {
    return res.status(500).json({ error: 'XAI_KEY is not configured on server' })
  }

  try {
    const formData = new FormData()
    const fileBlob = new Blob([req.file.buffer], { type: req.file.mimetype || 'audio/webm' })
    const extension = guessExtension(req.file.mimetype)
    formData.append('file', fileBlob, `meeting.${extension}`)
    formData.append('model', 'grok-stt')
    formData.append('diarize', 'true')
    formData.append('timestamps', 'true')
    formData.append('language', 'auto')

    const response = await fetch('https://api.x.ai/v1/stt', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.XAI_KEY}`,
      },
      body: formData,
    })

    if (!response.ok) {
      const text = await response.text()
      return res.status(response.status).json({ error: `xAI STT failed: ${text}` })
    }

    const result = await response.json()
    const segments = parseGrokResponse(result)
    return res.json({ segments })
  } catch (err) {
    return res.status(500).json({ error: `xAI proxy request failed: ${err.message}` })
  }
})

function parseGrokResponse(result) {
  const segmentLevel = parseSegmentLevel(result)
  if (segmentLevel.length > 0) return segmentLevel

  const wordLevel = parseWordLevel(result)
  if (wordLevel.length > 0) return wordLevel

  const transcript =
    String(result?.text || result?.transcript || result?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '')
      .trim()
  if (transcript) {
    return [
      {
        speaker: 0,
        text: transcript,
        startTime: 0,
        endTime: 0,
        confidence: 1,
        source: 'grok-fallback',
        isFinal: true,
      },
    ]
  }

  return []
}

function parseSegmentLevel(result) {
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

function parseWordLevel(result) {
  const words = result?.words
  if (!Array.isArray(words) || words.length === 0) return []

  const normalized = words
    .map((w) => ({
      speaker: normalizeSpeaker(w?.speaker),
      token: String(w?.word || w?.text || '').trim(),
      start: toNumber(w?.start),
      end: toNumber(w?.end),
      confidence: toConfidence(w?.confidence),
    }))
    .filter((w) => w.token.length > 0)

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
      segments.push(finalizeWordSegment(current))
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
    segments.push(finalizeWordSegment(current))
  }

  return segments
}

function finalizeWordSegment(segment) {
  return {
    speaker: segment.speaker,
    text: segment.words.join(' '),
    startTime: segment.startTime,
    endTime: segment.endTime,
    confidence: segment.confidenceCount > 0 ? clamp(segment.confidenceSum / segment.confidenceCount, 0, 1) : 1,
    source: 'grok-words',
    isFinal: true,
  }
}

function normalizeSpeaker(value) {
  const parsed = Number(value)
  if (Number.isNaN(parsed) || parsed < 0) return 0
  return Math.floor(parsed)
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
  return 'webm'
}
