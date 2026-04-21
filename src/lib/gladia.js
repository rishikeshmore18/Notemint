const LIVE_INIT_URL = 'https://api.gladia.io/v2/live'

let websocket = null
let audioStream = null
let audioContext = null
let sourceNode = null
let processorNode = null
let silenceNode = null
let streaming = false

export async function startTranscription({ onSegment, onError, onConnected }) {
  try {
    audioStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    })
  } catch (err) {
    if (err.name === 'NotAllowedError') {
      onError('Microphone access denied. Allow microphone in browser settings.')
      return false
    }
    if (err.name === 'NotFoundError') {
      onError('No microphone found.')
      return false
    }
    onError('Microphone error: ' + err.message)
    return false
  }

  const AudioContextCtor = window.AudioContext || window.webkitAudioContext
  if (!AudioContextCtor) {
    onError('AudioContext is not supported in this browser.')
    cleanup()
    return false
  }

  try {
    audioContext = new AudioContextCtor()
    if (audioContext.state === 'suspended') {
      await audioContext.resume()
    }
  } catch (err) {
    onError('Could not start audio context: ' + err.message)
    cleanup()
    return false
  }

  const sampleRate = audioContext.sampleRate || 48000

  let websocketUrl = null
  try {
    const response = await fetch(LIVE_INIT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-gladia-key': import.meta.env.VITE_GLADIA_KEY,
      },
      body: JSON.stringify({
        encoding: 'wav/pcm',
        bit_depth: 16,
        sample_rate: sampleRate,
        channels: 1,
      }),
    })

    const payload = await response.json().catch(() => ({}))
    if (!response.ok) {
      onError('Transcription init failed: ' + (payload.error || response.status))
      cleanup()
      return false
    }

    websocketUrl = payload.url
    if (!websocketUrl) {
      onError('Transcription init failed: missing websocket URL.')
      cleanup()
      return false
    }
  } catch (err) {
    onError('Transcription init failed: ' + err.message)
    cleanup()
    return false
  }

  websocket = new WebSocket(websocketUrl)
  websocket.onopen = () => {
    startPcmStream(onError)
    if (onConnected) onConnected()
  }

  websocket.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data)

      if (msg.type === 'transcript') {
        const utterance = msg.data?.utterance
        const text = (utterance?.text || '').trim()
        if (!text) return

        onSegment({
          speaker: normalizeSpeaker(utterance?.speaker ?? utterance?.channel ?? 0),
          text,
          isFinal: Boolean(msg.data?.is_final),
        })
      }
    } catch {
      // Ignore malformed websocket messages.
    }
  }

  websocket.onerror = (event) => {
    console.error('[Gladia] WebSocket error:', event)
    onError('Transcription connection failed. Check your Gladia API key and internet connection.')
  }

  websocket.onclose = (event) => {
    console.log('[Gladia] WebSocket closed. Code:', event.code, 'Reason:', event.reason)
    if (event.code !== 1000 && event.code !== 1001) {
      onError('Transcription disconnected (code ' + event.code + '). ' + (event.reason || ''))
    }
  }

  return true
}

function startPcmStream(onError) {
  if (!audioStream || !audioContext || !websocket) return

  streaming = true
  sourceNode = audioContext.createMediaStreamSource(audioStream)
  processorNode = audioContext.createScriptProcessor(4096, 1, 1)
  silenceNode = audioContext.createGain()
  silenceNode.gain.value = 0

  processorNode.onaudioprocess = (event) => {
    if (!streaming || !websocket || websocket.readyState !== WebSocket.OPEN) return

    try {
      const input = event.inputBuffer.getChannelData(0)
      const pcmBuffer = floatTo16BitPcm(input)
      const base64Chunk = arrayBufferToBase64(pcmBuffer)

      websocket.send(
        JSON.stringify({
          type: 'audio_chunk',
          data: {
            chunk: base64Chunk,
          },
        }),
      )
    } catch (err) {
      console.warn('[Gladia] Failed to send audio chunk:', err)
      onError('Audio streaming error: ' + err.message)
    }
  }

  sourceNode.connect(processorNode)
  processorNode.connect(silenceNode)
  silenceNode.connect(audioContext.destination)
}

function floatTo16BitPcm(float32Array) {
  const buffer = new ArrayBuffer(float32Array.length * 2)
  const view = new DataView(buffer)

  for (let i = 0; i < float32Array.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, float32Array[i]))
    view.setInt16(i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
  }

  return buffer
}

function arrayBufferToBase64(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer)
  let binary = ''
  const chunkSize = 0x8000

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize)
    binary += String.fromCharCode.apply(null, chunk)
  }

  return btoa(binary)
}

function normalizeSpeaker(value) {
  const parsed = Number(value)
  if (Number.isNaN(parsed) || parsed < 0) return 0
  return Math.floor(parsed)
}

function cleanup() {
  streaming = false

  if (processorNode) {
    try {
      processorNode.disconnect()
    } catch {}
    processorNode = null
  }

  if (sourceNode) {
    try {
      sourceNode.disconnect()
    } catch {}
    sourceNode = null
  }

  if (silenceNode) {
    try {
      silenceNode.disconnect()
    } catch {}
    silenceNode = null
  }

  if (audioContext) {
    try {
      audioContext.close()
    } catch {}
    audioContext = null
  }

  if (audioStream) {
    audioStream.getTracks().forEach((track) => track.stop())
    audioStream = null
  }
}

export function stopTranscription() {
  streaming = false

  if (websocket && websocket.readyState === WebSocket.OPEN) {
    try {
      websocket.send(JSON.stringify({ type: 'stop_recording' }))
    } catch {}
  }

  setTimeout(() => {
    if (websocket) {
      try {
        websocket.close(1000)
      } catch {}
      websocket = null
    }
    cleanup()
  }, 300)
}

export function getAudioStream() {
  return audioStream
}

export function isConnected() {
  return Boolean(websocket && websocket.readyState === WebSocket.OPEN)
}
