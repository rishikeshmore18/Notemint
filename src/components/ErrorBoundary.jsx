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
        <div className="min-h-screen bg-white flex flex-col items-center justify-center px-6 text-center">
          <p className="text-sm font-medium text-gray-900 mb-2">something went wrong</p>
          {import.meta.env.DEV && this.state.error && (
            <p className="text-xs text-gray-400 mb-6 max-w-xs leading-relaxed">
              {this.state.error.message}
            </p>
          )}
          <button
            onClick={() => window.location.reload()}
            className="h-10 px-6 bg-indigo-600 text-white text-sm font-medium rounded-xl"
          >
            refresh the page
          </button>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            className="mt-3 text-xs text-gray-400 underline"
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
