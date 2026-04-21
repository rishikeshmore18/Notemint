import { useEffect, useState } from 'react'
import { resendSignupConfirmation, signIn, signUp } from '../lib/supabase'

const EMAIL_CONFIRMATION_MESSAGE =
  'Supabase email confirmation is enabled. Disable Confirm Email in Supabase to make signup instant.'

export default function AuthScreen({ initialEmail = '', initialError = null, onAuthenticated }) {
  const [mode, setMode] = useState('signin')
  const [email, setEmail] = useState(initialEmail)
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(initialError)
  const [notice, setNotice] = useState(null)
  const [pendingEmail, setPendingEmail] = useState(initialEmail)

  const isSignIn = mode === 'signin'

  useEffect(() => {
    if (initialEmail && !email) {
      setEmail(initialEmail)
      setPendingEmail(initialEmail)
    }
  }, [email, initialEmail])

  useEffect(() => {
    setError(initialError)
  }, [initialError])

  function handleModeChange(nextMode) {
    setMode(nextMode)
    setError(null)
    setNotice(null)
  }

  function handleEmailChange(event) {
    setEmail(event.target.value)
    if (error) setError(null)
    if (notice) setNotice(null)
  }

  function handlePasswordChange(event) {
    setPassword(event.target.value)
    if (error) setError(null)
    if (notice) setNotice(null)
  }

  async function handleSubmit(event) {
    event?.preventDefault?.()
    if (loading) return

    const trimmedEmail = email.trim()
    if (!trimmedEmail) {
      setError('please enter your email')
      return
    }

    if (!isSignIn && password.length < 6) {
      setError('password must be at least 6 characters')
      return
    }

    setLoading(true)
    setError(null)
    setNotice(null)

    try {
      if (isSignIn) {
        await signIn(trimmedEmail, password)
        window.localStorage.removeItem('pending_confirmation_email')
        setPendingEmail('')
        onAuthenticated()
      } else {
        const data = await signUp(trimmedEmail, password)

        if (data.session) {
          window.localStorage.removeItem('pending_confirmation_email')
          onAuthenticated()
          return
        }

        window.localStorage.setItem('pending_confirmation_email', trimmedEmail)
        setPendingEmail(trimmedEmail)
        setError(EMAIL_CONFIRMATION_MESSAGE)
      }
    } catch (err) {
      const message = err?.message ?? 'authentication failed'

      if (message.includes('Invalid login credentials')) {
        setError('incorrect email or password')
      } else if (message.includes('User already registered')) {
        setError('account already exists - sign in instead')
        setMode('signin')
      } else if (message.includes('Email not confirmed')) {
        setError(EMAIL_CONFIRMATION_MESSAGE)
        window.localStorage.setItem('pending_confirmation_email', trimmedEmail)
        setPendingEmail(trimmedEmail)
      } else if (message.includes('For security purposes')) {
        setError(message)
      } else {
        setError(message)
      }
    } finally {
      setLoading(false)
    }
  }

  async function handleResendConfirmation() {
    const trimmedEmail = email.trim() || pendingEmail
    if (!trimmedEmail) {
      setError('please enter your email')
      return
    }

    setLoading(true)
    setError(null)
    setNotice(null)

    try {
      await resendSignupConfirmation(trimmedEmail)
      window.localStorage.setItem('pending_confirmation_email', trimmedEmail)
      setPendingEmail(trimmedEmail)
      setNotice('confirmation email sent - open the newest message')
    } catch (err) {
      const message = err?.message ?? 'could not resend confirmation email'
      setError(message)
    } finally {
      setLoading(false)
    }
  }

  const showResend =
    !loading &&
    Boolean(email.trim() || pendingEmail) &&
    (error === EMAIL_CONFIRMATION_MESSAGE ||
      error === 'confirmation link expired - request a new email below' ||
      notice === 'check your email to confirm your account')

  return (
    <div className="min-h-screen bg-white">
      <div className="mx-auto flex min-h-screen w-full max-w-[360px] flex-col px-6">
        <div className="mt-[60px] text-[15px] font-medium text-gray-900">recall</div>
        <p className="mb-10 mt-1 text-xs text-gray-400">meeting notes, no bots</p>

        <div className="mb-4 rounded-full bg-gray-100 p-1">
          <div className="grid grid-cols-2 gap-1">
            <button
              type="button"
              className={`h-9 rounded-full text-xs font-medium transition ${
                isSignIn ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'
              }`}
              onClick={() => handleModeChange('signin')}
            >
              sign in
            </button>
            <button
              type="button"
              className={`h-9 rounded-full text-xs font-medium transition ${
                !isSignIn ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'
              }`}
              onClick={() => handleModeChange('signup')}
            >
              create account
            </button>
          </div>
        </div>

        <form className="flex flex-col gap-3" onSubmit={handleSubmit}>
          <input
            type="email"
            value={email}
            onChange={handleEmailChange}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSubmit()
            }}
            placeholder="you@company.com"
            autoComplete="email"
            inputMode="email"
            className="h-11 w-full rounded-lg border border-gray-200 px-4 text-base text-gray-900 placeholder:text-gray-400 focus:border-gray-400 focus:outline-none"
          />
          <input
            type="password"
            value={password}
            onChange={handlePasswordChange}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSubmit()
            }}
            placeholder="password"
            autoComplete={isSignIn ? 'current-password' : 'new-password'}
            className="h-11 w-full rounded-lg border border-gray-200 px-4 text-base text-gray-900 placeholder:text-gray-400 focus:border-gray-400 focus:outline-none"
          />
          <button
            type="submit"
            disabled={loading}
            className="h-11 w-full rounded-lg bg-indigo-600 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-70"
          >
            {loading ? (isSignIn ? 'signing in...' : 'creating account...') : isSignIn ? 'sign in' : 'create account'}
          </button>
          {error ? <p className="text-xs text-red-500">{error}</p> : null}
          {notice ? <p className="text-xs text-indigo-600">{notice}</p> : null}
          {showResend ? (
            <button
              type="button"
              onClick={handleResendConfirmation}
              className="self-start text-xs font-medium text-indigo-600"
            >
              resend confirmation email
            </button>
          ) : null}
        </form>

        <p className="mt-auto pb-8 text-center text-xs text-gray-300">
          your audio is never stored on our servers
        </p>
      </div>
    </div>
  )
}
