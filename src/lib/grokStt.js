/**
 * Grok STT Post-Processing
 * Called AFTER recording stops with the full audio blob.
 * Returns diarized segments with timestamps.
 *
 * API: POST https://api.x.ai/v1/stt
 * Auth: Bearer token in Authorization header (not exposed worse than other keys)
 * Pricing: $0.10/hour for batch REST
 */

export async function getDiarizedTranscript(audioBlob, onProgress, onComplete, onError) {
  const xaiKey = import.meta.env.VITE_XAI_KEY

  if (!xaiKey) {
    console.warn('[GrokSTT] No VITE_XAI_KEY found, skipping diarization')
    onError('XAI API key not configured')
    return null
  }

  if (!audioBlob || audioBlob.size === 0) {
    onError('No audio recorded')
    return null
  }

  console.log('[GrokSTT] Sending', (audioBlob.size / 1024).toFixed(1), 'KB to Grok STT')
  if (onProgress) onProgress('Analysing speakers...')

  try {
    const formData = new FormData()

    // Determine file extension from blob type.
    const mimeToExt = {
      'audio/webm': 'webm',
      'audio/webm;codecs=opus': 'webm',
      'audio/ogg': 'ogg',
      'audio/ogg;codecs=opus': 'ogg',
      'audio/mp4': 'mp4',
      'audio/mpeg': 'mp3',
    }
    const ext = mimeToExt[audioBlob.type] || 'webm'
    const filename = 'meeting.' + ext

    formData.append('file', audioBlob, filename)
    formData.append('model', 'grok-stt')
    formData.append('diarize', 'true')
    formData.append('timestamps', 'true')
    formData.append('language', 'auto')

    const response = await fetch('https://api.x.ai/v1/stt', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + xaiKey,
        // Do NOT set Content-Type; browser sets it with boundary automatically for FormData.
      },
      body: formData,
    })

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({}))
      console.error('[GrokSTT] API error:', response.status, errBody)
      onError('Diarization failed: ' + (errBody.error?.message || 'HTTP ' + response.status))
      return null
    }

    const result = await response.json()
    console.log('[GrokSTT] Response:', result)

    // Parse Grok STT response into our segment format.
    const segments = parseGrokResponse(result)
    console.log('[GrokSTT] Parsed', segments.length, 'diarized segments')

    if (onComplete) onComplete(segments)
    return segments
  } catch (err) {
    if (err.name === 'AbortError') return null
    console.error('[GrokSTT] Fetch error:', err)
    onError('Could not reach Grok STT: ' + err.message)
    return null
  }
}

function parseGrokResponse(result) {
  /**
   * Grok STT response shape (based on xAI docs):
   * {
   *   text: "full transcript",
   *   words: [
   *     { word: "hello", start: 0.0, end: 0.5, speaker: 0 },
   *     { word: "world", start: 0.6, end: 1.0, speaker: 1 },
   *     ...
   *   ],
   *   segments: [ ... ]  // may also have utterance-level segments
   * }
   *
   * We convert this to our app's format:
   * { speaker: number, text: string, startTime: number, endTime: number, isFinal: true }
   */

  // Try utterance-level segments first (cleaner).
  if (result.segments && Array.isArray(result.segments) && result.segments.length > 0) {
    return result.segments
      .map((seg) => ({
        speaker: typeof seg.speaker === 'number' ? seg.speaker : parseInt(seg.speaker || '0', 10),
        text: seg.text || seg.transcript || '',
        startTime: seg.start || seg.start_time || 0,
        endTime: seg.end || seg.end_time || 0,
        isFinal: true,
        source: 'grok',
      }))
      .filter((s) => s.text.trim().length > 0)
  }

  // Fallback: group word-level timestamps by speaker.
  if (result.words && Array.isArray(result.words) && result.words.length > 0) {
    return groupWordsIntoSegments(result.words)
  }

  // Last fallback: single segment with full text.
  if (result.text) {
    return [
      {
        speaker: 0,
        text: result.text,
        startTime: 0,
        endTime: 0,
        isFinal: true,
        source: 'grok-fallback',
      },
    ]
  }

  return []
}

function groupWordsIntoSegments(words) {
  if (!words || words.length === 0) return []

  const segments = []
  let currentSpeaker = words[0].speaker ?? 0
  let currentWords = []
  let segStart = words[0].start || 0

  words.forEach((word, i) => {
    const speaker = typeof word.speaker === 'number' ? word.speaker : parseInt(word.speaker || '0', 10)

    if (speaker !== currentSpeaker) {
      // Speaker changed; close current segment.
      if (currentWords.length > 0) {
        segments.push({
          speaker: currentSpeaker,
          text: currentWords.join(' '),
          startTime: segStart,
          endTime: words[i - 1].end || 0,
          isFinal: true,
          source: 'grok',
        })
      }
      // Start new segment.
      currentSpeaker = speaker
      currentWords = [word.word || word.text || '']
      segStart = word.start || 0
    } else {
      currentWords.push(word.word || word.text || '')
    }
  })

  // Close final segment.
  if (currentWords.length > 0) {
    segments.push({
      speaker: currentSpeaker,
      text: currentWords.join(' '),
      startTime: segStart,
      endTime: words[words.length - 1].end || 0,
      isFinal: true,
      source: 'grok',
    })
  }

  return segments
}

/**
 * Calculate smart time window size based on total duration
 * Short meetings: 5-second windows
 * Long meetings: 30-second windows
 */
export function getTimeWindowSeconds(totalDurationSeconds) {
  if (totalDurationSeconds <= 60) return 5
  if (totalDurationSeconds <= 180) return 10
  if (totalDurationSeconds <= 300) return 15
  if (totalDurationSeconds <= 600) return 20
  return 30
}

/**
 * Group segments into time windows for the transcript display
 * Returns array of { timeLabel, speaker, text } objects
 */
export function groupSegmentsByTime(segments) {
  if (!segments || segments.length === 0) return []

  // Filter segments that have timestamps.
  const timedSegments = segments.filter((s) => typeof s.startTime === 'number' && s.startTime >= 0)

  if (timedSegments.length === 0) {
    // No timestamps: just return the segments as-is.
    return segments.map((s) => ({
      timeLabel: null,
      speaker: s.speaker,
      text: s.text,
      startTime: 0,
    }))
  }

  const maxTime = Math.max(...timedSegments.map((s) => s.endTime || s.startTime))
  const windowSize = getTimeWindowSeconds(maxTime)

  // Group by time window.
  const windows = {}
  timedSegments.forEach((seg) => {
    const windowStart = Math.floor(seg.startTime / windowSize) * windowSize
    const key = windowStart
    if (!windows[key]) {
      windows[key] = {
        timeLabel: formatTime(windowStart),
        windowStart,
        segments: [],
      }
    }
    windows[key].segments.push(seg)
  })

  // Flatten windows into display blocks.
  const result = []
  Object.values(windows)
    .sort((a, b) => a.windowStart - b.windowStart)
    .forEach((window) => {
      let showLabel = true
      window.segments.forEach((seg) => {
        result.push({
          timeLabel: showLabel ? window.timeLabel : null,
          speaker: seg.speaker,
          text: seg.text,
          startTime: seg.startTime,
        })
        showLabel = false
      })
    })

  return result
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return m + ':' + String(s).padStart(2, '0')
}

