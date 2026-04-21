const PHRASES = [
  'the quick brown fox jumps over the lazy dog',
  'my name is being recorded for voice recognition',
  'hello this is a test of the meeting app',
  'I will be identified as the host of this meeting',
  'voice recognition helps label the transcript correctly',
]

export function getEnrollmentPhrases() {
  return PHRASES
}

export async function recordPhrase(durationMs = 4000) {
  let stream

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: 16000,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
    })
  } catch (err) {
    if (err.name === 'NotAllowedError') {
      throw new Error('MICROPHONE_DENIED')
    }
    if (err.name === 'NotFoundError') {
      throw new Error('MICROPHONE_NOT_FOUND')
    }
    throw new Error(`MICROPHONE_ERROR: ${err.message}`)
  }

  const mimeType = getPreferredMimeType()
  const recorder =
    mimeType === ''
      ? new MediaRecorder(stream)
      : new MediaRecorder(stream, {
          mimeType,
        })

  return new Promise((resolve, reject) => {
    const chunks = []
    let settled = false

    const stopTracks = () => {
      stream.getTracks().forEach((track) => track.stop())
    }

    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        chunks.push(event.data)
      }
    }

    recorder.onstop = () => {
      if (settled) return
      settled = true
      stopTracks()
      resolve(new Blob(chunks, mimeType ? { type: mimeType } : undefined))
    }

    recorder.onerror = (event) => {
      if (settled) return
      settled = true
      stopTracks()
      reject(event.error)
    }

    recorder.start()

    setTimeout(() => {
      if (recorder.state !== 'inactive') {
        recorder.stop()
      }
    }, durationMs)
  })
}

export async function saveEnrollment(userId, blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()

    reader.onloadend = () => {
      try {
        localStorage.setItem(`enrolled_audio_${userId}`, reader.result)
        localStorage.setItem(`enrolled_${userId}`, 'true')
        resolve(true)
      } catch (err) {
        if (err.name === 'QuotaExceededError') {
          try {
            localStorage.setItem(`enrolled_${userId}`, 'true')
          } catch (storageErr) {
            console.warn(storageErr)
          }
          console.warn(err)
          resolve(false)
          return
        }
        reject(err)
      }
    }

    reader.onerror = () => {
      reject(reader.error)
    }

    reader.readAsDataURL(blob)
  })
}

export function getEnrollment(userId) {
  try {
    return localStorage.getItem(`enrolled_${userId}`) === 'true'
  } catch (err) {
    return false
  }
}

export function clearEnrollment(userId) {
  try {
    localStorage.removeItem(`enrolled_audio_${userId}`)
    localStorage.removeItem(`enrolled_${userId}`)
  } catch (err) {
    // Ignore storage cleanup errors.
  }
}

export function matchSpeakers(segments) {
  if (!segments || segments.length === 0) {
    return {}
  }

  const wordCounts = {}

  segments.forEach((seg) => {
    const key = seg.speaker
    const words = seg.text.trim().split(/\s+/).filter(Boolean).length
    wordCounts[key] = (wordCounts[key] || 0) + words
  })

  const speakers = Object.keys(wordCounts).map(Number)
  if (speakers.length === 0) {
    return {}
  }

  let youSpeaker = speakers[0]
  speakers.forEach((speaker) => {
    if (wordCounts[speaker] > wordCounts[youSpeaker]) {
      youSpeaker = speaker
    }
  })

  const labelMap = {
    [youSpeaker]: 'You',
  }

  const otherSpeakers = speakers
    .filter((speaker) => speaker !== youSpeaker)
    .sort((a, b) => wordCounts[b] - wordCounts[a])

  otherSpeakers.forEach((speaker, index) => {
    labelMap[speaker] = `Person ${index + 1}`
  })

  return labelMap
}

function getPreferredMimeType() {
  const priorities = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4', '']

  for (const type of priorities) {
    if (type === '' || MediaRecorder.isTypeSupported(type)) {
      return type
    }
  }

  return ''
}
