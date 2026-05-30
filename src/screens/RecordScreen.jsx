import { useEffect, useMemo, useRef, useState } from 'react'
import WaveformVisualizer from '../components/WaveformVisualizer'
import { getAudioStream, getFullAudioBlob, startTranscription, stopTranscription } from '../lib/gladia'
import { getContextProfile, getCorrectionMemory, MEETING_TYPE_OPTIONS, parseTerms } from '../lib/contextProfile'
import { supabase } from '../lib/supabase'

const TRANSCRIPTION_PROVIDERS = [
  { value: 'assemblyai', label: 'AssemblyAI', detail: 'Universal', recommended: true },
  { value: 'deepgram', label: 'Deepgram', detail: 'Nova-3' },
  { value: 'grok', label: 'Grok', detail: 'fast baseline' },
]
const LAST_MEETING_TYPE_KEY_PREFIX = 'last_meeting_type_'

export default function RecordScreen({
  user,
  transcriptionProvider = 'assemblyai',
  onTranscriptionProviderChange,
  compareModeAvailable = false,
  compareModeEnabled = false,
  onCompareModeChange,
  onMeetingComplete,
  onSignOut,
  onViewHistory,
  onReEnrollVoice,
  onEditContext,
  onOpenCorrectionDictionary,
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
  const [meetingTopic, setMeetingTopic] = useState('')
  const [meetingGoal, setMeetingGoal] = useState('')
  const [expectedParticipantsInput, setExpectedParticipantsInput] = useState('')
  const [importantTermsInput, setImportantTermsInput] = useState('')
  const [meetingType, setMeetingType] = useState('')
  const [contextProfile, setContextProfile] = useState(null)
  const [correctionMemory, setCorrectionMemory] = useState({ boostTerms: [], confusionPairs: [] })
  const segmentsRef = useRef([])
  const transcriptEndRef = useRef(null)
  const menuRef = useRef(null)
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
        const savedMeetingType = getStoredMeetingType(user.id)
        if (savedMeetingType && !meetingType) {
          setMeetingType(savedMeetingType)
        } else if (!meetingType && profile?.meeting_types?.[0]) {
          setMeetingType(String(profile.meeting_types[0]))
        }
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
    if (meetingDetailsMode === 'unset') {
      setMeetingDetailsMode('skip')
    }
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
      expectedParticipantsInput,
      importantTermsInput,
      meetingType,
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
                      onEditContext?.()
                    }}
                    className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                  >
                    edit work context
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setMenuOpen(false)
                      onOpenCorrectionDictionary?.()
                    }}
                    className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors border-t border-gray-100"
                  >
                    correction dictionary
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setMenuOpen(false)
                      onReEnrollVoice?.()
                    }}
                    className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors border-t border-gray-100"
                  >
                    re-enroll voice
                  </button>
                  {compareModeAvailable ? (
                    <button
                      type="button"
                      onClick={() => onCompareModeChange?.(!compareModeEnabled)}
                      className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors border-t border-gray-100"
                    >
                      testing mode: {compareModeEnabled ? 'on' : 'off'}
                    </button>
                  ) : null}
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
            <div className="mt-5 w-full max-w-xs rounded-2xl border border-gray-100 bg-gray-50 p-3 text-left">
              <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-gray-400">meeting details</p>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setMeetingDetailsMode('skip')}
                  className={`rounded-xl border px-2.5 py-2 text-xs transition-colors ${
                    meetingDetailsMode === 'skip'
                      ? 'border-indigo-300 bg-indigo-50 text-indigo-700'
                      : 'border-gray-200 bg-white text-gray-500 hover:text-gray-700'
                  }`}
                >
                  start without details
                </button>
                <button
                  type="button"
                  onClick={() => setMeetingDetailsMode('details')}
                  className={`rounded-xl border px-2.5 py-2 text-xs transition-colors ${
                    meetingDetailsMode === 'details'
                      ? 'border-indigo-300 bg-indigo-50 text-indigo-700'
                      : 'border-gray-200 bg-white text-gray-500 hover:text-gray-700'
                  }`}
                >
                  add meeting details
                </button>
              </div>
              {meetingDetailsMode === 'details' ? (
                <div className="mt-3 space-y-2.5">
                  <Field
                    label="meeting topic"
                    value={meetingTopic}
                    onChange={setMeetingTopic}
                    placeholder="branch wait times review"
                    maxLength={120}
                  />
                  <Field
                    label="goal"
                    value={meetingGoal}
                    onChange={setMeetingGoal}
                    placeholder="identify root causes and next actions"
                    maxLength={180}
                  />
                  <Field
                    label="expected participants"
                    value={expectedParticipantsInput}
                    onChange={setExpectedParticipantsInput}
                    placeholder="Tom, Sarah, John"
                    maxLength={200}
                  />
                  <Field
                    label="important terms"
                    value={importantTermsInput}
                    onChange={setImportantTermsInput}
                    placeholder="CDs, fraud hold, delinquency"
                    maxLength={260}
                  />
                  <div>
                    <p className="mb-1 text-[11px] font-medium uppercase tracking-[0.12em] text-gray-400">
                      meeting type
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {MEETING_TYPE_OPTIONS.map((type) => {
                        const selected = meetingType === type
                        return (
                          <button
                            key={type}
                            type="button"
                            onClick={() => {
                              setMeetingType(type)
                              storeMeetingType(user?.id, type)
                            }}
                            className={`rounded-full px-2.5 py-1 text-[11px] transition-colors ${
                              selected
                                ? 'bg-indigo-600 text-white'
                                : 'bg-gray-100 text-gray-500 hover:bg-gray-200 hover:text-gray-700'
                            }`}
                          >
                            {type}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                  {renderSuggestionChips({
                    profile: contextProfile,
                    onUseTerm: (term) => {
                      setImportantTermsInput((prev) => appendCommaSeparated(prev, term))
                    },
                    onUseParticipant: (name) => {
                      setExpectedParticipantsInput((prev) => appendCommaSeparated(prev, name))
                    },
                  })}
                </div>
              ) : null}
            </div>
            <div className="mt-7 w-full max-w-xs rounded-2xl border border-gray-100 bg-gray-50 p-1">
              <p className="px-3 pb-2 pt-2 text-left text-[11px] font-medium uppercase tracking-[0.16em] text-gray-400">
                transcript model
              </p>
              <div className="grid grid-cols-3 gap-1">
                {TRANSCRIPTION_PROVIDERS.map((provider) => {
                  const selected = transcriptionProvider === provider.value
                  return (
                    <button
                      key={provider.value}
                      type="button"
                      onClick={() => onTranscriptionProviderChange?.(provider.value)}
                      className={`rounded-xl px-2 py-2 text-center transition-colors ${
                        selected
                          ? 'bg-white text-indigo-600 shadow-sm'
                          : 'text-gray-400 hover:bg-white/70 hover:text-gray-600'
                      }`}
                      aria-pressed={selected}
                    >
                      <span className="block text-xs font-medium">{provider.label}</span>
                      <span className="mt-0.5 block text-[10px] leading-tight opacity-75">{provider.detail}</span>
                      {provider.recommended ? (
                        <span className="mt-1 inline-block rounded-full bg-emerald-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-emerald-700">
                          recommended
                        </span>
                      ) : null}
                    </button>
                  )
                })}
              </div>
            </div>
            {compareModeAvailable ? (
              <p className="mt-2 text-[11px] text-gray-400">
                testing mode is available in the profile menu.
              </p>
            ) : null}
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
                  liveTranscriptEnabled ? 'bg-indigo-600' : 'bg-gray-300'
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

function buildMeetingContextPayload({
  meetingDetailsMode,
  meetingTopic,
  meetingGoal,
  expectedParticipantsInput,
  importantTermsInput,
  meetingType,
  contextProfile,
  correctionMemory,
}) {
  const expectedParticipants = parseTerms(expectedParticipantsInput)
  const importantTerms = parseTerms(importantTermsInput)
  const topic = String(meetingTopic || '').trim().slice(0, 120)
  const goal = String(meetingGoal || '').trim().slice(0, 180)
  const finalMeetingType = String(meetingType || '').trim().slice(0, 48)
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
    ...expectedParticipants,
    ...profileTerms,
    ...correctionBoostTerms,
    finalMeetingType,
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
    meetingType: finalMeetingType,
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

function renderSuggestionChips({ profile, onUseTerm, onUseParticipant }) {
  const participants = Array.isArray(profile?.participant_names) ? profile.participant_names.slice(0, 8) : []
  const terms = uniqueTerms([
    ...(Array.isArray(profile?.organization_terms) ? profile.organization_terms.slice(0, 8) : []),
    ...(Array.isArray(profile?.custom_terms) ? profile.custom_terms.slice(0, 8) : []),
    ...(Array.isArray(profile?.generated_keyterms) ? profile.generated_keyterms.slice(0, 8) : []),
  ]).slice(0, 10)

  if (participants.length === 0 && terms.length === 0) return null

  return (
    <div className="space-y-1.5">
      {participants.length > 0 ? (
        <div>
          <p className="mb-1 text-[11px] font-medium uppercase tracking-[0.12em] text-gray-400">people suggestions</p>
          <div className="flex flex-wrap gap-1.5">
            {participants.map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => onUseParticipant(name)}
                className="rounded-full bg-white px-2.5 py-1 text-[11px] text-gray-600 border border-gray-200 hover:bg-gray-50"
              >
                + {name}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {terms.length > 0 ? (
        <div>
          <p className="mb-1 text-[11px] font-medium uppercase tracking-[0.12em] text-gray-400">term suggestions</p>
          <div className="flex flex-wrap gap-1.5">
            {terms.map((term) => (
              <button
                key={term}
                type="button"
                onClick={() => onUseTerm(term)}
                className="rounded-full bg-white px-2.5 py-1 text-[11px] text-gray-600 border border-gray-200 hover:bg-gray-50"
              >
                + {term}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}

function appendCommaSeparated(previous, value) {
  const existing = String(previous || '').trim()
  const cleaned = String(value || '').trim()
  if (!cleaned) return existing
  if (!existing) return cleaned
  const existingSet = new Set(
    existing
      .split(/[\n,]/g)
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean),
  )
  if (existingSet.has(cleaned.toLowerCase())) return existing
  return `${existing}, ${cleaned}`
}

function getStoredMeetingType(userId) {
  if (!userId || typeof window === 'undefined') return ''
  return String(localStorage.getItem(LAST_MEETING_TYPE_KEY_PREFIX + userId) || '').trim()
}

function storeMeetingType(userId, value) {
  if (!userId || typeof window === 'undefined') return
  const cleaned = String(value || '').trim()
  if (!cleaned) return
  localStorage.setItem(LAST_MEETING_TYPE_KEY_PREFIX + userId, cleaned)
}

function Field({ label, value, onChange, placeholder, maxLength }) {
  return (
    <div>
      <p className="mb-1 text-[11px] font-medium uppercase tracking-[0.12em] text-gray-400">{label}</p>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value.slice(0, maxLength))}
        placeholder={placeholder}
        className="h-8 w-full rounded-lg border border-gray-200 bg-white px-2.5 text-xs text-gray-700 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-100 focus:border-indigo-400"
      />
    </div>
  )
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
