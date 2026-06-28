import { useEffect, useMemo, useRef, useState } from 'react'
import WaveformVisualizer from '../components/WaveformVisualizer'
import { getAudioStream, getFullAudioBlob, startTranscription, stopTranscription } from '../lib/gladia'
import { getContextProfile, getCorrectionMemory, parseTerms } from '../lib/contextProfile'
import { supabase } from '../lib/supabase'

const AUDIO_FILE_ACCEPT = 'audio/*,.aac,.aif,.aiff,.flac,.m4a,.mp3,.mp4,.oga,.ogg,.opus,.wav,.webm'
const AUDIO_FILE_EXTENSIONS = new Set([
  'aac',
  'aif',
  'aiff',
  'flac',
  'm4a',
  'mp3',
  'mp4',
  'oga',
  'ogg',
  'opus',
  'wav',
  'webm',
])

export default function RecordScreen({
  user,
  voiceEnrollmentIssue = null,
  onMeetingComplete,
  onSignOut,
  onViewHistory,
  onReEnrollVoice,
  onEditContext,
  onOpenCorrectionDictionary,
  onGoHome,
}) {
  const [isRecording, setIsRecording] = useState(false)
  const liveTranscriptEnabled = false
  const setLiveTranscriptEnabled = () => {}
  const [segments, setSegments] = useState([])
  const [audioStream, setAudioStream] = useState(null)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [error, setError] = useState(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [meetingDetailsMode, setMeetingDetailsMode] = useState('unset')
  const [showStartChoice, setShowStartChoice] = useState(false)
  const [startChoiceAction, setStartChoiceAction] = useState('record')
  const [pendingUploadFile, setPendingUploadFile] = useState(null)
  const [meetingTopic, setMeetingTopic] = useState('')
  const [meetingGoal, setMeetingGoal] = useState('')
  const [expectedParticipantCount, setExpectedParticipantCount] = useState('')
  const [contextProfile, setContextProfile] = useState(null)
  const [correctionMemory, setCorrectionMemory] = useState({ boostTerms: [], confusionPairs: [] })
  const segmentsRef = useRef([])
  const transcriptEndRef = useRef(null)
  const menuRef = useRef(null)
  const fileInputRef = useRef(null)
  const silentRecorderRef = useRef(null)
  const silentAudioStreamRef = useRef(null)
  const silentChunksRef = useRef([])

  const initial = useMemo(() => {
    const email = user?.email ?? ''
    return email ? email[0].toUpperCase() : 'R'
  }, [user?.email])

  useEffect(() => {
    checkMicPermission()
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (!user?.id) return
      try {
        const profile = await getContextProfile(supabase, user.id)
        const correction = await getCorrectionMemory(supabase, user.id).catch(() => ({
          boostTerms: [],
          confusionPairs: [],
        }))
        if (cancelled) return
        setContextProfile(profile || null)
        setCorrectionMemory(correction)
      } catch (err) {
        if (!cancelled) {
          console.warn('[RecordScreen] Could not load context profile:', err?.message || err)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [user?.id])

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
      if (silentRecorderRef.current?.state !== 'inactive') {
        try {
          silentRecorderRef.current.stop()
        } catch {}
      }
      silentAudioStreamRef.current?.getTracks().forEach((track) => track.stop())
      setAudioStream(null)
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
    if (meetingDetailsMode === 'unset') {
      setStartChoiceAction('record')
      setShowStartChoice(true)
      return
    }
    await handleStart(meetingDetailsMode)
  }

  function handleUploadClick() {
    if (isRecording) return
    setError(null)
    fileInputRef.current?.click()
  }

  function handleAudioFileSelected(event) {
    const file = event.target.files?.[0] || null
    event.target.value = ''
    if (!file) return

    if (!isSupportedAudioFile(file)) {
      setError('Choose a supported audio file like MP3, WAV, M4A, OGG, FLAC, MP4, or WebM.')
      return
    }

    if (file.size <= 0) {
      setError('This audio file is empty. Choose another file.')
      return
    }

    setError(null)
    setPendingUploadFile(file)

    if (meetingDetailsMode === 'unset') {
      setStartChoiceAction('upload')
      setShowStartChoice(true)
      return
    }

    void handleProcessUploadedFile(file, meetingDetailsMode)
  }

  async function handleProcessUploadedFile(file = pendingUploadFile, startMode = meetingDetailsMode) {
    if (!file || isRecording) return

    const nextMode = startMode === 'details' ? 'details' : 'skip'
    setMeetingDetailsMode(nextMode)
    setShowStartChoice(false)
    setPendingUploadFile(null)
    setSegments([])
    segmentsRef.current = []
    setElapsedSeconds(0)
    setError(null)

    const meetingContextPayload = buildMeetingContextPayload({
      meetingDetailsMode: nextMode,
      meetingTopic,
      meetingGoal,
      expectedParticipantCount,
      contextProfile,
      correctionMemory,
    })

    onMeetingComplete([], file, false, meetingContextPayload)
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

  async function handleStart(startMode = meetingDetailsMode) {
    if (!navigator.mediaDevices && window.location.protocol === 'http:') {
      setError('Microphone requires HTTPS. Deploy the app or use localhost.')
      return
    }

    setError(null)
    const nextMode = startMode === 'details' ? 'details' : 'skip'
    setMeetingDetailsMode(nextMode)
    setShowStartChoice(false)
    setElapsedSeconds(0)
    setSegments([])
    segmentsRef.current = []
    let started = false

    if (liveTranscriptEnabled) {
      started = await startTranscription({
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
      setAudioStream(getAudioStream())
    } else {
      started = await startAudioOnlyRecording()
      if (!started) {
        setIsRecording(false)
        setAudioStream(null)
        return
      }
    }

    setIsRecording(true)
  }

  async function handleStop() {
    if (!isRecording) return

    console.log('[RecordScreen] Stop pressed. Current segment count:', segmentsRef.current.length)

    setIsRecording(false)

    let finalSegments = []
    let audioBlob = null

    if (liveTranscriptEnabled) {
      stopTranscription()
      setAudioStream(null)
      await delay(1200)

      finalSegments = segmentsRef.current || segments
      audioBlob = getFullAudioBlob()
      console.log('[RecordScreen] Audio blob size:', audioBlob?.size, 'bytes')
      console.log('[RecordScreen] Passing segments to results:', finalSegments.length)

      if (finalSegments.length === 0) {
        console.warn('[RecordScreen] No segments captured')
      }
    } else {
      if (silentRecorderRef.current && silentRecorderRef.current.state !== 'inactive') {
        silentRecorderRef.current.stop()
        await delay(500)
      }

      if (silentAudioStreamRef.current) {
        silentAudioStreamRef.current.getTracks().forEach((track) => track.stop())
        silentAudioStreamRef.current = null
      }

      if (silentChunksRef.current.length > 0) {
        const mimeType = silentRecorderRef.current?.mimeType || 'audio/webm'
        audioBlob = new Blob(silentChunksRef.current, { type: mimeType })
      }

      setAudioStream(null)
      finalSegments = []
    }

    const meetingContextPayload = buildMeetingContextPayload({
      meetingDetailsMode,
      meetingTopic,
      meetingGoal,
      expectedParticipantCount,
      contextProfile,
      correctionMemory,
    })
    onMeetingComplete(finalSegments, audioBlob, liveTranscriptEnabled, meetingContextPayload)
  }

  async function startAudioOnlyRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      })

      silentAudioStreamRef.current = stream
      setAudioStream(stream)

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : ''

      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
      silentRecorderRef.current = recorder
      silentChunksRef.current = []

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          silentChunksRef.current.push(event.data)
        }
      }

      recorder.start(1000)
      return true
    } catch (err) {
      setError('Microphone access denied: ' + err.message)
      return false
    }
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
      'bg-[var(--mint-soft)] text-[var(--mint-d)]',
      'bg-emerald-100 text-emerald-700',
      'bg-amber-100 text-amber-700',
      'bg-rose-100 text-rose-700',
    ]
    return colors[speaker % colors.length]
  }

  return (
    <div className="nm-screen flex flex-col px-7 md:px-8">
      <div className="mx-auto flex min-h-screen w-full max-w-[512px] flex-col">
        <header className="flex items-center justify-between pt-5">
          <button
            type="button"
            onClick={() => onGoHome?.()}
            className="inline-flex items-center gap-2 text-[20px] font-extrabold tracking-[-.04em] text-[var(--ink)] hover:text-[var(--mint-d)]"
          >
            <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-[var(--mint-glow)] to-[var(--mint-d)] text-white shadow-[0_8px_18px_rgba(6,177,122,.30)]">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 12c4 0 6-2 6-6 0 4 2 6 6 6-4 0-6 2-6 6 0-4-2-6-6-6z" />
              </svg>
            </span>
            notemint
          </button>
          <div className="flex items-center gap-3">
            <div className="relative" ref={menuRef}>
              <button
                type="button"
                onClick={() => setMenuOpen((prev) => !prev)}
                aria-label="Open profile menu"
                className="flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-[#2A4B40] to-[var(--ink)] text-base font-bold text-white shadow-[var(--sh-sm)]"
              >
                {initial}
              </button>

              {menuOpen ? (
                <div className="absolute right-0 z-20 mt-2 w-52 overflow-hidden rounded-2xl border border-[var(--line)] bg-white shadow-[var(--sh-md)]">
                  <button
                    type="button"
                    onClick={() => {
                      setMenuOpen(false)
                      onEditContext?.()
                    }}
                    className="w-full px-4 py-3 text-left text-sm font-semibold text-[var(--ink)] transition-colors hover:bg-[var(--paper)]"
                  >
                    edit work context
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setMenuOpen(false)
                      onOpenCorrectionDictionary?.()
                    }}
                    className="w-full border-t border-[var(--line)] px-4 py-3 text-left text-sm font-semibold text-[var(--ink)] transition-colors hover:bg-[var(--paper)]"
                  >
                    correction dictionary
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setMenuOpen(false)
                      onReEnrollVoice?.()
                    }}
                    className="w-full border-t border-[var(--line)] px-4 py-3 text-left text-sm font-semibold text-[var(--ink)] transition-colors hover:bg-[var(--paper)]"
                  >
                    re-enroll voice
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setMenuOpen(false)
                      onSignOut()
                    }}
                    className="w-full border-t border-[var(--line)] px-4 py-3 text-left text-sm font-semibold text-[var(--coral)] transition-colors hover:bg-[var(--paper)]"
                  >
                    sign out
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </header>

        {!isRecording && segments.length === 0 ? (
          <main className="nm-fade-in flex flex-1 flex-col">
            <input
              ref={fileInputRef}
              type="file"
              accept={AUDIO_FILE_ACCEPT}
              className="hidden"
              onChange={handleAudioFileSelected}
            />
            {voiceEnrollmentIssue ? (
              <div className="mb-5 w-full max-w-xs rounded-[22px] border border-amber-100 bg-amber-50 px-4 py-3 text-left shadow-[var(--sh-sm)]">
                <p className="text-sm font-bold text-amber-900">voice setup needs another try</p>
                <p className="mt-1 text-xs leading-relaxed text-amber-700">
                  We could not finish verifying your first voice setup in the background.
                </p>
                <button
                  type="button"
                  onClick={() => onReEnrollVoice?.()}
                  className="mt-2 text-xs font-bold text-amber-900 underline underline-offset-2"
                >
                  re-enroll voice
                </button>
              </div>
            ) : null}
            <div className="pt-7 text-left">
              <p className="text-[17px] font-semibold text-[var(--ink2)]">Good morning, {user?.email?.split('@')?.[0] || 'there'}</p>
              <h1 className="mt-2 max-w-[340px] text-[31px] font-black leading-[1.12] tracking-[-1.2px] text-[var(--ink)]">
                Ready when you are. Hit record.
              </h1>
            </div>

            <div className="flex flex-1 flex-col items-center justify-center pt-7 text-center">
              <button
                type="button"
                onClick={() => {
                  void handleRecordClick()
                }}
                disabled={isRecording}
                className="relative flex h-[148px] w-[148px] items-center justify-center rounded-full bg-gradient-to-br from-[var(--mint-glow)] to-[var(--mint-d)] text-white shadow-[0_22px_70px_rgba(6,177,122,.42)] transition active:scale-95 disabled:opacity-60"
                aria-label="Start recording"
              >
                <span className="absolute -inset-12 rounded-full bg-[radial-gradient(circle,rgba(31,214,160,.28),rgba(31,214,160,0)_68%)]" />
                <svg width="54" height="54" viewBox="0 0 24 24" fill="none" className="relative z-[1]">
                  <rect x="9" y="2" width="6" height="12" rx="3" stroke="currentColor" strokeWidth="1.8" />
                  <path
                    d="M5 10C5 14.4 7.8 17 12 17C16.2 17 19 14.4 19 10"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                  />
                  <line x1="12" y1="17" x2="12" y2="21" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                  <line x1="9" y1="21" x2="15" y2="21" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
              </button>
              <p className="mt-20 text-[17px] font-extrabold text-[var(--ink)]">Tap to start a meeting</p>
              <p className="mt-1 text-[15px] font-medium text-[var(--ink3)]">Transcribed & summarized automatically</p>
            </div>

            <button
              type="button"
              onClick={handleUploadClick}
              disabled={isRecording}
              className="mx-auto mt-2 inline-flex h-[54px] items-center gap-3 rounded-[16px] bg-white px-7 text-[15px] font-extrabold text-[var(--ink)] shadow-[var(--sh-md)] transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--mint-d)" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />
              </svg>
              Upload audio file
            </button>
            <p className="mt-2 text-center text-[11px] font-medium text-[var(--ink3)]">MP3, WAV, M4A, OGG, FLAC, MP4, or WebM</p>
            {false ? (
              <>
              <div className="mt-8 w-full max-w-xs bg-gray-50 rounded-2xl px-4 py-3.5 flex items-center justify-between">
              <div className="text-left">
                <p className="text-sm font-medium text-gray-800">live transcript</p>
                <p className="text-xs text-gray-400 mt-0.5">
                  {liveTranscriptEnabled ? 'words appear as you speak' : 'transcript generated after meeting'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setLiveTranscriptEnabled((prev) => !prev)}
                className={`relative w-12 h-6 rounded-full transition-colors duration-200 flex-shrink-0 ml-4 ${
                  liveTranscriptEnabled ? 'bg-[var(--mint-d)]' : 'bg-gray-300'
                }`}
                role="switch"
                aria-checked={liveTranscriptEnabled}
                aria-label="Toggle live transcript"
              >
                <span
                  className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-transform duration-200 ${
                    liveTranscriptEnabled ? 'translate-x-6' : 'translate-x-0.5'
                  }`}
                />
              </button>
            </div>
            <p className="text-xs text-gray-300 mt-3 max-w-xs">
              {liveTranscriptEnabled
                ? 'uses more data — good for real-time notes'
                : 'saves data — best for longer meetings'}
            </p>
            </>
            ) : null}
            <button
              type="button"
              onClick={onViewHistory}
              className="mt-auto mb-7 flex w-full items-center gap-4 rounded-[22px] bg-white px-4 py-4 text-left shadow-[var(--sh-md)] transition active:scale-[.99]"
            >
              <span className="flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-[16px] bg-[var(--mint-soft)] text-[var(--mint-d)]">
                <svg width="23" height="23" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M3 3v5h5" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M12 7v5l4 2" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[16px] font-extrabold text-[var(--ink)]">Past meetings</span>
                <span className="mt-1 block text-[13px] font-semibold text-[var(--ink3)]">Open your saved notes</span>
              </span>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--ink3)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M9 18l6-6-6-6" />
              </svg>
            </button>
          </main>
        ) : (
          <main className="nm-fade-in flex flex-1 flex-col pt-6">
            <div className="nm-card px-4 py-5" style={{ minHeight: '40px' }}>
              <WaveformVisualizer className="w-full" isRecording={isRecording} audioStream={audioStream} />
            </div>
            <div className="mt-6 flex items-center justify-center gap-3">
              <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />
              <p className="text-4xl font-extrabold tracking-[-.04em] text-[var(--ink)]">{formatTime(elapsedSeconds)}</p>
            </div>
            <p className="mt-2 text-center text-xs font-bold uppercase tracking-[0.2em] text-[var(--ink3)]">recording</p>

            <div className="mt-6 overflow-y-auto rounded-[22px] bg-white/45 px-2 py-1" style={{ maxHeight: 'calc(100dvh - 280px)' }}>
              <div className="flex flex-col gap-3 pb-2">
                {segments.length === 0 && isRecording && (
                  <p className="pt-4 text-center text-xs font-medium text-[var(--ink3)]">
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

        {isRecording || segments.length > 0 ? (
        <div className="mt-auto flex flex-col items-center pb-8 pt-4 safe-bottom">
          <button
            type="button"
            onClick={isRecording ? handleStop : handleRecordClick}
            disabled={isRecording ? false : undefined}
            className={`relative flex h-[78px] w-[78px] items-center justify-center rounded-full transition active:scale-95 md:h-20 md:w-20 ${
              isRecording
                ? 'border-2 border-[var(--mint-d)] bg-white text-[var(--mint-d)] shadow-[var(--sh-sm)]'
                : 'bg-gradient-to-br from-[var(--mint-glow)] to-[var(--mint-d)] text-white shadow-[0_18px_44px_rgba(6,177,122,.40)]'
            }`}
          >
            {isRecording ? <PulseRing /> : null}
            {isRecording ? <StopIcon className="h-4 w-4" /> : <MicIcon className="h-6 w-6" />}
          </button>
          <p className="mt-3 text-xs font-bold text-[var(--ink3)]">{isRecording ? 'stop recording' : 'start meeting'}</p>

          {error ? (
            <div className="mt-4 text-center">
              <p className="rounded-2xl bg-red-50 px-3 py-2 text-xs font-medium text-red-500">{error}</p>
              <button
                type="button"
                onClick={handleRetry}
                className="mt-2 text-xs font-bold text-[var(--mint-d)]"
              >
                retry
              </button>
            </div>
          ) : null}
        </div>
        ) : null}

        {showStartChoice && !isRecording ? (
          <>
            <div
              className="fixed inset-0 z-50 bg-[rgba(17,34,28,.40)]"
              style={{ animation: 'fadeIn .3s' }}
              onClick={() => {
                setShowStartChoice(false)
                if (startChoiceAction === 'upload') {
                  setPendingUploadFile(null)
                }
              }}
            />
            <div
              className="fixed inset-x-0 bottom-0 z-[51] mx-auto w-full max-w-[512px] rounded-t-[30px] bg-white px-[22px] pb-[30px] pt-2 shadow-[0_-10px_40px_rgba(17,34,28,.18)]"
              style={{ animation: 'sheetUp .42s cubic-bezier(.2,.9,.2,1)' }}
            >
              <div className="mx-auto my-2 h-[5px] w-[38px] rounded bg-[var(--line)]" />
              <div className="text-[20px] font-extrabold tracking-[-.5px] text-[var(--ink)]">Meeting details</div>
              <div className="mb-5 mt-1 text-[13px] text-[var(--ink3)]">Optional - helps sharpen the summary.</div>

              {startChoiceAction === 'upload' && pendingUploadFile ? (
                <p className="mb-3 truncate rounded-[13px] bg-[var(--paper)] px-3 py-2 text-xs font-semibold text-[var(--ink3)]">
                  {pendingUploadFile.name}
                </p>
              ) : null}

              <div className="flex flex-col gap-[13px]">
                <Field
                  label="meeting topic"
                  value={meetingTopic}
                  onChange={setMeetingTopic}
                  placeholder="e.g. onboarding redesign sync"
                  maxLength={120}
                />
                <TextAreaField
                  label="goal, agenda, important terms"
                  value={meetingGoal}
                  onChange={setMeetingGoal}
                  placeholder="review wait times, staffing plan, CDs, fraud hold"
                  maxLength={260}
                />
                <NumberField
                  label="participants"
                  value={expectedParticipantCount}
                  onChange={setExpectedParticipantCount}
                  min={1}
                  max={50}
                />
              </div>

              <div className="mt-6 flex gap-[11px]">
                <button
                  type="button"
                  onClick={() => {
                    if (startChoiceAction === 'upload') {
                      void handleProcessUploadedFile(pendingUploadFile, 'skip')
                    } else {
                      void handleStart('skip')
                    }
                  }}
                  className="h-[52px] flex-1 rounded-[15px] bg-[var(--paper)] text-[14.5px] font-bold text-[var(--ink2)]"
                >
                  Skip
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (startChoiceAction === 'upload') {
                      void handleProcessUploadedFile(pendingUploadFile, 'details')
                    } else {
                      void handleStart('details')
                    }
                  }}
                  className="h-[52px] flex-[2] rounded-[15px] bg-gradient-to-br from-[var(--mint)] to-[var(--mint-d)] text-[14.5px] font-bold text-white shadow-[0_8px_20px_rgba(6,177,122,.34)]"
                >
                  {startChoiceAction === 'upload' ? 'Process file' : 'Start recording'}
                </button>
              </div>
            </div>
          </>
        ) : null}
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

function isSupportedAudioFile(file) {
  const type = String(file?.type || '').toLowerCase()
  if (type.startsWith('audio/')) return true
  if (type === 'video/mp4' || type === 'application/ogg') return true

  const extension = String(file?.name || '')
    .split('.')
    .pop()
    ?.toLowerCase()
  return Boolean(extension && AUDIO_FILE_EXTENSIONS.has(extension))
}

function buildMeetingContextPayload({
  meetingDetailsMode,
  meetingTopic,
  meetingGoal,
  expectedParticipantCount,
  contextProfile,
  correctionMemory,
}) {
  const topic = String(meetingTopic || '').trim().slice(0, 120)
  const goal = String(meetingGoal || '').trim().slice(0, 260)
  const participantCount = normalizeParticipantCount(expectedParticipantCount)
  const expectedParticipants = participantCount ? [`${participantCount} participants`] : []
  const importantTerms = parseTerms(meetingGoal)
  const industry = String(contextProfile?.industry || '').trim().slice(0, 48)

  const generatedKeyterms = Array.isArray(contextProfile?.generated_keyterms)
    ? contextProfile.generated_keyterms
    : []
  const profileTerms = [
    ...(Array.isArray(contextProfile?.organization_terms) ? contextProfile.organization_terms : []),
    ...(Array.isArray(contextProfile?.custom_terms) ? contextProfile.custom_terms : []),
    ...(Array.isArray(contextProfile?.participant_names) ? contextProfile.participant_names : []),
    ...generatedKeyterms,
  ]

  const correctionBoostTerms = Array.isArray(correctionMemory?.boostTerms) ? correctionMemory.boostTerms : []
  const correctionPairsRaw = Array.isArray(correctionMemory?.confusionPairs)
    ? correctionMemory.confusionPairs
    : []
  const correctionPairs = correctionPairsRaw
    .map((pair) => ({
      original: String(pair?.original || '').trim(),
      corrected: String(pair?.corrected || '').trim(),
      confidence: Number(pair?.confidence || 0),
      count: Number(pair?.count || 0),
      ambiguous: Boolean(pair?.ambiguous),
    }))
    .filter((pair) => pair.original && pair.corrected)
    // Conservative reuse: avoid pushing uncertain mappings into future meetings.
    .filter((pair) => !pair.ambiguous && pair.confidence >= 0.65)
    .slice(0, 20)

  const contextTerms = uniqueTerms([
    ...importantTerms,
    ...profileTerms,
    ...correctionBoostTerms,
    topic,
    goal,
  ]).slice(0, 200)

  const knownParticipants = uniqueTerms([
    ...expectedParticipants,
    ...(Array.isArray(contextProfile?.participant_names) ? contextProfile.participant_names : []),
  ]).slice(0, 20)

  const knownTerms = uniqueTerms([
    ...importantTerms,
    ...(Array.isArray(contextProfile?.organization_terms) ? contextProfile.organization_terms : []),
    ...(Array.isArray(contextProfile?.custom_terms) ? contextProfile.custom_terms : []),
    ...generatedKeyterms,
    ...correctionBoostTerms,
  ]).slice(0, 50)

  return {
    mode: meetingDetailsMode === 'details' ? 'details' : 'skip',
    topic,
    goal,
    expectedParticipants,
    importantTerms,
    meetingType: '',
    industry,
    knownParticipants,
    knownTerms,
    contextTerms,
    summaryContext: String(contextProfile?.summary_context || ''),
    doNotInfer: Array.isArray(contextProfile?.do_not_infer) ? contextProfile.do_not_infer : [],
    confusionPairs: correctionPairs,
  }
}

function uniqueTerms(values) {
  const out = []
  const seen = new Set()
  const list = Array.isArray(values) ? values : []

  for (const raw of list) {
    const value = String(raw || '')
      .replace(/\s+/g, ' ')
      .trim()
    if (!value) continue
    if (value.length > 60) continue
    if (value.split(' ').length > 8) continue
    const key = value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(value)
  }

  return out
}

function normalizeParticipantCount(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return ''
  const rounded = Math.round(parsed)
  if (rounded < 1) return ''
  return String(Math.min(rounded, 50))
}

function Field({ label, value, onChange, placeholder, maxLength }) {
  return (
    <div>
      <p className="mb-1 text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--ink3)]">{label}</p>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value.slice(0, maxLength))}
        placeholder={placeholder}
        className="nm-input min-h-9 px-3 py-1 text-xs placeholder:text-[var(--ink3)]"
      />
    </div>
  )
}

function TextAreaField({ label, value, onChange, placeholder, maxLength }) {
  return (
    <div>
      <p className="mb-1 text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--ink3)]">{label}</p>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value.slice(0, maxLength))}
        placeholder={placeholder}
        rows={3}
        className="nm-input resize-none text-xs placeholder:text-[var(--ink3)]"
      />
    </div>
  )
}

function NumberField({ label, value, onChange, min = 1, max = 50 }) {
  return (
    <div>
      <p className="mb-1 text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--ink3)]">{label}</p>
      <input
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step="1"
        value={value}
        onChange={(event) => {
          const cleaned = event.target.value.replace(/[^\d]/g, '').slice(0, 2)
          if (!cleaned) {
            onChange('')
            return
          }
          onChange(String(Math.min(Number(cleaned), max)))
        }}
        placeholder="4"
        className="nm-input min-h-9 px-3 py-1 text-xs placeholder:text-[var(--ink3)]"
      />
    </div>
  )
}

function PulseRing() {
  return <span className="absolute inset-[-7px] rounded-full border-2 border-[rgba(6,177,122,.24)] animate-pulse" />
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
