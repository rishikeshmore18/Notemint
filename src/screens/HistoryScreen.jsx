import React, { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { getPendingAudioUploadBackups } from '../lib/audioUploadQueue'
import { deleteLocalMeeting, deleteMeetingRecord, getLocalMeetings } from '../lib/summary'

export default function HistoryScreen({ user, onBack, onOpenMeeting, onRetryPendingAudioUploads = null }) {
  const [meetings, setMeetings] = useState([])
  const [searchQuery, setSearchQuery] = useState('')
  const [dateFilter, setDateFilter] = useState({
    mode: 'all',
    startDate: '',
    endDate: '',
  })
  const [dateFilterOpen, setDateFilterOpen] = useState(false)
  const [sortOrder, setSortOrder] = useState('newest')
  const [searchFocused, setSearchFocused] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [deletingMeetingId, setDeletingMeetingId] = useState('')
  const [revealedMeetingId, setRevealedMeetingId] = useState('')
  const [pendingBackupIds, setPendingBackupIds] = useState(new Set())
  const touchState = React.useRef({
    id: '',
    x: 0,
    y: 0,
    startedAt: 0,
    longPressTimer: null,
  })

  useEffect(() => {
    loadMeetings()
    void refreshPendingAudioBackups()
    const retry = onRetryPendingAudioUploads?.()
    if (retry?.finally) {
      void retry.finally(() => {
        void refreshPendingAudioBackups()
      })
    }
  }, [])

  async function refreshPendingAudioBackups() {
    if (!user?.id) return
    const records = await getPendingAudioUploadBackups(user.id)
    setPendingBackupIds(new Set(records.map((record) => record.meetingId).filter(Boolean)))
  }

  async function loadMeetings() {
    setLoading(true)
    setError(null)

    const localMeetings = getLocalMeetings(user.id)

    try {
      let { data, error } = await supabase
        .from('meetings')
        .select('id, title, summary, created_at, duration_segments, audio_storage_path, audio_expires_at, audio_deleted_at, audio_upload_status, transcription_status')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(50)

      if (error && isMissingColumnError(error, 'transcription_status')) {
        ;({ data, error } = await supabase
          .from('meetings')
          .select('id, title, summary, created_at, duration_segments, audio_storage_path, audio_expires_at, audio_deleted_at, audio_upload_status')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false })
          .limit(50))
      }

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

      const remoteMeetings = await attachSpeakerSearchNames(data || [])
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

  async function attachSpeakerSearchNames(remoteMeetings) {
    const list = Array.isArray(remoteMeetings) ? remoteMeetings : []
    const meetingIds = list
      .map((meeting) => meeting?.id)
      .filter((id) => id && !String(id).startsWith('local_'))

    if (meetingIds.length === 0) return list

    try {
      const { data, error } = await supabase
        .from('meeting_speakers')
        .select('meeting_id, display_name')
        .in('meeting_id', meetingIds)

      if (error || !Array.isArray(data)) {
        if (error) console.warn('[History] Could not load speaker search names:', error.message)
        return list
      }

      const namesByMeeting = new Map()
      for (const row of data) {
        const meetingId = row?.meeting_id
        const displayName = String(row?.display_name || '').trim()
        if (!meetingId || !displayName || isGenericSpeakerLabel(displayName)) continue
        const current = namesByMeeting.get(meetingId) || []
        if (!current.some((name) => name.toLowerCase() === displayName.toLowerCase())) {
          current.push(displayName)
        }
        namesByMeeting.set(meetingId, current)
      }

      return list.map((meeting) => ({
        ...meeting,
        speaker_names: namesByMeeting.get(meeting.id) || [],
      }))
    } catch (err) {
      console.warn('[History] Could not attach speaker search names:', err?.message || err)
      return list
    }
  }

  async function handleOpenMeeting(meeting) {
    if (revealedMeetingId === meeting.id) return
    if (String(meeting.id).startsWith('local_')) {
      onOpenMeeting(meeting)
      return
    }

    try {
      let { data, error } = await supabase
        .from('meetings')
        .select('id, user_id, title, summary, created_at, duration_segments, transcript_compressed, segments, label_map, audio_storage_path, audio_mime_type, audio_size_bytes, audio_duration_seconds, audio_uploaded_at, audio_retention_days, audio_expires_at, audio_deleted_at, audio_upload_status, transcription_status, transcription_provider, transcription_model, transcription_duration_ms, transcription_error')
        .eq('id', meeting.id)
        .eq('user_id', user.id)
        .single()

      if (error && isMissingColumnError(error, 'transcription_status')) {
        ;({ data, error } = await supabase
          .from('meetings')
          .select('id, user_id, title, summary, created_at, duration_segments, transcript_compressed, segments, label_map, audio_storage_path, audio_mime_type, audio_size_bytes, audio_duration_seconds, audio_uploaded_at, audio_retention_days, audio_expires_at, audio_deleted_at, audio_upload_status')
          .eq('id', meeting.id)
          .eq('user_id', user.id)
          .single())
      }

      if (error) {
        console.error('[History] Supabase error:', error)
        setError('Could not open meeting: ' + error.message)
        return
      }

      const meetingWithSpeakerLabels = await hydrateMeetingSpeakerLabels(data, user.id)
      onOpenMeeting(meetingWithSpeakerLabels)
    } catch (err) {
      console.error('[History] Supabase error:', err)
      setError('Could not open meeting: ' + (err.message || 'Unknown error'))
    }
  }

  async function hydrateMeetingSpeakerLabels(meeting, userId) {
    if (!meeting?.id || !userId || String(meeting.id).startsWith('local_')) return meeting

    try {
      const { data, error } = await supabase
        .from('meeting_speakers')
        .select('raw_speaker_id, display_name')
        .eq('meeting_id', meeting.id)

      if (error || !Array.isArray(data) || data.length === 0) {
        if (error) console.warn('[History] Could not load meeting speaker labels:', error.message)
        return meeting
      }

      const mergedLabelMap = { ...(meeting.label_map || {}) }
      for (const row of data) {
        const speakerId = Number(row?.raw_speaker_id)
        const displayName = String(row?.display_name || '').trim()
        if (!Number.isFinite(speakerId) || !displayName) continue

        const existing = String(mergedLabelMap[speakerId] || '').trim()
        if (!existing || isGenericSpeakerLabel(existing)) {
          mergedLabelMap[speakerId] = displayName
        }
      }

      return { ...meeting, label_map: mergedLabelMap }
    } catch (err) {
      console.warn('[History] Could not hydrate speaker labels:', err?.message || err)
      return meeting
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

  function isGenericSpeakerLabel(value) {
    const text = String(value || '').trim()
    return !text || /^person\s*\d+$/i.test(text)
  }

  const normalizedSearch = normalizeSearchText(searchQuery)
  const searchedMeetings = normalizedSearch
    ? meetings.filter((meeting) => meetingMatchesSearch(meeting, normalizedSearch))
    : meetings
  const filteredMeetings = searchedMeetings.filter((meeting) => meetingMatchesDateFilter(meeting, dateFilter))
  const visibleMeetings = sortMeetingsByDate(filteredMeetings, sortOrder)
  const searchSuggestions = buildSearchSuggestions(meetings, normalizedSearch).slice(0, 5)
  const showSuggestions = searchFocused && normalizedSearch.length >= 2 && searchSuggestions.length > 0

  return (
    <div className="nm-screen mx-auto flex min-h-screen max-w-2xl flex-col px-5 md:px-8">
      <p className="nm-title mb-1 text-2xl">past meetings</p>
      <p className="nm-subtle mb-5">
        {meetings.length} meeting{meetings.length !== 1 ? 's' : ''} saved
      </p>

      <div className="sticky top-0 z-10 mb-4 rounded-b-[28px] bg-[var(--paper)]/95 pb-3 pt-1 backdrop-blur">
        <div className="relative">
          <div className="flex h-12 items-center gap-2 rounded-[24px] border border-[var(--line)] bg-white/95 px-4 shadow-[var(--sh-sm)]">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="text-gray-400" aria-hidden="true">
              <path
                d="m20 20-4.2-4.2M10.8 18a7.2 7.2 0 1 1 0-14.4 7.2 7.2 0 0 1 0 14.4Z"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            </svg>
            <input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              onFocus={() => setSearchFocused(true)}
              onBlur={() => {
                window.setTimeout(() => setSearchFocused(false), 120)
              }}
              placeholder="Search date, time, person..."
              className="min-w-0 flex-1 bg-transparent text-sm text-[var(--ink)] placeholder:text-[var(--ink3)] focus:outline-none"
            />
            {searchQuery ? (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="rounded-full px-2 py-1 text-xs text-[var(--ink3)] hover:bg-[var(--paper)] hover:text-[var(--ink2)]"
                aria-label="Clear search"
              >
                clear
              </button>
            ) : null}
          </div>
          {showSuggestions ? (
            <div className="absolute left-0 right-0 top-14 z-20 overflow-hidden rounded-[24px] border border-[var(--line)] bg-white shadow-[var(--sh-md)]">
              {searchSuggestions.map((suggestion) => (
                <button
                  key={`${suggestion.type}_${suggestion.value}`}
                  type="button"
                  onMouseDown={(event) => {
                    event.preventDefault()
                    setSearchQuery(suggestion.value)
                    setSearchFocused(false)
                  }}
                  className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm hover:bg-[var(--paper)]"
                >
                  <span className="truncate text-[var(--ink)]">{suggestion.value}</span>
                  <span className="shrink-0 text-[11px] text-[var(--ink3)]">{suggestion.type}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <div className="mt-3 flex items-center gap-2">
          <div className="relative">
            <button
              type="button"
              onClick={() => setDateFilterOpen((prev) => !prev)}
              className={`h-9 rounded-full border px-4 text-xs font-bold shadow-[var(--sh-sm)] transition active:scale-95 ${
                dateFilter.mode === 'all'
                  ? 'border-[var(--line)] bg-white text-[var(--ink2)] hover:bg-[var(--paper)]'
                  : 'border-[var(--mint-d)] bg-[var(--mint-d)] text-white'
              }`}
            >
              {getDateFilterLabel(dateFilter)}
            </button>
            {dateFilterOpen ? (
              <DateFilterPanel
                value={dateFilter}
                onChange={setDateFilter}
                onClose={() => setDateFilterOpen(false)}
              />
            ) : null}
          </div>
          <button
            type="button"
            onClick={() => setSortOrder((prev) => (prev === 'newest' ? 'oldest' : 'newest'))}
            className="h-9 rounded-full border border-[var(--line)] bg-white px-4 text-xs font-bold text-[var(--ink2)] shadow-[var(--sh-sm)] hover:bg-[var(--paper)] sm:ml-auto"
          >
            {sortOrder === 'newest' ? 'Newest first' : 'Oldest first'}
          </button>
        </div>
        {normalizedSearch ? (
          <p className="mt-2 text-xs text-[var(--ink3)]">
            {visibleMeetings.length} result{visibleMeetings.length !== 1 ? 's' : ''} for "{searchQuery.trim()}"
          </p>
        ) : null}
      </div>

      {loading && (
        <div className="flex justify-center py-12">
          <div
            className="w-2 h-2 rounded-full bg-[var(--mint-d)]"
            style={{ animation: 'dotPulse 1.2s ease-in-out infinite' }}
          />
        </div>
      )}

      {error && !loading && (
        <div className="text-center py-8">
          <p className="text-sm text-red-400 mb-3">{error}</p>
          <button onClick={loadMeetings} className="text-sm text-[var(--mint-d)] underline">
            try again
          </button>
        </div>
      )}

      {!loading && !error && meetings.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <p className="text-sm text-[var(--ink3)] mb-1">no meetings yet</p>
          <p className="text-xs text-[var(--muted)]">record your first meeting to see it here</p>
        </div>
      )}

      {!loading && !error && meetings.length > 0 && visibleMeetings.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <p className="text-sm text-[var(--ink3)] mb-1">no matching meetings</p>
          <p className="text-xs text-[var(--muted)]">try a date, time, title, or participant name</p>
        </div>
      )}

      {!loading && !error && visibleMeetings.length > 0 && (
        <div className="flex flex-col gap-0 flex-1 overflow-y-auto" style={{ maxHeight: 'calc(100dvh - 112px)' }}>
          {visibleMeetings.map((meeting) => (
            <div key={meeting.id} className="relative group">
              <button
                onClick={() => handleOpenMeeting(meeting)}
                onTouchStart={(event) => handleTouchStart(event, meeting.id)}
                onTouchMove={(event) => handleTouchMove(event, meeting.id)}
                onTouchEnd={handleTouchEnd}
                onTouchCancel={handleTouchEnd}
                className="flex w-full flex-col items-start rounded-[24px] border border-transparent px-3 py-4 text-left transition-colors hover:border-[var(--line)] hover:bg-white/70 active:bg-[var(--mint-soft)]"
              >
                <div className="flex items-center justify-between w-full mb-1">
                  <span className="mr-3 flex-1 truncate text-sm font-bold text-[var(--ink)]">
                    {meeting.title || 'Untitled meeting'}
                  </span>
                  <span className="flex-shrink-0 text-xs text-[var(--ink3)]">
                    {formatDate(meeting.created_at)}
                  </span>
                </div>
                <p className="line-clamp-2 text-xs leading-relaxed text-[var(--ink3)]">
                  {getTldr(meeting.summary)}
                </p>
                {meeting.duration_segments > 0 && (
                  <span className="mt-1.5 text-xs text-[var(--muted)]">
                    {meeting.duration_segments} segments
                  </span>
                )}
                {meeting.audio_storage_path ? (
                  <span className="mt-1 text-xs text-[var(--muted)]">
                    {meeting.audio_upload_status === 'pending'
                      ? 'audio uploaded, verifying'
                      : meeting.audio_expires_at
                        ? `audio kept until ${formatDate(meeting.audio_expires_at)}`
                        : 'audio saved'}
                  </span>
                ) : null}
                {meeting.audio_upload_status === 'pending' && !meeting.audio_storage_path && (
                  <span className="text-xs text-amber-500 mt-1">
                    {pendingBackupIds.has(meeting.id)
                      ? 'recording saved on this device, uploading'
                      : 'audio uploading'}
                  </span>
                )}
                {meeting.audio_upload_status === 'failed' && (
                  <span className="text-xs text-amber-600 mt-1">
                    {pendingBackupIds.has(meeting.id)
                      ? 'upload will retry automatically'
                      : 'audio unavailable'}
                  </span>
                )}
              </button>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation()
                  void handleDeleteMeeting(meeting)
                }}
                disabled={deletingMeetingId === meeting.id}
                className={`absolute right-2 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-red-100 bg-white text-red-500 shadow-[var(--sh-sm)] transition-opacity ${
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

function DateFilterPanel({ value, onChange, onClose }) {
  const mode = value?.mode || 'all'
  const startDate = value?.startDate || ''
  const endDate = value?.endDate || ''

  function setPreset(nextMode) {
    onChange({
      mode: nextMode,
      startDate: '',
      endDate: '',
    })
    if (nextMode !== 'exact' && nextMode !== 'range') {
      onClose?.()
    }
  }

  return (
    <div className="absolute left-0 top-11 z-30 w-[min(320px,calc(100vw-40px))] rounded-[24px] border border-[var(--line)] bg-white p-3 shadow-[var(--sh-md)]">
      <div className="grid grid-cols-2 gap-1.5">
        {[
          ['all', 'All dates'],
          ['today', 'Today'],
          ['week', 'Last 7 days'],
          ['month', 'Last 30 days'],
        ].map(([nextMode, label]) => (
          <button
            key={nextMode}
            type="button"
            onClick={() => setPreset(nextMode)}
            className={`h-9 rounded-xl px-2 text-xs font-medium transition ${
              mode === nextMode ? 'bg-[var(--mint-d)] text-white' : 'bg-[var(--paper)] text-[var(--ink2)] hover:bg-[var(--mint-soft)]'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="mt-3 border-t border-gray-100 pt-3">
        <button
          type="button"
          onClick={() => onChange({ mode: 'exact', startDate, endDate: '' })}
          className={`mb-2 h-8 rounded-full px-3 text-xs font-bold ${
            mode === 'exact' ? 'bg-[var(--mint-d)] text-white' : 'bg-[var(--paper)] text-[var(--ink2)]'
          }`}
        >
          Exact date
        </button>
        <input
          type="date"
          value={startDate}
          onChange={(event) => {
            onChange({
              mode: 'exact',
              startDate: event.target.value,
              endDate: '',
            })
          }}
          className="h-10 w-full rounded-xl border border-[var(--line)] bg-white px-3 text-xs text-[var(--ink2)] focus:outline-none focus:ring-2 focus:ring-[var(--mint-soft)]"
        />
      </div>

      <div className="mt-3 border-t border-gray-100 pt-3">
        <button
          type="button"
          onClick={() => onChange({ mode: 'range', startDate, endDate })}
          className={`mb-2 h-8 rounded-full px-3 text-xs font-bold ${
            mode === 'range' ? 'bg-[var(--mint-d)] text-white' : 'bg-[var(--paper)] text-[var(--ink2)]'
          }`}
        >
          Date range
        </button>
        <div className="grid grid-cols-2 gap-2">
          <input
            type="date"
            value={startDate}
            onChange={(event) => {
              onChange({
                mode: 'range',
                startDate: event.target.value,
                endDate,
              })
            }}
            className="h-10 min-w-0 rounded-xl border border-[var(--line)] bg-white px-2 text-xs text-[var(--ink2)] focus:outline-none focus:ring-2 focus:ring-[var(--mint-soft)]"
            aria-label="Start date"
          />
          <input
            type="date"
            value={endDate}
            onChange={(event) => {
              onChange({
                mode: 'range',
                startDate,
                endDate: event.target.value,
              })
            }}
            className="h-10 min-w-0 rounded-xl border border-[var(--line)] bg-white px-2 text-xs text-[var(--ink2)] focus:outline-none focus:ring-2 focus:ring-[var(--mint-soft)]"
            aria-label="End date"
          />
        </div>
      </div>

      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={() => {
            onChange({ mode: 'all', startDate: '', endDate: '' })
            onClose?.()
          }}
          className="h-8 rounded-full px-3 text-xs text-[var(--ink3)] hover:bg-[var(--paper)] hover:text-[var(--ink2)]"
        >
          clear
        </button>
        <button
          type="button"
          onClick={onClose}
          className="h-8 rounded-full bg-[var(--mint-d)] px-3 text-xs font-bold text-white hover:bg-[var(--mint)]"
        >
          apply
        </button>
      </div>
    </div>
  )
}

function meetingMatchesSearch(meeting, normalizedQuery) {
  if (!normalizedQuery) return true
  const haystack = buildMeetingSearchText(meeting)
  const tokens = normalizedQuery.split(' ').filter(Boolean)
  if (tokens.length === 0) return true
  return tokens.every((token) => haystack.includes(token))
}

function meetingMatchesDateFilter(meeting, filter) {
  const mode = filter?.mode || 'all'
  if (mode === 'all') return true
  const date = meeting?.created_at ? new Date(meeting.created_at) : null
  if (!date || Number.isNaN(date.getTime())) return false

  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const meetingDay = new Date(date.getFullYear(), date.getMonth(), date.getDate())

  if (mode === 'today') {
    return date >= startOfToday
  }

  if (mode === 'week' || mode === 'month') {
    const days = mode === 'week' ? 7 : 30
    const since = new Date(startOfToday)
    since.setDate(since.getDate() - (days - 1))
    return date >= since
  }

  if (mode === 'exact') {
    const exactDate = parseDateInput(filter?.startDate)
    if (!exactDate) return true
    return meetingDay.getTime() === exactDate.getTime()
  }

  if (mode === 'range') {
    const startDate = parseDateInput(filter?.startDate)
    const endDate = parseDateInput(filter?.endDate)
    if (startDate && meetingDay < startDate) return false
    if (endDate && meetingDay > endDate) return false
    return true
  }

  return true
}

function sortMeetingsByDate(meetings, sortOrder) {
  const list = Array.isArray(meetings) ? [...meetings] : []
  const direction = sortOrder === 'oldest' ? 1 : -1
  return list.sort((a, b) => {
    const aTime = new Date(a?.created_at || 0).getTime()
    const bTime = new Date(b?.created_at || 0).getTime()
    return direction * (aTime - bTime)
  })
}

function buildSearchSuggestions(meetings, normalizedQuery) {
  if (!normalizedQuery || normalizedQuery.length < 2) return []
  const suggestions = []
  const seen = new Set()

  for (const meeting of Array.isArray(meetings) ? meetings : []) {
    const speakerNames = Array.isArray(meeting?.speaker_names) ? meeting.speaker_names : []
    for (const name of speakerNames) {
      addSuggestion(suggestions, seen, 'person', name, normalizedQuery)
    }

    addSuggestion(suggestions, seen, 'title', meeting?.title, normalizedQuery)

    const createdAt = meeting?.created_at ? new Date(meeting.created_at) : null
    if (createdAt && !Number.isNaN(createdAt.getTime())) {
      const dateValues = buildDateSearchParts(createdAt)
        .filter(Boolean)
        .filter((value) => String(value).length <= 24)
      for (const value of dateValues) {
        addSuggestion(suggestions, seen, 'date', value, normalizedQuery)
      }
    }
  }

  return suggestions.sort((a, b) => a.value.length - b.value.length)
}

function addSuggestion(suggestions, seen, type, rawValue, normalizedQuery) {
  const value = String(rawValue || '').replace(/\s+/g, ' ').trim()
  if (!value || value.length < 2 || value.length > 64) return
  const normalizedValue = normalizeSearchText(value)
  if (!normalizedValue.includes(normalizedQuery)) return
  const key = `${type}:${normalizedValue}`
  if (seen.has(key)) return
  seen.add(key)
  suggestions.push({ type, value })
}

function getDateFilterLabel(filter) {
  const mode = filter?.mode || 'all'
  if (mode === 'today') return 'Today'
  if (mode === 'week') return 'Last 7 days'
  if (mode === 'month') return 'Last 30 days'

  if (mode === 'exact') {
    return filter?.startDate ? formatDateInputLabel(filter.startDate) : 'Exact date'
  }

  if (mode === 'range') {
    const start = filter?.startDate ? formatDateInputLabel(filter.startDate) : 'Start'
    const end = filter?.endDate ? formatDateInputLabel(filter.endDate) : 'End'
    return `${start} - ${end}`
  }

  return 'Filter date'
}

function parseDateInput(value) {
  const text = String(value || '').trim()
  if (!text) return null
  const [year, month, day] = text.split('-').map(Number)
  if (!year || !month || !day) return null
  const date = new Date(year, month - 1, day)
  if (Number.isNaN(date.getTime())) return null
  return date
}

function formatDateInputLabel(value) {
  const date = parseDateInput(value)
  if (!date) return ''
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

function buildMeetingSearchText(meeting) {
  const createdAt = meeting?.created_at
  const createdDate = createdAt ? new Date(createdAt) : null
  const dateParts = Number.isNaN(createdDate?.getTime?.()) ? [] : buildDateSearchParts(createdDate)
  const speakerNames = Array.isArray(meeting?.speaker_names) ? meeting.speaker_names : []

  return normalizeSearchText(
    [
      meeting?.title,
      meeting?.summary,
      ...speakerNames,
      ...dateParts,
    ].join(' '),
  )
}

function buildDateSearchParts(date) {
  const monthLong = date.toLocaleDateString('en-US', { month: 'long' })
  const monthShort = date.toLocaleDateString('en-US', { month: 'short' })
  const weekdayLong = date.toLocaleDateString('en-US', { weekday: 'long' })
  const weekdayShort = date.toLocaleDateString('en-US', { weekday: 'short' })
  const day = String(date.getDate())
  const year = String(date.getFullYear())
  const isoDate = date.toISOString().slice(0, 10)
  const time12 = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  const time24 = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  const relative = getRelativeDateLabel(date)

  return [
    monthLong,
    monthShort,
    weekdayLong,
    weekdayShort,
    day,
    year,
    isoDate,
    time12,
    time24,
    relative,
    `${monthLong} ${day}`,
    `${monthShort} ${day}`,
  ]
}

function getRelativeDateLabel(date) {
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const diffDays = Math.round((startOfToday - startOfDate) / (1000 * 60 * 60 * 24))

  if (diffDays === 0) return 'today'
  if (diffDays === 1) return 'yesterday'
  if (diffDays > 1 && diffDays < 7) return `${diffDays} days ago`
  return ''
}

function normalizeSearchText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function isMissingColumnError(error, columnName) {
  const message = String(error?.message || '').toLowerCase()
  const code = String(error?.code || '')
  const needle = String(columnName || '').toLowerCase()
  return code === '42703' || (needle && message.includes(needle) && message.includes('column'))
}
