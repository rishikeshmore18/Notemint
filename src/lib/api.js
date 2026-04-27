import { supabase } from './supabase.js'

const BASE_URL = import.meta.env.VITE_API_URL

if (!BASE_URL) {
  console.error('[API] VITE_API_URL is not set. Backend calls will fail.')
}

async function getAuthToken() {
  const {
    data: { session },
  } = await supabase.auth.getSession()

  if (!session?.access_token) {
    throw new Error('Not authenticated')
  }

  return session.access_token
}

export async function createGladiaSession() {
  const token = await getAuthToken()
  const response = await fetch(`${BASE_URL}/api/gladia/session`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({}),
  })

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}))
    throw new Error(payload.error || 'Could not create Gladia session')
  }

  return response.json()
}

export async function streamSummary(transcript, onChunk, onComplete, onError) {
  if (!transcript || transcript.trim().length < 20) {
    onError?.('Transcript too short to summarize')
    return
  }

  try {
    const token = await getAuthToken()
    const response = await fetch(`${BASE_URL}/api/summarize`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ transcript }),
    })

    if (!response.ok || !response.body) {
      const payload = await response.json().catch(() => ({}))
      onError?.(payload.error || 'Summary request failed')
      return
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let fullText = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const jsonStr = trimmed.slice(5).trim()
        if (!jsonStr) continue

        if (jsonStr === '[DONE]') {
          onComplete?.(fullText)
          return
        }

        try {
          const payload = JSON.parse(jsonStr)
          if (payload.error) {
            onError?.(payload.error)
            return
          }
          if (payload.text) {
            fullText += payload.text
            onChunk?.(payload.text)
          }
        } catch {
          // Ignore non-JSON SSE lines
        }
      }
    }

    onComplete?.(fullText)
  } catch (err) {
    onError?.(err.message || 'Summary stream failed')
  }
}

export async function grokDiarizeAudio(audioBlob) {
  const token = await getAuthToken()
  const formData = new FormData()
  formData.append('audio', audioBlob, inferFileName(audioBlob))

  const response = await fetch(`${BASE_URL}/api/grok`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: formData,
  })

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}))
    throw new Error(payload.error || 'Grok diarization failed')
  }

  const payload = await response.json()
  return Array.isArray(payload?.segments) ? payload.segments : []
}

export async function enrollVoice(audioBlob) {
  const token = await getAuthToken()
  const formData = new FormData()
  formData.append('audio', audioBlob, inferFileName(audioBlob))

  const response = await fetch(`${BASE_URL}/api/voice/enroll`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: formData,
  })

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}))
    throw new Error(payload.error || 'Voice enrollment failed')
  }

  return response.json()
}

export async function getVoiceStatus() {
  try {
    const token = await getAuthToken()
    const response = await fetch(`${BASE_URL}/api/voice/status`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })

    if (!response.ok) {
      return {
        enrolled: false,
        status: 'NotEnrolled',
        sample_count: 0,
        remaining_clips_needed: 5,
      }
    }

    return response.json()
  } catch {
    return {
      enrolled: false,
      status: 'NotEnrolled',
      sample_count: 0,
      remaining_clips_needed: 5,
    }
  }
}

export async function identifyVoice(audioBlob) {
  try {
    const token = await getAuthToken()
    const formData = new FormData()
    formData.append('audio', audioBlob, inferFileName(audioBlob))

    const response = await fetch(`${BASE_URL}/api/voice/identify`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
      },
      body: formData,
    })

    if (!response.ok) {
      return { identified_profile: null, confidence: 0, is_confident: false }
    }

    return response.json()
  } catch {
    return { identified_profile: null, confidence: 0, is_confident: false }
  }
}

function inferFileName(audioBlob) {
  const type = String(audioBlob?.type || '')
  if (type.includes('mp4')) return 'clip.mp4'
  if (type.includes('ogg')) return 'clip.ogg'
  if (type.includes('mpeg') || type.includes('mp3')) return 'clip.mp3'
  if (type.includes('wav')) return 'clip.wav'
  return 'clip.webm'
}
