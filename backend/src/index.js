import 'dotenv/config'
import cors from 'cors'
import express from 'express'
import { gladiaRouter } from './routes/gladia.js'
import { summarizeRouter } from './routes/summarize.js'
import { grokRouter } from './routes/grok.js'
import { voiceRouter } from './routes/voice.js'

const app = express()
const PORT = Number(process.env.PORT || 3001)

app.use(
  cors({
    origin: [process.env.FRONTEND_URL, 'http://localhost:5173', 'http://localhost:3000'].filter(Boolean),
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }),
)

app.use(express.json({ limit: '10mb' }))

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' })
})

app.use('/api/gladia', gladiaRouter)
app.use('/api/summarize', summarizeRouter)
app.use('/api/grok', grokRouter)
app.use('/api/voice', voiceRouter)

app.use((err, _req, res, _next) => {
  console.error('[Backend Error]', err)
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
  })
})

app.listen(PORT, () => {
  console.log(`[Backend] Notemint backend running on port ${PORT}`)
  console.log('[Backend] Allowed frontend origin:', process.env.FRONTEND_URL || '(not set)')
})
