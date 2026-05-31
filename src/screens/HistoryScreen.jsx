import React, { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { deleteLocalMeeting, deleteMeetingRecord, getLocalMeetings } from '../lib/summary'

export default function HistoryScreen({ user, onBack, onOpenMeeting }) {
  const [meetings, setMeetings] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [deletingMeetingId, setDeletingMeetingId] = useState('')
  const [revealedMeetingId, setRevealedMeetingId] = useState('')
  const touchState = React.useRef({
    id: '',
    x: 0,
    y: 0,
    startedAt: 0,
    longPressTimer: null,
  })

  useEffect(() => {
    loadMeetings()
  }, [])

  async function loadMeetings() {
    setLoading(true)
    setError(null)

    const localMeetings = getLocalMeetings(user.id)

    try {
      const { data, error } = await supabase
        .from('meetings')
        .select('id, title, summary, created_at, duration_segments, audio_storage_path, audio_expires_at, audio_deleted_at, audio_upload_status')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(50)

      if (error) {
        console.error('[History] Supabase error:', error)
        if (localMeetings.length > 0) {
          setMeetings(localMeetings)
          setError(null)
        } else if (String(error.message || '').includes("Could not find the table 'public.meetings'")) {
          setError('Supabase table "meetings" is not created yet. Use the SQL file in /supabase/sql.')
        } else {
          setError('Could not load meetings: ' + error.message)
        }
        return
      }

      const remoteMeetings = data || []
      const merged = [...remoteMeetings]
      for (const localMeeting of localMeetings) {
        if (!merged.some((m) => m.id === localMeeting.id)) {
          merged.push(localMeeting)
        }
      }

      merged.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      setMeetings(merged)
    } catch (err) {
      console.error('[History] Supabase error:', err)
      if (localMeetings.length > 0) {
        setMeetings(localMeetings)
        setError(null)
      } else {
        setError('Could not load meetings: ' + (err.message || 'Unknown error'))
      }
    } finally {
      setLoading(false)
    }
  }

  async function handleOpenMeeting(meeting) {
    if (revealedMeetingId === meeting.id) return
    if (String(meeting.id).startsWith('local_')) {
      onOpenMeeting(meeting)
      return
    }

    try {
      const { data, error } = await supabase
        .from('meetings')
        .select('id, user_id, title, summary, created_at, duration_segments, transcript_compressed, segments, label_map, audio_storage_path, audio_mime_type, audio_size_bytes, audio_duration_seconds, audio_uploaded_at, audio_retention_days, audio_expires_at, audio_deleted_at, audio_upload_status')
        .eq('id', meeting.id)
        .eq('user_id', user.id)
        .single()

      if (error) {
        console.error('[History] Supabase error:', error)
        setError('Could not open meeting: ' + error.message)
        return
      }

      onOpenMeeting(data)
    } catch (err) {
      console.error('[History] Supabase error:', err)
      setError('Could not open meeting: ' + (err.message || 'Unknown error'))
    }
  }

  async function handleDeleteMeeting(meeting) {
    if (!meeting?.id || !user?.id) return
    const confirmed = window.confirm('Delete this meeting? Transcript and summary will be removed.')
    if (!confirmed) return

    setDeletingMeetingId(meeting.id)
    setError(null)
    try {
      if (String(meeting.id).startsWith('local_')) {
        deleteLocalMeeting(user.id, meeting.id)
      } else {
        await deleteMeetingRecord(supabase, {
          userId: user.id,
          meetingId: meeting.id,
          audioStoragePath: meeting.audio_storage_path || '',
        })
      }
      setMeetings((prev) => prev.filter((item) => item.id !== meeting.id))
      if (revealedMeetingId === meeting.id) setRevealedMeetingId('')
    } catch (err) {
      setError(err?.message || 'Could not delete meeting')
    } finally {
      setDeletingMeetingId('')
    }
  }

  function clearLongPressTimer() {
    if (touchState.current.longPressTimer) {
      clearTimeout(touchState.current.longPressTimer)
      touchState.current.longPressTimer = null
    }
  }

  function handleTouchStart(event, meetingId) {
    const touch = event.touches?.[0]
    if (!touch) return
    clearLongPressTimer()
    touchState.current.id = meetingId
    touchState.current.x = touch.clientX
    touchState.current.y = touch.clientY
    touchState.current.startedAt = Date.now()
    touchState.current.longPressTimer = setTimeout(() => {
      setRevealedMeetingId(meetingId)
      clearLongPressTimer()
    }, 480)
  }

  function handleTouchMove(event, meetingId) {
    const touch = event.touches?.[0]
    if (!touch || touchState.current.id !== meetingId) return
    const dx = touch.clientX - touchState.current.x
    const dy = touch.clientY - touchState.current.y
    if (Math.abs(dy) > 18) {
      clearLongPressTimer()
      return
    }
    if (Math.abs(dx) > 52) {
      clearLongPressTimer()
      setRevealedMeetingId((prev) => (prev === meetingId ? '' : meetingId))
    }
  }

  function handleTouchEnd() {
    clearLongPressTimer()
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
    if (diffDays < 7) return diffDays + ' days ago'
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
            <div key={meeting.id} className="relative group">
              <button
                onClick={() => handleOpenMeeting(meeting)}
                onTouchStart={(event) => handleTouchStart(event, meeting.id)}
                onTouchMove={(event) => handleTouchMove(event, meeting.id)}
                onTouchEnd={handleTouchEnd}
                onTouchCancel={handleTouchEnd}
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
                {meeting.audio_storage_path ? (
                  <span className="text-xs text-gray-300 mt-1">
                    {meeting.audio_expires_at
                      ? `audio kept until ${formatDate(meeting.audio_expires_at)}`
                      : 'audio kept (no expiry)'}
                  </span>
                ) : null}
                {meeting.audio_upload_status === 'pending' && (
                  <span className="text-xs text-amber-500 mt-1">audio still uploading</span>
                )}
                {meeting.audio_upload_status === 'failed' && (
                  <span className="text-xs text-amber-600 mt-1">audio unavailable</span>
                )}
              </button>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation()
                  void handleDeleteMeeting(meeting)
                }}
                disabled={deletingMeetingId === meeting.id}
                className={`absolute right-2 top-1/2 -translate-y-1/2 h-8 w-8 rounded-full border border-red-200 bg-white text-red-500 flex items-center justify-center transition-opacity ${
                  revealedMeetingId === meeting.id ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                } disabled:opacity-40`}
                title="delete meeting"
              >
                {deletingMeetingId === meeting.id ? (
                  <span className="text-[10px]">...</span>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M4 7h16" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                    <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" stroke="currentColor" strokeWidth="1.6" />
                    <path d="M7 7l1 12a1 1 0 0 0 1 .9h6a1 1 0 0 0 1-.9L17 7" stroke="currentColor" strokeWidth="1.6" />
                    <path d="M10 11v5M14 11v5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                  </svg>
                )}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
