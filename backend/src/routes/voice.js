import express from 'express'
import multer from 'multer'
import { requireAuth } from '../middleware/auth.js'

export const voiceRouter = express.Router()

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
})

voiceRouter.post('/enroll', requireAuth, upload.single('audio'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No audio file provided' })
  }
  if (!process.env.VOICE_SERVICE_URL) {
    return res.status(500).json({ error: 'VOICE_SERVICE_URL is not configured on server' })
  }

  try {
    const formData = new FormData()
    const fileBlob = new Blob([req.file.buffer], { type: req.file.mimetype || 'audio/wav' })
    formData.append('audio', fileBlob, 'enroll.wav')
    formData.append('user_id', req.user.id)

    const response = await fetch(`${process.env.VOICE_SERVICE_URL}/enroll`, {
      method: 'POST',
      body: formData,
    })

    const payload = await response.json().catch(() => ({}))
    if (!response.ok) {
      return res.status(response.status).json({
        error: payload.error || payload.detail || 'Voice enroll failed',
      })
    }

    return res.json(payload)
  } catch (err) {
    return res.status(500).json({ error: `Voice enroll proxy failed: ${err.message}` })
  }
})

voiceRouter.post('/identify', requireAuth, upload.single('audio'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No audio file provided' })
  }
  if (!process.env.VOICE_SERVICE_URL) {
    return res.status(500).json({ error: 'VOICE_SERVICE_URL is not configured on server' })
  }

  const threshold = Number(process.env.VOICE_MATCH_THRESHOLD || 0.72)

  try {
    const formData = new FormData()
    const fileBlob = new Blob([req.file.buffer], { type: req.file.mimetype || 'audio/wav' })
    formData.append('audio', fileBlob, 'snippet.wav')
    formData.append('user_id', req.user.id)
    formData.append('threshold', String(threshold))

    const response = await fetch(`${process.env.VOICE_SERVICE_URL}/identify`, {
      method: 'POST',
      body: formData,
    })

    const payload = await response.json().catch(() => ({}))
    if (!response.ok) {
      return res.status(response.status).json({
        error: payload.error || payload.detail || 'Voice identify failed',
      })
    }

    return res.json(payload)
  } catch (err) {
    return res.status(500).json({ error: `Voice identify proxy failed: ${err.message}` })
  }
})

voiceRouter.get('/status', requireAuth, async (req, res) => {
  if (!process.env.VOICE_SERVICE_URL) {
    return res.status(500).json({ error: 'VOICE_SERVICE_URL is not configured on server' })
  }

  try {
    const params = new URLSearchParams({ user_id: req.user.id })
    const response = await fetch(`${process.env.VOICE_SERVICE_URL}/status?${params.toString()}`)
    const payload = await response.json().catch(() => ({}))

    if (!response.ok) {
      return res.status(response.status).json({
        error: payload.error || payload.detail || 'Voice status failed',
      })
    }

    return res.json(payload)
  } catch (err) {
    return res.status(500).json({ error: `Voice status proxy failed: ${err.message}` })
  }
})
