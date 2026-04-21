import { useEffect, useRef, useState } from 'react'
import AuthScreen from './screens/AuthScreen'
import AuthCallbackScreen from './screens/AuthCallbackScreen'
import EnrollScreen from './screens/EnrollScreen'
import RecordScreen from './screens/RecordScreen'
import ResultsScreen from './screens/ResultsScreen'
import { getCurrentUser, signOut, supabase, syncUserProfile } from './lib/supabase'

export default function App() {
  const [screen, setScreen] = useState('loading')
  const [currentUser, setCurrentUser] = useState(null)
  const [currentMeeting, setCurrentMeeting] = useState([])
  const [authScreenError, setAuthScreenError] = useState(null)
  const [callbackState, setCallbackState] = useState({
    status: 'pending',
    title: 'Confirming your email',
    message: 'Finishing secure sign in...',
  })
  const callbackContextRef = useRef(getAuthCallbackContext())
  const redirectTimeoutRef = useRef(null)

  useEffect(() => {
    let isMounted = true
    const callbackContext = callbackContextRef.current

    if (callbackContext.active) {
      setScreen('auth-callback')
    }

    const initialize = async () => {
      const user = await getCurrentUser()
      if (!isMounted) return
      setCurrentUser(user)
      resolveInitialScreen(user, callbackContext)
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

    applyEnrollmentGate(user)
  }

  function handleSignedInUser(user) {
    void syncUserProfile(user)

    if (callbackContextRef.current.active) {
      showCallbackSuccess(user)
      return
    }

    applyEnrollmentGate(user)
  }

  function applyEnrollmentGate(user) {
    if (!user) {
      setScreen('auth')
      return
    }

    const enrolled = localStorage.getItem(`enrolled_${user.id}`) === 'true'
    setScreen(enrolled ? 'home' : 'enroll')
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
      applyEnrollmentGate(user)
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
    const user = await getCurrentUser()
    await syncUserProfile(user)
    setCurrentUser(user)
    setAuthScreenError(null)
    applyEnrollmentGate(user)
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
    setScreen('home')
  }

  async function handleSignOut() {
    await signOut()
    setCurrentUser(null)
    setScreen('auth')
  }

  function handleMeetingComplete(segments) {
    setCurrentMeeting(segments)
    setScreen('results')
  }

  function handleNewMeeting() {
    setCurrentMeeting([])
    setScreen('home')
  }

  if (screen === 'loading') {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center">
        <span className="h-2 w-2 rounded-full bg-gray-400" />
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
    return <EnrollScreen user={currentUser} onComplete={handleSkipEnrollment} />
  }

  if (screen === 'results') {
    return <ResultsScreen segments={currentMeeting} onNewMeeting={handleNewMeeting} />
  }

  return (
    <RecordScreen
      user={currentUser}
      enrolledVoiceId={currentUser ? localStorage.getItem(`enrolled_${currentUser.id}`) : null}
      onMeetingComplete={handleMeetingComplete}
      onSignOut={handleSignOut}
    />
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
