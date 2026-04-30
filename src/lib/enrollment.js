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

export async function saveEnrollment(userId) {
  try {
    localStorage.setItem(`enrolled_${userId}`, 'true')
    // Cleanup old data from previous app versions that stored audio in localStorage.
    localStorage.removeItem(`enrolled_audio_${userId}`)
    return true
  } catch (err) {
    console.warn(err)
    return false
  }
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
  if (!segments || segments.length === 0) return {}

  // Count words per speaker
  const wordCounts = {}
  const firstAppearance = {}

  segments.forEach((seg) => {
    const key = seg.speaker
    const words = seg.text.trim().split(/\s+/).filter(Boolean).length
    wordCounts[key] = (wordCounts[key] || 0) + words
    if (firstAppearance[key] === undefined) {
      firstAppearance[key] = seg // track first time this speaker appeared
    }
  })

  const speakerKeys = Object.keys(wordCounts)
    .map(Number)
    .sort((a, b) => a - b)

  if (speakerKeys.length === 0) return {}

  // If only one speaker: they are "You"
  if (speakerKeys.length === 1) {
    return { [speakerKeys[0]]: 'You' }
  }

  // With multiple speakers:
  // The speaker who spoke the MOST words is "You" (the one running the meeting)
  // This heuristic works for most meeting scenarios where the host speaks more
  const maxSpeaker = speakerKeys.reduce(
    (max, key) => (wordCounts[key] > wordCounts[max] ? key : max),
    speakerKeys[0],
  )

  const labelMap = {}
  let personIndex = 1

  // Sort remaining speakers by word count descending for consistent labeling
  speakerKeys
    .filter((key) => key !== maxSpeaker)
    .sort((a, b) => wordCounts[b] - wordCounts[a])
    .forEach((key) => {
      labelMap[key] = 'Person ' + personIndex
      personIndex++
    })

  labelMap[maxSpeaker] = 'You'

  console.log('[Enrollment] Speaker label map:', labelMap)
  console.log('[Enrollment] Word counts:', wordCounts)

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
