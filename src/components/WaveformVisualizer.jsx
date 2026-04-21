import React, { useEffect, useRef } from 'react'

export default function WaveformVisualizer({ isRecording, audioStream, className = '' }) {
  const canvasRef = useRef(null)
  const animFrameRef = useRef(null)
  const analyserRef = useRef(null)
  const audioCtxRef = useRef(null)
  const sourceRef = useRef(null)
  const roRef = useRef(null)

  // Draw a flat idle state (grey bars)
  function drawIdle(canvas, ctx) {
    const dpr = window.devicePixelRatio || 1
    const w = canvas.offsetWidth
    const h = 40

    canvas.width = w * dpr
    canvas.height = h * dpr
    canvas.style.width = w + 'px'
    canvas.style.height = h + 'px'
    ctx.scale(dpr, dpr)

    ctx.clearRect(0, 0, w, h)

    const barCount = 20
    const gap = 3
    const barWidth = (w - gap * (barCount - 1)) / barCount

    for (let i = 0; i < barCount; i++) {
      const x = i * (barWidth + gap)
      const barH = 3
      const y = (h - barH) / 2
      ctx.fillStyle = '#E5E7EB'
      ctx.beginPath()
      ctx.roundRect(x, y, barWidth, barH, 2)
      ctx.fill()
    }
  }

  // Draw animated bars from frequency data
  function drawActive(canvas, ctx, analyser) {
    const dpr = window.devicePixelRatio || 1
    const w = canvas.offsetWidth
    const h = 40

    canvas.width = w * dpr
    canvas.height = h * dpr
    canvas.style.width = w + 'px'
    canvas.style.height = h + 'px'
    ctx.scale(dpr, dpr)

    const dataArray = new Uint8Array(analyser.frequencyBinCount)

    function draw() {
      animFrameRef.current = requestAnimationFrame(draw)

      analyser.getByteFrequencyData(dataArray)
      ctx.clearRect(0, 0, w, h)

      const barCount = 20
      const gap = 3
      const barWidth = (w - gap * (barCount - 1)) / barCount

      for (let i = 0; i < barCount; i++) {
        const dataIndex = Math.floor((i / barCount) * dataArray.length)
        const value = dataArray[dataIndex] / 255
        const barH = Math.max(3, value * h * 0.85)
        const x = i * (barWidth + gap)
        const y = (h - barH) / 2

        // Gradient: bright indigo at peak, softer at base
        const alpha = 0.5 + value * 0.5
        ctx.fillStyle = `rgba(79, 70, 229, ${alpha})`
        ctx.beginPath()
        ctx.roundRect(x, y, barWidth, barH, 2)
        ctx.fill()
      }
    }

    draw()
  }

  function cleanup() {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current)
      animFrameRef.current = null
    }
    if (sourceRef.current) {
      try {
        sourceRef.current.disconnect()
      } catch {}
      sourceRef.current = null
    }
    if (audioCtxRef.current) {
      try {
        audioCtxRef.current.close()
      } catch {}
      audioCtxRef.current = null
    }
    analyserRef.current = null
  }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')

    // ResizeObserver keeps canvas sharp when container resizes
    roRef.current = new ResizeObserver(() => {
      if (!isRecording || !analyserRef.current) {
        drawIdle(canvas, ctx)
      }
    })
    roRef.current.observe(canvas)

    return () => {
      if (roRef.current) roRef.current.disconnect()
      cleanup()
    }
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')

    if (!isRecording || !audioStream) {
      cleanup()
      drawIdle(canvas, ctx)
      return
    }

    // Start audio analysis
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext
      if (!AudioContext) {
        drawIdle(canvas, ctx)
        return
      }

      audioCtxRef.current = new AudioContext()

      // Resume context — required by Safari after user gesture
      if (audioCtxRef.current.state === 'suspended') {
        audioCtxRef.current.resume()
      }

      analyserRef.current = audioCtxRef.current.createAnalyser()
      analyserRef.current.fftSize = 64
      analyserRef.current.smoothingTimeConstant = 0.75

      sourceRef.current = audioCtxRef.current.createMediaStreamSource(audioStream)
      sourceRef.current.connect(analyserRef.current)

      drawActive(canvas, ctx, analyserRef.current)
    } catch (err) {
      // If AudioContext fails (old browser, permissions issue), show idle state
      console.warn('WaveformVisualizer: AudioContext error', err)
      drawIdle(canvas, ctx)
    }

    return () => {
      cleanup()
    }
  }, [isRecording, audioStream])

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ display: 'block', width: '100%', height: '40px' }}
    />
  )
}
