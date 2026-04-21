import React, { useState } from 'react'

export default function PastMeetingScreen({ user, meeting, onBack }) {
  const [activeTab, setActiveTab] = useState('summary')
  const [copiedWhat, setCopiedWhat] = useState(null)

  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      const el = document.createElement('textarea')
      el.value = text
      el.style.cssText = 'position:fixed;opacity:0;top:0;left:0'
      document.body.appendChild(el)
      el.focus()
      el.select()
      let success = false
      try {
        success = document.execCommand('copy')
      } catch {}
      document.body.removeChild(el)
      return success
    }
  }

  async function handleCopy(type) {
    const text = type === 'summary' ? meeting.summary || '' : meeting.transcript_compressed || ''
    await copyToClipboard(text)
    setCopiedWhat(type)
    setTimeout(() => {
      setCopiedWhat(null)
    }, 2000)
  }

  function renderMarkdownLite(text) {
    if (!text) return null
    return text.split('\n').map((line, i) => {
      const t = line.trim()

      if (t.startsWith('**') && t.endsWith('**') && t.length > 4) {
        return (
          <p key={i} className="text-sm font-semibold text-gray-900 mt-5 mb-2 first:mt-1">
            {t.slice(2, -2)}
          </p>
        )
      }

      if (t.startsWith('→')) {
        return (
          <div key={i} className="flex items-start gap-2 bg-indigo-50 rounded-lg px-3 py-2 mb-1.5">
            <span className="text-indigo-400 flex-shrink-0 mt-0.5 text-sm">→</span>
            <span className="text-sm text-indigo-800 leading-relaxed">{t.slice(1).trim()}</span>
          </div>
        )
      }

      if (t.startsWith('- ')) {
        return (
          <div key={i} className="flex items-start gap-2 py-0.5">
            <span className="text-gray-300 flex-shrink-0 mt-1.5 text-xs">●</span>
            <p className="text-sm text-gray-700 leading-relaxed">{t.slice(2)}</p>
          </div>
        )
      }

      if (!t) return <div key={i} className="h-1.5" />

      return (
        <p key={i} className="text-sm text-gray-700 leading-relaxed py-0.5">
          {line}
        </p>
      )
    })
  }

  function getSpeakerBadgeClass(label) {
    if (label === 'You') return 'bg-indigo-100 text-indigo-700'
    if (label === 'Person 1') return 'bg-emerald-100 text-emerald-700'
    if (label === 'Person 2') return 'bg-amber-100 text-amber-700'
    if (label === 'Person 3') return 'bg-rose-100 text-rose-700'
    return 'bg-gray-100 text-gray-600'
  }

  function parseTranscript(compressed) {
    if (!compressed) return []
    return compressed
      .split('\n')
      .map((line) => {
        const match = line.match(/^\[([^\]]+)\]:\s*(.+)$/)
        if (!match) return null
        return { label: match[1], text: match[2] }
      })
      .filter(Boolean)
  }

  const transcriptLines = parseTranscript(meeting.transcript_compressed)

  return (
    <div className="min-h-screen bg-white flex flex-col max-w-2xl mx-auto px-5 md:px-10">
      <div className="flex items-center justify-between h-14 flex-shrink-0">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 transition-colors"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path
              d="M10 12L6 8L10 4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          history
        </button>

        <span className="text-sm font-medium text-gray-900 truncate px-4">{meeting.title || 'Untitled meeting'}</span>

        <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center flex-shrink-0">
          <span className="text-sm font-medium text-indigo-600">
            {user?.email?.[0]?.toUpperCase() || '?'}
          </span>
        </div>
      </div>

      <div className="flex rounded-xl overflow-hidden border border-gray-100 mb-4 flex-shrink-0">
        <button
          onClick={() => setActiveTab('summary')}
          className={`flex-1 h-9 text-sm transition-colors ${
            activeTab === 'summary'
              ? 'bg-indigo-600 text-white font-medium'
              : 'bg-white text-gray-500 hover:text-gray-700'
          }`}
        >
          summary
        </button>
        <button
          onClick={() => setActiveTab('transcript')}
          className={`flex-1 h-9 text-sm transition-colors ${
            activeTab === 'transcript'
              ? 'bg-indigo-600 text-white font-medium'
              : 'bg-white text-gray-500 hover:text-gray-700'
          }`}
        >
          transcript
        </button>
      </div>

      <div className="flex-1 overflow-y-auto pb-4" style={{ maxHeight: 'calc(100dvh - 220px)' }}>
        {activeTab === 'summary' && <div>{renderMarkdownLite(meeting.summary)}</div>}

        {activeTab === 'transcript' && (
          <div>
            {transcriptLines.map((line, index) => (
              <div key={index} className="flex items-start gap-2.5 py-2.5 border-b border-gray-50 last:border-0">
                <span
                  className={`text-xs font-medium px-2 py-0.5 rounded-full flex-shrink-0 mt-0.5 ${getSpeakerBadgeClass(
                    line.label,
                  )}`}
                >
                  {line.label.toLowerCase()}
                </span>
                <p className="text-sm text-gray-800 leading-relaxed">{line.text}</p>
              </div>
            ))}

            {transcriptLines.length === 0 && (
              <p className="text-sm text-gray-400 text-center py-8">no transcript available</p>
            )}
          </div>
        )}
      </div>

      <div
        className="flex flex-col gap-2 pt-4 flex-shrink-0"
        style={{ paddingBottom: 'max(24px, env(safe-area-inset-bottom))' }}
      >
        <button
          onClick={() => handleCopy('summary')}
          disabled={!meeting.summary}
          className="h-11 w-full rounded-xl bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 active:bg-indigo-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {copiedWhat === 'summary' ? 'copied! ✓' : 'copy summary'}
        </button>

        <button
          onClick={() => handleCopy('transcript')}
          disabled={!meeting.transcript_compressed}
          className="h-11 w-full rounded-xl border border-gray-200 text-gray-700 text-sm font-medium hover:bg-gray-50 active:bg-gray-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {copiedWhat === 'transcript' ? 'copied! ✓' : 'copy transcript'}
        </button>

        <button
          onClick={onBack}
          className="h-11 w-full text-sm text-gray-400 hover:text-gray-600 transition-colors"
        >
          back to history
        </button>
      </div>
    </div>
  )
}
