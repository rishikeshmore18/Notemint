import { useEffect, useRef, useState } from 'react'
import AuthScreen from './screens/AuthScreen'
import AuthCallbackScreen from './screens/AuthCallbackScreen'
import EnrollScreen from './screens/EnrollScreen'
import ContextOnboardingScreen from './screens/ContextOnboardingScreen'
import RecordScreen from './screens/RecordScreen'
import SpeakerReviewScreen from './screens/SpeakerReviewScreen'
import ResultsScreen from './screens/ResultsScreen'
import HistoryScreen from './screens/HistoryScreen'
import PastMeetingScreen from './screens/PastMeetingScreen'
import LoadingDot from './components/LoadingDot'
import { getCurrentUser, signOut, supabase, syncUserProfile } from './lib/supabase'
import {
  getStoredAudioTranscriptionStatus,
  getVoiceStatus,
  startStoredAudioTranscription,
  transcribeAudio,
} from './lib/api'
import { rememberSpeakerLabels } from './lib/speakerMemory'
import { hasContextProfile } from './lib/contextProfile'
import {
  createMeetingDraft,
  setMeetingAudioUploadStatus,
} from './lib/summary'
import { retryPendingAudioUploads, uploadAudioWithBackup } from './lib/audioUploadQueue'
import { repairSpeakerTurns } from './lib/speakerTurnRepair'

export default function App() {
  const [screen, setScreen] = useState('loading')
  const [enrollMode, setEnrollMode] = useState('initial')
  const [contextMode, setContextMode] = useState('initial')
  const [processingMessage, setProcessingMessage] = useState('')
  const [currentUser, setCurrentUser] = useState(null)
  const [meetingSegments, setMeetingSegments] = useState([])
  const [meetingAudioBlob, setMeetingAudioBlob] = useState(null)
  const [meetingId, setMeetingId] = useState(null)
  const [audioSaveMessage, setAudioSaveMessage] = useState('')
  const [audioUploadStatus, setAudioUploadStatus] = useState('pending')
  const [audioUploadProgress, setAudioUploadProgress] = useState(0)
  const [meetingContext, setMeetingContext] = useState(null)
  const [diarizedSegments, setDiarizedSegments] = useState([])
  const [confirmedLabelMap, setConfirmedLabelMap] = useState({})
  const [selectedMeeting, setSelectedMeeting] = useState(null)
  const [authScreenError, setAuthScreenError] = useState(null)
  const [voiceEnrollmentIssue, setVoiceEnrollmentIssue] = useState(null)
  const [callbackState, setCallbackState] = useState({
    status: 'pending',
    title: 'Confirming your email',
    message: 'Finishing secure sign in...',
  })
  const callbackContextRef = useRef(getAuthCallbackContext())
  const redirectTimeoutRef = useRef(null)
  const uploadRetryInFlightRef = useRef(false)
  const feedbackUrl = String(
    import.meta.env.VITE_FEEDBACK_FORM_URL || 'https://forms.gle/vJekpUCer7bX3M856',
  ).trim()

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

  useEffect(() => {
    if (!currentUser?.id) return

    const retryUploads = () => {
      void retryPendingMeetingAudioUploads()
    }

    retryUploads()
    const retryInterval = window.setInterval(retryUploads, 180000)
    window.addEventListener('online', retryUploads)
    window.addEventListener('focus', retryUploads)
    return () => {
      window.clearInterval(retryInterval)
      window.removeEventListener('online', retryUploads)
      window.removeEventListener('focus', retryUploads)
    }
  }, [currentUser?.id])

  useEffect(() => {
    const refreshIssue = () => {
      setVoiceEnrollmentIssue(readVoiceEnrollmentIssue(currentUser?.id))
    }

    refreshIssue()
    window.addEventListener('notemint:voice-enrollment-failed', refreshIssue)
    window.addEventListener('notemint:voice-enrollment-updated', refreshIssue)
    window.addEventListener('storage', refreshIssue)
    return () => {
      window.removeEventListener('notemint:voice-enrollment-failed', refreshIssue)
      window.removeEventListener('notemint:voice-enrollment-updated', refreshIssue)
      window.removeEventListener('storage', refreshIssue)
    }
  }, [currentUser?.id])

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

    let enrolled = localStorage.getItem(`enrolled_${user.id}`) === 'true'
    if (!enrolled) {
      try {
        const voiceStatus = await getVoiceStatus()
        enrolled = Boolean(voiceStatus?.enrolled)
        if (enrolled) {
          localStorage.setItem(`enrolled_${user.id}`, 'true')
        }
      } catch (err) {
        console.warn('[App] Could not verify enrollment status from backend:', err?.message || err)
      }
    }

    if (!enrolled) {
      setScreen('enroll')
      return
    }

    setVoiceEnrollmentIssue(readVoiceEnrollmentIssue(user.id))

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

  async function transcribeWithAssemblyAI(audioBlob, onStatus, options = {}) {
    onStatus?.('Generating transcript...')
    const parsed = await transcribeAudio(audioBlob, 'assemblyai', options)
    if (Array.isArray(parsed) && parsed.length > 0) {
      return repairSpeakerTurns(parsed)
    }
    return []
  }

  async function transcribeStoredMeetingAudio({ meetingId, audioStoragePath, onStatus, options = {} }) {
    if (!meetingId || !audioStoragePath) {
      throw new Error('Stored audio is not ready')
    }

    onStatus?.('Starting transcription...')
    const started = await startStoredAudioTranscription({
      meetingId,
      audioStoragePath,
      contextTerms: Array.isArray(options?.contextTerms) ? options.contextTerms : [],
      meetingContext: options?.meetingContext || null,
    })

    if (started?.status === 'completed' && Array.isArray(started.segments) && started.segments.length > 0) {
      return repairSpeakerTurns(started.segments)
    }

    const startedAt = Date.now()
    const timeoutMs = 180000
    while (Date.now() - startedAt < timeoutMs) {
      onStatus?.('Processing your meeting...')
      await delay(2500)
      const status = await getStoredAudioTranscriptionStatus(meetingId)
      if (status.status === 'completed') {
        return repairSpeakerTurns(status.segments)
      }
      if (status.status === 'failed') {
        throw new Error(status.error || 'Transcription failed')
      }
    }

    throw new Error('Transcription timed out')
  }

  async function transcribeMeetingAudioOptimized({ audioBlob, audioPersistence, onStatus, options = {} }) {
    if (audioPersistence?.meetingId && audioPersistence?.audioStoragePath) {
      try {
        return await transcribeStoredMeetingAudio({
          meetingId: audioPersistence.meetingId,
          audioStoragePath: audioPersistence.audioStoragePath,
          onStatus,
          options,
        })
      } catch (err) {
        console.warn('[App] Stored-audio transcription failed, falling back to blob route:', err?.message || err)
      }
    }

    return transcribeWithAssemblyAI(audioBlob, onStatus, options)
  }

  async function prepareMeetingAudioPersistence(audioBlob) {
    setMeetingId(null)
    setAudioSaveMessage('')
    setAudioUploadStatus('pending')
    setAudioUploadProgress(0)

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

    void uploadAudioWithBackup(
      supabase,
      {
        userId: currentUser.id,
        meetingId: draftMeetingId,
        audioBlob,
      },
      {
        onStatus: (status, result) => {
          if (status === 'uploaded_verified') {
            setAudioUploadStatus('uploaded')
            setAudioUploadProgress(100)
            setAudioSaveMessage('')
            return
          }
          if (status === 'uploaded') {
            setAudioUploadStatus('pending')
            setAudioUploadProgress(100)
            setAudioSaveMessage('Recording uploaded. Verifying playback...')
            return
          }
          if (status === 'backup_failed') {
            console.warn('[App] Audio backup failed:', result?.error || result)
            setAudioUploadStatus('backup_failed')
            setAudioSaveMessage('Keep this tab open. Recording is not safely backed up yet.')
            return
          }
          if (status === 'pending_retry') {
            console.warn('[App] Audio upload pending retry:', result?.error || result)
            setAudioUploadStatus('pending')
            setAudioSaveMessage('Recording saved on this device. Upload will retry automatically when connection returns.')
            return
          }
          if (status === 'pending_retry_unbacked') {
            console.warn('[App] Audio upload failed without local backup:', result?.error || result)
            setAudioUploadStatus('backup_failed')
            setAudioSaveMessage('Keep this tab open. Recording is not safely backed up yet.')
            return
          }
          if (status === 'backed_up') {
            setAudioUploadStatus('pending')
            setAudioSaveMessage('Recording saved on this device. Uploading...')
            return
          }
          if (status === 'uploading') {
            setAudioUploadStatus('pending')
            setAudioSaveMessage('Recording saved on this device. Uploading...')
            return
          }
          if (status === 'uploading_unbacked') {
            setAudioUploadStatus('backup_failed')
            setAudioSaveMessage('Keep this tab open. Recording is not safely backed up yet.')
          }
        },
        onProgress: (progress) => {
          setAudioUploadProgress(normalizeUploadProgress(progress))
        },
      },
    )

    return {
      meetingId: draftMeetingId,
      audioStoragePath: '',
    }
  }

  async function retryPendingMeetingAudioUploads() {
    if (!currentUser?.id || uploadRetryInFlightRef.current) return
    uploadRetryInFlightRef.current = true
    try {
      await retryPendingAudioUploads(supabase, currentUser.id, {
        onItemStatus: (record, status) => {
          if (record?.meetingId !== meetingId) return
          if (status === 'uploaded_verified') {
            setAudioUploadStatus('uploaded')
            setAudioUploadProgress(100)
            setAudioSaveMessage('')
            return
          }
          if (status === 'uploaded') {
            setAudioUploadStatus('pending')
            setAudioUploadProgress(100)
            setAudioSaveMessage('Recording uploaded. Verifying playback...')
            return
          }
          if (status === 'uploading') {
            setAudioUploadStatus('pending')
            setAudioSaveMessage('Recording saved on this device. Uploading...')
            return
          }
          if (status === 'pending') {
            setAudioUploadStatus('pending')
            setAudioSaveMessage('Recording saved on this device. Upload will retry automatically when connection returns.')
          }
        },
        onItemProgress: (record, progress) => {
          if (record?.meetingId !== meetingId) return
          setAudioUploadProgress(normalizeUploadProgress(progress))
        },
      })
    } catch (err) {
      console.warn('[App] Pending audio retry failed:', err?.message || err)
    } finally {
      uploadRetryInFlightRef.current = false
    }
  }

  async function retryMeetingAudioUpload() {
    if (!currentUser?.id || !meetingId) {
      return
    }

    if (!meetingAudioBlob || meetingAudioBlob.size === 0) {
      await retryPendingMeetingAudioUploads()
      return
    }

    setAudioUploadStatus('pending')
    setAudioSaveMessage('Recording is uploading in the background.')

    try {
      await setMeetingAudioUploadStatus(supabase, {
        userId: currentUser.id,
        meetingId,
        status: 'pending',
      })
    } catch (err) {
      console.warn('[App] Could not mark audio upload as pending:', err?.message || err)
    }

    void uploadAudioWithBackup(
      supabase,
      {
        userId: currentUser.id,
        meetingId,
        audioBlob: meetingAudioBlob,
      },
      {
        onStatus: (status, result) => {
          if (status === 'uploaded_verified') {
            setAudioUploadStatus('uploaded')
            setAudioUploadProgress(100)
            setAudioSaveMessage('')
            return
          }
          if (status === 'uploaded') {
            setAudioUploadStatus('pending')
            setAudioUploadProgress(100)
            setAudioSaveMessage('Recording uploaded. Verifying playback...')
            return
          }
          if (status === 'backup_failed') {
            console.warn('[App] Retry audio backup failed:', result?.error || result)
            setAudioUploadStatus('backup_failed')
            setAudioSaveMessage('Keep this tab open. Recording is not safely backed up yet.')
            return
          }
          if (status === 'pending_retry') {
            console.warn('[App] Retry audio upload pending retry:', result?.error || result)
            setAudioUploadStatus('pending')
            setAudioSaveMessage('Recording saved on this device. Upload will retry automatically when connection returns.')
            return
          }
          if (status === 'pending_retry_unbacked') {
            console.warn('[App] Retry audio upload failed without local backup:', result?.error || result)
            setAudioUploadStatus('backup_failed')
            setAudioSaveMessage('Keep this tab open. Recording is not safely backed up yet.')
            return
          }
          if (status === 'backed_up') {
            setAudioUploadStatus('pending')
            setAudioSaveMessage('Recording saved on this device. Uploading...')
            return
          }
          if (status === 'uploading') {
            setAudioUploadStatus('pending')
            setAudioSaveMessage('Recording saved on this device. Uploading...')
            return
          }
          if (status === 'uploading_unbacked') {
            setAudioUploadStatus('backup_failed')
            setAudioSaveMessage('Keep this tab open. Recording is not safely backed up yet.')
          }
        },
        onProgress: (progress) => {
          setAudioUploadProgress(normalizeUploadProgress(progress))
        },
      },
    )
  }

  const bestAvailableSegments = diarizedSegments.length > 0 ? diarizedSegments : meetingSegments

  if (screen === 'loading') {
    return (
      <>
        <div className="min-h-screen bg-white flex items-center justify-center">
          <LoadingDot />
        </div>
        <FloatingFeedbackButton url={feedbackUrl} />
      </>
    )
  }

  if (screen === 'auth') {
    return (
      <>
        <AuthScreen
          onAuthenticated={handleAuthenticated}
          initialEmail={getPendingConfirmationEmail()}
          initialError={authScreenError}
        />
        <FloatingFeedbackButton url={feedbackUrl} />
      </>
    )
  }

  if (screen === 'auth-callback') {
    return (
      <>
        <GlobalBackButton
          onHome={() => handleReturnToAuth(null)}
          onClick={() => {
            handleReturnToAuth(null)
          }}
        />
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
        <FloatingFeedbackButton url={feedbackUrl} />
      </>
    )
  }

  if (screen === 'enroll') {
    return (
      <>
        <GlobalBackButton
          onHome={() => setScreen('home')}
          onClick={() => {
            if (currentUser) {
              setScreen('home')
              return
            }
            handleReturnToAuth(null)
          }}
        />
        <EnrollScreen
          user={currentUser}
          mode={enrollMode}
          onComplete={() => {
            setEnrollMode('initial')
            handleSkipEnrollment()
          }}
        />
        <FloatingFeedbackButton url={feedbackUrl} />
      </>
    )
  }

  if (screen === 'context-onboarding') {
    return (
      <>
        <GlobalBackButton
          onHome={() => setScreen('home')}
          onClick={() => {
            setContextMode('initial')
            setScreen('home')
          }}
        />
        <ContextOnboardingScreen
          user={currentUser}
          mode={contextMode}
          onComplete={() => {
            setContextMode('initial')
            void applyEnrollmentGate(currentUser)
          }}
          onSkip={() => {
            setContextMode('initial')
            setScreen('home')
          }}
        />
        <FloatingFeedbackButton url={feedbackUrl} />
      </>
    )
  }

  if (screen === 'processing') {
    return (
      <>
        <GlobalBackButton onClick={() => setScreen('home')} onHome={() => setScreen('home')} />
        <ProcessingScreen message={processingMessage} />
        <FloatingFeedbackButton url={feedbackUrl} />
      </>
    )
  }

  if (screen === 'results') {
    return (
      <>
        <GlobalBackButton onClick={() => setScreen('home')} onHome={() => setScreen('home')} />
        <ResultsScreen
          user={currentUser}
          segments={bestAvailableSegments}
          audioBlob={meetingAudioBlob}
          meetingContext={meetingContext}
          confirmedLabelMap={confirmedLabelMap}
          initialMeetingId={meetingId}
          audioSaveMessage={audioSaveMessage}
          audioUploadStatus={audioUploadStatus}
          audioUploadProgress={audioUploadProgress}
          onRetryAudioUpload={retryMeetingAudioUpload}
          onNewMeeting={() => {
            setMeetingSegments([])
            setMeetingAudioBlob(null)
            setMeetingId(null)
            setAudioSaveMessage('')
            setAudioUploadStatus('pending')
            setAudioUploadProgress(0)
            setMeetingContext(null)
            setDiarizedSegments([])
            setConfirmedLabelMap({})
            setProcessingMessage('')
            setEnrollMode('initial')
            setScreen('home')
          }}
        />
        <FloatingFeedbackButton url={feedbackUrl} />
      </>
    )
  }

  if (screen === 'speaker-review') {
    return (
      <>
        <GlobalBackButton onClick={() => setScreen('home')} onHome={() => setScreen('home')} />
        <SpeakerReviewScreen
          segments={bestAvailableSegments}
          audioBlob={meetingAudioBlob}
          user={currentUser}
          onConfirmed={(labelMap, correctedSegments) => {
            void rememberSpeakerLabels(currentUser?.id, labelMap).catch((err) => {
              console.warn('[App] Could not remember speaker names:', err?.message || err)
            })
            if (Array.isArray(correctedSegments) && correctedSegments.length > 0) {
              if (diarizedSegments.length > 0) {
                setDiarizedSegments(correctedSegments)
              } else {
                setMeetingSegments(correctedSegments)
              }
            }
            setConfirmedLabelMap(labelMap)
            setScreen('results')
          }}
          onSkip={() => {
            setConfirmedLabelMap({})
            setScreen('results')
          }}
        />
        <FloatingFeedbackButton url={feedbackUrl} />
      </>
    )
  }

  if (screen === 'history') {
    return (
      <>
        <GlobalBackButton
          onClick={() => setScreen('home')}
          onHome={() => setScreen('home')}
          user={currentUser}
          onEditContext={() => {
            setContextMode('edit')
            setScreen('context-onboarding')
          }}
          onOpenCorrectionDictionary={() => {
            setContextMode('dictionary')
            setScreen('context-onboarding')
          }}
          onReEnrollVoice={() => {
            setEnrollMode('reset')
            clearVoiceEnrollmentIssue(currentUser?.id)
            setVoiceEnrollmentIssue(null)
            setScreen('enroll')
          }}
          onSignOut={handleSignOut}
        />
        <HistoryScreen
          user={currentUser}
          onBack={() => setScreen('home')}
          onRetryPendingAudioUploads={retryPendingMeetingAudioUploads}
          onOpenMeeting={(meeting) => {
            setSelectedMeeting(meeting)
            setScreen('past-meeting')
          }}
        />
        <FloatingFeedbackButton url={feedbackUrl} />
      </>
    )
  }

  if (screen === 'past-meeting' && selectedMeeting) {
    return (
      <>
        <GlobalBackButton onClick={() => setScreen('history')} onHome={() => setScreen('home')} />
        <PastMeetingScreen
          user={currentUser}
          meeting={selectedMeeting}
          onBack={() => setScreen('history')}
          onRetryPendingAudioUploads={retryPendingMeetingAudioUploads}
        />
        <FloatingFeedbackButton url={feedbackUrl} />
      </>
    )
  }

  return (
    <>
      <RecordScreen
        user={currentUser}
        voiceEnrollmentIssue={voiceEnrollmentIssue}
        onMeetingComplete={async (segments, audioBlob, hadLiveTranscript = true, meetingContextPayload = null) => {
          setMeetingAudioBlob(audioBlob)
          setMeetingContext(meetingContextPayload)
          setConfirmedLabelMap({})
          setDiarizedSegments([])
          setMeetingSegments(Array.isArray(segments) ? segments : [])
          setProcessingMessage('Preparing your transcript...')
          setScreen('processing')

          const audioPersistence = await prepareMeetingAudioPersistence(audioBlob)

          const transcriptionOptions = {
            contextTerms: Array.isArray(meetingContextPayload?.contextTerms) ? meetingContextPayload.contextTerms : [],
            meetingContext: meetingContextPayload && typeof meetingContextPayload === 'object' ? meetingContextPayload : null,
          }

          if (hadLiveTranscript) {
            if (!audioBlob || audioBlob.size === 0) {
              setScreen('speaker-review')
              return
            }

            try {
              const parsed = await transcribeMeetingAudioOptimized({
                audioBlob,
                audioPersistence,
                onStatus: setProcessingMessage,
                options: transcriptionOptions,
              })
              if (Array.isArray(parsed) && parsed.length > 0) {
                setDiarizedSegments(parsed)
              }
            } catch (err) {
              console.warn('[App] Diarization failed, using live segments fallback:', err?.message || err)
              setDiarizedSegments([])
            }

            setScreen('speaker-review')
            return
          }

          setMeetingSegments([])
          setProcessingMessage('Preparing your transcript...')

          if (!audioBlob || audioBlob.size === 0) {
            setScreen('results')
            return
          }

          try {
            const parsed = await transcribeMeetingAudioOptimized({
              audioBlob,
              audioPersistence,
              onStatus: setProcessingMessage,
              options: transcriptionOptions,
            })
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
          clearVoiceEnrollmentIssue(currentUser?.id)
          setVoiceEnrollmentIssue(null)
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
        onGoHome={() => setScreen('home')}
        onViewHistory={() => setScreen('history')}
        onSignOut={handleSignOut}
      />
      <FloatingFeedbackButton url={feedbackUrl} />
    </>
  )
}

function GlobalBackButton({
  onClick,
  onHome,
  user = null,
  onEditContext = null,
  onOpenCorrectionDictionary = null,
  onReEnrollVoice = null,
  onSignOut = null,
}) {
  if (typeof onClick !== 'function') return null
  return (
    <div className="sticky top-0 z-40 bg-white/95 px-4 py-2 backdrop-blur">
      <div className="mx-auto grid h-10 max-w-2xl grid-cols-[auto_1fr_auto] items-center">
        <button
          type="button"
          onClick={onClick}
          className="inline-flex h-9 min-w-9 items-center justify-center rounded-full bg-white px-3 text-sm font-medium text-gray-700 shadow-sm ring-1 ring-black/5 hover:bg-gray-50"
          aria-label="Go back"
        >
          <span aria-hidden="true" className="mr-1 text-base leading-none">{'<'}</span>
          back
        </button>
        <button
          type="button"
          onClick={typeof onHome === 'function' ? onHome : onClick}
          className="justify-self-center text-sm font-medium text-gray-900 hover:text-indigo-600"
        >
          notemint
        </button>
        <div className="flex h-9 w-[70px] items-center justify-end">
          {user ? (
            <TopBarProfileMenu
              user={user}
              onEditContext={onEditContext}
              onOpenCorrectionDictionary={onOpenCorrectionDictionary}
              onReEnrollVoice={onReEnrollVoice}
              onSignOut={onSignOut}
            />
          ) : null}
        </div>
      </div>
    </div>
  )
}

function TopBarProfileMenu({
  user,
  onEditContext,
  onOpenCorrectionDictionary,
  onReEnrollVoice,
  onSignOut,
}) {
  const [open, setOpen] = useState(false)
  const initial = user?.email?.[0]?.toUpperCase() || '?'

  function handleAction(action) {
    setOpen(false)
    action?.()
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-label="Open profile menu"
        className="flex h-8 w-8 items-center justify-center rounded-full bg-indigo-100 text-sm font-medium text-indigo-600"
      >
        {initial}
      </button>

      {open ? (
        <div className="absolute right-0 mt-2 w-44 overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
          <button
            type="button"
            onClick={() => handleAction(onEditContext)}
            className="w-full px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50"
          >
            edit work context
          </button>
          <button
            type="button"
            onClick={() => handleAction(onOpenCorrectionDictionary)}
            className="w-full border-t border-gray-100 px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50"
          >
            correction dictionary
          </button>
          <button
            type="button"
            onClick={() => handleAction(onReEnrollVoice)}
            className="w-full border-t border-gray-100 px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50"
          >
            re-enroll voice
          </button>
          <button
            type="button"
            onClick={() => handleAction(onSignOut)}
            className="w-full border-t border-gray-100 px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50"
          >
            sign out
          </button>
        </div>
      ) : null}
    </div>
  )
}

function FloatingFeedbackButton({ url }) {
  const destination = String(url || '').trim()
  const hasUrl = destination.length > 0

  return (
    <button
      type="button"
      onClick={() => {
        if (!hasUrl) return
        window.open(destination, '_blank', 'noopener,noreferrer')
      }}
      className={`fixed bottom-5 right-5 z-40 inline-flex h-11 items-center justify-center rounded-full px-4 text-sm font-medium text-white shadow-lg transition ${
        hasUrl ? 'bg-indigo-600 hover:bg-indigo-700' : 'bg-gray-400 cursor-not-allowed'
      }`}
      title={hasUrl ? 'Open feedback form in new tab' : 'Set VITE_FEEDBACK_FORM_URL to enable feedback'}
      aria-label="Open feedback form"
      disabled={!hasUrl}
    >
      feedback
    </button>
  )
}

function ProcessingScreen({ message }) {
  return (
    <div className="min-h-screen bg-white/85 flex items-center justify-center px-6 backdrop-blur-sm">
      <div className="text-center">
        <div className="mx-auto mb-4 h-9 w-9 animate-spin rounded-full border-2 border-gray-200 border-t-indigo-600" />
        <p className="text-sm font-medium text-gray-900">Processing your meeting</p>
        <p className="mt-1 text-xs text-gray-400">{message || 'Recognizing speakers...'}</p>
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

function getVoiceEnrollmentFailureKey(userId) {
  return `voice_enrollment_failed_${userId}`
}

function readVoiceEnrollmentIssue(userId) {
  if (!userId || typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(getVoiceEnrollmentFailureKey(userId))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return {
      message: String(parsed?.message || 'Voice setup needs another try.'),
      createdAt: parsed?.createdAt || null,
    }
  } catch {
    return {
      message: 'Voice setup needs another try.',
      createdAt: null,
    }
  }
}

function clearVoiceEnrollmentIssue(userId) {
  if (!userId || typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(getVoiceEnrollmentFailureKey(userId))
    window.dispatchEvent(new CustomEvent('notemint:voice-enrollment-updated', { detail: { userId } }))
  } catch (err) {
    console.warn('[App] Could not clear voice enrollment issue:', err?.message || err)
  }
}

function normalizeUploadProgress(progress) {
  const percentage = Number(progress?.percentage)
  if (!Number.isFinite(percentage)) return 0
  return Math.max(0, Math.min(100, Math.round(percentage)))
}

function delay(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms)
  })
}
