const INTERJECTION_SET = new Set([
  'yes',
  'no',
  'right',
  'okay',
  'ok',
  'sure',
  'yeah',
  'yep',
  'nope',
  'hmm',
  'uh-huh',
  'mm-hmm',
])

export function repairSpeakerTurns(segments) {
  const input = Array.isArray(segments) ? segments : []
  if (input.length <= 1) return input

  const normalized = input.map((segment, index) => ({
    ...segment,
    __repairMeta: {
      originalIndex: index,
      originalSpeaker: segment?.speaker,
    },
  }))

  const sameSpeakerMerged = mergeAdjacentSameSpeaker(normalized)
  const fragmentRepaired = repairLikelyFragmentSwaps(sameSpeakerMerged)

  return fragmentRepaired.map(({ __repairMeta, ...segment }) => segment)
}

function mergeAdjacentSameSpeaker(segments) {
  const out = []

  for (const current of segments) {
    const previous = out[out.length - 1]
    if (!previous) {
      out.push(current)
      continue
    }

    if (!canMergeSameSpeaker(previous, current)) {
      out.push(current)
      continue
    }

    out[out.length - 1] = mergeSegments(previous, current, 'same_speaker_small_gap')
  }

  return out
}

function canMergeSameSpeaker(previous, current) {
  if (Number(previous?.speaker) !== Number(current?.speaker)) return false

  const gap = computeGap(previous?.endTime, current?.startTime)
  if (gap !== null && gap > 0.8) return false
  if (gap !== null && gap < -0.25) return false

  return true
}

function repairLikelyFragmentSwaps(segments) {
  if (segments.length < 3) return segments

  const out = [...segments]
  let index = 1

  while (index < out.length - 1) {
    const previous = out[index - 1]
    const fragment = out[index]
    const next = out[index + 1]

    if (shouldReassignFragment(previous, fragment, next)) {
      const merged = mergeSegments(mergeSegments(previous, fragment, 'fragment_reassign'), next, 'fragment_reassign')
      merged.uncertain = markUncertain(merged)
      out.splice(index - 1, 3, merged)
      index = Math.max(1, index - 1)
      continue
    }

    index += 1
  }

  return out
}

function shouldReassignFragment(previous, fragment, next) {
  if (!previous || !fragment || !next) return false
  if (Number(previous.speaker) !== Number(next.speaker)) return false
  if (Number(fragment.speaker) === Number(previous.speaker)) return false

  const fragmentText = cleanText(fragment.text)
  if (!fragmentText) return false
  if (isLikelyInterjection(fragmentText)) return false

  const fragmentWords = wordCount(fragmentText)
  if (fragmentWords > 4) return false

  const fragmentDuration = durationSeconds(fragment.startTime, fragment.endTime)
  if (fragmentDuration !== null && fragmentDuration > 1.2) return false

  const leftGap = computeGap(previous.endTime, fragment.startTime)
  const rightGap = computeGap(fragment.endTime, next.startTime)
  if (leftGap !== null && (leftGap < -0.2 || leftGap > 0.7)) return false
  if (rightGap !== null && (rightGap < -0.2 || rightGap > 0.7)) return false

  const fragmentConfidence = toConfidence(fragment.confidence)
  const allowConfidenceReassign =
    fragment.uncertain === true || fragmentConfidence === null || fragmentConfidence <= 0.58
  if (!allowConfidenceReassign) return false

  const previousConfidence = toConfidence(previous.confidence)
  const nextConfidence = toConfidence(next.confidence)
  const strongNeighbors =
    (previousConfidence === null || previousConfidence >= 0.62) &&
    (nextConfidence === null || nextConfidence >= 0.62)
  if (!strongNeighbors) return false

  if (fragmentWords >= 3 && /^(i|we)\b/i.test(fragmentText)) return false

  return true
}

function mergeSegments(first, second, reason) {
  const text = joinText(first?.text, second?.text)
  const mergedFrom = [
    ...(Array.isArray(first?.repairMeta?.mergedFrom) ? first.repairMeta.mergedFrom : [extractOrigin(first)]),
    ...(Array.isArray(second?.repairMeta?.mergedFrom) ? second.repairMeta.mergedFrom : [extractOrigin(second)]),
  ].filter(Boolean)

  const confidence = meanConfidence(first?.confidence, second?.confidence)
  const speakerConfidence = meanConfidence(first?.speakerConfidence, second?.speakerConfidence)
  const wordConfidence = meanConfidence(first?.wordConfidence, second?.wordConfidence)

  const merged = {
    ...first,
    text,
    startTime: minNullable(first?.startTime, second?.startTime),
    endTime: maxNullable(first?.endTime, second?.endTime),
    confidence,
    speakerConfidence,
    wordConfidence,
    uncertain: false,
    repairMeta: {
      repaired: true,
      reason,
      mergedFrom,
    },
  }

  merged.uncertain = markUncertain(merged)
  return merged
}

function extractOrigin(segment) {
  if (!segment) return null
  const { __repairMeta, ...rest } = segment
  return {
    originalIndex: __repairMeta?.originalIndex,
    speaker: rest?.speaker,
    startTime: rest?.startTime ?? null,
    endTime: rest?.endTime ?? null,
    confidence: rest?.confidence ?? null,
    text: String(rest?.text || ''),
  }
}

function joinText(first, second) {
  const a = cleanText(first)
  const b = cleanText(second)
  if (!a) return b
  if (!b) return a

  const noSpaceBefore = /^[,.;:!?)]/.test(b)
  if (noSpaceBefore) return `${a}${b}`
  return `${a} ${b}`.replace(/\s+/g, ' ').trim()
}

function cleanText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
}

function wordCount(value) {
  const text = cleanText(value)
  if (!text) return 0
  return text.split(' ').filter(Boolean).length
}

function isLikelyInterjection(text) {
  const normalized = cleanText(text).toLowerCase().replace(/[.!?,]/g, '')
  return INTERJECTION_SET.has(normalized)
}

function durationSeconds(startTime, endTime) {
  const start = Number(startTime)
  const end = Number(endTime)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  if (end < start) return null
  return end - start
}

function computeGap(endTime, startTime) {
  const end = Number(endTime)
  const start = Number(startTime)
  if (!Number.isFinite(end) || !Number.isFinite(start)) return null
  return start - end
}

function toConfidence(value) {
  const num = Number(value)
  if (!Number.isFinite(num)) return null
  return num
}

function meanConfidence(a, b) {
  const x = toConfidence(a)
  const y = toConfidence(b)
  if (x === null && y === null) return null
  if (x === null) return y
  if (y === null) return x
  return Math.max(0, Math.min(1, (x + y) / 2))
}

function minNullable(a, b) {
  const x = Number(a)
  const y = Number(b)
  const xValid = Number.isFinite(x)
  const yValid = Number.isFinite(y)
  if (!xValid && !yValid) return null
  if (!xValid) return y
  if (!yValid) return x
  return Math.min(x, y)
}

function maxNullable(a, b) {
  const x = Number(a)
  const y = Number(b)
  const xValid = Number.isFinite(x)
  const yValid = Number.isFinite(y)
  if (!xValid && !yValid) return null
  if (!xValid) return y
  if (!yValid) return x
  return Math.max(x, y)
}

function markUncertain(segment) {
  const text = cleanText(segment?.text)
  if (!text) return true
  if (segment?.uncertain === true) return true

  const confidence = toConfidence(segment?.confidence)
  if (confidence !== null && confidence < 0.6) return true

  const words = wordCount(text)
  const duration = durationSeconds(segment?.startTime, segment?.endTime)
  if (words <= 1) return true
  if (duration !== null && duration < 0.7 && words <= 3) return true

  return false
}
