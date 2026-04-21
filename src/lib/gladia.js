const GLADIA_WS_URL = 'wss://api.gladia.io/audio/text/audio-transcription'

let websocket = null
let mediaRecorder = null
let audioStream = null

export async function startTranscription({ onSegment, onError, onConnected }) {
  // Step 1: Get microphone
  try {
    audioStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: 16000,
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

  // Step 2: Open WebSocket
  websocket = new WebSocket(GLADIA_WS_URL)
  websocket.binaryType = 'arraybuffer'

  websocket.onopen = () => {
    // Send config as JSON immediately
    const config = {
      x_gladia_key: import.meta.env.VITE_GLADIA_KEY,
      encoding: 'wav/pcm',
      sample_rate: 16000,
      language_behaviour: 'automatic single language',
      diarization: true,
      diarization_config: {
        number_of_speakers: 0,
        min_speakers: 1,
        max_speakers: 4,
      },
    }

    websocket.send(JSON.stringify(config))

    // Start sending audio chunks after config is sent
    startAudioStream(onSegment, onError)

    if (onConnected) onConnected()
  }

  websocket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data)

      // Gladia sends { event: 'transcript', type: 'final'|'partial', transcription: '...', speaker: 0 }
      // Also handles older format: { transcription: '...', speaker: 0, type: 'final' }
      const text = data.transcription || data.transcript || ''
      const type = data.type || ''
      const isFinal = type === 'final'
      const speakerRaw = data.speaker

      // Normalize speaker to integer
      const speaker =
        typeof speakerRaw === 'number' ? speakerRaw : parseInt(speakerRaw ?? '0', 10) || 0

      if (!text || !text.trim()) return

      onSegment({
        speaker,
        text: text.trim(),
        isFinal,
      })
    } catch (err) {
      // Ignore malformed messages
    }
  }

  websocket.onerror = (event) => {
    console.error('[Gladia] WebSocket error:', event)
    onError('Transcription connection failed. Check your Gladia API key and internet connection.')
  }

  websocket.onclose = (event) => {
    console.log('[Gladia] WebSocket closed. Code:', event.code, 'Reason:', event.reason)
    if (event.code !== 1000 && event.code !== 1001) {
      onError(
        'Transcription disconnected (code ' +
          event.code +
          '). ' +
          (event.reason || 'Check your API key.'),
      )
    }
  }

  return true
}

function startAudioStream(onSegment, onError) {
  if (!audioStream) return

  // Find the best supported MIME type
  const mimeTypes = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
    '',
  ]

  let mimeType = ''
  for (const type of mimeTypes) {
    if (!type || MediaRecorder.isTypeSupported(type)) {
      mimeType = type
      break
    }
  }

  try {
    const options = mimeType ? { mimeType } : {}
    mediaRecorder = new MediaRecorder(audioStream, options)
  } catch (err) {
    try {
      mediaRecorder = new MediaRecorder(audioStream)
    } catch (err2) {
      onError('Could not start audio recorder: ' + err2.message)
      return
    }
  }

  mediaRecorder.ondataavailable = async (event) => {
    if (!event.data || event.data.size === 0) return
    if (!websocket || websocket.readyState !== WebSocket.OPEN) return

    try {
      // Convert blob to base64 and send as JSON frame.
      // This is more compatible across browsers than raw binary.
      const arrayBuffer = await event.data.arrayBuffer()
      const uint8Array = new Uint8Array(arrayBuffer)
      let binary = ''
      uint8Array.forEach((byte) => {
        binary += String.fromCharCode(byte)
      })
      const base64 = btoa(binary)

      websocket.send(JSON.stringify({ frames: base64 }))
    } catch (err) {
      console.warn('[Gladia] Failed to send audio chunk:', err)
    }
  }

  mediaRecorder.onerror = (err) => {
    console.error('[Gladia] MediaRecorder error:', err)
    onError('Audio recording error: ' + err.message)
  }

  // 250ms chunks for near-real-time feel
  mediaRecorder.start(250)
}

export function stopTranscription() {
  // Send finalize message so Gladia flushes final transcript
  if (websocket && websocket.readyState === WebSocket.OPEN) {
    try {
      websocket.send(JSON.stringify({ event: 'terminate' }))
    } catch {}
  }

  setTimeout(() => {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      try {
        mediaRecorder.stop()
      } catch {}
    }
    if (audioStream) {
      audioStream.getTracks().forEach((track) => track.stop())
    }
    if (websocket) {
      try {
        websocket.close(1000)
      } catch {}
    }
    websocket = null
    mediaRecorder = null
    audioStream = null
  }, 500)
}

export function getAudioStream() {
  return audioStream
}

export function isConnected() {
  return websocket && websocket.readyState === WebSocket.OPEN
}
