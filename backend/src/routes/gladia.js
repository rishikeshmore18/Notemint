import express from 'express'
import { requireAuth } from '../middleware/auth.js'

export const gladiaRouter = express.Router()

gladiaRouter.post('/session', requireAuth, async (req, res) => {
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
        bit_depth: 16,
        sample_rate: 16000,
        channels: 1,
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
