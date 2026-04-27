export async function blobToWav(blob) {
  if (!blob || blob.size === 0) {
    throw new Error('Audio blob is empty')
  }

  if (typeof window === 'undefined') {
    throw new Error('blobToWav can only run in the browser')
  }

  const AudioContextCtor = window.AudioContext || window.webkitAudioContext
  if (!AudioContextCtor) {
    throw new Error('AudioContext is not supported in this browser')
  }

  const audioContext = new AudioContextCtor()

  try {
    const arrayBuffer = await blob.arrayBuffer()
    const decoded = await audioContext.decodeAudioData(arrayBuffer.slice(0))
    const monoBuffer = decoded.numberOfChannels > 1 ? mixToMono(decoded, audioContext) : decoded
    return audioBufferToWavBlob(monoBuffer)
  } finally {
    try {
      await audioContext.close()
    } catch {
      // Ignore close errors.
    }
  }
}

export function audioBufferToWavBlob(audioBuffer) {
  const channelCount = audioBuffer.numberOfChannels
  const sampleRate = audioBuffer.sampleRate
  const frameCount = audioBuffer.length
  const bytesPerSample = 2
  const blockAlign = channelCount * bytesPerSample
  const byteRate = sampleRate * blockAlign
  const dataSize = frameCount * blockAlign
  const wavBuffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(wavBuffer)

  writeString(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeString(view, 8, 'WAVE')
  writeString(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channelCount, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, 16, true)
  writeString(view, 36, 'data')
  view.setUint32(40, dataSize, true)

  let offset = 44
  const channelData = []
  for (let channel = 0; channel < channelCount; channel += 1) {
    channelData.push(audioBuffer.getChannelData(channel))
  }

  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      const sample = clamp(channelData[channel][frame], -1, 1)
      const int16 = sample < 0 ? sample * 0x8000 : sample * 0x7fff
      view.setInt16(offset, int16, true)
      offset += 2
    }
  }

  return new Blob([wavBuffer], { type: 'audio/wav' })
}

function mixToMono(audioBuffer, audioContext) {
  const frameCount = audioBuffer.length
  const sampleRate = audioBuffer.sampleRate
  const channelCount = audioBuffer.numberOfChannels
  const mono = audioContext.createBuffer(1, frameCount, sampleRate)
  const monoData = mono.getChannelData(0)

  for (let frame = 0; frame < frameCount; frame += 1) {
    let sum = 0
    for (let channel = 0; channel < channelCount; channel += 1) {
      sum += audioBuffer.getChannelData(channel)[frame]
    }
    monoData[frame] = sum / channelCount
  }

  return mono
}

function writeString(view, offset, value) {
  for (let i = 0; i < value.length; i += 1) {
    view.setUint8(offset + i, value.charCodeAt(i))
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}
