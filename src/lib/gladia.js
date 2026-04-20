const GLADIA_URL = 'wss://api.gladia.io/audio/text/audio-transcription'

let websocket = null
let mediaRecorder = null
let audioStream = null
let animationFrameId = null

export async function startTranscription({ onSegment, onError }) {
  // 1. Request microphone with specific constraints for quality
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
      onError('Microphone access denied. Please allow microphone in your browser settings.')
      return false
    }
    if (err.name === 'NotFoundError') {
      onError('No microphone found. Please connect a microphone.')
      return false
    }
    onError(`Could not access microphone: ${err.message}`)
    return false
  }

  // 2. Open WebSocket to Gladia
  websocket = new WebSocket(GLADIA_URL)

  websocket.onerror = () => {
    onError('Connection to transcription service failed. Check your internet connection.')
  }

  websocket.onclose = (event) => {
    if (event.code !== 1000) {
      onError(`Transcription connection closed unexpectedly (code: ${event.code})`)
    }
  }

  websocket.onopen = () => {
    // Send config immediately on open
    websocket.send(
      JSON.stringify({
        x_gladia_key: import.meta.env.VITE_GLADIA_KEY,
        encoding: 'WAV/PCM',
        sample_rate: 16000,
        language_behaviour: 'automatic single language',
        output_encoding: 'utf-8',
        diarization: true,
        diarization_config: {
          number_of_speakers: 0,
          min_speakers: 1,
          max_speakers: 4,
        },
      }),
    )

    // 3. Start MediaRecorder and stream audio chunks
    // Use timeslice of 250ms for near-real-time streaming
    try {
      mediaRecorder = new MediaRecorder(audioStream, {
        mimeType: getSupportedMimeType(),
      })
    } catch (err) {
      mediaRecorder = new MediaRecorder(audioStream)
    }

    mediaRecorder.ondataavailable = async (event) => {
      if (event.data.size > 0 && websocket && websocket.readyState === WebSocket.OPEN) {
        const arrayBuffer = await event.data.arrayBuffer()
        websocket.send(arrayBuffer)
      }
    }

    mediaRecorder.start(250)
  }

  websocket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data)
      // Gladia response structure
      if (data.event === 'transcript' && data.transcription) {
        const text = data.transcription.trim()
        if (!text) return

        onSegment({
          speaker: data.speaker ?? 0,
          text,
          isFinal: data.type === 'final',
          confidence: data.confidence ?? 1,
        })
      }
    } catch (err) {
      // Ignore malformed messages silently
    }
  }

  return true
}

export function stopTranscription() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop()
  }
  if (websocket) {
    websocket.close(1000, 'Recording stopped by user')
    websocket = null
  }
  if (audioStream) {
    audioStream.getTracks().forEach((track) => track.stop())
    audioStream = null
  }
  mediaRecorder = null
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId)
    animationFrameId = null
  }
}

export function getAudioStream() {
  return audioStream
}

function getSupportedMimeType() {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg']
  for (const type of types) {
    if (MediaRecorder.isTypeSupported(type)) return type
  }
  return ''
}
