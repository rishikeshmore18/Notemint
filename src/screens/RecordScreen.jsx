import { useEffect, useMemo, useRef, useState } from 'react'
import WaveformVisualizer from '../components/WaveformVisualizer'
import { getAudioStream, getFullAudioBlob, startTranscription, stopTranscription } from '../lib/gladia'

export default function RecordScreen({ user, onMeetingComplete, onSignOut, onViewHistory, onReEnrollVoice }) {
  const [isRecording, setIsRecording] = useState(false)
  const [segments, setSegments] = useState([])
  const [audioStream, setAudioStream] = useState(null)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [error, setError] = useState(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const segmentsRef = useRef([])
  const transcriptEndRef = useRef(null)
  const menuRef = useRef(null)

  const initial = useMemo(() => {
    const email = user?.email ?? ''
    return email ? email[0].toUpperCase() : 'R'
  }, [user?.email])

  useEffect(() => {
    checkMicPermission()
  }, [])

  useEffect(() => {
    segmentsRef.current = segments
  }, [segments])

  useEffect(() => {
    if (transcriptEndRef.current) {
      transcriptEndRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' })
    }
  }, [segments])

  useEffect(() => {
    if (!isRecording) return undefined

    const timer = setInterval(() => {
      setElapsedSeconds((prev) => prev + 1)
    }, 1000)

    return () => clearInterval(timer)
  }, [isRecording])

  useEffect(() => {
    return () => {
      stopTranscription()
    }
  }, [])

  useEffect(() => {
    if (!menuOpen) return undefined

    const handlePointerDown = (event) => {
      if (!menuRef.current) return
      if (menuRef.current.contains(event.target)) return
      setMenuOpen(false)
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('touchstart', handlePointerDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('touchstart', handlePointerDown)
    }
  }, [menuOpen])

  async function handleRecordClick() {
    if (isRecording) {
      await handleStop()
      return
    }
    await handleStart()
  }

  async function checkMicPermission() {
    try {
      if (navigator.permissions) {
        const result = await navigator.permissions.query({ name: 'microphone' })
        if (result.state === 'denied') {
          setError('Microphone access is blocked. Go to browser settings to allow it.')
        }
        result.onchange = () => {
          if (result.state === 'denied') {
            setError('Microphone access was blocked.')
          } else if (result.state === 'granted') {
            setError(null)
          }
        }
      }
    } catch {
      // permissions API not available - ignore silently
    }
  }

  async function handleStart() {
    if (!navigator.mediaDevices && window.location.protocol === 'http:') {
      setError('Microphone requires HTTPS. Deploy the app or use localhost.')
      return
    }

    setError(null)
    setElapsedSeconds(0)
    setSegments([])
    segmentsRef.current = []

    const started = await startTranscription({
      onSegment: (incomingSegment) => {
        console.log('[RecordScreen] segment received:', incomingSegment)
        handleSegment({
          speaker: normalizeSpeaker(incomingSegment.speaker),
          text: incomingSegment.text,
          isFinal: Boolean(incomingSegment.isFinal),
        })
      },
      onError: (message) => {
        console.log('[RecordScreen] error received:', message)
        const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent)
        if (isSafari && message.toLowerCase().includes('could not access microphone')) {
          setError('use Chrome or Firefox for best experience')
          return
        }
        if (message.toLowerCase().includes('connection')) {
          setError('check your internet connection')
          return
        }
        setError(message)
      },
      onConnected: () => {
        console.log('[RecordScreen] Gladia connected successfully')
      },
    })
    console.log('[RecordScreen] startTranscription called')

    if (!started) {
      setIsRecording(false)
      setAudioStream(null)
      return
    }

    setIsRecording(true)
    setAudioStream(getAudioStream())
  }

  async function handleStop() {
    if (!isRecording) return

    console.log('[RecordScreen] Stop pressed. Current segment count:', segmentsRef.current.length)

    setIsRecording(false)

    stopTranscription()
    setAudioStream(null)
    await delay(1200)

    const finalSegments = segmentsRef.current
    const audioBlob = getFullAudioBlob()
    console.log('[RecordScreen] Audio blob size:', audioBlob?.size, 'bytes')

    console.log('[RecordScreen] Passing segments to results:', finalSegments.length)

    if (finalSegments.length === 0) {
      console.warn('[RecordScreen] No segments captured')
    }

    onMeetingComplete(finalSegments, audioBlob)
  }

  function handleRetry() {
    setError(null)
  }

  function handleSegment(seg) {
    // seg has shape: { speaker: number, text: string, isFinal: boolean }
    setSegments((prev) => {
      const updated = [...prev]
      const last = updated[updated.length - 1]

      if (!seg.isFinal) {
        // PARTIAL: update last entry if same speaker and also partial.
        if (last && !last.isFinal && last.speaker === seg.speaker) {
          updated[updated.length - 1] = { ...seg, id: last.id || Date.now() }
          return updated
        }
        return [...updated, { ...seg, id: Date.now() }]
      }

      // FINAL: replace the last partial from same speaker.
      if (last && !last.isFinal && last.speaker === seg.speaker) {
        updated[updated.length - 1] = { ...seg, id: last.id || Date.now() }
        return updated
      }
      return [...updated, { ...seg, id: Date.now() }]
    })

    // Keep ref in sync for stop handler (avoids stale closure).
    segmentsRef.current = [...segmentsRef.current]
    // We update it after state settles via useEffect instead.
  }

  function getSpeakerBadgeClass(speaker) {
    const colors = [
      'bg-indigo-100 text-indigo-700',
      'bg-emerald-100 text-emerald-700',
      'bg-amber-100 text-amber-700',
      'bg-rose-100 text-rose-700',
    ]
    return colors[speaker % colors.length]
  }

  return (
    <div className="min-h-screen bg-white flex flex-col max-w-2xl mx-auto px-5 md:px-8">
      <div className="w-full flex min-h-screen flex-col">
        <header className="flex h-14 items-center justify-between">
          <p className="text-sm font-medium text-gray-900">recall</p>
          <div className="flex items-center gap-3">
            <button
              onClick={onViewHistory}
              className="text-xs text-gray-400 hover:text-gray-600 transition-colors flex items-center gap-1"
              title="past meetings"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.25" />
                <path
                  d="M7 4.5V7L8.5 8.5"
                  stroke="currentColor"
                  strokeWidth="1.25"
                  strokeLinecap="round"
                />
              </svg>
              history
            </button>
            <div className="relative" ref={menuRef}>
              <button
                type="button"
                onClick={() => setMenuOpen((prev) => !prev)}
                aria-label="Open profile menu"
                className="flex h-8 w-8 items-center justify-center rounded-full bg-indigo-100 text-sm font-medium text-indigo-600"
              >
                {initial}
              </button>

              {menuOpen ? (
                <div className="absolute right-0 mt-2 w-40 rounded-xl border border-gray-200 bg-white shadow-sm z-20 overflow-hidden">
                  <button
                    type="button"
                    onClick={() => {
                      setMenuOpen(false)
                      onReEnrollVoice?.()
                    }}
                    className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                  >
                    re-enroll voice
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setMenuOpen(false)
                      onSignOut()
                    }}
                    className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors border-t border-gray-100"
                  >
                    sign out
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </header>

        {!isRecording && segments.length === 0 ? (
          <main className="flex flex-col items-center justify-center flex-1 text-center px-6">
            <div className="w-16 h-16 rounded-full bg-indigo-50 flex items-center justify-center mb-4">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                <rect x="9" y="2" width="6" height="12" rx="3" stroke="#4F46E5" strokeWidth="1.5" />
                <path
                  d="M5 10C5 14.4 7.8 17 12 17C16.2 17 19 14.4 19 10"
                  stroke="#4F46E5"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
                <line x1="12" y1="17" x2="12" y2="21" stroke="#4F46E5" strokeWidth="1.5" strokeLinecap="round" />
                <line x1="9" y1="21" x2="15" y2="21" stroke="#4F46E5" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </div>
            <p className="text-sm font-medium text-gray-700 mb-1">ready to record</p>
            <p className="text-xs text-gray-400 leading-relaxed max-w-xs">
              tap the button below to start.
              <br />
              speakers are detected automatically.
            </p>
          </main>
        ) : (
          <main className="flex flex-1 flex-col pt-6">
            <div className="w-full" style={{ minHeight: '40px' }}>
              <WaveformVisualizer className="w-full" isRecording={isRecording} audioStream={audioStream} />
            </div>
            <div className="mt-6 flex items-center justify-center gap-3">
              <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />
              <p className="text-3xl font-medium text-gray-900">{formatTime(elapsedSeconds)}</p>
            </div>
            <p className="mt-2 text-center text-xs uppercase tracking-[0.2em] text-gray-400">recording</p>

            <div className="mt-6 overflow-y-auto" style={{ maxHeight: 'calc(100dvh - 280px)' }}>
              <div className="flex flex-col gap-3 pb-2">
                {segments.length === 0 && isRecording && (
                  <p className="text-xs text-gray-400 text-center pt-4">
                    listening... speak now
                  </p>
                )}
                {segments.map((seg, i) => (
                  <div key={seg.id || i} className="flex items-start gap-2.5">
                    <span
                      className={`text-xs font-medium px-2 py-0.5 rounded-full flex-shrink-0 mt-0.5 ${getSpeakerBadgeClass(
                        seg.speaker,
                      )}`}
                    >
                      {seg.speaker === 0 ? 'you' : 'person ' + seg.speaker}
                    </span>
                    <p
                      className={`text-sm leading-relaxed transition-colors duration-200 ${
                        seg.isFinal ? 'text-gray-900' : 'text-gray-400 italic'
                      }`}
                    >
                      {seg.text}
                    </p>
                  </div>
                ))}
                <div ref={transcriptEndRef} />
              </div>
            </div>
          </main>
        )}

        <div className="mt-auto flex flex-col items-center pb-8 pt-4 safe-bottom">
          <button
            type="button"
            onClick={isRecording ? handleStop : handleRecordClick}
            disabled={isRecording ? false : undefined}
            className={`relative flex h-[72px] w-[72px] items-center justify-center rounded-full transition md:h-20 md:w-20 ${
              isRecording
                ? 'border-2 border-indigo-600 bg-white text-indigo-600'
                : 'bg-indigo-600 text-white'
            }`}
          >
            {isRecording ? <PulseRing /> : null}
            {isRecording ? <StopIcon className="h-4 w-4" /> : <MicIcon className="h-6 w-6" />}
          </button>
          <p className="mt-3 text-xs text-gray-400">{isRecording ? 'stop recording' : 'start meeting'}</p>

          {error ? (
            <div className="mt-4 text-center">
              <p className="text-xs text-red-500">{error}</p>
              <button
                type="button"
                onClick={handleRetry}
                className="mt-2 text-xs font-medium text-indigo-600"
              >
                retry
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function normalizeSpeaker(value) {
  const parsed = Number(value)
  if (Number.isNaN(parsed) || parsed < 0) return 0
  return Math.floor(parsed)
}

function formatTime(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, '0')
  const seconds = (totalSeconds % 60).toString().padStart(2, '0')
  return `${minutes}:${seconds}`
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function PulseRing() {
  return <span className="absolute inset-[-6px] rounded-full border-2 border-indigo-200 animate-pulse" />
}

function MicIcon({ className }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path
        d="M12 15a3 3 0 0 0 3-3V7a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3Z"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path d="M19 11.5a7 7 0 1 1-14 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M12 18.5v3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

function StopIcon({ className }) {
  return <div className={`${className} rounded-sm bg-current`} aria-hidden="true" />
}
