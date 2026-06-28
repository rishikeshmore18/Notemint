export default function AuthCallbackScreen({ status, title, message, onContinue }) {
  const isSuccess = status === 'success'
  const isError = status === 'error'

  return (
    <div className="nm-screen">
      <div className="mx-auto flex min-h-screen w-full max-w-[360px] flex-col px-6">
        <div className="mt-[60px] text-center text-2xl font-black tracking-[-0.04em] text-[var(--ink)]">Notemint</div>

        <div className="flex flex-1 flex-col items-center justify-center text-center">
          <div
            className={`flex h-12 w-12 items-center justify-center rounded-full ${
              isSuccess ? 'bg-emerald-50 text-emerald-600' : isError ? 'bg-red-50 text-red-500' : 'bg-[var(--mint-soft)] text-[var(--mint-d)]'
            }`}
          >
            {isSuccess ? <SuccessIcon /> : isError ? <ErrorIcon /> : <LoadingDot />}
          </div>
          <h1 className="mt-6 text-xl font-bold text-[var(--ink)]">{title}</h1>
          <p className="mt-2 text-sm leading-relaxed text-[var(--ink3)]">{message}</p>
          {onContinue ? (
            <button
              type="button"
              onClick={onContinue}
              className="nm-btn nm-btn-primary mt-6 px-4"
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
