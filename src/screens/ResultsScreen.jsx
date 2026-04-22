import React, { useEffect, useRef, useState } from 'react'
import { matchSpeakers } from '../lib/enrollment'
import { compressTranscript, getSummary, saveMeeting } from '../lib/summary'
import { supabase } from '../lib/supabase'

export default function ResultsScreen({ user, segments, onNewMeeting }) {
  const [activeTab, setActiveTab] = useState('summary')
  const [summaryText, setSummaryText] = useState('')
  const [summaryStatus, setSummaryStatus] = useState('idle')
  const [summaryError, setSummaryError] = useState(null)
  const [labelMap, setLabelMap] = useState({})
  const [saveStatus, setSaveStatus] = useState(null)
  const [copiedWhat, setCopiedWhat] = useState(null)

  const summaryTextRef = useRef('')
  const mountedRef = useRef(true)
  const labelMapRef = useRef({})

  useEffect(() => {
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    runSummary()
  }, [])

  async function runSummary() {
    if (!segments || segments.length === 0) {
      setSummaryStatus('error')
      setSummaryError('No speech was captured. Make sure your microphone was working and try again.')
      return
    }

    const map = matchSpeakers(segments)
    labelMapRef.current = map
    if (mountedRef.current) setLabelMap(map)

    const compressed = compressTranscript(segments, map)
    if (mountedRef.current) setSummaryStatus('generating')

    summaryTextRef.current = ''
    if (mountedRef.current) setSummaryText('')

    getSummary(
      compressed,
      (chunk) => {
        if (!mountedRef.current) return
        summaryTextRef.current += chunk
        setSummaryText(summaryTextRef.current)
      },
      async (fullText) => {
        if (!mountedRef.current) return
        setSummaryStatus('done')
        setSaveStatus('saving')
        const id = await saveMeeting(supabase, user.id, {
          title: null,
          transcript: compressed,
          summary: fullText,
          segments,
          labelMap: labelMapRef.current,
        })
        if (!mountedRef.current) return
        setSaveStatus(id ? 'saved' : 'failed')
      },
      (errMsg) => {
        if (!mountedRef.current) return
        setSummaryStatus('error')
        setSummaryError(errMsg)
      },
    )
  }

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
    let text = ''
    if (type === 'summary') {
      text = summaryTextRef.current
    } else {
      text = segments
        .filter((s) => s.isFinal)
        .map((s) => `[${labelMapRef.current[s.speaker] || 'Speaker'}]: ${s.text}`)
        .join('\n')
    }
    await copyToClipboard(text)
    setCopiedWhat(type)
    setTimeout(() => {
      if (mountedRef.current) setCopiedWhat(null)
    }, 2000)
  }

  function renderMarkdownLite(text) {
    if (!text) return null
    return text.split('\n').map((line, i) => {
      const trimmed = line.trim()

      if (trimmed.startsWith('**') && trimmed.endsWith('**') && trimmed.length > 4) {
        return (
          <p key={i} className="text-sm font-semibold text-gray-900 mt-5 mb-2 first:mt-1">
            {trimmed.slice(2, -2)}
          </p>
        )
      }

      if (trimmed.startsWith('->') || trimmed.startsWith('=>') || trimmed.startsWith('>')) {
        const actionText = trimmed.replace(/^(->|=>|>)\s*/, '')
        return (
          <div key={i} className="flex items-start gap-2 bg-indigo-50 rounded-lg px-3 py-2 mb-1.5">
            <span className="text-indigo-400 flex-shrink-0 mt-0.5 text-sm">-&gt;</span>
            <span className="text-sm text-indigo-800 leading-relaxed">{actionText}</span>
          </div>
        )
      }

      if (trimmed.startsWith('- ')) {
        return (
          <div key={i} className="flex items-start gap-2 py-0.5">
            <span className="text-gray-300 flex-shrink-0 mt-1.5 text-xs">*</span>
            <p className="text-sm text-gray-700 leading-relaxed">{trimmed.slice(2)}</p>
          </div>
        )
      }

      if (!trimmed) return <div key={i} className="h-1.5" />

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

  function getMergedTranscriptBlocks() {
    const finals = segments.filter((s) => s.isFinal)
    const merged = []
    finals.forEach((seg) => {
      const label = labelMap[seg.speaker] || 'Person ' + (seg.speaker + 1)
      const last = merged[merged.length - 1]
      if (last && last.label === label) {
        last.text += ' ' + seg.text
      } else {
        merged.push({ label, text: seg.text })
      }
    })
    return merged
  }

  return (
    <div className="min-h-screen bg-white flex flex-col max-w-2xl mx-auto px-5 md:px-10">
      <div className="flex items-center justify-between h-14 flex-shrink-0">
        <span className="text-sm font-medium text-gray-900">recall</span>
        <span className="text-xs text-gray-400">
          {new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}
        </span>
        <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center flex-shrink-0">
          <span className="text-sm font-medium text-indigo-600">
            {user?.email?.[0]?.toUpperCase() || '?'}
          </span>
        </div>
      </div>

      <div className="h-5 flex items-center justify-end mb-1">
        {saveStatus === 'saving' && <p className="text-xs text-gray-300">saving...</p>}
        {saveStatus === 'saved' && <p className="text-xs text-gray-300">saved</p>}
        {saveStatus === 'failed' && <p className="text-xs text-red-300">could not save</p>}
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
        {activeTab === 'summary' && (
          <div>
            {summaryStatus === 'generating' && !summaryText && (
              <div className="flex flex-col items-center py-12">
                <div className="flex items-center gap-1.5 mb-3">
                  <div className="w-1.5 h-1.5 rounded-full bg-indigo-300 dot-pulse" style={{ animationDelay: '0ms' }} />
                  <div className="w-1.5 h-1.5 rounded-full bg-indigo-300 dot-pulse" style={{ animationDelay: '200ms' }} />
                  <div className="w-1.5 h-1.5 rounded-full bg-indigo-300 dot-pulse" style={{ animationDelay: '400ms' }} />
                </div>
                <p className="text-sm text-gray-400">generating summary...</p>
              </div>
            )}

            {(summaryStatus === 'generating' || summaryStatus === 'done') && summaryText && (
              <div>
                {summaryStatus === 'generating' && <p className="text-xs text-gray-300 text-right mb-2">writing...</p>}
                {renderMarkdownLite(summaryText)}
              </div>
            )}

            {summaryStatus === 'error' && (
              <div className="py-10 text-center">
                <p className="text-sm text-red-500 mb-4">{summaryError}</p>
                <button
                  onClick={() => {
                    setSummaryStatus('idle')
                    setSummaryError(null)
                    setSummaryText('')
                    summaryTextRef.current = ''
                    setTimeout(() => {
                      runSummary()
                    }, 100)
                  }}
                  className="text-sm text-indigo-600 underline"
                >
                  try again
                </button>
              </div>
            )}
          </div>
        )}

        {activeTab === 'transcript' && (
          <div>
            <p className="text-xs text-gray-400 mb-4">
              {new Set(segments.map((s) => s.speaker)).size} speaker
              {new Set(segments.map((s) => s.speaker)).size > 1 ? 's' : ''}
              {' - '}
              {segments.filter((s) => s.isFinal).length} segments
            </p>

            {getMergedTranscriptBlocks().map((block, i) => (
              <div key={i} className="flex items-start gap-2.5 py-2.5 border-b border-gray-50 last:border-0">
                <span className={`text-xs font-medium px-2 py-0.5 rounded-full flex-shrink-0 mt-0.5 ${getSpeakerBadgeClass(block.label)}`}>
                  {block.label.toLowerCase()}
                </span>
                <p className="text-sm text-gray-800 leading-relaxed">{block.text}</p>
              </div>
            ))}

            {getMergedTranscriptBlocks().length === 0 && (
              <div className="text-center py-10">
                <p className="text-sm text-gray-400">No transcript segments to show.</p>
                <p className="text-xs text-gray-300 mt-1">
                  Only final segments are shown here.
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2 pt-4 flex-shrink-0" style={{ paddingBottom: 'max(24px, env(safe-area-inset-bottom))' }}>
        <button
          onClick={() => handleCopy('summary')}
          disabled={!summaryText || summaryText.trim().length === 0}
          className="h-11 w-full rounded-xl bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 active:bg-indigo-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {copiedWhat === 'summary' ? 'copied!' : 'copy summary'}
        </button>

        <button
          onClick={() => handleCopy('transcript')}
          className="h-11 w-full rounded-xl border border-gray-200 text-gray-700 text-sm font-medium hover:bg-gray-50 active:bg-gray-100 transition-colors"
        >
          {copiedWhat === 'transcript' ? 'copied!' : 'copy transcript'}
        </button>

        <button
          onClick={onNewMeeting}
          className="h-11 w-full text-sm text-gray-400 hover:text-gray-600 transition-colors"
        >
          new meeting
        </button>
      </div>
    </div>
  )
}
