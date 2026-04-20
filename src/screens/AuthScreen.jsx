import { useState } from 'react'
import { signIn, signUp } from '../lib/supabase'

export default function AuthScreen({ onAuthenticated }) {
  const [mode, setMode] = useState('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const isSignIn = mode === 'signin'

  function handleModeChange(nextMode) {
    setMode(nextMode)
    setError(null)
  }

  function handleEmailChange(event) {
    setEmail(event.target.value)
    if (error) setError(null)
  }

  function handlePasswordChange(event) {
    setPassword(event.target.value)
    if (error) setError(null)
  }

  async function handleSubmit(event) {
    event.preventDefault()
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

    try {
      if (isSignIn) {
        await signIn(trimmedEmail, password)
      } else {
        await signUp(trimmedEmail, password)
      }
      onAuthenticated()
    } catch (err) {
      const message = err?.message ?? 'authentication failed'

      if (message.includes('Invalid login credentials')) {
        setError('incorrect email or password')
      } else if (message.includes('User already registered')) {
        setError('account already exists - sign in instead')
        setMode('signin')
      } else if (message.includes('Email not confirmed')) {
        setError('check your email to confirm your account')
      } else {
        setError(message)
      }
    } finally {
      setLoading(false)
    }
  }

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
            placeholder="you@company.com"
            autoComplete="email"
            className="h-11 w-full rounded-lg border border-gray-200 px-4 text-sm text-gray-900 placeholder:text-gray-400 focus:border-gray-400 focus:outline-none"
          />
          <input
            type="password"
            value={password}
            onChange={handlePasswordChange}
            placeholder="password"
            autoComplete={isSignIn ? 'current-password' : 'new-password'}
            className="h-11 w-full rounded-lg border border-gray-200 px-4 text-sm text-gray-900 placeholder:text-gray-400 focus:border-gray-400 focus:outline-none"
          />
          <button
            type="submit"
            disabled={loading}
            className="h-11 w-full rounded-lg bg-indigo-600 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-70"
          >
            {loading ? 'signing in...' : isSignIn ? 'sign in' : 'create account'}
          </button>
          {error ? <p className="text-xs text-red-500">{error}</p> : null}
        </form>

        <p className="mt-auto pb-8 text-center text-xs text-gray-300">
          your audio is never stored on our servers
        </p>
      </div>
    </div>
  )
}
