import express from 'express'
import { requireAuth } from '../middleware/auth.js'

export const gladiaRouter = express.Router()

gladiaRouter.post('/session', requireAuth, async (req, res) => {
  const { enable_diarization = true } = req.body || {}

  if (!process.env.GLADIA_KEY) {
    return res.status(500).json({ error: 'GLADIA_KEY is not configured on server' })
  }

  try {
    // Gladia v2 live currently rejects diarization fields at session-creation time.
    // Live transcript still works, and post-meeting diarization is handled via Grok.
    if (enable_diarization) {
      console.log('[Gladia] Live diarization requested but skipped due to API schema constraints')
    }

    const response = await fetch('https://api.gladia.io/v2/live', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Gladia-Key': process.env.GLADIA_KEY,
      },
      body: JSON.stringify({
        encoding: 'wav/pcm',
        bit_depth: 16,
        sample_rate: 16000,
        channels: 1,
        language_config: {
          languages: [],
          code_switching: true,
        },
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
