import { grokDiarizeAudio } from './api.js'

/**
 * Grok STT Post-Processing
 * Called AFTER recording stops with the full audio blob.
 * Returns diarized segments with timestamps.
 *
 * API now goes through backend: POST /api/grok
 */

export async function getDiarizedTranscript(audioBlob, onProgress, onComplete, onError) {
  if (!audioBlob || audioBlob.size === 0) {
    onError('No audio recorded')
    return null
  }

  console.log('[GrokSTT] Sending', (audioBlob.size / 1024).toFixed(1), 'KB to backend Grok route')
  if (onProgress) onProgress('Analysing speakers...')

  try {
    const backendSegments = await grokDiarizeAudio(audioBlob)
    const segments = normalizeSegments(backendSegments)
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

function normalizeSegments(segments) {
  if (!Array.isArray(segments)) return []
  return segments
    .map((seg) => ({
      speaker: normalizeSpeaker(seg?.speaker),
      text: String(seg?.text || '').trim(),
      startTime: toNumber(seg?.startTime),
      endTime: toNumber(seg?.endTime),
      confidence: typeof seg?.confidence === 'number' ? seg.confidence : 1,
      source: seg?.source || 'grok',
      isFinal: seg?.isFinal !== false,
    }))
    .filter((seg) => seg.text.length > 0)
}

function normalizeSpeaker(value) {
  const parsed = Number(value)
  if (Number.isNaN(parsed) || parsed < 0) return 0
  return Math.floor(parsed)
}

function toNumber(value) {
  const parsed = Number(value)
  if (Number.isNaN(parsed) || parsed < 0) return 0
  return parsed
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
