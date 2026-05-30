import { useEffect, useRef, useState } from 'react'
import AuthScreen from './screens/AuthScreen'
import AuthCallbackScreen from './screens/AuthCallbackScreen'
import EnrollScreen from './screens/EnrollScreen'
import ContextOnboardingScreen from './screens/ContextOnboardingScreen'
import RecordScreen from './screens/RecordScreen'
import SpeakerReviewScreen from './screens/SpeakerReviewScreen'
import ResultsScreen from './screens/ResultsScreen'
import CompareResultsScreen from './screens/CompareResultsScreen'
import HistoryScreen from './screens/HistoryScreen'
import PastMeetingScreen from './screens/PastMeetingScreen'
import LoadingDot from './components/LoadingDot'
import { getCurrentUser, signOut, supabase, syncUserProfile } from './lib/supabase'
import { streamSummary, transcribeAudio, transcribeAudioDetailed } from './lib/api'
import { rememberSpeakerLabels } from './lib/speakerMemory'
import { hasContextProfile, setContextOnboardingCompleted } from './lib/contextProfile'
import {
  compressTranscript,
  createMeetingDraft,
  getRecentTranscriptionEvaluations,
  setMeetingAudioUploadStatus,
  saveTranscriptionEvaluations,
  uploadMeetingAudio,
} from './lib/summary'
import { repairSpeakerTurns } from './lib/speakerTurnRepair'

export default function App() {
  const [screen, setScreen] = useState('loading')
  const [enrollMode, setEnrollMode] = useState('initial')
  const [contextMode, setContextMode] = useState('initial')
  const [processingMessage, setProcessingMessage] = useState('')
  const [transcriptionProvider, setTranscriptionProvider] = useState('assemblyai')
  const [currentUser, setCurrentUser] = useState(null)
  const [meetingSegments, setMeetingSegments] = useState([])
  const [meetingAudioBlob, setMeetingAudioBlob] = useState(null)
  const [meetingId, setMeetingId] = useState(null)
  const [audioSaveMessage, setAudioSaveMessage] = useState('')
  const [audioUploadStatus, setAudioUploadStatus] = useState('pending')
  const [meetingContext, setMeetingContext] = useState(null)
  const [compareModeEnabled, setCompareModeEnabled] = useState(true)
  const [compareResults, setCompareResults] = useState([])
  const [compareHistory, setCompareHistory] = useState([])
  const [bestTranscriptProvider, setBestTranscriptProvider] = useState('')
  const [bestSummaryProvider, setBestSummaryProvider] = useState('')
  const [diarizedSegments, setDiarizedSegments] = useState([])
  const [confirmedLabelMap, setConfirmedLabelMap] = useState({})
  const [selectedMeeting, setSelectedMeeting] = useState(null)
  const [authScreenError, setAuthScreenError] = useState(null)
  const [callbackState, setCallbackState] = useState({
    status: 'pending',
    title: 'Confirming your email',
    message: 'Finishing secure sign in...',
  })
  const callbackContextRef = useRef(getAuthCallbackContext())
  const redirectTimeoutRef = useRef(null)
  const compareRunRef = useRef(0)
  const compareModeAvailable = true

  useEffect(() => {
    let cancelled = false
    if (screen !== 'compare-results' || !currentUser?.id) return () => {}

    ;(async () => {
      try {
        const history = await getRecentTranscriptionEvaluations(supabase, currentUser.id, 80)
        if (!cancelled) {
          setCompareHistory(history)
        }
      } catch (err) {
        if (!cancelled) {
          setCompareHistory([])
          console.warn('[App] Could not load compare history:', err?.message || err)
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [screen, currentUser?.id])

  useEffect(() => {
    let isMounted = true
    const callbackContext = callbackContextRef.current

    if (callbackContext.active) {
      setScreen('auth-callback')
    }

    const initialize = async () => {
      try {
        const user = await getCurrentUser()
        if (!isMounted) return
        setCurrentUser(user)
        resolveInitialScreen(user, callbackContext)
      } catch (err) {
        if (!isMounted) return
        console.error('[App] Initial auth bootstrap failed:', err)
        setCurrentUser(null)
        setAuthScreenError('Could not reach authentication service. Check your setup and try again.')
        setScreen('auth')
      }
    }

    initialize()

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') {
        clearRedirectTimeout()
        setCurrentUser(null)
        setAuthScreenError(null)
        clearAuthCallbackUrl()
        callbackContextRef.current = { active: false }
        setScreen('auth')
        return
      }

      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
        const user = session?.user ?? null
        setCurrentUser(user)
        handleSignedInUser(user)
      }
    })

    return () => {
      isMounted = false
      clearRedirectTimeout()
      subscription.unsubscribe()
    }
  }, [])

  function clearRedirectTimeout() {
    if (redirectTimeoutRef.current) {
      clearTimeout(redirectTimeoutRef.current)
      redirectTimeoutRef.current = null
    }
  }

  function resolveInitialScreen(user, callbackContext) {
    if (callbackContext.active) {
      if (user) {
        showCallbackSuccess(user)
        return
      }

      if (callbackContext.message) {
        showCallbackError(callbackContext.message)
        return
      }

      showCallbackError('We could not verify that confirmation link. Request a new email and try again.')
      return
    }

    void applyEnrollmentGate(user)
  }

  function handleSignedInUser(user) {
    void syncUserProfile(user)

    if (callbackContextRef.current.active) {
      showCallbackSuccess(user)
      return
    }

    void applyEnrollmentGate(user)
  }

  async function applyEnrollmentGate(user) {
    if (!user) {
      setScreen('auth')
      return
    }

    const enrolled = localStorage.getItem(`enrolled_${user.id}`) === 'true'
    if (!enrolled) {
      setScreen('enroll')
      return
    }

    const contextReady = await hasContextProfile(supabase, user.id)
    setScreen(contextReady ? 'home' : 'context-onboarding')
  }

  function showCallbackSuccess(user) {
    clearRedirectTimeout()
    setCallbackState({
      status: 'success',
      title: 'Email confirmed',
      message: 'Your account is ready. Redirecting now...',
    })
    setScreen('auth-callback')
    clearAuthCallbackUrl()
    callbackContextRef.current = { active: false }
    redirectTimeoutRef.current = setTimeout(() => {
      void applyEnrollmentGate(user)
    }, 1200)
  }

  function showCallbackError(message) {
    clearRedirectTimeout()
    setCallbackState({
      status: 'error',
      title: 'Confirmation link unavailable',
      message,
    })
    setScreen('auth-callback')
  }

  async function handleAuthenticated() {
    try {
      const user = await getCurrentUser()
      await syncUserProfile(user)
      setCurrentUser(user)
      setAuthScreenError(null)
      await applyEnrollmentGate(user)
    } catch (err) {
      console.error('[App] Post-auth bootstrap failed:', err)
      setCurrentUser(null)
      setAuthScreenError('Could not finish sign-in setup. Please try again.')
      setScreen('auth')
    }
  }

  function handleReturnToAuth(errorMessage) {
    clearRedirectTimeout()
    setAuthScreenError(errorMessage ?? null)
    clearAuthCallbackUrl()
    callbackContextRef.current = { active: false }
    setScreen('auth')
  }

  function handleSkipEnrollment() {
    if (!currentUser) return
    localStorage.setItem(`enrolled_${currentUser.id}`, 'true')
    void applyEnrollmentGate(currentUser)
  }

  async function handleSignOut() {
    await signOut()
    setCurrentUser(null)
    setScreen('auth')
  }

  function getTranscriptionProviderLabel(provider) {
    if (provider === 'deepgram') return 'Deepgram'
    if (provider === 'assemblyai') return 'AssemblyAI'
    return 'Grok'
  }

  function getProviderFallbackOrder(selectedProvider) {
    const baseOrder = ['assemblyai', 'deepgram', 'grok']
    return [selectedProvider, ...baseOrder.filter((provider) => provider !== selectedProvider)]
  }

  async function transcribeWithFallback(audioBlob, selectedProvider, onStatus, options = {}) {
    const providers = getProviderFallbackOrder(selectedProvider)
    let lastError = null

    for (let i = 0; i < providers.length; i += 1) {
      const provider = providers[i]
      const label = getTranscriptionProviderLabel(provider)
      if (i === 0) {
        onStatus?.(`generating transcript with ${label}...`)
      } else {
        onStatus?.(`${getTranscriptionProviderLabel(selectedProvider)} failed, trying ${label}...`)
      }

      try {
        const parsed = await transcribeAudio(audioBlob, provider, options)
        if (Array.isArray(parsed) && parsed.length > 0) {
          return repairSpeakerTurns(parsed)
        }
      } catch (err) {
        lastError = err
      }
    }

    if (lastError) {
      throw lastError
    }
    return []
  }

  function updateCompareProvider(provider, patch, runId) {
    if (compareRunRef.current !== runId) return
    setCompareResults((prev) =>
      prev.map((item) => (item.provider === provider ? { ...item, ...patch } : item)),
    )
  }

  async function runCompareMode(audioBlob, meetingContextPayload) {
    const runId = Date.now()
    compareRunRef.current = runId

    const providers = ['assemblyai', 'deepgram', 'grok']
    const initial = providers.map((provider) => ({
      provider,
      model: '',
      segments: [],
      summary: '',
      durationMs: 0,
      speakerCount: 0,
      segmentCount: 0,
      status: 'queued',
      error: '',
      userRating: { bestTranscript: false, bestSummary: false },
      notes: '',
      transcriptRating: null,
      summaryRating: null,
      correctionCount: 0,
      manualSpeakerFixes: 0,
    }))

    setCompareResults(initial)
    setBestTranscriptProvider('')
    setBestSummaryProvider('')
    setScreen('compare-results')

    const transcriptionOptions = {
      contextTerms: Array.isArray(meetingContextPayload?.contextTerms) ? meetingContextPayload.contextTerms : [],
      meetingContext: meetingContextPayload && typeof meetingContextPayload === 'object' ? meetingContextPayload : null,
      compareMode: true,
    }

    const tasks = providers.map(async (provider) => {
      try {
        updateCompareProvider(provider, { status: 'transcribing' }, runId)
        const stt = await transcribeAudioDetailed(audioBlob, provider, transcriptionOptions)
        const segments = Array.isArray(stt?.segments) ? repairSpeakerTurns(stt.segments) : []
        const speakerCount = new Set(segments.map((segment) => segment?.speaker).filter((x) => Number.isFinite(Number(x)))).size
        updateCompareProvider(
          provider,
          {
            status: 'summarizing',
            model: stt?.model || '',
            segments,
            durationMs: Number(stt?.durationMs || 0),
            segmentCount: segments.length,
            speakerCount,
            error: '',
          },
          runId,
        )

        const transcript = compressTranscript(segments, {})
        if (!transcript || transcript.length < 20) {
          updateCompareProvider(
            provider,
            {
              status: 'failed',
              error: 'Transcript too short to summarize.',
            },
            runId,
          )
          return
        }

        const summary = await summarizeForCompare(transcript, meetingContextPayload)
        updateCompareProvider(
          provider,
          {
            status: 'done',
            summary,
            userRating: {
              bestTranscript: bestTranscriptProvider === provider,
              bestSummary: bestSummaryProvider === provider,
            },
          },
          runId,
        )
      } catch (err) {
        updateCompareProvider(
          provider,
          {
            status: 'failed',
            error: String(err?.message || 'Provider failed'),
          },
          runId,
        )
      }
    })

    await Promise.allSettled(tasks)
  }

  function buildCompareEvaluationRows() {
    return compareResults.map((item) => ({
      provider: item.provider,
      model: item.model || null,
      segments: Array.isArray(item.segments) ? item.segments : [],
      summary: item.summary || '',
      durationMs: Number(item.durationMs || 0),
      speakerCount: Number(item.speakerCount || 0),
      segmentCount: Number(item.segmentCount || 0),
      correctionCount: Number(item.correctionCount || 0),
      transcriptRating: item.transcriptRating,
      summaryRating: item.summaryRating,
      notes: item.notes || (item.error ? `provider_error: ${item.error}` : ''),
      manualSpeakerFixes: Number(item.manualSpeakerFixes || 0),
      bestTranscript: bestTranscriptProvider === item.provider,
      bestSummary: bestSummaryProvider === item.provider,
    }))
  }

  async function persistCompareEvaluations(meetingId = null) {
    if (!currentUser?.id || compareResults.length === 0) return
    const rows = buildCompareEvaluationRows()
    try {
      await saveTranscriptionEvaluations(supabase, {
        userId: currentUser.id,
        meetingId,
        evaluations: rows,
        compareRunId: compareRunRef.current ? String(compareRunRef.current) : null,
      })
      if (screen === 'compare-results') {
        const history = await getRecentTranscriptionEvaluations(supabase, currentUser.id, 80)
        setCompareHistory(history)
      }
    } catch (err) {
      console.warn('[App] Could not persist compare evaluations:', err?.message || err)
    }
  }

  async function prepareMeetingAudioPersistence(audioBlob) {
    setMeetingId(null)
    setAudioSaveMessage('')
    setAudioUploadStatus('pending')

    if (!currentUser?.id || !audioBlob || audioBlob.size === 0) {
      setAudioUploadStatus('failed')
      if (audioBlob && audioBlob.size === 0) {
        setAudioSaveMessage('Audio playback could not be saved. Transcript is still available.')
      }
      return null
    }

    let draftMeetingId = null
    try {
      draftMeetingId = await createMeetingDraft(supabase, currentUser.id)
      setMeetingId(draftMeetingId)
    } catch (err) {
      console.warn('[App] Could not create meeting draft for audio:', err?.message || err)
      setAudioUploadStatus('failed')
      setAudioSaveMessage('Audio playback could not be saved. Transcript is still available.')
      return null
    }

    const uploadPromise = uploadMeetingAudio(supabase, {
      userId: currentUser.id,
      meetingId: draftMeetingId,
      audioBlob,
    })

    uploadPromise
      .then((result) => {
        if (!result?.ok) {
          setAudioUploadStatus('failed')
          setAudioSaveMessage('Audio playback could not be saved. Transcript is still available.')
        } else {
          setAudioUploadStatus('uploaded')
          setAudioSaveMessage('')
        }
      })
      .catch(async (err) => {
        console.warn('[App] Could not upload meeting audio:', err?.message || err)
        setAudioUploadStatus('failed')
        try {
          await setMeetingAudioUploadStatus(supabase, {
            userId: currentUser.id,
            meetingId: draftMeetingId,
            status: 'failed',
          })
        } catch (statusErr) {
          console.warn('[App] Could not mark audio upload as failed:', statusErr?.message || statusErr)
        }
        setAudioSaveMessage('Audio playback could not be saved. Transcript is still available.')
      })

    try {
      await withTimeout(uploadPromise, 3000)
    } catch (err) {
      if (err?.name === 'TimeoutError') {
        setAudioUploadStatus('pending')
        setAudioSaveMessage('Audio is still saving in the background. Transcript is available.')
      } else {
        setAudioUploadStatus('failed')
        setAudioSaveMessage('Audio playback could not be saved. Transcript is still available.')
      }
    }

    return draftMeetingId
  }

  async function retryMeetingAudioUpload() {
    if (!currentUser?.id || !meetingId || !meetingAudioBlob || meetingAudioBlob.size === 0) {
      return
    }

    setAudioUploadStatus('pending')
    setAudioSaveMessage('Audio is still saving in the background. Transcript is available.')

    try {
      await setMeetingAudioUploadStatus(supabase, {
        userId: currentUser.id,
        meetingId,
        status: 'pending',
      })
    } catch (err) {
      console.warn('[App] Could not mark audio upload as pending:', err?.message || err)
    }

    try {
      const result = await uploadMeetingAudio(supabase, {
        userId: currentUser.id,
        meetingId,
        audioBlob: meetingAudioBlob,
      })

      if (result?.ok) {
        setAudioUploadStatus('uploaded')
        setAudioSaveMessage('')
      } else {
        setAudioUploadStatus('failed')
        setAudioSaveMessage('Audio playback could not be saved. Transcript is still available.')
      }
    } catch (err) {
      console.warn('[App] Retry audio upload failed:', err?.message || err)
      setAudioUploadStatus('failed')
      setAudioSaveMessage('Audio playback could not be saved. Transcript is still available.')
      try {
        await setMeetingAudioUploadStatus(supabase, {
          userId: currentUser.id,
          meetingId,
          status: 'failed',
        })
      } catch (statusErr) {
        console.warn('[App] Could not mark retry failure status:', statusErr?.message || statusErr)
      }
    }
  }

  const bestAvailableSegments = diarizedSegments.length > 0 ? diarizedSegments : meetingSegments

  if (screen === 'loading') {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center">
        <LoadingDot />
      </div>
    )
  }

  if (screen === 'auth') {
    return (
      <AuthScreen
        onAuthenticated={handleAuthenticated}
        initialEmail={getPendingConfirmationEmail()}
        initialError={authScreenError}
      />
    )
  }

  if (screen === 'auth-callback') {
    return (
      <AuthCallbackScreen
        status={callbackState.status}
        title={callbackState.title}
        message={callbackState.message}
        onContinue={
          callbackState.status === 'error'
            ? () => handleReturnToAuth('confirmation link expired - request a new email below')
            : null
        }
      />
    )
  }

  if (screen === 'enroll') {
    return (
      <EnrollScreen
        user={currentUser}
        mode={enrollMode}
        onComplete={() => {
          setEnrollMode('initial')
          handleSkipEnrollment()
        }}
      />
    )
  }

  if (screen === 'context-onboarding') {
    return (
      <ContextOnboardingScreen
        user={currentUser}
        mode={contextMode}
        onComplete={() => {
          setContextOnboardingCompleted(currentUser?.id)
          setContextMode('initial')
          setScreen('home')
        }}
        onSkip={() => {
          setContextOnboardingCompleted(currentUser?.id)
          setContextMode('initial')
          setScreen('home')
        }}
      />
    )
  }

  if (screen === 'processing') {
    return <ProcessingScreen message={processingMessage} />
  }

  if (screen === 'results') {
    return (
      <ResultsScreen
        user={currentUser}
        segments={bestAvailableSegments}
        audioBlob={meetingAudioBlob}
        meetingContext={meetingContext}
        confirmedLabelMap={confirmedLabelMap}
        initialMeetingId={meetingId}
        audioSaveMessage={audioSaveMessage}
        audioUploadStatus={audioUploadStatus}
        onRetryAudioUpload={retryMeetingAudioUpload}
        onNewMeeting={() => {
          setMeetingSegments([])
          setMeetingAudioBlob(null)
          setMeetingId(null)
          setAudioSaveMessage('')
          setAudioUploadStatus('pending')
          setMeetingContext(null)
          setCompareResults([])
          setBestTranscriptProvider('')
          setBestSummaryProvider('')
          compareRunRef.current = Date.now()
          setDiarizedSegments([])
          setConfirmedLabelMap({})
          setProcessingMessage('')
          setEnrollMode('initial')
          setScreen('home')
        }}
      />
    )
  }

  if (screen === 'speaker-review') {
    return (
      <SpeakerReviewScreen
        segments={bestAvailableSegments}
        audioBlob={meetingAudioBlob}
        user={currentUser}
        onConfirmed={(labelMap) => {
          void rememberSpeakerLabels(currentUser?.id, labelMap).catch((err) => {
            console.warn('[App] Could not remember speaker names:', err?.message || err)
          })
          setConfirmedLabelMap(labelMap)
          setScreen('results')
        }}
        onSkip={() => {
          setConfirmedLabelMap({})
          setScreen('results')
        }}
      />
    )
  }

  if (screen === 'history') {
    return (
      <HistoryScreen
        user={currentUser}
        onBack={() => setScreen('home')}
        onOpenMeeting={(meeting) => {
          setSelectedMeeting(meeting)
          setScreen('past-meeting')
        }}
      />
    )
  }

  if (screen === 'past-meeting' && selectedMeeting) {
    return (
      <PastMeetingScreen
        user={currentUser}
        meeting={selectedMeeting}
        onBack={() => setScreen('history')}
      />
    )
  }

  if (screen === 'compare-results') {
    return (
      <CompareResultsScreen
        results={compareResults}
        history={compareHistory}
        bestTranscriptProvider={bestTranscriptProvider}
        bestSummaryProvider={bestSummaryProvider}
        onSelectBestTranscript={(provider) => {
          setBestTranscriptProvider(provider)
          setCompareResults((prev) =>
            prev.map((item) => ({
              ...item,
              userRating: {
                ...item.userRating,
                bestTranscript: item.provider === provider,
              },
            })),
          )
        }}
        onSelectBestSummary={(provider) => {
          setBestSummaryProvider(provider)
          setCompareResults((prev) =>
            prev.map((item) => ({
              ...item,
              userRating: {
                ...item.userRating,
                bestSummary: item.provider === provider,
              },
            })),
          )
        }}
        onContinueWithProvider={(provider) => {
          const selected = compareResults.find((item) => item.provider === provider && item.status === 'done')
          if (!selected) return
          void persistCompareEvaluations(meetingId)
          const segments = Array.isArray(selected.segments) ? selected.segments : []
          setMeetingSegments([])
          setDiarizedSegments(segments)
          setConfirmedLabelMap({})
          setScreen('speaker-review')
        }}
        onUpdateProviderRating={(provider, patch) => {
          setCompareResults((prev) =>
            prev.map((item) =>
              item.provider === provider
                ? {
                    ...item,
                    transcriptRating:
                      patch && Object.prototype.hasOwnProperty.call(patch, 'transcriptRating')
                        ? patch.transcriptRating
                        : item.transcriptRating,
                    summaryRating:
                      patch && Object.prototype.hasOwnProperty.call(patch, 'summaryRating')
                        ? patch.summaryRating
                        : item.summaryRating,
                    notes:
                      patch && Object.prototype.hasOwnProperty.call(patch, 'notes')
                        ? String(patch.notes || '').slice(0, 300)
                        : item.notes,
                    correctionCount:
                      patch && Object.prototype.hasOwnProperty.call(patch, 'correctionCount')
                        ? Math.max(0, Number(patch.correctionCount) || 0)
                        : item.correctionCount,
                    manualSpeakerFixes:
                      patch && Object.prototype.hasOwnProperty.call(patch, 'manualSpeakerFixes')
                        ? Math.max(0, Number(patch.manualSpeakerFixes) || 0)
                        : item.manualSpeakerFixes,
                  }
                : item,
            ),
          )
        }}
        onSaveEvaluations={() => void persistCompareEvaluations(meetingId)}
        onNewMeeting={() => {
          void persistCompareEvaluations(meetingId)
          setMeetingSegments([])
          setMeetingAudioBlob(null)
          setMeetingId(null)
          setAudioSaveMessage('')
          setAudioUploadStatus('pending')
          setMeetingContext(null)
          setCompareResults([])
          setBestTranscriptProvider('')
          setBestSummaryProvider('')
          compareRunRef.current = Date.now()
          setDiarizedSegments([])
          setConfirmedLabelMap({})
          setProcessingMessage('')
          setEnrollMode('initial')
          setScreen('home')
        }}
      />
    )
  }

  return (
    <RecordScreen
      user={currentUser}
      transcriptionProvider={transcriptionProvider}
      onTranscriptionProviderChange={setTranscriptionProvider}
      compareModeAvailable={compareModeAvailable}
      compareModeEnabled={compareModeEnabled}
      onCompareModeChange={() => setCompareModeEnabled(true)}
      onMeetingComplete={async (segments, audioBlob, hadLiveTranscript = true, meetingContextPayload = null) => {
        setMeetingAudioBlob(audioBlob)
        setMeetingContext(meetingContextPayload)
        await prepareMeetingAudioPersistence(audioBlob)
        setConfirmedLabelMap({})
        setProcessingMessage('')
        setDiarizedSegments([])
        const transcriptionOptions = {
          contextTerms: Array.isArray(meetingContextPayload?.contextTerms) ? meetingContextPayload.contextTerms : [],
          meetingContext: meetingContextPayload && typeof meetingContextPayload === 'object' ? meetingContextPayload : null,
        }

        if (compareModeAvailable && compareModeEnabled) {
          if (!audioBlob || audioBlob.size === 0) {
            setCompareResults([
              {
                provider: 'assemblyai',
                model: '',
                segments: [],
                summary: '',
                durationMs: 0,
                speakerCount: 0,
                segmentCount: 0,
                status: 'failed',
                error: 'No audio captured.',
                userRating: { bestTranscript: false, bestSummary: false },
                notes: '',
                transcriptRating: null,
                summaryRating: null,
                correctionCount: 0,
                manualSpeakerFixes: 0,
              },
              {
                provider: 'deepgram',
                model: '',
                segments: [],
                summary: '',
                durationMs: 0,
                speakerCount: 0,
                segmentCount: 0,
                status: 'failed',
                error: 'No audio captured.',
                userRating: { bestTranscript: false, bestSummary: false },
                notes: '',
                transcriptRating: null,
                summaryRating: null,
                correctionCount: 0,
                manualSpeakerFixes: 0,
              },
              {
                provider: 'grok',
                model: '',
                segments: [],
                summary: '',
                durationMs: 0,
                speakerCount: 0,
                segmentCount: 0,
                status: 'failed',
                error: 'No audio captured.',
                userRating: { bestTranscript: false, bestSummary: false },
                notes: '',
                transcriptRating: null,
                summaryRating: null,
                correctionCount: 0,
                manualSpeakerFixes: 0,
              },
            ])
            setScreen('compare-results')
            return
          }
          await runCompareMode(audioBlob, meetingContextPayload)
          return
        }

        if (hadLiveTranscript) {
          setMeetingSegments(segments)

          if (!audioBlob || audioBlob.size === 0) {
            setScreen('speaker-review')
            return
          }

          setScreen('speaker-review')
          void (async () => {
            try {
              const parsed = await transcribeWithFallback(
                audioBlob,
                transcriptionProvider,
                undefined,
                transcriptionOptions,
              )
              if (Array.isArray(parsed) && parsed.length > 0) {
                setDiarizedSegments(parsed)
              } else {
                setDiarizedSegments([])
              }
            } catch (err) {
              console.warn('[App] Diarization failed, using live segments fallback:', err?.message || err)
              setDiarizedSegments([])
            }
          })()
          return
        }

        setMeetingSegments([])
        setProcessingMessage('')
        setScreen('processing')

        if (!audioBlob || audioBlob.size === 0) {
          setScreen('results')
          return
        }

        try {
          const parsed = await transcribeWithFallback(
            audioBlob,
            transcriptionProvider,
            setProcessingMessage,
            transcriptionOptions,
          )
          if (Array.isArray(parsed) && parsed.length > 0) {
            setDiarizedSegments(parsed)
            setScreen('speaker-review')
          } else {
            setDiarizedSegments([])
            setScreen('results')
          }
        } catch (err) {
          console.warn('[App] Silent-mode diarization failed:', err?.message || err)
          setDiarizedSegments([])
          setScreen('results')
        }
      }}
      onReEnrollVoice={() => {
        setEnrollMode('reset')
        setScreen('enroll')
      }}
      onEditContext={() => {
        setContextMode('edit')
        setScreen('context-onboarding')
      }}
      onOpenCorrectionDictionary={() => {
        setContextMode('dictionary')
        setScreen('context-onboarding')
      }}
      onViewHistory={() => setScreen('history')}
      onSignOut={handleSignOut}
    />
  )
}

function ProcessingScreen({ message }) {
  return (
    <div className="min-h-screen bg-white flex items-center justify-center px-6">
      <div className="text-center">
        <div className="mx-auto mb-3 h-2 w-2 rounded-full bg-indigo-400 animate-pulse" />
        <p className="text-sm font-medium text-gray-800">processing recording</p>
        <p className="mt-1 text-xs text-gray-400">{message || 'generating transcript...'}</p>
      </div>
    </div>
  )
}

function getAuthCallbackContext() {
  if (typeof window === 'undefined') return { active: false }

  const url = new URL(window.location.href)
  const hashParams = window.location.hash.startsWith('#')
    ? new URLSearchParams(window.location.hash.slice(1))
    : new URLSearchParams()
  const searchParams = url.searchParams
  const rawMessage =
    hashParams.get('error_description') ||
    searchParams.get('error_description') ||
    hashParams.get('message') ||
    searchParams.get('message')

  const active =
    searchParams.get('auth_callback') === '1' ||
    hashParams.has('access_token') ||
    hashParams.has('error_code') ||
    searchParams.has('error_code')

  return {
    active,
    message: rawMessage ? rawMessage.replace(/\+/g, ' ') : null,
  }
}

function clearAuthCallbackUrl() {
  if (typeof window === 'undefined') return

  const url = new URL(window.location.href)
  url.hash = ''
  url.searchParams.delete('auth_callback')
  url.searchParams.delete('error')
  url.searchParams.delete('error_code')
  url.searchParams.delete('error_description')
  url.searchParams.delete('message')
  window.history.replaceState({}, '', `${url.pathname}${url.search}`)
}

function getPendingConfirmationEmail() {
  if (typeof window === 'undefined') return ''
  return window.localStorage.getItem('pending_confirmation_email') ?? ''
}

async function summarizeForCompare(transcript, meetingContextPayload) {
  return new Promise((resolve, reject) => {
    let fullText = ''
    streamSummary(
      transcript,
      (chunk) => {
        fullText += chunk
      },
      (completed) => resolve(completed || fullText),
      (err) => reject(new Error(err || 'Summary failed')),
      {
        meetingContext: meetingContextPayload && typeof meetingContextPayload === 'object' ? meetingContextPayload : null,
      },
    )
  })
}

function getCompareModeAvailability() {
  if (typeof window === 'undefined') return false
  const params = new URLSearchParams(window.location.search)
  if (params.get('compareModels') === '1') return true
  return import.meta.env.VITE_ENABLE_COMPARE_MODE === 'true'
}

function withTimeout(promise, timeoutMs) {
  let timeoutId = null
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const error = new Error('Operation timed out')
      error.name = 'TimeoutError'
      reject(error)
    }, timeoutMs)
  })

  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId)
  })
}
