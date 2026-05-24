import React, { useEffect, useMemo, useRef, useState } from 'react'
import { matchSpeakers } from '../lib/enrollment'
import { generateContextKeyterms } from '../lib/api'
import { getContextProfile, getCorrectionMemory, upsertContextProfile } from '../lib/contextProfile'
import {
  compressTranscript,
  getSummary,
  saveMeeting,
  saveMeetingSpeakers,
  saveTranscriptCorrections,
  updateMeetingTranscriptAndSummary,
} from '../lib/summary'
import { supabase } from '../lib/supabase'

export default function ResultsScreen({ user, segments, audioBlob, meetingContext, confirmedLabelMap, onNewMeeting }) {
  const [activeTab, setActiveTab] = useState('summary')
  const [summaryText, setSummaryText] = useState('')
  const [summaryStatus, setSummaryStatus] = useState('idle')
  const [summaryError, setSummaryError] = useState(null)
  const [labelMap, setLabelMap] = useState({})
  const [saveStatus, setSaveStatus] = useState(null)
  const [copiedWhat, setCopiedWhat] = useState(null)
  const [meetingId, setMeetingId] = useState(null)
  const [editableSegments, setEditableSegments] = useState([])
  const [editingSegmentKey, setEditingSegmentKey] = useState(null)
  const [editingText, setEditingText] = useState('')
  const [audioUrl, setAudioUrl] = useState('')
  const [activeLineIndex, setActiveLineIndex] = useState(-1)
  const [isPlaying, setIsPlaying] = useState(false)

  const summaryTextRef = useRef('')
  const mountedRef = useRef(true)
  const labelMapRef = useRef({})
  const audioRef = useRef(null)
  const lineRefs = useRef({})
  const correctionSaveKeyRef = useRef(new Set())
  const contextRefreshTimerRef = useRef(null)
  const contextRefreshInFlightRef = useRef(false)
  const contextRefreshQueuedRef = useRef(false)

  useEffect(() => {
    return () => {
      mountedRef.current = false
      if (contextRefreshTimerRef.current) {
        clearTimeout(contextRefreshTimerRef.current)
        contextRefreshTimerRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    if (!audioBlob) {
      setAudioUrl('')
      return
    }
    const url = URL.createObjectURL(audioBlob)
    setAudioUrl(url)
    return () => {
      URL.revokeObjectURL(url)
    }
  }, [audioBlob])

  useEffect(() => {
    const selectedSegments = getSelectedSegments(segments)
    if (selectedSegments.length === 0) {
      setEditableSegments([])
      setSummaryStatus('error')
      setSummaryError('No speech was captured. Make sure your microphone was working and try again.')
      return
    }

    const mapped = toEditableSegments(selectedSegments)
    setEditableSegments(mapped)

    const finalMap = getFinalLabelMap(selectedSegments, confirmedLabelMap)
    labelMapRef.current = finalMap
    setLabelMap(finalMap)
    setMeetingId(null)
    correctionSaveKeyRef.current.clear()

    void runSummary({
      targetSegments: mapped,
      persist: true,
      persistSpeakerMappings: true,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segments, confirmedLabelMap])

  useEffect(() => {
    if (activeLineIndex < 0) return
    const node = lineRefs.current[activeLineIndex]
    if (!node) return
    node.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [activeLineIndex])

  const correctedCount = useMemo(
    () => editableSegments.filter((segment) => Boolean(segment?.correctionMeta)).length,
    [editableSegments],
  )

  async function runSummary({ targetSegments = editableSegments, persist = false, persistSpeakerMappings = false } = {}) {
    const selectedSegments = Array.isArray(targetSegments) ? targetSegments : []
    if (selectedSegments.length === 0) {
      setSummaryStatus('error')
      setSummaryError('No transcript segments found.')
      return
    }

    const compressed = compressTranscript(selectedSegments, labelMapRef.current)
    if (!compressed || compressed.trim().length < 10) {
      setSummaryStatus('error')
      setSummaryError('Transcript is too short to summarize.')
      return
    }

    setSummaryStatus('generating')
    setSummaryError(null)
    summaryTextRef.current = ''
    setSummaryText('')

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

        if (!persist) return
        setSaveStatus('saving')

        try {
          let currentMeetingId = meetingId
          if (!currentMeetingId) {
            currentMeetingId = await saveMeeting(supabase, user.id, {
              title: null,
              transcript: compressed,
              summary: fullText,
              segments: selectedSegments,
              labelMap: labelMapRef.current,
            })
            if (currentMeetingId) setMeetingId(currentMeetingId)
          } else {
            await updateMeetingTranscriptAndSummary(supabase, currentMeetingId, compressed, fullText)
          }

          if (currentMeetingId && persistSpeakerMappings) {
            await saveMeetingSpeakers(supabase, {
              userId: user.id,
              meetingId: currentMeetingId,
              segments: selectedSegments,
              labelMap: labelMapRef.current,
              confirmedByUser: Boolean(confirmedLabelMap && Object.keys(confirmedLabelMap).length > 0),
            })
          }

          setSaveStatus(currentMeetingId ? 'saved' : 'failed')
        } catch (err) {
          console.warn('[Results] Could not persist summary update:', err?.message || err)
          setSaveStatus('failed')
        }
      },
      (errMsg) => {
        if (!mountedRef.current) return
        setSummaryStatus('error')
        setSummaryError(errMsg)
      },
      {
        meetingContext: meetingContext && typeof meetingContext === 'object' ? meetingContext : null,
      },
    )
  }

  async function handleRegenerateSummary() {
    await runSummary({
      targetSegments: editableSegments,
      persist: Boolean(meetingId),
      persistSpeakerMappings: false,
    })
  }

  async function handleSaveCorrection(segment, nextText) {
    const correctedText = String(nextText || '').replace(/\s+/g, ' ').trim()
    if (!correctedText) return

    const existingOriginal = segment?.correctionMeta?.originalText
    const originalText = existingOriginal || String(segment?.text || '').trim()
    if (!originalText || originalText === correctedText) return

    setEditableSegments((prev) =>
      prev.map((item) =>
        item.key === segment.key
          ? {
              ...item,
              text: correctedText,
              uncertain: item.uncertain || false,
              correctionMeta: {
                originalText,
                correctedText,
                correctedAt: new Date().toISOString(),
              },
            }
          : item,
      ),
    )

    setEditingSegmentKey(null)
    setEditingText('')

    const persistKey = `${segment.key}:${originalText}:${correctedText}`
    if (correctionSaveKeyRef.current.has(persistKey)) return
    correctionSaveKeyRef.current.add(persistKey)

    try {
      await saveTranscriptCorrections(supabase, {
        userId: user?.id,
        meetingId,
        provider: segment?.source || null,
        corrections: [{ originalText, correctedText }],
        contextTermsUsed: Array.isArray(meetingContext?.contextTerms) ? meetingContext.contextTerms : [],
      })
      scheduleContextRefresh()
    } catch (err) {
      console.warn('[Results] Could not save transcript correction:', err?.message || err)
    }
  }

  function scheduleContextRefresh() {
    if (!user?.id) return
    if (contextRefreshTimerRef.current) {
      clearTimeout(contextRefreshTimerRef.current)
    }
    contextRefreshTimerRef.current = setTimeout(() => {
      contextRefreshTimerRef.current = null
      void refreshContextFromCorrections()
    }, 1200)
  }

  async function refreshContextFromCorrections() {
    if (!user?.id) return

    if (contextRefreshInFlightRef.current) {
      contextRefreshQueuedRef.current = true
      return
    }

    contextRefreshInFlightRef.current = true
    try {
      const profile = await getContextProfile(supabase, user.id)
      if (!profile) return

      const correctionMemory = await getCorrectionMemory(supabase, user.id, { limit: 250 }).catch(() => ({
        boostTerms: [],
        confusionPairs: [],
      }))

      const correctionTerms = uniqueList([
        ...toStringList(profile.correction_terms),
        ...toStringList(correctionMemory.boostTerms),
      ]).slice(0, 200)

      const generated = await generateContextKeyterms({
        industry: profile.industry || '',
        role: profile.role || '',
        meetingTypes: toStringList(profile.meeting_types),
        participantNames: toStringList(profile.participant_names),
        organizationTerms: toStringList(profile.organization_terms),
        customTerms: toStringList(profile.custom_terms),
        correctionTerms,
      })

      await upsertContextProfile(supabase, user.id, {
        industry: profile.industry || '',
        role: profile.role || '',
        meetingTypes: toStringList(profile.meeting_types),
        participantNames: toStringList(profile.participant_names),
        organizationTerms: toStringList(profile.organization_terms),
        customTerms: toStringList(profile.custom_terms),
        correctionTerms,
        generatedKeyterms: Array.isArray(generated?.keyterms) ? generated.keyterms : toStringList(profile.generated_keyterms),
        summaryContext: String(generated?.summaryContext || profile.summary_context || ''),
        doNotInfer: Array.isArray(generated?.doNotInfer) ? generated.doNotInfer : toStringList(profile.do_not_infer),
      })
    } catch (err) {
      console.warn('[Results] Could not refresh context keyterms after correction:', err?.message || err)
    } finally {
      contextRefreshInFlightRef.current = false
      if (contextRefreshQueuedRef.current) {
        contextRefreshQueuedRef.current = false
        scheduleContextRefresh()
      }
    }
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
      text = editableSegments
        .map((segment) => `[${labelMapRef.current[segment.speaker] || `Person ${Number(segment.speaker) + 1}`}]: ${segment.text}`)
        .join('\n')
    }
    await copyToClipboard(text)
    setCopiedWhat(type)
    setTimeout(() => {
      if (mountedRef.current) setCopiedWhat(null)
    }, 2000)
  }

  function handleAudioTimeUpdate() {
    const audio = audioRef.current
    if (!audio) return
    const currentTime = audio.currentTime
    const activeIndex = findActiveSegmentIndex(editableSegments, currentTime)
    setActiveLineIndex(activeIndex)
  }

  function startEditing(segment) {
    if (!segment) return
    if (audioRef.current && !audioRef.current.paused) {
      audioRef.current.pause()
      setIsPlaying(false)
    }
    setEditingSegmentKey(segment.key)
    setEditingText(segment.text || '')
  }

  return (
    <div className="min-h-screen bg-white flex flex-col max-w-2xl mx-auto px-5 md:px-10">
      <div className="flex items-center justify-between h-14 flex-shrink-0">
        <span className="text-sm font-medium text-gray-900">recall</span>
        <span className="text-xs text-gray-400">
          {new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}
        </span>
        <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center flex-shrink-0">
          <span className="text-sm font-medium text-indigo-600">{user?.email?.[0]?.toUpperCase() || '?'}</span>
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
            activeTab === 'summary' ? 'bg-indigo-600 text-white font-medium' : 'bg-white text-gray-500 hover:text-gray-700'
          }`}
        >
          summary
        </button>
        <button
          onClick={() => setActiveTab('transcript')}
          className={`flex-1 h-9 text-sm transition-colors ${
            activeTab === 'transcript' ? 'bg-indigo-600 text-white font-medium' : 'bg-white text-gray-500 hover:text-gray-700'
          }`}
        >
          transcript
        </button>
      </div>

      <div className="flex-1 overflow-y-auto pb-4" style={{ maxHeight: 'calc(100dvh - 220px)' }}>
        {activeTab === 'summary' && (
          <div>
            <div className="mb-3 flex items-center justify-between">
              <p className="text-xs text-gray-400">
                {correctedCount > 0 ? `${correctedCount} corrected line${correctedCount > 1 ? 's' : ''}` : 'no manual corrections yet'}
              </p>
              <button
                type="button"
                onClick={handleRegenerateSummary}
                disabled={editableSegments.length === 0 || summaryStatus === 'generating'}
                className="text-xs text-indigo-600 underline disabled:opacity-40 disabled:cursor-not-allowed"
              >
                regenerate summary from corrected transcript
              </button>
            </div>

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
                    void handleRegenerateSummary()
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
            <div className="mb-3 rounded-xl border border-gray-100 bg-gray-50 px-3 py-3">
              {audioUrl ? (
                <div>
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
                    }}
                    onTimeUpdate={handleAudioTimeUpdate}
                  />
                  <p className="mt-1 text-[11px] text-gray-500">
                    {isPlaying ? 'playing with synced transcript' : 'press play to sync transcript scrolling'}
                  </p>
                </div>
              ) : (
                <p className="text-xs text-gray-500">audio playback unavailable for this meeting.</p>
              )}
            </div>

            <div className="flex items-center justify-between mb-4">
              <p className="text-xs text-gray-400">
                {new Set(editableSegments.map((s) => s.speaker)).size} speaker
                {new Set(editableSegments.map((s) => s.speaker)).size > 1 ? 's' : ''} - {editableSegments.length} segments
              </p>
              <button
                type="button"
                onClick={handleRegenerateSummary}
                disabled={editableSegments.length === 0 || summaryStatus === 'generating'}
                className="text-xs text-indigo-600 underline disabled:opacity-40 disabled:cursor-not-allowed"
              >
                regenerate summary from corrected transcript
              </button>
            </div>

            <div className="flex flex-col gap-0">
              {editableSegments.map((segment, index) => {
                const label = labelMap[segment.speaker] || `person ${Number(segment.speaker) + 1}`
                const isActive = index === activeLineIndex
                const isEditing = editingSegmentKey === segment.key
                const isCorrected = Boolean(segment?.correctionMeta)
                const rowClass = isActive
                  ? 'bg-indigo-50'
                  : isCorrected
                    ? 'bg-amber-50'
                    : 'bg-white'

                return (
                  <div
                    key={segment.key}
                    ref={(node) => {
                      if (node) lineRefs.current[index] = node
                    }}
                    className={`flex items-start gap-2.5 py-2.5 border-b border-gray-50 last:border-0 ${rowClass}`}
                  >
                    <div className="w-10 flex-shrink-0 pt-0.5">
                      <span className="text-xs text-gray-300 font-mono tabular-nums">
                        {formatTimeLabel(segment.startTime)}
                      </span>
                    </div>

                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full mt-0.5 ${getSpeakerBadgeClass(label)}`}>
                      {String(label).toLowerCase()}
                    </span>

                    <div className="flex-1">
                      {isEditing ? (
                        <div>
                          <textarea
                            value={editingText}
                            onChange={(event) => setEditingText(event.target.value)}
                            rows={2}
                            className="w-full rounded-lg border border-indigo-200 bg-white px-2.5 py-1.5 text-sm text-gray-800 focus:outline-none focus:border-indigo-400 resize-y"
                          />
                          <div className="mt-1 flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => void handleSaveCorrection(segment, editingText)}
                              className="rounded-md bg-indigo-600 px-2.5 py-1 text-xs text-white"
                            >
                              save
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setEditingSegmentKey(null)
                                setEditingText('')
                              }}
                              className="rounded-md border border-gray-200 px-2.5 py-1 text-xs text-gray-500"
                            >
                              cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div>
                          <p className="text-sm text-gray-800 leading-relaxed">{segment.text}</p>
                          <div className="mt-1 flex items-center gap-3">
                            <button
                              type="button"
                              onClick={() => startEditing(segment)}
                              className="text-[11px] text-indigo-600 underline"
                            >
                              edit
                            </button>
                            {isCorrected ? (
                              <span className="text-[11px] text-amber-700">
                                corrected
                              </span>
                            ) : null}
                            {segment.uncertain ? (
                              <span className="text-[11px] text-amber-600">low confidence</span>
                            ) : null}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}

              {editableSegments.length === 0 && <p className="text-sm text-gray-400 text-center py-8">no transcript available</p>}
            </div>
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

        <button onClick={onNewMeeting} className="h-11 w-full text-sm text-gray-400 hover:text-gray-600 transition-colors">
          new meeting
        </button>
      </div>
    </div>
  )
}

function getSelectedSegments(segments) {
  const list = Array.isArray(segments) ? segments : []
  const finals = list.filter((segment) => segment?.isFinal === true)
  return finals.length > 0 ? finals : list
}

function toEditableSegments(segments) {
  return (Array.isArray(segments) ? segments : [])
    .map((segment, index) => ({
      ...segment,
      key: buildSegmentKey(segment, index),
      text: String(segment?.text || '').trim(),
      startTime: toNumberOrNull(segment?.startTime),
      endTime: toNumberOrNull(segment?.endTime),
      correctionMeta: null,
    }))
    .filter((segment) => segment.text.length > 0)
}

function buildSegmentKey(segment, index) {
  const speaker = Number(segment?.speaker)
  const start = toNumberOrNull(segment?.startTime)
  const end = toNumberOrNull(segment?.endTime)
  return `${index}_${Number.isFinite(speaker) ? speaker : 0}_${start ?? 'na'}_${end ?? 'na'}`
}

function toNumberOrNull(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) return null
  return parsed
}

function findActiveSegmentIndex(segments, currentTime) {
  const list = Array.isArray(segments) ? segments : []
  if (!Number.isFinite(currentTime)) return -1

  let bestIndex = -1
  let bestDelta = Number.POSITIVE_INFINITY

  for (let i = 0; i < list.length; i += 1) {
    const segment = list[i]
    const start = toNumberOrNull(segment?.startTime)
    const end = toNumberOrNull(segment?.endTime)
    if (start === null) continue

    if (end !== null && currentTime >= start && currentTime <= end) {
      return i
    }

    const delta = Math.abs(currentTime - start)
    if (delta < bestDelta && delta <= 1.4) {
      bestDelta = delta
      bestIndex = i
    }
  }

  return bestIndex
}

function formatTimeLabel(seconds) {
  const value = toNumberOrNull(seconds)
  if (value === null) return '--:--'
  const total = Math.floor(value)
  const minutes = Math.floor(total / 60)
  const secs = total % 60
  return `${minutes}:${String(secs).padStart(2, '0')}`
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

function getFinalLabelMap(segments, confirmedLabelMap) {
  if (confirmedLabelMap && Object.keys(confirmedLabelMap).length > 0) {
    return confirmedLabelMap
  }
  return matchSpeakers(segments)
}

function toStringList(value) {
  return Array.isArray(value)
    ? value
        .map((item) => String(item || '').trim())
        .filter(Boolean)
    : []
}

function uniqueList(values) {
  const list = Array.isArray(values) ? values : []
  const out = []
  const seen = new Set()
  for (const raw of list) {
    const value = String(raw || '')
      .replace(/\s+/g, ' ')
      .trim()
    if (!value) continue
    const key = value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(value)
  }
  return out
}
