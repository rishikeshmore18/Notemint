import React from 'react'

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary] Caught error:', error)
    console.error('[ErrorBoundary] Component stack:', info.componentStack)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="nm-screen flex min-h-screen flex-col items-center justify-center px-6 text-center">
          <p className="mb-2 text-sm font-bold text-[var(--ink)]">something went wrong</p>
          {import.meta.env.DEV && this.state.error && (
            <p className="mb-6 max-w-xs text-xs leading-relaxed text-[var(--ink3)]">
              {this.state.error.message}
            </p>
          )}
          <button
            onClick={() => window.location.reload()}
            className="nm-btn nm-btn-primary px-6"
          >
            refresh the page
          </button>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            className="mt-3 text-xs text-[var(--ink3)] underline"
          >
            try without refreshing
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

export default ErrorBoundary
