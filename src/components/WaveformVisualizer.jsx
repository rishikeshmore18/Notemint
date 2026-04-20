import { useEffect, useRef } from 'react'

const BAR_COUNT = 20
const BAR_GAP = 3
const CANVAS_HEIGHT = 40
const ACTIVE_COLOR = '#4F46E5'
const IDLE_COLOR = '#E5E7EB'
const MIN_BAR_HEIGHT = 3

export default function WaveformVisualizer({ isRecording, audioStream }) {
  const canvasRef = useRef(null)
  const animationFrameRef = useRef(null)
  const audioContextRef = useRef(null)
  const analyserRef = useRef(null)
  const sourceRef = useRef(null)
  const resizeObserverRef = useRef(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return undefined

    const resizeCanvas = () => {
      const width = Math.max(1, Math.floor(canvas.clientWidth))
      canvas.width = width
      canvas.height = CANVAS_HEIGHT
      if (!isRecording) drawIdle(canvas)
    }

    resizeCanvas()

    if (typeof ResizeObserver !== 'undefined') {
      resizeObserverRef.current = new ResizeObserver(resizeCanvas)
      resizeObserverRef.current.observe(canvas)
    } else {
      window.addEventListener('resize', resizeCanvas)
    }

    return () => {
      if (resizeObserverRef.current) {
        resizeObserverRef.current.disconnect()
        resizeObserverRef.current = null
      } else {
        window.removeEventListener('resize', resizeCanvas)
      }
    }
  }, [isRecording])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return undefined

    if (!isRecording || !audioStream) {
      cleanupAudio()
      drawIdle(canvas)
      return undefined
    }

    let cancelled = false

    const setup = async () => {
      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext
        if (!AudioCtx) return

        const audioContext = new AudioCtx()
        audioContextRef.current = audioContext
        if (audioContext.state === 'suspended') {
          await audioContext.resume()
        }

        const analyser = audioContext.createAnalyser()
        analyser.fftSize = 64
        analyser.smoothingTimeConstant = 0.8
        analyserRef.current = analyser

        const source = audioContext.createMediaStreamSource(audioStream)
        source.connect(analyser)
        sourceRef.current = source

        const dataArray = new Uint8Array(analyser.frequencyBinCount)

        const render = () => {
          if (cancelled) return

          try {
            analyser.getByteFrequencyData(dataArray)
            drawBars(canvas, dataArray, ACTIVE_COLOR)
          } catch (err) {
            drawIdle(canvas)
          }

          animationFrameRef.current = requestAnimationFrame(render)
        }

        render()
      } catch (err) {
        drawIdle(canvas)
      }
    }

    setup()

    return () => {
      cancelled = true
      cleanupAudio()
      drawIdle(canvas)
    }
  }, [audioStream, isRecording])

  function cleanupAudio() {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current)
      animationFrameRef.current = null
    }

    if (sourceRef.current) {
      sourceRef.current.disconnect()
      sourceRef.current = null
    }

    if (analyserRef.current) {
      analyserRef.current.disconnect()
      analyserRef.current = null
    }

    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {})
      audioContextRef.current = null
    }
  }

  return <canvas ref={canvasRef} style={{ width: '100%', height: '40px', display: 'block' }} />
}

function drawIdle(canvas) {
  const idleData = new Uint8Array(BAR_COUNT).fill(0)
  drawBars(canvas, idleData, IDLE_COLOR)
}

function drawBars(canvas, dataArray, color) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const width = canvas.width
  const height = canvas.height
  const totalGapWidth = (BAR_COUNT - 1) * BAR_GAP
  const barWidth = Math.max(1, (width - totalGapWidth) / BAR_COUNT)

  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = color

  for (let i = 0; i < BAR_COUNT; i += 1) {
    const value = dataArray[i] ?? 0
    const scaledHeight = (value / 255) * height * 0.8
    const barHeight = Math.max(MIN_BAR_HEIGHT, scaledHeight)
    const x = i * (barWidth + BAR_GAP)
    const y = (height - barHeight) / 2

    ctx.fillRect(x, y, barWidth, barHeight)
  }
}
