import React, { useState, useEffect, useRef } from 'react'
import {
  getEnrollmentPhrases,
  recordPhrase,
  saveEnrollment,
  clearEnrollment,
} from '../lib/enrollment'
import { finalizeVoiceEnrollment, getVoiceStatus, resetVoiceProfile, validateVoicePhrase } from '../lib/api'
import { blobToWav } from '../lib/audioToWav'

const MAX_BACKGROUND_VALIDATIONS = 2

export default function EnrollScreen({ user, onComplete, mode = 'initial' }) {
  const phrases = getEnrollmentPhrases()
  const [currentPhrase, setCurrentPhrase] = useState(0)
  const [phraseStatus, setPhraseStatus] = useState(() => phrases.map(() => 'pending'))
  const [isRecording, setIsRecording] = useState(false)
  const [countdown, setCountdown] = useState(null)
  const [error, setError] = useState(null)
  const [voiceStatus, setVoiceStatus] = useState({
    enrolled: false,
    status: 'NotEnrolled',
    sample_count: 0,
    remaining_clips_needed: 5,
  })
  const [voiceError, setVoiceError] = useState(null)
  const [resetStatus, setResetStatus] = useState('idle')
  const [didRunReset, setDidRunReset] = useState(false)
  const [isFinishing, setIsFinishing] = useState(false)
  const mountedRef = useRef(true)
  const blobRef = useRef(null)
  const enrollmentRunIdRef = useRef(createEnrollmentRunId())
  const validationQueueRef = useRef([])
  const activeValidationsRef = useRef(0)
  const validationPromisesRef = useRef({})
  const validationResultsRef = useRef({})
  const finishingRef = useRef(false)
  const isOptimisticInitialEnrollment = mode === 'initial'

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const status = await getVoiceStatus()
        if (cancelled || !mountedRef.current) return
        setVoiceStatus(normalizeVoiceStatus(status))
      } catch {
        if (cancelled || !mountedRef.current) return
        setVoiceError('voice status unavailable right now')
      }
    })()

    return () => {
      cancelled = true
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    if (!user || mode !== 'reset' || didRunReset) return undefined

    ;(async () => {
      setResetStatus('resetting')
      try {
        await resetVoiceProfile()
        if (cancelled || !mountedRef.current) return
        setVoiceStatus({
          enrolled: false,
          status: 'NotEnrolled',
          sample_count: 0,
          remaining_clips_needed: 5,
        })
        setCurrentPhrase(0)
        setPhraseStatus(phrases.map(() => 'pending'))
        setError(null)
        setVoiceError(null)
        blobRef.current = null
        enrollmentRunIdRef.current = createEnrollmentRunId()
        validationQueueRef.current = []
        activeValidationsRef.current = 0
        validationPromisesRef.current = {}
        validationResultsRef.current = {}
        finishingRef.current = false
        setIsFinishing(false)
        setResetStatus('done')
      } catch {
        if (cancelled || !mountedRef.current) return
        setVoiceError('could not reset existing voice profile - please try again')
        setResetStatus('error')
      } finally {
        if (!cancelled && mountedRef.current) {
          setDidRunReset(true)
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [didRunReset, mode, phrases, user])

  async function handleRecordClick() {
    if (!mountedRef.current) return
    if (mode === 'reset' && resetStatus === 'resetting') return
    if (isFinishing || finishingRef.current) return

    setError(null)
    setVoiceError(null)
    setCountdown(3)

    await delay(1000)
    if (!mountedRef.current) return
    setCountdown(2)

    await delay(1000)
    if (!mountedRef.current) return
    setCountdown(1)

    await delay(1000)
    if (!mountedRef.current) return

    setCountdown(null)
    setIsRecording(true)
    setPhraseStatus((prev) => prev.map((status, index) => (index === currentPhrase ? 'recording' : status)))

    try {
      const phraseIndex = currentPhrase
      const blob = await recordPhrase(6000)
      blobRef.current = blob
      if (!mountedRef.current) return

      setIsRecording(false)
      setPhraseStatus((prev) => prev.map((status, index) => (index === phraseIndex ? 'validating' : status)))
      validationResultsRef.current[phraseIndex] = null
      validationPromisesRef.current[phraseIndex] = enqueueVoiceClip(blob, phraseIndex)

      if (isOptimisticInitialEnrollment) {
        setPhraseStatus((prev) => prev.map((status, index) => (index === phraseIndex ? 'recorded' : status)))
      }

      const shouldFinish = hasRecordedAllPhrases()
      if (shouldFinish) {
        if (!mountedRef.current) return
        if (isOptimisticInitialEnrollment) {
          void finishEnrollmentInBackground()
          onComplete()
          return
        }
        await finishEnrollment()
        return
      }

      if (phraseIndex < phrases.length - 1) {
        await delay(250)
        if (!mountedRef.current) return
        setCurrentPhrase((prev) => Math.max(prev, phraseIndex + 1))
        return
      }
    } catch (err) {
      if (!mountedRef.current) return

      setIsRecording(false)
      setCountdown(null)
      setPhraseStatus((prev) => prev.map((status, index) => (index === currentPhrase ? 'pending' : status)))
      setError(err.message)
    }
  }

  function handleRetry() {
    setError(null)
    setVoiceError(null)
    setIsRecording(false)
    setCountdown(null)
  }

  function handleSkip() {
    clearEnrollment(user.id)
    onComplete()
  }

  function enqueueVoiceClip(blob, phraseIndex) {
    const taskPromise = new Promise((resolve) => {
      validationQueueRef.current.push({ blob, phraseIndex, resolve })
      pumpValidationQueue()
    })

    return taskPromise
  }

  function pumpValidationQueue() {
    while (
      activeValidationsRef.current < MAX_BACKGROUND_VALIDATIONS &&
      validationQueueRef.current.length > 0
    ) {
      const task = validationQueueRef.current.shift()
      activeValidationsRef.current += 1

      void processValidationTask(task).finally(() => {
        activeValidationsRef.current -= 1
        pumpValidationQueue()
      })
    }
  }

  async function processValidationTask(task) {
    const { blob, phraseIndex, resolve } = task

    try {
      const wavBlob = await blobToWav(blob)
      const result = await validateVoicePhrase(
        wavBlob,
        phraseIndex,
        phrases[phraseIndex],
        enrollmentRunIdRef.current,
      )

      validationResultsRef.current[phraseIndex] = result

      if (mountedRef.current) {
        if (result?.accepted) {
          setPhraseStatus((prev) => prev.map((status, index) => (index === phraseIndex ? 'done' : status)))
          setVoiceStatus(normalizeVoiceStatus(result))
          setVoiceError(null)
        } else {
          setPhraseStatus((prev) => prev.map((status, index) => (index === phraseIndex ? 'failed' : status)))
          setVoiceError(result?.message || 'record the highlighted phrase again')
        }
      }

      resolve(result)
    } catch (err) {
      const result = {
        accepted: false,
        reason: 'validation_failed',
        message: 'voice check failed - try again',
      }

      validationResultsRef.current[phraseIndex] = result

      if (mountedRef.current) {
        setPhraseStatus((prev) => prev.map((status, index) => (index === phraseIndex ? 'failed' : status)))
        setVoiceError(result.message)
      }

      console.warn('[Enroll] Voice phrase validation failed:', err)
      resolve(result)
    }
  }

  function hasRecordedAllPhrases() {
    return phrases.every((_, index) => validationPromisesRef.current[index])
  }

  async function finishEnrollment() {
    if (finishingRef.current) return
    finishingRef.current = true
    setIsFinishing(true)
    setError(null)
    setVoiceError('finishing voice setup...')

    try {
      const results = await Promise.all(phrases.map((_, index) => validationPromisesRef.current[index]))
      const firstFailedIndex = results.findIndex((result) => !result?.accepted)

      if (firstFailedIndex >= 0) {
        if (!mountedRef.current) return
        const failedResult = results[firstFailedIndex]
        setCurrentPhrase(firstFailedIndex)
        setPhraseStatus((prev) => prev.map((status, index) => (index === firstFailedIndex ? 'failed' : status)))
        setError(failedResult?.message || 'record the highlighted phrase again')
        setVoiceError('record the highlighted phrase again')
        return
      }

      const finalStatus = await finalizeVoiceEnrollment(enrollmentRunIdRef.current)
      if (!mountedRef.current) return
      setVoiceStatus(normalizeVoiceStatus(finalStatus))
      setVoiceError(null)
      void saveEnrollment(user.id)
      clearVoiceEnrollmentFailure(user.id)
      onComplete()
    } catch (err) {
      if (!mountedRef.current) return
      setError(err.message || 'could not finish voice setup')
      setVoiceError('could not finish voice setup')
    } finally {
      if (mountedRef.current) {
        setIsFinishing(false)
      }
      finishingRef.current = false
    }
  }

  async function finishEnrollmentInBackground() {
    const userId = user?.id
    if (!userId) return

    clearVoiceEnrollmentFailure(userId)

    try {
      const results = await Promise.all(phrases.map((_, index) => validationPromisesRef.current[index]))
      const failedResult = results.find((result) => !result?.accepted)

      if (failedResult) {
        markVoiceEnrollmentFailure(userId, failedResult?.message || 'voice setup needs another try')
        return
      }

      const finalStatus = await finalizeVoiceEnrollment(enrollmentRunIdRef.current)
      if (finalStatus?.enrolled) {
        void saveEnrollment(userId)
        clearVoiceEnrollmentFailure(userId)
        return
      }

      markVoiceEnrollmentFailure(userId, 'voice setup needs another try')
    } catch (err) {
      markVoiceEnrollmentFailure(userId, err?.message || 'voice setup needs another try')
    }
  }

  const sampleCount = Math.max(0, Number(voiceStatus.sample_count || 0))
  const progressPercent = Math.min(100, Math.round((sampleCount / 5) * 100))

  return (
    <div className="min-h-screen bg-white flex flex-col items-center px-6">
      <style>{`
        @keyframes scaleIn {
          from { transform: scale(1.2); opacity: 0.7; }
          to { transform: scale(1); opacity: 1; }
        }

        @keyframes barBounce {
          from { height: 8px; }
          to { height: 32px; }
        }

        .wave-bar {
          animation: barBounce 0.6s ease-in-out infinite alternate;
        }
      `}</style>

      <div className="w-full max-w-md mt-16 md:mt-20">
        <div className="flex gap-1.5">
          {phraseStatus.map((status, index) => {
            let colorClass = 'bg-gray-100'

            if (status === 'done') {
              colorClass = 'bg-indigo-600'
            } else if (status === 'recorded') {
              colorClass = 'bg-indigo-200'
            } else if (status === 'validating') {
              colorClass = 'bg-indigo-400'
            } else if (status === 'failed') {
              colorClass = 'bg-red-400'
            } else if (index === currentPhrase) {
              colorClass = 'bg-indigo-300'
            }

            return <div key={phrases[index]} className={`h-1 flex-1 rounded-full ${colorClass}`} />
          })}
        </div>

        {mode === 'reset' ? (
          <>
            <h2 className="text-xl font-semibold text-gray-900 mt-5 mb-1">re-enrol your voice</h2>
            <p className="text-sm text-gray-400 mb-3">
              your old voice profile will be replaced. say each phrase clearly.
            </p>
          </>
        ) : (
          <>
            <h2 className="text-xl font-semibold text-gray-900 mt-5 mb-1">recognise your voice</h2>
            <p className="text-sm text-gray-400 mb-3">
              say each phrase clearly when prompted. takes about 30 seconds.
            </p>
          </>
        )}

        {resetStatus === 'resetting' ? (
          <p className="text-xs text-gray-400 mb-3">resetting your old voice profile...</p>
        ) : null}
        {resetStatus === 'done' && mode === 'reset' ? (
          <p className="text-xs text-emerald-600 mb-3">old voice cleared - record 5 fresh phrases</p>
        ) : null}
        {resetStatus === 'error' ? (
          <p className="text-xs text-amber-500 mb-3">{voiceError}</p>
        ) : null}

        <div>
          {phrases.map((phrase, index) => (
            <div key={phrase} className="flex items-start gap-3 py-3 border-b border-gray-50">
              <div className="w-6 h-6 flex-shrink-0 mt-0.5">
                {phraseStatus[index] === 'done' || phraseStatus[index] === 'recorded' ? (
                  <div
                    className={`w-6 h-6 rounded-full flex items-center justify-center ${
                      phraseStatus[index] === 'recorded' ? 'bg-indigo-100 border border-indigo-200' : 'bg-indigo-600'
                    }`}
                  >
                    <svg viewBox="0 0 12 12" className="h-[10px] w-[10px]" fill="none" aria-hidden="true">
                      <path
                        d="M3 6L6 9L11 3"
                        stroke={phraseStatus[index] === 'recorded' ? '#4F46E5' : 'white'}
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </div>
                ) : phraseStatus[index] === 'failed' ? (
                  <div className="w-6 h-6 rounded-full bg-red-50 border border-red-200 flex items-center justify-center">
                    <span className="text-xs font-medium text-red-500">!</span>
                  </div>
                ) : index === currentPhrase &&
                  (phraseStatus[index] === 'pending' ||
                    phraseStatus[index] === 'recording' ||
                    phraseStatus[index] === 'validating') ? (
                  <div className="w-6 h-6 rounded-full bg-indigo-50 border border-indigo-200 flex items-center justify-center">
                    <span className="text-xs font-medium text-indigo-600">{index + 1}</span>
                  </div>
                ) : (
                  <div className="w-6 h-6 rounded-full bg-gray-100 flex items-center justify-center">
                    <span className="text-xs text-gray-400">{index + 1}</span>
                  </div>
                )}
              </div>

              <p className={`text-sm leading-relaxed ${index <= currentPhrase ? 'text-gray-800' : 'text-gray-300'}`}>
                {phrase}
              </p>
            </div>
          ))}
        </div>

        <div className="mt-4">
          <div className="flex items-center justify-between text-xs text-gray-500 mb-1.5">
            <span>{sampleCount} / 5 clips accepted</span>
            <span>{Math.max(0, Number(voiceStatus.remaining_clips_needed || 0))} remaining</span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-gray-100 overflow-hidden">
            <div
              className="h-full bg-indigo-500 transition-all duration-300"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
          {voiceStatus.enrolled ? (
            <p className="text-xs text-emerald-600 mt-2">your voice is ready for future meetings</p>
          ) : null}
          {voiceError ? <p className="text-xs text-amber-500 mt-2">{voiceError}</p> : null}
        </div>

        <div className="mt-6 min-h-[100px] flex flex-col items-center justify-center">
          {countdown === null && !isRecording && phraseStatus[currentPhrase] !== 'validating' && !isFinishing ? (
            <button
              type="button"
              onClick={handleRecordClick}
              className="w-full h-11 bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white text-sm font-medium rounded-xl transition-colors"
            >
              {phraseStatus[currentPhrase] === 'failed' ? 'record phrase again' : `record phrase ${currentPhrase + 1}`}
            </button>
          ) : null}

          {countdown !== null ? (
            <>
              <div
                key={countdown}
                style={{ animation: 'scaleIn 0.3s ease-out' }}
                className="text-6xl font-bold text-indigo-600 text-center"
              >
                {countdown}
              </div>
              <p className="text-xs text-gray-400 mt-2">get ready...</p>
            </>
          ) : null}

          {isRecording ? (
            <>
              <div className="flex items-end gap-1 h-10 justify-center mb-2">
                {[0, 100, 200, 100, 0].map((delayValue, index) => (
                  <div
                    key={`bar_${index}`}
                    className="wave-bar w-1.5 rounded-full bg-indigo-500"
                    style={{ animationDelay: `${delayValue}ms` }}
                  />
                ))}
              </div>
              <p className="text-sm text-gray-400">listening...</p>
            </>
          ) : null}

          {phraseStatus[currentPhrase] === 'validating' ? (
            <p className="text-sm text-gray-400">
              {isOptimisticInitialEnrollment ? 'saving voice sample...' : 'checking phrase...'}
            </p>
          ) : null}

          {isFinishing ? (
            <p className="text-sm text-gray-400">finishing voice setup...</p>
          ) : null}
        </div>

        {error ? (
          <div>
            <p className="text-sm text-red-500 text-center mt-3">{mapErrorMessage(error)}</p>
            <div className="text-center">
              <button
                type="button"
                onClick={handleRetry}
                className="text-xs text-indigo-600 underline mt-1"
              >
                try again
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <button
        type="button"
        onClick={handleSkip}
        className="mt-auto pb-8 text-xs text-gray-300 hover:text-gray-400 underline"
      >
        skip for now
      </button>
    </div>
  )
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function createEnrollmentRunId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  return `enroll_${Date.now()}_${Math.random().toString(36).slice(2)}`
}

function getVoiceEnrollmentFailureKey(userId) {
  return `voice_enrollment_failed_${userId}`
}

function markVoiceEnrollmentFailure(userId, message) {
  if (!userId || typeof window === 'undefined') return
  try {
    window.localStorage.setItem(
      getVoiceEnrollmentFailureKey(userId),
      JSON.stringify({
        message: String(message || 'voice setup needs another try'),
        createdAt: new Date().toISOString(),
      }),
    )
    window.dispatchEvent(new CustomEvent('notemint:voice-enrollment-failed', { detail: { userId } }))
  } catch (err) {
    console.warn('[Enroll] Could not store voice enrollment failure:', err?.message || err)
  }
}

function clearVoiceEnrollmentFailure(userId) {
  if (!userId || typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(getVoiceEnrollmentFailureKey(userId))
    window.dispatchEvent(new CustomEvent('notemint:voice-enrollment-updated', { detail: { userId } }))
  } catch {}
}

function mapErrorMessage(error) {
  if (
    error === 'say the full phrase' ||
    error === 'too quiet, try again' ||
    error === 'too loud, try again' ||
    error === 'we only heard part of it' ||
    error === 'voice check failed - try again' ||
    error === 'record the highlighted phrase again' ||
    error === 'could not finish voice setup'
  ) {
    return error
  }

  if (error.includes('MICROPHONE_DENIED')) {
    return 'microphone access was denied - check browser settings'
  }

  if (error.includes('MICROPHONE_NOT_FOUND')) {
    return 'no microphone found - connect one and try again'
  }

  return "couldn't access microphone - tap to try again"
}

function normalizeVoiceStatus(status) {
  return {
    enrolled: Boolean(status?.enrolled),
    status: status?.status || 'NotEnrolled',
    sample_count: Number(status?.sample_count || 0),
    remaining_clips_needed: Math.max(0, Number(status?.remaining_clips_needed || 5)),
  }
}
