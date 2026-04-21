import React, { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

export default function HistoryScreen({ user, onBack, onOpenMeeting }) {
  const [meetings, setMeetings] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    loadMeetings()
  }, [])

  async function loadMeetings() {
    setLoading(true)
    setError(null)
    try {
      const { data, error } = await supabase
        .from('meetings')
        .select('id, title, summary, created_at, duration_segments, transcript_compressed, segments, label_map')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(50)

      if (error) throw error
      setMeetings(data || [])
    } catch (err) {
      setError('Could not load meetings. Check your connection.')
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  function getTldr(summary) {
    if (!summary) return 'No summary available'
    const lines = summary.split('\n')
    const idx = lines.findIndex((line) => line.includes('TL;DR'))
    if (idx === -1) return summary.slice(0, 100) + '...'
    for (let i = idx + 1; i < lines.length; i += 1) {
      const text = lines[i].trim()
      if (text && !text.startsWith('**')) {
        return text.slice(0, 120) + (text.length > 120 ? '...' : '')
      }
    }
    return 'No summary'
  }

  function formatDate(isoString) {
    const d = new Date(isoString)
    const now = new Date()
    const diffMs = now - d
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

    if (diffDays === 0) return 'Today'
    if (diffDays === 1) return 'Yesterday'
    if (diffDays < 7) return `${diffDays} days ago`
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  }

  return (
    <div className="min-h-screen bg-white flex flex-col max-w-2xl mx-auto px-5 md:px-8">
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
          record
        </button>

        <span className="text-sm font-medium text-gray-900">recall</span>

        <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center">
          <span className="text-sm font-medium text-indigo-600">
            {user?.email?.[0]?.toUpperCase() || '?'}
          </span>
        </div>
      </div>

      <p className="text-lg font-semibold text-gray-900 mb-1">past meetings</p>
      <p className="text-xs text-gray-400 mb-5">
        {meetings.length} meeting{meetings.length !== 1 ? 's' : ''} saved
      </p>

      {loading && (
        <div className="flex justify-center py-12">
          <div
            className="w-1.5 h-1.5 rounded-full bg-indigo-400"
            style={{ animation: 'dotPulse 1.2s ease-in-out infinite' }}
          />
        </div>
      )}

      {error && !loading && (
        <div className="text-center py-8">
          <p className="text-sm text-red-400 mb-3">{error}</p>
          <button onClick={loadMeetings} className="text-sm text-indigo-600 underline">
            try again
          </button>
        </div>
      )}

      {!loading && !error && meetings.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <p className="text-sm text-gray-400 mb-1">no meetings yet</p>
          <p className="text-xs text-gray-300">record your first meeting to see it here</p>
        </div>
      )}

      {!loading && !error && meetings.length > 0 && (
        <div className="flex flex-col gap-0 flex-1 overflow-y-auto" style={{ maxHeight: 'calc(100dvh - 160px)' }}>
          {meetings.map((meeting) => (
            <button
              key={meeting.id}
              onClick={() => onOpenMeeting(meeting)}
              className="flex flex-col items-start text-left py-4 border-b border-gray-50 hover:bg-gray-50 active:bg-gray-100 transition-colors px-1 rounded-lg w-full"
            >
              <div className="flex items-center justify-between w-full mb-1">
                <span className="text-sm font-medium text-gray-900 truncate flex-1 mr-3">
                  {meeting.title || 'Untitled meeting'}
                </span>
                <span className="text-xs text-gray-400 flex-shrink-0">
                  {formatDate(meeting.created_at)}
                </span>
              </div>
              <p className="text-xs text-gray-400 leading-relaxed line-clamp-2">
                {getTldr(meeting.summary)}
              </p>
              {meeting.duration_segments > 0 && (
                <span className="text-xs text-gray-300 mt-1.5">
                  {meeting.duration_segments} segments
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
