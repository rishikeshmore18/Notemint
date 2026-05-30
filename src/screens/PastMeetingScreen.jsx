import React, { useEffect, useRef, useState } from 'react'
import { groupSegmentsByTime } from '../lib/grokStt'
import { deleteMeetingAudio, getMeetingAudioSignedUrl, getMeetingProviderOutputs } from '../lib/summary'
import { supabase } from '../lib/supabase'

export default function PastMeetingScreen({ user, meeting, onBack }) {
  const [activeTab, setActiveTab] = useState('summary')
  const [copiedWhat, setCopiedWhat] = useState(null)
  const [audioUrl, setAudioUrl] = useState('')
  const [audioStatus, setAudioStatus] = useState('idle')
  const [audioStoragePath, setAudioStoragePath] = useState(meeting?.audio_storage_path || '')
  const [audioDeletedAt, setAudioDeletedAt] = useState(meeting?.audio_deleted_at || null)
  const [audioActionStatus, setAudioActionStatus] = useState('idle')
  const [providerOutputs, setProviderOutputs] = useState([])
  const [selectedProvider, setSelectedProvider] = useState('meeting')
  const [editableBlocks, setEditableBlocks] = useState([])
  const [editingBlockKey, setEditingBlockKey] = useState(null)
  const [editingBlockText, setEditingBlockText] = useState('')
  const [activeLineIndex, setActiveLineIndex] = useState(-1)
  const [isPlaying, setIsPlaying] = useState(false)
  const [autoScrollEnabled, setAutoScrollEnabled] = useState(true)
  const audioRef = useRef(null)
  const lineRefs = useRef({})
  const scrollContainerRef = useRef(null)
  const programmaticScrollRef = useRef(false)
  const signedUrlRefreshRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    setAudioUrl('')
    setAudioStoragePath(meeting?.audio_storage_path || '')
    setAudioDeletedAt(meeting?.audio_deleted_at || null)
    setAudioActionStatus('idle')
    setAudioStatus(meeting?.audio_storage_path ? 'loading' : 'unavailable')
    setActiveLineIndex(-1)
    setIsPlaying(false)
    setAutoScrollEnabled(true)
    signedUrlRefreshRef.current = false

    if (!meeting?.audio_storage_path || !user?.id) {
      setAudioStatus('unavailable')
      return () => {
        cancelled = true
      }
    }

    ;(async () => {
      try {
        const signedUrl = await getMeetingAudioSignedUrl(supabase, {
          audioStoragePath: meeting.audio_storage_path,
          userId: user?.id,
          meetingId: meeting?.id || null,
          expiresInSeconds: 3600,
        })
        if (!cancelled) {
          setAudioUrl(signedUrl)
          setAudioStatus(signedUrl ? 'ready' : 'unavailable')
        }
      } catch (err) {
        console.warn('[PastMeeting] Could not load signed audio URL:', err?.message || err)
        if (!cancelled) {
          setAudioUrl('')
          setAudioStatus('error')
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [meeting?.audio_storage_path, meeting?.id, user?.id])

  useEffect(() => {
    let cancelled = false
    setProviderOutputs([])
    setSelectedProvider('meeting')
    if (!user?.id || !meeting?.id || String(meeting.id).startsWith('local_')) return () => {}

    ;(async () => {
      try {
        const rows = await getMeetingProviderOutputs(supabase, {
          userId: user.id,
          meetingId: meeting.id,
        })
        if (cancelled) return
        setProviderOutputs(rows)
      } catch (err) {
        if (!cancelled) {
          console.warn('[PastMeeting] Could not load provider outputs:', err?.message || err)
          setProviderOutputs([])
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [meeting?.id, user?.id])

  useEffect(() => {
    const selectedRow =
      selectedProvider === 'meeting'
        ? null
        : providerOutputs.find((row) => String(row?.provider || '').toLowerCase() === selectedProvider) || null
    const segmentsForView = Array.isArray(selectedRow?.segments) ? selectedRow.segments : meeting?.segments
    const transcriptForView = buildTranscriptFromSegments(segmentsForView) || String(meeting?.transcript_compressed || '')
    const blocks = buildEditableBlocks(segmentsForView, transcriptForView)
    setEditableBlocks(blocks)
    setEditingBlockKey(null)
    setEditingBlockText('')
  }, [
    selectedProvider,
    meeting?.id,
    meeting?.segments,
    meeting?.transcript_compressed,
    providerOutputs,
  ])

  useEffect(() => {
    if (!autoScrollEnabled) return
    if (activeLineIndex < 0) return
    const node = lineRefs.current[activeLineIndex]
    if (!node) return
    programmaticScrollRef.current = true
    node.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    const timer = setTimeout(() => {
      programmaticScrollRef.current = false
    }, 450)
    return () => clearTimeout(timer)
  }, [activeLineIndex, autoScrollEnabled])

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
    const text = type === 'summary' ? effectiveSummary || '' : buildTranscriptFromBlocks(editableBlocks) || effectiveTranscript || ''
    await copyToClipboard(text)
    setCopiedWhat(type)
    setTimeout(() => {
      setCopiedWhat(null)
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
    const labelLower = String(label).toLowerCase()
    if (labelLower === 'you') return 'bg-indigo-100 text-indigo-700'
    if (labelLower === 'person 1' || labelLower === 'person1') return 'bg-emerald-100 text-emerald-700'
    if (labelLower === 'person 2' || labelLower === 'person2') return 'bg-amber-100 text-amber-700'
    if (labelLower === 'person 3' || labelLower === 'person3') return 'bg-rose-100 text-rose-700'
    if (labelLower === '0') return 'bg-indigo-100 text-indigo-700'
    if (labelLower === '1') return 'bg-emerald-100 text-emerald-700'
    if (labelLower === '2') return 'bg-amber-100 text-amber-700'
    return 'bg-gray-100 text-gray-600'
  }

  function handleAudioTimeUpdate(blocks) {
    const audio = audioRef.current
    if (!audio || !Array.isArray(blocks) || blocks.length === 0) return
    setActiveLineIndex(findActiveBlockIndex(blocks, audio.currentTime))
  }

  function handleTranscriptManualScroll() {
    if (!isPlaying || activeTab !== 'transcript') return
    if (programmaticScrollRef.current) return
    setAutoScrollEnabled(false)
  }

  function resumeAutoScroll() {
    setAutoScrollEnabled(true)
    const node = lineRefs.current[activeLineIndex]
    if (!node) return
    programmaticScrollRef.current = true
    node.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    setTimeout(() => {
      programmaticScrollRef.current = false
    }, 450)
  }

  function renderAudioPlayer(blocks) {
    if (audioStatus === 'loading') {
      return (
        <div className="mb-3 rounded-xl border border-gray-100 bg-gray-50 px-3 py-3 text-xs text-gray-500">
          loading meeting audio...
        </div>
      )
    }

    if (audioStatus === 'error') {
      return (
        <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
          audio file could not be loaded. transcript is still available.
        </div>
      )
    }

    if (!audioUrl) {
      return (
        <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
          {audioDeletedAt ? 'audio was deleted. transcript and summary are still available.' : 'audio playback is not available for this meeting.'}
        </div>
      )
    }

    return (
      <div className="mb-3 rounded-xl border border-gray-100 bg-gray-50 px-3 py-3">
        <audio
          ref={audioRef}
          src={audioUrl}
          controls
          className="w-full"
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onEnded={() => {
            setIsPlaying(false)
            setActiveLineIndex(-1)
            setAutoScrollEnabled(true)
          }}
          onTimeUpdate={() => handleAudioTimeUpdate(blocks)}
          onError={() => void handleAudioError()}
        />
        <div className="mt-1 flex items-center justify-between gap-3">
          <div>
            <p className="text-[11px] text-gray-500">
              {isPlaying
                ? autoScrollEnabled
                  ? 'playing with synced transcript'
                  : 'auto-scroll paused'
                : 'press play to sync transcript scrolling'}
            </p>
            {meeting?.audio_expires_at ? (
              <p className="text-[11px] text-gray-400">
                audio kept until {formatDate(meeting.audio_expires_at)}
              </p>
            ) : null}
          </div>
          <div className="flex items-center gap-3">
            {isPlaying && !autoScrollEnabled ? (
              <button
                type="button"
                onClick={resumeAutoScroll}
                className="text-[11px] text-indigo-600 underline"
              >
                resume auto-scroll
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => void handleDeleteAudio()}
              disabled={audioActionStatus === 'deleting'}
              className="text-[11px] text-red-500 underline disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {audioActionStatus === 'deleting' ? 'deleting audio...' : 'delete audio'}
            </button>
          </div>
        </div>
        {audioActionStatus === 'error' ? (
          <p className="mt-1 text-[11px] text-red-500">could not delete audio. try again.</p>
        ) : null}
      </div>
    )
  }

  async function handleAudioError() {
    if (!audioStoragePath || !user?.id || signedUrlRefreshRef.current) {
      setAudioUrl('')
      setAudioStatus('error')
      return
    }

    signedUrlRefreshRef.current = true
    setAudioStatus('loading')
    try {
      const signedUrl = await getMeetingAudioSignedUrl(supabase, {
        audioStoragePath,
        userId: user?.id,
        meetingId: meeting?.id || null,
        expiresInSeconds: 3600,
      })
      setAudioUrl(signedUrl)
      setAudioStatus(signedUrl ? 'ready' : 'error')
    } catch (err) {
      console.warn('[PastMeeting] Could not refresh signed audio URL:', err?.message || err)
      setAudioUrl('')
      setAudioStatus('error')
    }
  }

  async function handleDeleteAudio() {
    if (!audioStoragePath || !meeting?.id || !user?.id) return
    const confirmed = window.confirm('Delete the saved audio for this meeting? The transcript and summary will stay.')
    if (!confirmed) return

    if (audioRef.current && !audioRef.current.paused) {
      audioRef.current.pause()
    }

    setAudioActionStatus('deleting')
    try {
      await deleteMeetingAudio(supabase, {
        userId: user.id,
        meetingId: meeting.id,
        audioStoragePath,
      })
      setAudioUrl('')
      setAudioStoragePath('')
      setAudioDeletedAt(new Date().toISOString())
      setAudioStatus('unavailable')
      setAudioActionStatus('deleted')
      setIsPlaying(false)
      setActiveLineIndex(-1)
    } catch (err) {
      console.warn('[PastMeeting] Could not delete audio:', err?.message || err)
      setAudioActionStatus('error')
    }
  }

  function startEditingBlock(block) {
    setEditingBlockKey(block?.key || null)
    setEditingBlockText(String(block?.text || ''))
  }

  function saveEditingBlock(block) {
    const nextText = String(editingBlockText || '').replace(/\s+/g, ' ').trim()
    if (!nextText) {
      setEditingBlockKey(null)
      setEditingBlockText('')
      return
    }
    setEditableBlocks((prev) =>
      prev.map((item) => (item.key === block.key ? { ...item, text: nextText, edited: true } : item)),
    )
    setEditingBlockKey(null)
    setEditingBlockText('')
  }

  const selectedProviderRow =
    selectedProvider === 'meeting'
      ? null
      : providerOutputs.find((row) => String(row?.provider || '').toLowerCase() === selectedProvider) || null
  const effectiveSegments = Array.isArray(selectedProviderRow?.segments) ? selectedProviderRow.segments : meeting?.segments
  const effectiveSummary = String(selectedProviderRow?.summary || meeting?.summary || '')
  const effectiveTranscript = buildTranscriptFromSegments(effectiveSegments) || String(meeting?.transcript_compressed || '')

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

      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-xs text-gray-400">model output</p>
        <select
          value={selectedProvider}
          onChange={(event) => setSelectedProvider(event.target.value)}
          className="h-8 rounded-lg border border-gray-200 bg-white px-2 text-xs text-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-100 focus:border-indigo-400"
        >
          <option value="meeting">Meeting (default)</option>
          {providerOutputs.map((row) => {
            const key = String(row?.provider || '').toLowerCase()
            if (!key) return null
            return (
              <option key={key} value={key}>
                {formatProviderLabel(key)}
              </option>
            )
          })}
        </select>
      </div>

      <div
        ref={scrollContainerRef}
        className="flex-1 overflow-y-auto pb-4"
        style={{ maxHeight: 'calc(100dvh - 220px)' }}
        onScroll={handleTranscriptManualScroll}
        onWheel={handleTranscriptManualScroll}
        onTouchMove={handleTranscriptManualScroll}
      >
        {activeTab === 'summary' && <div>{renderMarkdownLite(effectiveSummary)}</div>}

        {activeTab === 'transcript' &&
          (() => {
            const rawSegments = editableBlocks.length > 0 ? editableBlocks : null
            if (rawSegments) {
              const labelMapFromDb = meeting.label_map || {}
              const blocks = rawSegments

              return (
                <div className="flex flex-col gap-0">
                  {renderAudioPlayer(blocks)}
                  {blocks.map((block, i) => (
                    <div
                      key={block.key || i}
                      ref={(node) => {
                        if (node) lineRefs.current[i] = node
                      }}
                      className={`flex items-start gap-2.5 py-2.5 border-b border-gray-50 last:border-0 ${
                        i === activeLineIndex ? 'bg-indigo-50' : 'bg-white'
                      }`}
                    >
                      <div className="w-10 flex-shrink-0 pt-0.5">
                        {block.timeLabel && (
                          <span className="text-xs text-gray-300 font-mono tabular-nums">
                            {block.timeLabel}
                          </span>
                        )}
                      </div>
                      <span
                        className={`text-xs font-medium px-2 py-0.5 rounded-full flex-shrink-0 mt-0.5 ${getSpeakerBadgeClass(
                          block.label || labelMapFromDb[block.speaker] || 'person ' + block.speaker,
                        )}`}
                      >
                        {String(block.label || labelMapFromDb[block.speaker] || 'person ' + block.speaker).toLowerCase()}
                      </span>
                      <div className="flex-1">
                        {editingBlockKey === block.key ? (
                          <div>
                            <textarea
                              value={editingBlockText}
                              onChange={(event) => setEditingBlockText(event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key === 'Escape') {
                                  event.preventDefault()
                                  setEditingBlockKey(null)
                                  setEditingBlockText('')
                                  return
                                }
                                if (event.key === 'Enter' && !event.shiftKey) {
                                  event.preventDefault()
                                  saveEditingBlock(block)
                                }
                              }}
                              rows={2}
                              className="w-full rounded-lg border border-indigo-200 bg-white px-2.5 py-1.5 text-sm text-gray-800 focus:outline-none focus:border-indigo-400 resize-y"
                            />
                            <p className="mt-1 text-[11px] text-gray-500">enter to save, esc to cancel</p>
                          </div>
                        ) : (
                          <>
                            <p className="text-sm text-gray-800 leading-relaxed">{block.text}</p>
                            <div className="mt-1 flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => startEditingBlock(block)}
                                className="text-[11px] text-indigo-600 underline"
                              >
                                edit
                              </button>
                              {block.edited ? <span className="text-[11px] text-amber-700">edited</span> : null}
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )
            }
            return null
          })()}
      </div>

      <div className="flex flex-col gap-2 pt-4 flex-shrink-0" style={{ paddingBottom: 'max(24px, env(safe-area-inset-bottom))' }}>
        <button
          onClick={() => handleCopy('summary')}
          disabled={!effectiveSummary}
          className="h-11 w-full rounded-xl bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 active:bg-indigo-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {copiedWhat === 'summary' ? 'copied!' : 'copy summary'}
        </button>

        <button
          onClick={() => handleCopy('transcript')}
          disabled={!effectiveTranscript}
          className="h-11 w-full rounded-xl border border-gray-200 text-gray-700 text-sm font-medium hover:bg-gray-50 active:bg-gray-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {copiedWhat === 'transcript' ? 'copied!' : 'copy transcript'}
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

function formatProviderLabel(provider) {
  const key = String(provider || '').toLowerCase()
  if (key === 'assemblyai') return 'AssemblyAI'
  if (key === 'deepgram') return 'Deepgram'
  if (key === 'grok') return 'Grok'
  return provider
}

function findActiveBlockIndex(blocks, currentTime) {
  const list = Array.isArray(blocks) ? blocks : []
  if (list.length === 0) return -1

  if (!Number.isFinite(currentTime)) return -1

  let activeIndex = -1
  let nearestIndex = -1
  let nearestDelta = Number.POSITIVE_INFINITY

  for (let i = 0; i < list.length; i += 1) {
    const block = list[i]
    const startTime = toNumberOrNull(block?.startTime)
    const endTime = toNumberOrNull(block?.endTime)
    if (startTime === null) continue

    if (endTime !== null && currentTime >= startTime - 0.15 && currentTime <= endTime + 0.15) {
      return i
    }

    if (startTime <= currentTime + 0.15) {
      activeIndex = i
    }

    const delta = Math.abs(currentTime - startTime)
    if (delta < nearestDelta && delta <= 1.4) {
      nearestDelta = delta
      nearestIndex = i
    }
  }

  return activeIndex >= 0 ? activeIndex : nearestIndex
}

function toNumberOrNull(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) return null
  return parsed
}

function formatDate(isoString) {
  const date = new Date(isoString)
  if (Number.isNaN(date.getTime())) return 'scheduled deletion'
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

function buildTranscriptFromSegments(segments) {
  const list = Array.isArray(segments) ? segments : []
  if (list.length === 0) return ''
  const lines = []
  for (const segment of list) {
    const text = String(segment?.text || '').replace(/\s+/g, ' ').trim()
    if (!text) continue
    const speakerNumber = Number(segment?.speaker)
    const label = Number.isFinite(speakerNumber) ? `Person ${speakerNumber + 1}` : 'Person 1'
    lines.push(`[${label}]: ${text}`)
  }
  return lines.join('\n')
}

function buildEditableBlocks(segments, transcript) {
  const grouped = Array.isArray(segments) && segments.length > 0 ? groupSegmentsByTime(segments) : []
  if (grouped.length > 0) {
    return grouped.map((block, index) => ({
      key: `seg_${index}_${block.startTime ?? 'na'}`,
      speaker: block.speaker,
      label: Number.isFinite(Number(block.speaker)) ? `Person ${Number(block.speaker) + 1}` : String(block.label || 'person 1'),
      text: String(block.text || ''),
      timeLabel: block.timeLabel || null,
      startTime: block.startTime,
      endTime: block.endTime,
      edited: false,
    }))
  }

  const parsed = parseTranscriptLines(transcript)
  return parsed.map((block, index) => ({
    key: `line_${index}`,
    speaker: index % 4,
    label: block.label,
    text: block.text,
    timeLabel: null,
    startTime: null,
    endTime: null,
    edited: false,
  }))
}

function parseTranscriptLines(compressed) {
  if (!compressed) return []
  return String(compressed)
    .split('\n')
    .map((line) => {
      const match = line.match(/^\[([^\]]+)\]:\s*(.+)$/)
      if (!match) return null
      return {
        label: match[1],
        text: match[2],
      }
    })
    .filter(Boolean)
}

function buildTranscriptFromBlocks(blocks) {
  const list = Array.isArray(blocks) ? blocks : []
  const lines = []
  for (const block of list) {
    const label = String(block?.label || 'Person 1').trim() || 'Person 1'
    const text = String(block?.text || '').replace(/\s+/g, ' ').trim()
    if (!text) continue
    lines.push(`[${label}]: ${text}`)
  }
  return lines.join('\n')
}
