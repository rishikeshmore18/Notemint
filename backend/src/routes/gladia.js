import express from 'express'
import { requireAuth } from '../middleware/auth.js'

export const gladiaRouter = express.Router()

gladiaRouter.post('/session', requireAuth, async (req, res) => {
  const { enable_diarization = true } = req.body || {}

  if (!process.env.GLADIA_KEY) {
    return res.status(500).json({ error: 'GLADIA_KEY is not configured on server' })
  }

  try {
    const response = await fetch('https://api.gladia.io/v2/live', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Gladia-Key': process.env.GLADIA_KEY,
      },
      body: JSON.stringify({
        encoding: 'wav/pcm',
        sample_rate: 16000,
        language_config: {
          languages: [],
          code_switching: true,
        },
        diarization: Boolean(enable_diarization),
        diarization_config: enable_diarization
          ? {
              min_speakers: 1,
              max_speakers: 4,
            }
          : undefined,
        pre_processing: {
          audio_enhancer: false,
        },
        realtime_processing: {
          words_accurate_timestamps: false,
        },
      }),
    })

    if (!response.ok) {
      const text = await response.text()
      return res.status(response.status).json({ error: `Gladia session creation failed: ${text}` })
    }

    const data = await response.json()
    return res.json({
      session_url: data.url,
      session_id: data.id,
    })
  } catch (err) {
    return res.status(500).json({ error: `Failed to create Gladia session: ${err.message}` })
  }
})
