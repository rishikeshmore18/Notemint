import express from 'express'
import multer from 'multer'
import { requireAuth } from '../middleware/auth.js'

export const grokRouter = express.Router()

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 },
})

grokRouter.post('/diarize', requireAuth, upload.single('audio'), async (req, res) => {
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
    return res.json(result)
  } catch (err) {
    return res.status(500).json({ error: `xAI proxy request failed: ${err.message}` })
  }
})

function guessExtension(mimeType = '') {
  if (mimeType.includes('mp4')) return 'mp4'
  if (mimeType.includes('ogg')) return 'ogg'
  if (mimeType.includes('mpeg') || mimeType.includes('mp3')) return 'mp3'
  return 'webm'
}
