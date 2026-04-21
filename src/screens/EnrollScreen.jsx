import React, { useState, useEffect, useRef } from 'react'
import {
  getEnrollmentPhrases,
  recordPhrase,
  saveEnrollment,
  clearEnrollment,
} from '../lib/enrollment'

export default function EnrollScreen({ user, onComplete }) {
  const phrases = getEnrollmentPhrases()
  const [currentPhrase, setCurrentPhrase] = useState(0)
  const [phraseStatus, setPhraseStatus] = useState(() => phrases.map(() => 'pending'))
  const [isRecording, setIsRecording] = useState(false)
  const [countdown, setCountdown] = useState(null)
  const [error, setError] = useState(null)
  const mountedRef = useRef(true)
  const blobRef = useRef(null)

  useEffect(() => {
    return () => {
      mountedRef.current = false
    }
  }, [])

  async function handleRecordClick() {
    if (!mountedRef.current) return

    setError(null)
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
      const blob = await recordPhrase(4000)
      blobRef.current = blob
      if (!mountedRef.current) return

      setIsRecording(false)
      setPhraseStatus((prev) => prev.map((status, index) => (index === currentPhrase ? 'done' : status)))

      if (currentPhrase < phrases.length - 1) {
        await delay(600)
        if (!mountedRef.current) return
        setCurrentPhrase((prev) => prev + 1)
        return
      }

      void saveEnrollment(user.id, blobRef.current)
      onComplete()
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
    setIsRecording(false)
    setCountdown(null)
  }

  function handleSkip() {
    clearEnrollment(user.id)
    onComplete()
  }

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
            } else if (index === currentPhrase) {
              colorClass = 'bg-indigo-300'
            }

            return <div key={phrases[index]} className={`h-1 flex-1 rounded-full ${colorClass}`} />
          })}
        </div>

        <h2 className="text-xl font-semibold text-gray-900 mt-5 mb-1">recognise your voice</h2>
        <p className="text-sm text-gray-400 mb-6">
          say each phrase clearly when prompted. takes about 30 seconds.
        </p>

        <div>
          {phrases.map((phrase, index) => (
            <div key={phrase} className="flex items-start gap-3 py-3 border-b border-gray-50">
              <div className="w-6 h-6 flex-shrink-0 mt-0.5">
                {phraseStatus[index] === 'done' ? (
                  <div className="w-6 h-6 rounded-full bg-indigo-600 flex items-center justify-center">
                    <svg viewBox="0 0 12 12" className="h-[10px] w-[10px]" fill="none" aria-hidden="true">
                      <path
                        d="M3 6L6 9L11 3"
                        stroke="white"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </div>
                ) : index === currentPhrase && (phraseStatus[index] === 'pending' || phraseStatus[index] === 'recording') ? (
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

        <div className="mt-6 min-h-[100px] flex flex-col items-center justify-center">
          {countdown === null && !isRecording ? (
            <button
              type="button"
              onClick={handleRecordClick}
              className="w-full h-11 bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white text-sm font-medium rounded-xl transition-colors"
            >
              record phrase {currentPhrase + 1}
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

function mapErrorMessage(error) {
  if (error.includes('MICROPHONE_DENIED')) {
    return 'microphone access was denied - check browser settings'
  }

  if (error.includes('MICROPHONE_NOT_FOUND')) {
    return 'no microphone found - connect one and try again'
  }

  return "couldn't access microphone - tap to try again"
}
