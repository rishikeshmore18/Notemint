import { useEffect, useState } from 'react'
import AuthScreen from './screens/AuthScreen'
import RecordScreen from './screens/RecordScreen'
import ResultsScreen from './screens/ResultsScreen'
import { getCurrentUser, signOut, supabase } from './lib/supabase'

export default function App() {
  const [screen, setScreen] = useState('loading')
  const [currentUser, setCurrentUser] = useState(null)
  const [currentMeeting, setCurrentMeeting] = useState([])

  useEffect(() => {
    let isMounted = true

    const initialize = async () => {
      const user = await getCurrentUser()
      if (!isMounted) return
      setCurrentUser(user)
      applyEnrollmentGate(user)
    }

    initialize()

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') {
        setCurrentUser(null)
        setScreen('auth')
        return
      }

      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
        const user = session?.user ?? null
        setCurrentUser(user)
        applyEnrollmentGate(user)
      }
    })

    return () => {
      isMounted = false
      subscription.unsubscribe()
    }
  }, [])

  function applyEnrollmentGate(user) {
    if (!user) {
      setScreen('auth')
      return
    }

    const enrolled = localStorage.getItem(`enrolled_${user.id}`) === 'true'
    setScreen(enrolled ? 'home' : 'enroll')
  }

  async function handleAuthenticated() {
    const user = await getCurrentUser()
    setCurrentUser(user)
    applyEnrollmentGate(user)
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
    return <AuthScreen onAuthenticated={handleAuthenticated} />
  }

  if (screen === 'enroll') {
    return <EnrollScreen onSkip={handleSkipEnrollment} />
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

function EnrollScreen({ onSkip }) {
  return (
    <div className="min-h-screen bg-white flex items-center justify-center">
      <div className="flex flex-col items-center gap-4">
        <p className="text-gray-900">enrollment coming soon</p>
        <button
          type="button"
          onClick={onSkip}
          className="h-10 rounded-lg bg-indigo-600 px-4 text-sm font-medium text-white"
        >
          skip for now
        </button>
      </div>
    </div>
  )
}
