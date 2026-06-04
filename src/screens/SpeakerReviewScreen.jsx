import React, { useEffect, useMemo, useRef, useState } from 'react'
import { getVoiceStatus, identifySpeakersBatch, rememberContactVoice } from '../lib/api'
import { getSpeakerNameSuggestions } from '../lib/speakerMemory'

export default function SpeakerReviewScreen({ segments, audioBlob, user, onConfirmed, onSkip }) {
  const [speakerNames, setSpeakerNames] = useState({})
  const [editingSpeaker, setEditingSpeaker] = useState(null)
  const [inputValue, setInputValue] = useState('')
  const [snippets, setSnippets] = useState({})
  const [playingSpeaker, setPlayingSpeaker] = useState(null)
  const [identifyingStatus, setIdentifyingStatus] = useState('idle')
  const [autoLabelMeta, setAutoLabelMeta] = useState({})
  const [reviewStateMap, setReviewStateMap] = useState({})
  const [nameSuggestions, setNameSuggestions] = useState([])

  const audioRefs = useRef({})
  const snippetUrlsRef = useRef([])
  const autoConfirmedRef = useRef(false)

  const allSpeakers = useMemo(() => {
    if (!Array.isArray(segments)) return []
    return [...new Set(segments.map((s) => Number(s.speaker)).filter((n) => !Number.isNaN(n)))].sort((a, b) => a - b)
  }, [segments])

  const selfAssignedSpeaker = useMemo(() => {
    const row = Object.entries(speakerNames).find(([, value]) => value === 'You')
    return row ? String(row[0]) : null
  }, [speakerNames])

  const initial = (user?.email?.[0] || '?').toUpperCase()

  useEffect(() => {
    let cancelled = false

    async function loadSuggestions() {
      if (!user?.id) {
        setNameSuggestions([])
        return
      }

      try {
        const suggestions = await getSpeakerNameSuggestions(user.id, 8)
        if (!cancelled) setNameSuggestions(suggestions)
      } catch (err) {
        if (!cancelled) {
          setNameSuggestions([])
          console.warn('[SpeakerReview] Could not load saved names:', err?.message || err)
        }
      }
    }

    loadSuggestions()
    return () => {
      cancelled = true
    }
  }, [user?.id])

  useEffect(() => {
    let cancelled = false

    async function prepareSnippetsAndIdentify() {
      if (!audioBlob || allSpeakers.length === 0) return

      setIdentifyingStatus('identifying')
      clearSnippetUrls()

      const snippetMap = {}
      for (const speakerId of allSpeakers) {
        const bestSegment = findBestSegmentForSpeaker(segments, speakerId)
        if (!bestSegment) continue

        try {
          const wavSnippet = await extractAudioSlice(
            audioBlob,
            bestSegment.startTime || 0,
            Math.min((bestSegment.endTime || 0), (bestSegment.startTime || 0) + 8),
          )

          if (!wavSnippet) continue
          const url = URL.createObjectURL(wavSnippet)
          snippetUrlsRef.current.push(url)
          snippetMap[speakerId] = {
            blob: wavSnippet,
            url,
            text: bestSegment.text || '',
            startTime: bestSegment.startTime || 0,
            endTime: bestSegment.endTime || 0,
          }
        } catch (err) {
          console.warn('[SpeakerReview] Could not extract snippet:', err)
        }
      }

      if (cancelled) return
      setSnippets(snippetMap)

      try {
        const status = await getVoiceStatus()
        if (cancelled) return

        const nextAutoLabels = {}
        const nextAutoMeta = {}
        const nextReviewState = {}
        const speakerStatsMap = {}
        const hasManySpeakers = allSpeakers.length >= 4
        const selfThreshold = hasManySpeakers ? 0.86 : 0.78
        const contactThreshold = hasManySpeakers ? 0.88 : 0.8

        for (const speakerId of allSpeakers) {
          const stats = getSpeakerStats(segments, speakerId)
          speakerStatsMap[speakerId] = stats
          nextReviewState[speakerId] = 'needs review'

          if (!snippetMap[speakerId]?.blob) {
            nextReviewState[speakerId] = 'low confidence'
            nextAutoMeta[speakerId] = {
              source: 'none',
              confidence: null,
              reason: 'no_clean_audio',
            }
            continue
          }

          if (isTinySpeaker(stats)) {
            nextReviewState[speakerId] = 'low confidence'
            nextAutoMeta[speakerId] = {
              source: 'none',
              confidence: null,
              reason: 'tiny_turn',
            }
          }
        }

        const batchMatches = await identifySpeakersBatch(snippetMap)
        if (cancelled) return

        if (status?.enrolled) {
          const selfMatches = []
          for (const speakerId of allSpeakers) {
            const snippet = snippetMap[speakerId]
            if (!snippet?.blob) continue
            if (isTinySpeaker(speakerStatsMap[speakerId])) continue

            const result = batchMatches?.[speakerId]?.self

            if (result?.identified_profile === 'self' && result?.is_confident) {
              const confidence = Number(result.confidence || 0)
              selfMatches.push({ speakerId, confidence })
            }
          }

          const strongSelfMatches = selfMatches
            .filter((match) => match.confidence >= selfThreshold)
            .sort((a, b) => b.confidence - a.confidence)

          if (strongSelfMatches.length > 0) {
            const top = strongSelfMatches[0]
            const second = strongSelfMatches[1]
            const clearWinner = !second || top.confidence - second.confidence >= 0.08

            if (clearWinner) {
              nextAutoLabels[top.speakerId] = 'You'
              nextReviewState[top.speakerId] = 'auto-detected'
              nextAutoMeta[top.speakerId] = {
                source: 'self',
                confidence: top.confidence,
              }
            } else {
              nextReviewState[top.speakerId] = 'needs review'
              nextAutoMeta[top.speakerId] = {
                source: 'self',
                confidence: top.confidence,
                reason: 'self_conflict',
              }
              nextReviewState[second.speakerId] = 'needs review'
              nextAutoMeta[second.speakerId] = {
                source: 'self',
                confidence: second.confidence,
                reason: 'self_conflict',
              }
            }
          } else {
            for (const match of selfMatches) {
              if (nextReviewState[match.speakerId] === 'low confidence') continue
              nextReviewState[match.speakerId] = 'low confidence'
              nextAutoMeta[match.speakerId] = {
                source: 'self',
                confidence: match.confidence,
                reason: 'below_self_threshold',
              }
            }
          }
        }

        const contactMatches = []
        for (const speakerId of allSpeakers) {
          const snippet = snippetMap[speakerId]
          if (!snippet?.blob) continue
          if (isTinySpeaker(speakerStatsMap[speakerId])) continue

          const result = batchMatches?.[speakerId]?.contact
          if (!result?.display_name) continue

          const confidence = Number(result.confidence || 0)
          const isConfident = Boolean(result?.is_confident) && confidence >= contactThreshold
          contactMatches.push({
            speakerId,
            displayName: String(result.display_name).trim(),
            confidence,
            isConfident,
          })
        }

        const usedContactNames = new Map()
        for (const match of contactMatches) {
          if (!match.displayName || match.displayName.toLowerCase() === 'you') continue

          const hasSelfLabel = nextAutoLabels[match.speakerId] === 'You'
          if (hasSelfLabel && match.isConfident) {
            nextReviewState[match.speakerId] = 'needs review'
            delete nextAutoLabels[match.speakerId]
            nextAutoMeta[match.speakerId] = {
              source: 'self',
              confidence: match.confidence,
              reason: 'self_contact_conflict',
            }
            continue
          }

          if (!match.isConfident) {
            if (nextReviewState[match.speakerId] !== 'low confidence') {
              nextReviewState[match.speakerId] = 'low confidence'
              nextAutoMeta[match.speakerId] = {
                source: 'contact',
                confidence: match.confidence,
                reason: 'below_contact_threshold',
              }
            }
            continue
          }

          const key = match.displayName.toLowerCase()
          const existingSpeaker = usedContactNames.get(key)
          if (typeof existingSpeaker !== 'undefined' && existingSpeaker !== match.speakerId) {
            nextReviewState[existingSpeaker] = 'needs review'
            nextReviewState[match.speakerId] = 'needs review'
            delete nextAutoLabels[existingSpeaker]
            delete nextAutoLabels[match.speakerId]
            nextAutoMeta[existingSpeaker] = {
              source: 'contact',
              confidence: match.confidence,
              reason: 'duplicate_contact_match',
            }
            nextAutoMeta[match.speakerId] = {
              source: 'contact',
              confidence: match.confidence,
              reason: 'duplicate_contact_match',
            }
            continue
          }

          usedContactNames.set(key, match.speakerId)
          if (!nextAutoLabels[match.speakerId]) {
            nextAutoLabels[match.speakerId] = match.displayName
            nextReviewState[match.speakerId] = 'auto-detected'
            nextAutoMeta[match.speakerId] = {
              source: 'contact',
              confidence: match.confidence,
            }
          }
        }

        for (const speakerId of allSpeakers) {
          if (nextReviewState[speakerId] !== 'auto-detected' && nextReviewState[speakerId] !== 'low confidence') {
            nextReviewState[speakerId] = 'needs review'
          }
        }

        setAutoLabelMeta(nextAutoMeta)
        setReviewStateMap(nextReviewState)
        setSpeakerNames((prev) => {
          const next = { ...prev }
          for (const [speakerId, name] of Object.entries(nextAutoLabels)) {
            if (!next[speakerId]) next[speakerId] = name
          }
          return next
        })

        const autoLabelCount = Object.keys(nextAutoLabels).length
        const allAutoDetected =
          allSpeakers.length > 0 &&
          allSpeakers.every((speakerId) => nextReviewState[speakerId] === 'auto-detected' && nextAutoLabels[speakerId])
        const hasConfidentSelf = Object.values(nextAutoLabels).some((label) => label === 'You')
        if (!cancelled && !autoConfirmedRef.current && hasConfidentSelf && (allSpeakers.length === 1 || allAutoDetected || autoLabelCount === allSpeakers.length)) {
          autoConfirmedRef.current = true
          onConfirmed(buildLabelMapFromAutoLabels(allSpeakers, nextAutoLabels))
          return
        }
      } catch (err) {
        console.warn('[SpeakerReview] Voice status/identify skipped:', err)
        setReviewStateMap((prev) => {
          const next = { ...prev }
          for (const speakerId of allSpeakers) {
            if (!next[speakerId]) next[speakerId] = 'needs review'
          }
          return next
        })
      } finally {
        if (!cancelled) setIdentifyingStatus('done')
      }
    }

    prepareSnippetsAndIdentify()

    return () => {
      cancelled = true
      clearSnippetUrls()
      Object.values(audioRefs.current).forEach((audio) => {
        try {
          audio.pause()
        } catch {}
      })
    }
  }, [allSpeakers, audioBlob, segments])

  function clearSnippetUrls() {
    for (const url of snippetUrlsRef.current) {
      try {
        URL.revokeObjectURL(url)
      } catch {}
    }
    snippetUrlsRef.current = []
  }

  function toggleSnippet(sp) {
    const currentAudio = audioRefs.current[sp]
    if (!currentAudio) return

    if (playingSpeaker === sp) {
      currentAudio.pause()
      currentAudio.currentTime = 0
      setPlayingSpeaker(null)
      return
    }

    if (playingSpeaker !== null) {
      const prevAudio = audioRefs.current[playingSpeaker]
      if (prevAudio) {
        prevAudio.pause()
        prevAudio.currentTime = 0
      }
    }

    currentAudio.play().catch(() => {})
    setPlayingSpeaker(sp)
  }

  function saveName(sp) {
    const name = inputValue.trim()
    if (name) {
      setSpeakerNames((prev) => ({
        ...prev,
        [sp]: name,
      }))
    }
    setEditingSpeaker(null)
    setInputValue('')
  }

  function handleConfirm() {
    const labelMap = {}
    let personIndex = 1

    for (const speakerId of allSpeakers) {
      if (speakerNames[speakerId]) {
        labelMap[speakerId] = speakerNames[speakerId]
      } else {
        labelMap[speakerId] = `Person ${personIndex}`
        personIndex += 1
      }
    }

    const rememberTasks = allSpeakers
      .map((speakerId) => {
        const label = labelMap[speakerId]
        const snippetBlob = snippets[speakerId]?.blob
        if (!snippetBlob || !shouldRememberContactName(label)) return null
        return rememberContactVoice(snippetBlob, label)
      })
      .filter(Boolean)

    if (rememberTasks.length > 0) {
      void Promise.allSettled(rememberTasks).then((results) => {
        const failed = results.filter((result) => result.status === 'rejected').length
        if (failed > 0) {
          console.warn(`[SpeakerReview] ${failed} contact voice sample(s) failed to save`)
        }
      })
    }

    onConfirmed(labelMap)
  }

  if (allSpeakers.length === 1) {
    const onlySpeaker = allSpeakers[0]
    const singleName = speakerNames[onlySpeaker]
    const singleMeta = autoLabelMeta[onlySpeaker]
    const singleReviewState = reviewStateMap[onlySpeaker]

    if (identifyingStatus === 'identifying') {
      return (
        <div className="min-h-screen bg-white flex flex-col max-w-md mx-auto px-5">
          <div className="flex items-center justify-between h-14">
            <span className="text-sm font-medium text-gray-900">notemint</span>
            <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center">
              <span className="text-sm font-medium text-indigo-600">{initial}</span>
            </div>
          </div>
          <div className="flex flex-1 items-center justify-center">
            <p className="text-sm text-indigo-400">matching your voice...</p>
          </div>
        </div>
      )
    }

    return (
      <div className="min-h-screen bg-white flex flex-col max-w-md mx-auto px-5">
        <div className="flex items-center justify-between h-14">
          <span className="text-sm font-medium text-gray-900">notemint</span>
          <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center">
            <span className="text-sm font-medium text-indigo-600">{initial}</span>
          </div>
        </div>

        <p className="text-xl font-semibold text-gray-900 mt-6 mb-1">one speaker detected</p>
        <p className="text-sm text-gray-400 mb-6">
          {singleReviewState === 'low confidence' && singleMeta?.source === 'self'
            ? 'possible match to your voice - confirm before saving.'
            : singleName === 'You'
              ? 'your voice was detected.'
              : 'is this recording your voice?'}
        </p>

        <div className="flex gap-3">
          <button
            onClick={() => onConfirmed({ [onlySpeaker]: 'You' })}
            className="flex-1 h-11 bg-indigo-600 text-white rounded-xl text-sm font-medium"
          >
            yes, that's me
          </button>
          <button
            onClick={onSkip}
            className="flex-1 h-11 border border-gray-200 text-gray-600 rounded-xl text-sm"
          >
            skip
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-white flex flex-col max-w-md mx-auto px-5">
      <div className="flex items-center justify-between h-14">
        <span className="text-sm font-medium text-gray-900">notemint</span>
        {identifyingStatus === 'identifying' ? (
          <span className="text-xs text-indigo-400">matching voices...</span>
        ) : (
          <span className="text-xs text-gray-300">review speakers</span>
        )}
        <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center">
          <span className="text-sm font-medium text-indigo-600">{initial}</span>
        </div>
      </div>

      <p className="text-xl font-semibold text-gray-900 mt-4 mb-1">{allSpeakers.length} speakers found</p>
      <p className="text-sm text-gray-400 mb-5">listen and identify each speaker</p>

      <div className="flex flex-col gap-3 flex-1">
        {allSpeakers.map((sp, idx) => {
          const name = speakerNames[sp]
          const snippet = snippets[sp]
          const isPlaying = playingSpeaker === sp
          const autoInfo = autoLabelMeta[sp]
          const anotherSpeakerIsYou = selfAssignedSpeaker !== null && selfAssignedSpeaker !== String(sp)
          const suggestionNames = nameSuggestions.filter((candidate) => {
            const normalized = String(candidate || '').trim().toLowerCase()
            if (!normalized || normalized === 'you') return false
            return !Object.entries(speakerNames).some(([speakerKey, speakerName]) => {
              if (String(speakerKey) === String(sp)) return false
              return String(speakerName || '').trim().toLowerCase() === normalized
            })
          })
          const reviewState = reviewStateMap[sp] || 'needs review'
          const reviewPillClass =
            reviewState === 'auto-detected'
              ? 'bg-emerald-100 text-emerald-700'
              : reviewState === 'low confidence'
                ? 'bg-amber-100 text-amber-700'
                : 'bg-gray-100 text-gray-600'

          return (
            <div key={sp} className="border border-gray-100 rounded-2xl p-4">
              <div className="flex items-center justify-between mb-2.5">
                <div className="flex items-center gap-2">
                  <span
                    className={`text-xs font-medium px-2.5 py-1 rounded-full ${
                      name === 'You' ? 'bg-indigo-100 text-indigo-700' : 'bg-gray-100 text-gray-600'
                    }`}
                  >
                    {name || `Speaker ${idx + 1}`}
                  </span>
                  {typeof autoInfo?.confidence === 'number' ? (
                    <span className="text-xs text-indigo-400">
                      {autoInfo.source === 'self' ? 'auto self' : 'auto match'} {autoInfo.confidence.toFixed(2)}
                    </span>
                  ) : null}
                  <span className={`text-[11px] px-2 py-0.5 rounded-full ${reviewPillClass}`}>
                    {reviewState}
                  </span>
                </div>

                <button
                  onClick={() => toggleSnippet(sp)}
                  disabled={!snippet?.url}
                  className={`w-9 h-9 rounded-full flex items-center justify-center ${
                    snippet?.url ? 'bg-gray-100 hover:bg-gray-200' : 'bg-gray-50 opacity-50'
                  }`}
                >
                  {isPlaying ? (
                    <span className="text-xs text-indigo-600">||</span>
                  ) : (
                    <span className="text-xs text-gray-600">▶</span>
                  )}
                </button>
              </div>

              <audio
                ref={(el) => {
                  if (el) audioRefs.current[sp] = el
                }}
                src={snippet?.url || ''}
                onEnded={() => setPlayingSpeaker(null)}
                style={{ display: 'none' }}
              />

              <p className="text-xs text-gray-500 italic leading-relaxed mb-3 line-clamp-2">
                "{snippet?.text || 'Extracting sample...'}"
              </p>

              {editingSpeaker === sp ? (
                <div className="flex gap-2">
                  <input
                    className="flex-1 h-9 border border-indigo-200 rounded-lg px-3 text-sm focus:outline-none focus:border-indigo-400"
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') saveName(sp)
                      if (e.key === 'Escape') {
                        setEditingSpeaker(null)
                        setInputValue('')
                      }
                    }}
                    placeholder="e.g. Alex"
                    autoFocus
                    maxLength={24}
                  />
                  <button
                    onClick={() => saveName(sp)}
                    className="h-9 px-4 bg-gray-900 text-white text-sm rounded-lg font-medium"
                  >
                    save
                  </button>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  <div className="flex gap-2">
                    <button
                      onClick={() =>
                        setSpeakerNames((prev) => ({
                          ...prev,
                          [sp]: 'You',
                        }))
                      }
                      disabled={anotherSpeakerIsYou}
                      className={`flex-1 h-9 rounded-lg text-sm font-medium ${
                        name === 'You'
                          ? 'bg-indigo-600 text-white'
                          : anotherSpeakerIsYou
                            ? 'bg-gray-50 text-gray-300 cursor-not-allowed'
                            : 'bg-indigo-50 text-indigo-700 hover:bg-indigo-100'
                      }`}
                    >
                      {name === 'You' ? 'this is you' : 'this is me'}
                    </button>
                    <button
                      onClick={() => {
                        setEditingSpeaker(sp)
                        setInputValue(name && name !== 'You' ? name : '')
                      }}
                      className="flex-1 h-9 rounded-lg text-sm border border-gray-200 text-gray-600 hover:bg-gray-50"
                    >
                      {name && name !== 'You' ? name : 'name person'}
                    </button>
                  </div>

                  {name !== 'You' && suggestionNames.length > 0 ? (
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {suggestionNames.slice(0, 3).map((suggestedName) => (
                        <button
                          key={`${sp}-${suggestedName}`}
                          onClick={() =>
                            setSpeakerNames((prev) => ({
                              ...prev,
                              [sp]: suggestedName,
                            }))
                          }
                          className="h-7 px-2.5 rounded-full text-xs border border-gray-200 text-gray-600 hover:bg-gray-50"
                        >
                          {suggestedName}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className="flex flex-col gap-2 pt-5 pb-8">
        <button
          onClick={handleConfirm}
          className="h-11 w-full rounded-xl bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700"
        >
          confirm speakers
        </button>
        <button onClick={() => onSkip()} className="h-9 text-xs text-gray-400 underline">
          skip for now
        </button>
      </div>
    </div>
  )
}

function findBestSegmentForSpeaker(segments, speakerId) {
  const candidates = (segments || []).filter(
    (seg) => Number(seg?.speaker) === Number(speakerId) && Number(seg?.startTime || 0) >= 1.5 && String(seg?.text || '').trim(),
  )

  if (candidates.length === 0) return null

  return candidates.reduce((best, current) => {
    const bestDur = Number(best?.endTime || 0) - Number(best?.startTime || 0)
    const curDur = Number(current?.endTime || 0) - Number(current?.startTime || 0)
    return curDur > bestDur ? current : best
  }, candidates[0])
}

function getSpeakerStats(segments, speakerId) {
  const matches = (Array.isArray(segments) ? segments : []).filter(
    (segment) => Number(segment?.speaker) === Number(speakerId),
  )
  const finals = matches.filter((segment) => segment?.isFinal === true)
  const source = finals.length > 0 ? finals : matches

  let totalDuration = 0
  let durationCount = 0
  let totalWords = 0

  for (const segment of source) {
    const text = String(segment?.text || '').trim()
    if (text) totalWords += text.split(/\s+/g).filter(Boolean).length
    const start = Number(segment?.startTime)
    const end = Number(segment?.endTime)
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      totalDuration += end - start
      durationCount += 1
    }
  }

  return {
    segmentCount: source.length,
    totalDuration: durationCount > 0 ? totalDuration : null,
    totalWords,
  }
}

function isTinySpeaker(stats) {
  if (!stats) return true
  if (stats.segmentCount <= 1) {
    const shortByDuration = Number.isFinite(stats.totalDuration) && stats.totalDuration < 1.2
    const shortByWords = stats.totalWords <= 4
    if (shortByDuration || shortByWords) return true
  }
  return false
}

function shouldRememberContactName(name) {
  const cleaned = String(name || '').trim()
  if (!cleaned) return false
  if (cleaned.toLowerCase() === 'you') return false
  if (/^person\s*\d+$/i.test(cleaned)) return false
  return true
}

function buildLabelMapFromAutoLabels(allSpeakers, autoLabels) {
  const labelMap = {}
  let personIndex = 1
  for (const speakerId of allSpeakers) {
    if (autoLabels[speakerId]) {
      labelMap[speakerId] = autoLabels[speakerId]
    } else {
      labelMap[speakerId] = `Person ${personIndex}`
      personIndex += 1
    }
  }
  return labelMap
}

export async function extractAudioSlice(audioBlob, startSec, endSec) {
  if (!audioBlob) return null

  const arrayBuffer = await audioBlob.arrayBuffer()
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext
  if (!AudioContextCtor) return null

  const ctx = new AudioContextCtor()
  try {
    const sourceBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0))
    const sampleRate = sourceBuffer.sampleRate
    const startFrame = Math.max(0, Math.floor(startSec * sampleRate))
    const endFrame = Math.min(sourceBuffer.length, Math.floor(endSec * sampleRate))
    const frameCount = endFrame - startFrame
    if (frameCount <= 0) return null

    const slice = ctx.createBuffer(sourceBuffer.numberOfChannels, frameCount, sampleRate)
    for (let channel = 0; channel < sourceBuffer.numberOfChannels; channel += 1) {
      const channelData = sourceBuffer.getChannelData(channel)
      slice.getChannelData(channel).set(channelData.subarray(startFrame, endFrame))
    }

    return audioBufferToWavBlob(slice)
  } catch {
    return null
  } finally {
    try {
      await ctx.close()
    } catch {}
  }
}

export function audioBufferToWavBlob(audioBuffer) {
  const channelCount = audioBuffer.numberOfChannels
  const sampleRate = audioBuffer.sampleRate
  const frameCount = audioBuffer.length
  const bytesPerSample = 2
  const blockAlign = channelCount * bytesPerSample
  const byteRate = sampleRate * blockAlign
  const dataSize = frameCount * blockAlign
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channelCount, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, 16, true)
  writeAscii(view, 36, 'data')
  view.setUint32(40, dataSize, true)

  let offset = 44
  const channelData = []
  for (let channel = 0; channel < channelCount; channel += 1) {
    channelData.push(audioBuffer.getChannelData(channel))
  }

  for (let i = 0; i < frameCount; i += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      const sample = Math.max(-1, Math.min(1, channelData[channel][i]))
      const int16 = sample < 0 ? sample * 32768 : sample * 32767
      view.setInt16(offset, int16, true)
      offset += 2
    }
  }

  return new Blob([buffer], { type: 'audio/wav' })
}

function writeAscii(view, offset, text) {
  for (let i = 0; i < text.length; i += 1) {
    view.setUint8(offset + i, text.charCodeAt(i))
  }
}
