import { useEffect, useState } from 'react'
import { resendSignupConfirmation, signIn, signUp } from '../lib/supabase'

const EMAIL_CONFIRMATION_MESSAGE =
  'check your email to confirm your account, then sign in'

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
    <div className="nm-screen">
      <div className="mx-auto flex min-h-screen w-full max-w-[390px] flex-col px-6">
        <div className="mb-10 mt-[70px] text-center">
          <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-2xl bg-gradient-to-br from-[var(--mint-glow)] to-[var(--mint-d)] text-white shadow-[0_10px_24px_rgba(6,177,122,.28)]">
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 12c4 0 6-2 6-6 0 4 2 6 6 6-4 0-6 2-6 6 0-4-2-6-6-6z" />
            </svg>
          </div>
          <div className="nm-title text-2xl">Notemint</div>
        </div>

        <div className="nm-segmented mb-4">
          <div className="grid grid-cols-2 gap-1">
            <button
              type="button"
              className={`h-10 rounded-full text-sm font-bold transition ${
                isSignIn ? 'nm-segmented-active' : 'text-[var(--ink3)]'
              }`}
              onClick={() => handleModeChange('signin')}
            >
              sign in
            </button>
            <button
              type="button"
              className={`h-10 rounded-full text-sm font-bold transition ${
                !isSignIn ? 'nm-segmented-active' : 'text-[var(--ink3)]'
              }`}
              onClick={() => handleModeChange('signup')}
            >
              create account
            </button>
          </div>
        </div>

        <form className="nm-card-strong flex flex-col gap-3 px-4 py-5" onSubmit={handleSubmit}>
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
            className="nm-input text-base placeholder:text-[var(--ink3)]"
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
            className="nm-input text-base placeholder:text-[var(--ink3)]"
          />
          <button
            type="submit"
            disabled={loading}
            className="nm-btn nm-btn-primary w-full text-sm disabled:cursor-not-allowed disabled:opacity-70"
          >
            {loading ? (isSignIn ? 'signing in...' : 'creating account...') : isSignIn ? 'sign in' : 'create account'}
          </button>
          {error ? <p className="rounded-2xl bg-red-50 px-3 py-2 text-xs font-medium text-red-500">{error}</p> : null}
          {notice ? <p className="rounded-2xl bg-[var(--mint-soft)] px-3 py-2 text-xs font-medium text-[var(--mint-d)]">{notice}</p> : null}
          {showResend ? (
            <button
              type="button"
              onClick={handleResendConfirmation}
              className="self-start text-xs font-bold text-[var(--mint-d)] underline underline-offset-4"
            >
              resend confirmation email
            </button>
          ) : null}
        </form>

        <p className="mt-auto pb-8 text-center text-xs font-medium text-[var(--ink3)]">
          your audio is never stored on our servers
        </p>
      </div>
    </div>
  )
}
