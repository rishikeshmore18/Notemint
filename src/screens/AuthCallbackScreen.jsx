export default function AuthCallbackScreen({ status, title, message, onContinue }) {
  const isSuccess = status === 'success'
  const isError = status === 'error'

  return (
    <div className="min-h-screen bg-white">
      <div className="mx-auto flex min-h-screen w-full max-w-[360px] flex-col px-6">
        <div className="mt-[60px] text-[15px] font-medium text-gray-900">recall</div>
        <p className="mt-1 text-xs text-gray-400">meeting notes, no bots</p>

        <div className="flex flex-1 flex-col items-center justify-center text-center">
          <div
            className={`flex h-12 w-12 items-center justify-center rounded-full ${
              isSuccess ? 'bg-emerald-50 text-emerald-600' : isError ? 'bg-red-50 text-red-500' : 'bg-indigo-50 text-indigo-600'
            }`}
          >
            {isSuccess ? <SuccessIcon /> : isError ? <ErrorIcon /> : <LoadingDot />}
          </div>
          <h1 className="mt-6 text-xl font-medium text-gray-900">{title}</h1>
          <p className="mt-2 text-sm leading-relaxed text-gray-500">{message}</p>
          {onContinue ? (
            <button
              type="button"
              onClick={onContinue}
              className="mt-6 h-11 rounded-lg bg-indigo-600 px-4 text-sm font-medium text-white"
            >
              back to sign in
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function LoadingDot() {
  return <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-current" />
}

function SuccessIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden="true">
      <path
        d="M6 12.5 10 16l8-8"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function ErrorIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden="true">
      <path d="M12 7v6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M12 17h.01" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  )
}
