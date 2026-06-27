import React, { useEffect, useRef, useState } from 'react'
import { compareVoiceClips, getStoredAudioTranscriptionStatus } from '../lib/api'
import {
  compressTranscript,
  deleteMeetingAudio,
  getMeetingAudioSignedUrl,
  saveMeetingSpeakers,
  updateMeetingResults,
} from '../lib/summary'
import { supabase } from '../lib/supabase'
import { extractAudioSlice } from './SpeakerReviewScreen'

export default function PastMeetingScreen({ user, meeting, onBack, onRetryPendingAudioUploads = null }) {
  const [activeTab, setActiveTab] = useState('summary')
  const [copiedWhat, setCopiedWhat] = useState(null)
  const [audioUrl, setAudioUrl] = useState('')
  const [audioStatus, setAudioStatus] = useState('idle')
  const [audioStoragePath, setAudioStoragePath] = useState(meeting?.audio_storage_path || '')
  const [audioDeletedAt, setAudioDeletedAt] = useState(meeting?.audio_deleted_at || null)
  const [audioActionStatus, setAudioActionStatus] = useState('idle')
  const [transcriptionStatus, setTranscriptionStatus] = useState(meeting?.transcription_status || 'idle')
  const [recoveredSegments, setRecoveredSegments] = useState(null)
  const [editableBlocks, setEditableBlocks] = useState([])
  const [editingBlockKey, setEditingBlockKey] = useState(null)
  const [editingBlockText, setEditingBlockText] = useState('')
  const [localLabelMap, setLocalLabelMap] = useState({})
  const [editingSpeakerId, setEditingSpeakerId] = useState(null)
  const [editingSpeakerName, setEditingSpeakerName] = useState('')
  const [editSaveStatus, setEditSaveStatus] = useState('idle')
  const [splitReview, setSplitReview] = useState(null)
  const [splitReviewStatus, setSplitReviewStatus] = useState('idle')
  const [splitReviewError, setSplitReviewError] = useState('')
  const [selectedSplitMatches, setSelectedSplitMatches] = useState({})
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
    const segmentsForView = Array.isArray(recoveredSegments) ? recoveredSegments : meeting?.segments
    const transcriptForView = buildTranscriptFromSegments(segmentsForView) || String(meeting?.transcript_compressed || '')
    const blocks = buildEditableBlocks(segmentsForView, transcriptForView)
    setEditableBlocks(blocks)
    setEditingBlockKey(null)
    setEditingBlockText('')
    setEditingSpeakerId(null)
    setEditingSpeakerName('')
    setEditSaveStatus('idle')
  }, [
    meeting?.id,
    meeting?.segments,
    meeting?.transcript_compressed,
    recoveredSegments,
  ])

  useEffect(() => {
    setSplitReview(null)
    setSplitReviewStatus('idle')
    setSplitReviewError('')
    setSelectedSplitMatches({})
  }, [meeting?.id])

  useEffect(() => {
    setLocalLabelMap(meeting?.label_map && typeof meeting.label_map === 'object' ? meeting.label_map : {})
  }, [meeting?.id, meeting?.label_map])

  useEffect(() => {
    if (meeting?.audio_upload_status !== 'pending') return
    const retry = onRetryPendingAudioUploads?.()
    if (retry?.catch) {
      retry.catch((err) => {
        console.warn('[PastMeeting] Pending audio retry failed:', err?.message || err)
      })
    }
  }, [meeting?.id, meeting?.audio_upload_status])

  useEffect(() => {
    let cancelled = false
    setTranscriptionStatus(meeting?.transcription_status || 'idle')
    setRecoveredSegments(null)

    if (!user?.id || !meeting?.id || meeting?.transcription_status !== 'processing') {
      return () => {
        cancelled = true
      }
    }

    async function pollProcessingMeeting() {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        if (cancelled) return
        try {
          const result = await getStoredAudioTranscriptionStatus(meeting.id)
          if (cancelled) return
          setTranscriptionStatus(result.status)
          if (result.status === 'completed') {
            setRecoveredSegments(result.segments)
            return
          }
          if (result.status === 'failed') return
        } catch (err) {
          console.warn('[PastMeeting] Could not recover transcription job:', err?.message || err)
          return
        }
        await delay(2500)
      }
    }

    void pollProcessingMeeting()
    return () => {
      cancelled = true
    }
  }, [meeting?.id, meeting?.transcription_status, user?.id])

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
    const text = type === 'summary' ? effectiveSummary || '' : buildTranscriptFromBlocks(editableBlocks, localLabelMap) || effectiveTranscript || ''
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
            <span className="text-sm text-indigo-800 leading-relaxed">{renderTextWithCitations(actionText)}</span>
          </div>
        )
      }

      if (trimmed.startsWith('- ')) {
        return (
          <div key={i} className="flex items-start gap-2 py-0.5">
            <span className="text-gray-300 flex-shrink-0 mt-1.5 text-xs">*</span>
            <p className="text-sm text-gray-700 leading-relaxed">{renderTextWithCitations(trimmed.slice(2))}</p>
          </div>
        )
      }

      if (!trimmed) return <div key={i} className="h-1.5" />

      return (
        <p key={i} className="text-sm text-gray-700 leading-relaxed py-0.5">
          {renderTextWithCitations(line)}
        </p>
      )
    })
  }

  function renderTextWithCitations(text) {
    const value = String(text || '')
    const parts = []
    const regex = /\[S(\d+)\]/g
    let lastIndex = 0
    let match
    const maxCitationId = getMaxCitationIndex(editableBlocks, effectiveSegments)

    while ((match = regex.exec(value)) !== null) {
      if (match.index > lastIndex) {
        parts.push(value.slice(lastIndex, match.index))
      }

      const citationId = Number(match[1])
      const isValid = Number.isInteger(citationId) && citationId >= 1 && citationId <= maxCitationId
      const label = `[S${citationId}]`

      if (isValid) {
        parts.push(
          <button
            key={`${citationId}-${match.index}`}
            type="button"
            onClick={() => handleSummaryCitationClick(citationId)}
            className="inline text-indigo-600 hover:text-indigo-800 underline underline-offset-2"
            title={`Jump to transcript at source ${citationId}`}
          >
            {label}
          </button>,
        )
      } else {
        parts.push(
          <span key={`${citationId}-${match.index}`} className="text-gray-400">
            {label}
          </span>,
        )
      }

      lastIndex = regex.lastIndex
    }

    if (lastIndex < value.length) {
      parts.push(value.slice(lastIndex))
    }

    return parts.length > 0 ? parts : value
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

  function handleSummaryCitationClick(citationId) {
    const citationNumber = Number(citationId)
    if (!Number.isInteger(citationNumber) || citationNumber < 1) return

    const exactBlockIndex = editableBlocks.findIndex((block) => Number(block?.citationIndex) === citationNumber)
    const fallbackIndex = citationNumber - 1
    const nextLineIndex = exactBlockIndex >= 0 ? exactBlockIndex : fallbackIndex
    if (nextLineIndex < 0 || nextLineIndex >= editableBlocks.length) return

    const block = editableBlocks[nextLineIndex]
    const startTime = toNumberOrNull(block?.startTime)

    setActiveTab('transcript')
    setActiveLineIndex(nextLineIndex)
    setAutoScrollEnabled(true)

    window.setTimeout(() => {
      const node = lineRefs.current[nextLineIndex]
      if (node) {
        programmaticScrollRef.current = true
        node.scrollIntoView({ behavior: 'smooth', block: 'center' })
        window.setTimeout(() => {
          programmaticScrollRef.current = false
        }, 450)
      }

      if (startTime !== null && audioRef.current) {
        audioRef.current.currentTime = Math.max(0, startTime)
        audioRef.current.play().catch(() => {})
      }
    }, 80)
  }

  function renderAudioPlayer(blocks) {
    if (audioStatus === 'loading') {
      return (
        <div className="sticky top-0 z-20 mb-3 rounded-xl border border-gray-100 bg-gray-50 px-3 py-3 text-xs text-gray-500 shadow-sm">
          loading meeting audio...
        </div>
      )
    }

    if (audioStatus === 'error') {
      return (
        <div className="sticky top-0 z-20 mb-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700 shadow-sm">
          audio file could not be loaded. transcript is still available.
        </div>
      )
    }

    if (!audioUrl) {
      const isPendingUpload = meeting?.audio_upload_status === 'pending'
      return (
        <div className="sticky top-0 z-20 mb-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700 shadow-sm">
          {isPendingUpload
            ? 'recording upload is still pending. playback will appear after upload finishes.'
            : audioDeletedAt
              ? 'audio was deleted. transcript and summary are still available.'
              : 'audio playback is not available for this meeting.'}
        </div>
      )
    }

    return (
      <div className="sticky top-0 z-20 mb-3 rounded-xl border border-gray-100 bg-gray-50 px-3 py-3 shadow-sm">
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
            {meeting?.audio_storage_path ? (
              <p className="text-[11px] text-gray-400">
                {meeting?.audio_expires_at
                  ? `audio kept until ${formatDate(meeting.audio_expires_at)}`
                  : 'audio kept (no expiry)'}
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

  function cancelEditingBlock() {
    setEditingBlockKey(null)
    setEditingBlockText('')
  }

  function getEditingBlock() {
    if (!editingBlockKey) return null
    return editableBlocks.find((block) => block.key === editingBlockKey) || null
  }

  async function saveEditingBlock(block) {
    if (!block) return
    const nextText = String(editingBlockText || '').replace(/\s+/g, ' ').trim()
    if (!nextText) {
      setEditingBlockKey(null)
      setEditingBlockText('')
      return
    }

    const editResult = applyBlockTextEdit(editableBlocks, block, nextText)
    const nextBlocks = editResult.blocks
    setEditableBlocks(nextBlocks)
    setEditingBlockKey(null)
    setEditingBlockText('')
    await persistMeetingTranscriptEdits(nextBlocks, localLabelMap)
    if (editResult.splitReview) {
      setSplitReview(buildSplitReviewPayload(nextBlocks, editResult.splitReview))
      setSplitReviewStatus('idle')
      setSplitReviewError('')
      setSelectedSplitMatches({})
    }
  }

  function startEditingSpeaker(speakerId) {
    setEditingSpeakerId(speakerId)
    setEditingSpeakerName(getDisplaySpeakerLabel({ speaker: speakerId }, localLabelMap))
  }

  async function saveSpeakerName(speakerId) {
    const name = String(editingSpeakerName || '').replace(/\s+/g, ' ').trim()
    setEditingSpeakerId(null)
    setEditingSpeakerName('')
    if (!name) return

    const nextLabelMap = {
      ...localLabelMap,
      [speakerId]: name,
    }
    setLocalLabelMap(nextLabelMap)
    await persistMeetingTranscriptEdits(editableBlocks, nextLabelMap)
  }

  async function persistMeetingTranscriptEdits(blocks, labelMap) {
    if (!meeting?.id || !user?.id) return

    const segments = blocksToSegments(blocks)
    const transcript = compressTranscript(segments, labelMap)
    setEditSaveStatus('saving')
    try {
      await updateMeetingResults(supabase, meeting.id, {
        userId: user.id,
        transcript,
        summary: effectiveSummary,
        segments,
        labelMap,
      })
      await saveMeetingSpeakers(supabase, {
        userId: user.id,
        meetingId: meeting.id,
        segments,
        labelMap,
        confirmedByUser: true,
      }).catch((err) => {
        console.warn('[PastMeeting] Could not update speaker mappings:', err?.message || err)
      })
      setRecoveredSegments(segments)
      setEditSaveStatus('saved')
      window.setTimeout(() => setEditSaveStatus('idle'), 1400)
    } catch (err) {
      console.warn('[PastMeeting] Could not save transcript edits:', err?.message || err)
      setEditSaveStatus('error')
    }
  }

  async function runSplitReviewSearch() {
    if (!splitReview) return

    const candidates = Array.isArray(splitReview.candidates) ? splitReview.candidates.slice(0, 8) : []
    if (!audioUrl || !splitReview.reference || candidates.length === 0) {
      setSplitReviewError('audio is not available for voice matching. you can still rename/apply manually.')
      setSplitReviewStatus('failed')
      return
    }

    setSplitReviewStatus('running')
    setSplitReviewError('')
    try {
      const audioBlob = await fetchAudioBlob(audioUrl)
      const referenceBlob = await extractClipForBlock(audioBlob, splitReview.reference)
      if (!referenceBlob) {
        throw new Error('Could not prepare the corrected voice sample.')
      }

      const candidateClips = []
      for (const candidate of candidates) {
        const blob = await extractClipForBlock(audioBlob, candidate)
        if (!blob) continue
        candidateClips.push({
          id: candidate.key,
          blob,
        })
      }

      const scores = await compareVoiceClips(referenceBlob, candidateClips)
      const scoreById = new Map(scores.map((item) => [String(item.candidate_id), Number(item.confidence || 0)]))
      const reviewedCandidates = candidates
        .map((candidate) => ({
          ...candidate,
          confidence: scoreById.get(String(candidate.key)) ?? null,
        }))
        .filter((candidate) => candidate.confidence === null || candidate.confidence >= 0.62)
        .sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0))

      setSplitReview((prev) => ({
        ...prev,
        candidates: reviewedCandidates.length > 0 ? reviewedCandidates : candidates,
        searched: true,
      }))
      setSelectedSplitMatches(
        Object.fromEntries(
          reviewedCandidates
            .filter((candidate) => Number(candidate.confidence || 0) >= 0.72)
            .map((candidate) => [candidate.key, true]),
        ),
      )
      setSplitReviewStatus('review')
    } catch (err) {
      console.warn('[PastMeeting] Could not find similar speaker moments:', err?.message || err)
      setSplitReviewError('could not compare voice clips. you can still select matching lines manually.')
      setSplitReviewStatus('failed')
    }
  }

  async function applySplitReviewMatches() {
    if (!splitReview) return
    const selectedKeys = new Set(
      Object.entries(selectedSplitMatches)
        .filter(([, selected]) => Boolean(selected))
        .map(([key]) => key),
    )
    if (selectedKeys.size === 0) {
      setSplitReview(null)
      return
    }

    const nextBlocks = editableBlocks.map((block) => {
      if (!selectedKeys.has(block.key)) return block
      return {
        ...block,
        speaker: splitReview.newSpeaker,
        edited: true,
        uncertain: true,
        reviewMeta: {
          ...(block.reviewMeta || {}),
          speakerReview: 'user_confirmed_similar_split_speaker',
          matchedFromSplitSpeaker: splitReview.newSpeaker,
          matchedAt: new Date().toISOString(),
        },
      }
    })
    setEditableBlocks(nextBlocks)
    await persistMeetingTranscriptEdits(nextBlocks, localLabelMap)
    setSplitReview(null)
    setSelectedSplitMatches({})
    setSplitReviewStatus('idle')
  }

  function toggleSplitReviewMatch(key) {
    setSelectedSplitMatches((prev) => ({
      ...prev,
      [key]: !prev[key],
    }))
  }

  const effectiveSegments = Array.isArray(recoveredSegments) ? recoveredSegments : meeting?.segments
  const effectiveSummary = String(meeting?.summary || '')
  const effectiveTranscript = buildTranscriptFromSegments(effectiveSegments) || String(meeting?.transcript_compressed || '')

  return (
    <div className="min-h-screen bg-white flex flex-col max-w-2xl mx-auto px-5 md:px-10">
      <div className="flex items-center justify-between h-14 flex-shrink-0">
        <div className="w-8 flex-shrink-0" aria-hidden="true" />

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

      {transcriptionStatus === 'processing' ? (
        <div className="mb-3 rounded-xl border border-indigo-100 bg-indigo-50 px-3 py-2 text-xs text-indigo-700">
          transcript is still processing. this page will update automatically.
        </div>
      ) : null}

      {transcriptionStatus === 'failed' ? (
        <div className="mb-3 rounded-xl border border-amber-100 bg-amber-50 px-3 py-2 text-xs text-amber-700">
          transcription could not finish for this meeting.
        </div>
      ) : null}

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
                          getDisplaySpeakerLabel(block, localLabelMap),
                        )}`}
                      >
                        {getDisplaySpeakerLabel(block, localLabelMap).toLowerCase()}
                      </span>
                      <div className="flex-1">
                        {editingSpeakerId === block.speaker ? (
                          <div className="mb-2 flex flex-col gap-2 sm:flex-row">
                            <input
                              value={editingSpeakerName}
                              onChange={(event) => setEditingSpeakerName(event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key === 'Escape') {
                                  setEditingSpeakerId(null)
                                  setEditingSpeakerName('')
                                  return
                                }
                                if (event.key === 'Enter') {
                                  event.preventDefault()
                                  void saveSpeakerName(block.speaker)
                                }
                              }}
                              autoFocus
                              maxLength={32}
                              className="h-9 flex-1 rounded-lg border border-indigo-200 bg-white px-2.5 text-sm text-gray-800 focus:outline-none focus:border-indigo-400"
                              placeholder="speaker name"
                            />
                            <button
                              type="button"
                              onClick={() => void saveSpeakerName(block.speaker)}
                              className="h-9 rounded-lg bg-gray-900 px-4 text-sm font-medium text-white"
                            >
                              save name
                            </button>
                          </div>
                        ) : null}
                        <p className="text-sm text-gray-800 leading-relaxed">{block.text}</p>
                        <div className="mt-1 flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            onClick={() => startEditingBlock(block)}
                            className="text-[11px] text-indigo-600 underline"
                          >
                            edit
                          </button>
                          <button
                            type="button"
                            onClick={() => startEditingSpeaker(block.speaker)}
                            className="text-[11px] text-indigo-600 underline"
                          >
                            rename speaker
                          </button>
                          {block.edited ? <span className="text-[11px] text-amber-700">edited</span> : null}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )
            }
            return null
          })()}
      </div>

      {splitReview ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/20 px-4 py-6 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl bg-white p-4 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-base font-semibold text-gray-900">Find similar speaker moments?</p>
                <p className="mt-1 text-sm text-gray-500">
                  You created {getDisplaySpeakerLabel({ speaker: splitReview.newSpeaker }, localLabelMap).toLowerCase()}.
                  Notemint can check other lines that may be the same person.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSplitReview(null)}
                className="rounded-full px-2 py-1 text-sm text-gray-400 hover:bg-gray-100"
                aria-label="Close speaker review"
              >
                x
              </button>
            </div>

            {splitReviewStatus === 'idle' ? (
              <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                <button
                  type="button"
                  onClick={() => void runSplitReviewSearch()}
                  className="h-11 flex-1 rounded-xl bg-indigo-600 text-sm font-medium text-white hover:bg-indigo-700"
                >
                  find similar moments
                </button>
                <button
                  type="button"
                  onClick={() => setSplitReview(null)}
                  className="h-11 flex-1 rounded-xl border border-gray-200 text-sm font-medium text-gray-600 hover:bg-gray-50"
                >
                  skip
                </button>
              </div>
            ) : null}

            {splitReviewStatus === 'running' ? (
              <div className="mt-4 flex items-center gap-3 rounded-xl bg-indigo-50 px-3 py-3">
                <span className="h-5 w-5 animate-spin rounded-full border-2 border-indigo-200 border-t-indigo-600" />
                <p className="text-sm text-indigo-700">checking similar voice moments...</p>
              </div>
            ) : null}

            {splitReviewError ? (
              <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-700">{splitReviewError}</p>
            ) : null}

            {(splitReviewStatus === 'review' || splitReviewStatus === 'failed') ? (
              <div className="mt-4">
                <p className="text-xs font-medium uppercase tracking-wide text-gray-400">possible matches</p>
                <div className="mt-2 max-h-72 overflow-y-auto rounded-xl border border-gray-100">
                  {splitReview.candidates.length > 0 ? (
                    splitReview.candidates.slice(0, 8).map((candidate) => (
                      <label
                        key={candidate.key}
                        className="flex cursor-pointer items-start gap-3 border-b border-gray-50 px-3 py-2.5 last:border-0"
                      >
                        <input
                          type="checkbox"
                          checked={Boolean(selectedSplitMatches[candidate.key])}
                          onChange={() => toggleSplitReviewMatch(candidate.key)}
                          className="mt-1 h-4 w-4 rounded border-gray-300 text-indigo-600"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block text-xs text-gray-400">
                            {candidate.timeLabel || 'no timestamp'}
                            {Number.isFinite(candidate.confidence)
                              ? ` · ${Math.round(candidate.confidence * 100)}% voice match`
                              : ''}
                          </span>
                          <span className="mt-0.5 block line-clamp-2 text-sm text-gray-700">{candidate.text}</span>
                        </span>
                      </label>
                    ))
                  ) : (
                    <p className="px-3 py-4 text-sm text-gray-400">No similar lines found.</p>
                  )}
                </div>
                <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                  <button
                    type="button"
                    onClick={() => void applySplitReviewMatches()}
                    className="h-11 flex-1 rounded-xl bg-gray-900 text-sm font-medium text-white"
                  >
                    apply selected
                  </button>
                  <button
                    type="button"
                    onClick={() => setSplitReview(null)}
                    className="h-11 flex-1 rounded-xl border border-gray-200 text-sm font-medium text-gray-600 hover:bg-gray-50"
                  >
                    skip
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {getEditingBlock() ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 px-4 py-6 backdrop-blur-sm">
          <div className="w-full max-w-lg rounded-2xl bg-white p-4 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-base font-semibold text-gray-900">Edit transcript text</p>
                <p className="mt-1 text-xs text-gray-400">
                  {getDisplaySpeakerLabel(getEditingBlock(), localLabelMap).toLowerCase()}
                  {getEditingBlock()?.timeLabel ? ` · ${getEditingBlock().timeLabel}` : ''}
                </p>
              </div>
              <button
                type="button"
                onClick={cancelEditingBlock}
                className="rounded-full px-2 py-1 text-sm text-gray-400 hover:bg-gray-100"
                aria-label="Close transcript editor"
              >
                x
              </button>
            </div>

            <textarea
              value={editingBlockText}
              onChange={(event) => setEditingBlockText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault()
                  cancelEditingBlock()
                  return
                }
                if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault()
                  void saveEditingBlock(getEditingBlock())
                }
              }}
              autoFocus
              rows={6}
              className="mt-4 w-full rounded-xl border border-indigo-100 bg-gray-50 px-3 py-3 text-sm leading-relaxed text-gray-900 focus:border-indigo-400 focus:bg-white focus:outline-none"
            />

            <p className="mt-2 text-xs text-gray-500">
              Use <span className="font-semibold text-gray-700">/</span> to split merged speakers. Example: first speaker text / second speaker text.
            </p>
            <p className="mt-1 text-[11px] text-gray-400">Ctrl+Enter saves on desktop. On phone, use the save button.</p>

            <div className="mt-4 flex flex-col gap-2 sm:flex-row">
              <button
                type="button"
                onClick={() => void saveEditingBlock(getEditingBlock())}
                disabled={editSaveStatus === 'saving'}
                className="h-11 flex-1 rounded-xl bg-indigo-600 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                {editSaveStatus === 'saving' ? 'saving...' : 'save'}
              </button>
              <button
                type="button"
                onClick={cancelEditingBlock}
                className="h-11 flex-1 rounded-xl border border-gray-200 text-sm font-medium text-gray-600 hover:bg-gray-50"
              >
                cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="flex flex-col gap-2 pt-4 flex-shrink-0" style={{ paddingBottom: 'max(24px, env(safe-area-inset-bottom))' }}>
        {editSaveStatus !== 'idle' ? (
          <p
            className={`text-center text-xs ${
              editSaveStatus === 'error' ? 'text-red-500' : editSaveStatus === 'saving' ? 'text-gray-400' : 'text-emerald-600'
            }`}
          >
            {editSaveStatus === 'saving' ? 'saving transcript edits...' : editSaveStatus === 'saved' ? 'transcript edits saved' : 'could not save edits'}
          </p>
        ) : null}
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

      </div>
    </div>
  )
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

function getMaxCitationIndex(blocks, fallbackSegments) {
  const fromBlocks = (Array.isArray(blocks) ? blocks : [])
    .map((block) => Number(block?.citationIndex))
    .filter(Number.isFinite)
  if (fromBlocks.length > 0) return Math.max(...fromBlocks)
  return Array.isArray(fallbackSegments) ? fallbackSegments.length : 0
}

function getDisplaySpeakerLabel(block, labelMap) {
  const speakerId = block?.speaker
  const savedLabel = labelMap?.[speakerId]
  if (savedLabel) return String(savedLabel)

  const numericSpeaker = Number(speakerId)
  if (Number.isFinite(numericSpeaker)) return `Person ${numericSpeaker + 1}`

  if (block?.label) return String(block.label)
  return 'Person 1'
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
  const sourceSegments = Array.isArray(segments) ? segments : []
  if (sourceSegments.length > 0) {
    return sourceSegments
      .map((segment, index) => ({
      key: `seg_${index}_${segment.startTime ?? 'na'}`,
      segmentIndex: index,
      citationIndex: Number.isFinite(Number(segment.citationIndex)) ? Number(segment.citationIndex) : index + 1,
      speaker: segment.speaker,
      label: Number.isFinite(Number(segment.speaker)) ? `Person ${Number(segment.speaker) + 1}` : String(segment.label || 'person 1'),
      text: String(segment.text || ''),
      timeLabel: formatBlockTime(segment.startTime),
      startTime: toNumberOrNull(segment.startTime),
      endTime: toNumberOrNull(segment.endTime),
      source: segment.source || null,
      confidence: segment.confidence ?? null,
      speakerConfidence: segment.speakerConfidence ?? null,
      wordConfidence: segment.wordConfidence ?? null,
      uncertain: Boolean(segment.uncertain),
      reviewMeta: segment.reviewMeta || null,
      edited: false,
    }))
      .filter((block) => block.text.trim().length > 0)
  }

  const parsed = parseTranscriptLines(transcript)
  return parsed.map((block, index) => ({
    key: `line_${index}`,
    segmentIndex: index,
    citationIndex: index + 1,
    speaker: index % 4,
    label: block.label,
    text: block.text,
    timeLabel: null,
    startTime: null,
    endTime: null,
    edited: false,
  }))
}

function formatBlockTime(seconds) {
  const value = toNumberOrNull(seconds)
  if (value === null) return null
  const total = Math.floor(value)
  const minutes = Math.floor(total / 60)
  const secs = total % 60
  return `${minutes}:${String(secs).padStart(2, '0')}`
}

function applyBlockTextEdit(blocks, targetBlock, nextText) {
  const list = Array.isArray(blocks) ? blocks : []
  const slashParts = splitMergedSpeakerText(nextText)
  if (slashParts.length < 2) {
    return {
      blocks: list.map((item) => (item.key === targetBlock.key ? { ...item, text: nextText, edited: true } : item)),
      splitReview: null,
    }
  }

  const targetIndex = list.findIndex((item) => item.key === targetBlock.key)
  if (targetIndex < 0) return { blocks: list, splitReview: null }

  const nextSpeaker = getNextSpeakerIdFromBlocks(list)
  const splitGroupId = `split_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const replacement = createSplitBlocks(targetBlock, slashParts, nextSpeaker, splitGroupId)
  return {
    blocks: [...list.slice(0, targetIndex), ...replacement, ...list.slice(targetIndex + 1)],
    splitReview: {
      originalSpeaker: targetBlock.speaker,
      newSpeaker: nextSpeaker,
      referenceKey: replacement[1]?.key || replacement[0]?.key || null,
      splitGroupId,
    },
  }
}

function splitMergedSpeakerText(text) {
  return String(text || '')
    .split('/')
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

function createSplitBlocks(block, parts, nextSpeaker, splitGroupId) {
  const start = toNumberOrNull(block?.startTime)
  const end = toNumberOrNull(block?.endTime)
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0) || parts.length
  let elapsedRatio = 0
  const splitAt = new Date().toISOString()

  return parts.map((part, index) => {
    const ratio = part.length / totalLength
    const partStart = start !== null && end !== null ? start + (end - start) * elapsedRatio : start
    elapsedRatio += ratio
    const partEnd = start !== null && end !== null ? start + (end - start) * elapsedRatio : end
    const speaker = index === 0 ? block.speaker : nextSpeaker + index - 1

    return {
      ...block,
      key: `${block.key}_split_${index}_${splitGroupId}`,
      citationIndex: block.citationIndex,
      speaker,
      label: Number.isFinite(Number(speaker)) ? `Person ${Number(speaker) + 1}` : block.label,
      text: part,
      startTime: toNumberOrNull(partStart),
      endTime: toNumberOrNull(partEnd),
      edited: true,
      uncertain: index === 0 ? block.uncertain : true,
      reviewMeta: {
        ...(block.reviewMeta || {}),
        speakerReview: index === 0 ? 'split_original' : 'user_split_new_speaker',
        splitGroupId,
        splitFromSpeaker: block.speaker,
        splitAt,
      },
    }
  })
}

function buildSplitReviewPayload(blocks, splitReview) {
  if (!splitReview) return null
  const list = Array.isArray(blocks) ? blocks : []
  const reference = list.find((block) => block.key === splitReview.referenceKey)
  if (!reference) return null

  const candidates = list
    .filter((block) => {
      if (!block || block.key === reference.key) return false
      if (block.reviewMeta?.splitGroupId === splitReview.splitGroupId) return false
      if (Number(block.speaker) !== Number(splitReview.originalSpeaker)) return false
      if (toNumberOrNull(block.startTime) === null || toNumberOrNull(block.endTime) === null) return false
      return String(block.text || '').trim().length > 0
    })
    .sort((a, b) => {
      const aDistance = Math.abs(Number(a.startTime || 0) - Number(reference.startTime || 0))
      const bDistance = Math.abs(Number(b.startTime || 0) - Number(reference.startTime || 0))
      return aDistance - bDistance
    })
    .slice(0, 8)

  return {
    ...splitReview,
    reference,
    candidates,
    searched: false,
  }
}

async function fetchAudioBlob(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error('Could not load meeting audio')
  return response.blob()
}

async function extractClipForBlock(audioBlob, block) {
  const start = toNumberOrNull(block?.startTime)
  const end = toNumberOrNull(block?.endTime)
  if (start === null) return null
  const safeEnd = end === null ? start + 6 : Math.min(end, start + 8)
  if (safeEnd <= start + 0.5) return null
  return extractAudioSlice(audioBlob, Math.max(0, start), safeEnd)
}

function getNextSpeakerIdFromBlocks(blocks) {
  const speakers = (Array.isArray(blocks) ? blocks : [])
    .map((block) => Number(block?.speaker))
    .filter(Number.isFinite)
  if (speakers.length === 0) return 0
  return Math.max(...speakers) + 1
}

function blocksToSegments(blocks) {
  return (Array.isArray(blocks) ? blocks : [])
    .map((block) => ({
      speaker: Number.isFinite(Number(block?.speaker)) ? Number(block.speaker) : 0,
      citationIndex: Number.isFinite(Number(block?.citationIndex)) ? Number(block.citationIndex) : null,
      text: String(block?.text || '').replace(/\s+/g, ' ').trim(),
      startTime: toNumberOrNull(block?.startTime),
      endTime: toNumberOrNull(block?.endTime),
      confidence: block?.confidence ?? null,
      source: block?.source || 'user_edited',
      isFinal: true,
      speakerConfidence: block?.speakerConfidence ?? null,
      wordConfidence: block?.wordConfidence ?? null,
      uncertain: Boolean(block?.uncertain),
      reviewMeta: block?.reviewMeta || null,
    }))
    .filter((segment) => segment.text.length > 0)
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

function buildTranscriptFromBlocks(blocks, labelMap = {}) {
  const list = Array.isArray(blocks) ? blocks : []
  const lines = []
  for (const block of list) {
    const label = getDisplaySpeakerLabel(block, labelMap)
    const text = String(block?.text || '').replace(/\s+/g, ' ').trim()
    if (!text) continue
    lines.push(`[${label}]: ${text}`)
  }
  return lines.join('\n')
}

function delay(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms)
  })
}
