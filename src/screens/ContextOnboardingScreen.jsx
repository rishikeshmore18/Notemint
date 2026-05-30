import { useEffect, useMemo, useState } from 'react'
import {
  INDUSTRY_OPTIONS,
  MEETING_TYPE_OPTIONS,
  ROLE_OPTIONS,
  getCorrectionMemory,
  getContextProfile,
  parseTerms,
  upsertContextProfile,
} from '../lib/contextProfile'
import { supabase } from '../lib/supabase'
import { generateContextKeyterms } from '../lib/api'

export default function ContextOnboardingScreen({ user, mode = 'initial', onComplete, onSkip }) {
  const [industry, setIndustry] = useState('')
  const [role, setRole] = useState('')
  const [meetingTypes, setMeetingTypes] = useState([])
  const [participantNamesInput, setParticipantNamesInput] = useState('')
  const [organizationTermsInput, setOrganizationTermsInput] = useState('')
  const [customTermsInput, setCustomTermsInput] = useState('')
  const [correctionTermsInput, setCorrectionTermsInput] = useState('')
  const [generatedKeyterms, setGeneratedKeyterms] = useState([])
  const [generatedSummaryContext, setGeneratedSummaryContext] = useState('')
  const [generatedDoNotInfer, setGeneratedDoNotInfer] = useState([])
  const [newKeytermInput, setNewKeytermInput] = useState('')
  const [recentCorrections, setRecentCorrections] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [regenerating, setRegenerating] = useState(false)
  const [error, setError] = useState(null)
  const [generationWarning, setGenerationWarning] = useState('')

  const title = mode === 'edit' ? 'edit work context' : mode === 'dictionary' ? 'correction dictionary' : 'set your work context'
  const subtitle =
    mode === 'edit'
      ? 'update this anytime to improve transcript accuracy.'
      : mode === 'dictionary'
        ? 'review corrections and refresh term suggestions from real edits.'
      : 'helps improve names, domain terms, and meeting summaries.'

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        const existing = await getContextProfile(supabase, user?.id)
        if (cancelled || !existing) return

        setIndustry(existing.industry || '')
        setRole(existing.role || '')
        setMeetingTypes(Array.isArray(existing.meeting_types) ? existing.meeting_types : [])
        setParticipantNamesInput(listToInput(existing.participant_names))
        setOrganizationTermsInput(listToInput(existing.organization_terms))
        setCustomTermsInput(listToInput(existing.custom_terms))
        setCorrectionTermsInput(listToInput(existing.correction_terms))
        setGeneratedKeyterms(Array.isArray(existing.generated_keyterms) ? existing.generated_keyterms : [])
        setGeneratedSummaryContext(String(existing.summary_context || ''))
        setGeneratedDoNotInfer(Array.isArray(existing.do_not_infer) ? existing.do_not_infer : [])
        const memory = await getCorrectionMemory(supabase, user?.id, { limit: 250 }).catch(() => ({
          confusionPairs: [],
        }))
        if (!cancelled) {
          setRecentCorrections(Array.isArray(memory?.confusionPairs) ? memory.confusionPairs : [])
        }
      } catch (err) {
        if (!cancelled) {
          setError(err.message || 'Could not load context profile')
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [user?.id])

  const parsedParticipantNames = useMemo(() => parseTerms(participantNamesInput), [participantNamesInput])
  const parsedOrganizationTerms = useMemo(() => parseTerms(organizationTermsInput), [organizationTermsInput])
  const parsedCustomTerms = useMemo(() => parseTerms(customTermsInput), [customTermsInput])
  const parsedCorrectionTerms = useMemo(() => parseTerms(correctionTermsInput), [correctionTermsInput])
  const normalizedGeneratedKeyterms = useMemo(
    () =>
      uniqueTerms(generatedKeyterms)
        .filter((term) => term.split(' ').length <= 6)
        .slice(0, 200),
    [generatedKeyterms],
  )

  async function runRegenerateSuggestions() {
    setRegenerating(true)
    setGenerationWarning('')
    try {
      const generated = await generateContextKeyterms({
        industry,
        role,
        meetingTypes,
        participantNames: parsedParticipantNames,
        organizationTerms: parsedOrganizationTerms,
        customTerms: parsedCustomTerms,
        correctionTerms: parsedCorrectionTerms,
      })
      const nextKeyterms = Array.isArray(generated?.keyterms) ? generated.keyterms : []
      const nextSummaryContext = String(generated?.summaryContext || '')
      const nextDoNotInfer = Array.isArray(generated?.doNotInfer) ? generated.doNotInfer : []
      setGeneratedKeyterms(nextKeyterms)
      setGeneratedSummaryContext(nextSummaryContext)
      setGeneratedDoNotInfer(nextDoNotInfer)
      return {
        keyterms: nextKeyterms,
        summaryContext: nextSummaryContext,
        doNotInfer: nextDoNotInfer,
      }
    } catch (err) {
      setGenerationWarning('could not regenerate suggestions right now')
      console.warn('[ContextOnboarding] Keyterm regeneration failed:', err?.message || err)
      return null
    } finally {
      setRegenerating(false)
    }
  }

  async function handleSave() {
    if (!user?.id) return
    setSaving(true)
    setError(null)
    setGenerationWarning('')
    try {
      let finalGeneratedKeyterms = normalizedGeneratedKeyterms
      let finalSummaryContext = generatedSummaryContext
      let finalDoNotInfer = generatedDoNotInfer

      if (mode === 'initial' && finalGeneratedKeyterms.length === 0 && !regenerating) {
        const regenerated = await runRegenerateSuggestions()
        if (regenerated) {
          finalGeneratedKeyterms = uniqueTerms(regenerated.keyterms)
            .filter((term) => term.split(' ').length <= 6)
            .slice(0, 200)
          finalSummaryContext = String(regenerated.summaryContext || '')
          finalDoNotInfer = Array.isArray(regenerated.doNotInfer) ? regenerated.doNotInfer : []
        }
      }

      await upsertContextProfile(supabase, user.id, {
        industry,
        role,
        meetingTypes,
        participantNames: parsedParticipantNames,
        organizationTerms: parsedOrganizationTerms,
        customTerms: parsedCustomTerms,
        correctionTerms: parsedCorrectionTerms,
        generatedKeyterms: finalGeneratedKeyterms,
        summaryContext: finalSummaryContext,
        doNotInfer: finalDoNotInfer,
      })
      onComplete?.()
    } catch (err) {
      setError(err.message || 'Could not save context profile')
    } finally {
      setSaving(false)
    }
  }

  function toggleMeetingType(type) {
    setMeetingTypes((prev) => {
      if (prev.includes(type)) return prev.filter((item) => item !== type)
      return [...prev, type]
    })
  }

  function handleAddKeyterm() {
    const term = String(newKeytermInput || '')
      .replace(/\s+/g, ' ')
      .trim()
    if (!term) return
    setGeneratedKeyterms((prev) => uniqueTerms([...prev, term]).slice(0, 200))
    setNewKeytermInput('')
  }

  function handleRemoveKeyterm(term) {
    const key = String(term || '').trim().toLowerCase()
    setGeneratedKeyterms((prev) => prev.filter((item) => String(item || '').trim().toLowerCase() !== key))
  }

  return (
    <div className="min-h-screen bg-white px-6 py-8">
      <div className="mx-auto w-full max-w-xl">
        <h1 className="text-xl font-semibold text-gray-900">{title}</h1>
        <p className="mt-1 text-sm text-gray-400">{subtitle}</p>

        {loading ? <p className="mt-6 text-sm text-gray-400">loading context...</p> : null}

        {!loading ? (
          <div className="mt-6 space-y-5">
            {mode !== 'dictionary' ? (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">industry</label>
                <select
                  value={industry}
                  onChange={(event) => setIndustry(event.target.value)}
                  className="w-full h-11 rounded-xl border border-gray-200 bg-white px-3 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-indigo-100 focus:border-indigo-400"
                >
                  <option value="">skip for now</option>
                  {INDUSTRY_OPTIONS.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            {mode !== 'dictionary' ? (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">role</label>
                <select
                  value={role}
                  onChange={(event) => setRole(event.target.value)}
                  className="w-full h-11 rounded-xl border border-gray-200 bg-white px-3 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-indigo-100 focus:border-indigo-400"
                >
                  <option value="">skip for now</option>
                  {ROLE_OPTIONS.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            {mode !== 'dictionary' ? (
              <div>
                <p className="block text-sm font-medium text-gray-700 mb-2">meeting types</p>
                <div className="flex flex-wrap gap-2">
                  {MEETING_TYPE_OPTIONS.map((type) => {
                    const selected = meetingTypes.includes(type)
                    return (
                      <button
                        key={type}
                        type="button"
                        onClick={() => toggleMeetingType(type)}
                        className={`rounded-full px-3 py-1.5 text-xs transition-colors ${
                          selected
                            ? 'bg-indigo-600 text-white'
                            : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                        }`}
                      >
                        {type}
                      </button>
                    )
                  })}
                </div>
              </div>
            ) : null}

            {mode !== 'dictionary' ? (
              <>
                <Field
                  label="common people names"
                  value={participantNamesInput}
                  onChange={setParticipantNamesInput}
                  placeholder="Tom, Sarah, John Smith"
                  helper="comma or new line separated"
                />
                <Field
                  label="organization / product terms"
                  value={organizationTermsInput}
                  onChange={setOrganizationTermsInput}
                  placeholder="Notemint, Fraud Hold, Branch Ops"
                  helper="comma or new line separated"
                />
                <Field
                  label="acronyms / special words"
                  value={customTermsInput}
                  onChange={setCustomTermsInput}
                  placeholder="CDs, IEP, SLA, delinquency"
                  helper="comma or new line separated"
                />
              </>
            ) : null}
            <Field
              label="words often transcribed wrong (optional)"
              value={correctionTermsInput}
              onChange={setCorrectionTermsInput}
              placeholder="staffing issue, fraud prevention"
              helper="comma or new line separated"
            />

            <div className="rounded-xl border border-gray-100 bg-gray-50 px-3 py-3">
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs font-medium text-gray-700">generated keyterms</p>
                <button
                  type="button"
                  onClick={() => void runRegenerateSuggestions()}
                  disabled={regenerating}
                  className="text-xs text-indigo-600 underline disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {regenerating ? 'regenerating...' : 'regenerate suggestions'}
                </button>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {normalizedGeneratedKeyterms.length > 0 ? (
                  normalizedGeneratedKeyterms.map((term) => (
                    <button
                      key={term}
                      type="button"
                      onClick={() => handleRemoveKeyterm(term)}
                      className="rounded-full bg-white border border-gray-200 px-2.5 py-1 text-[11px] text-gray-600 hover:bg-gray-100"
                      title="remove term"
                    >
                      {term} ×
                    </button>
                  ))
                ) : (
                  <p className="text-xs text-gray-400">no generated keyterms yet</p>
                )}
              </div>
              <div className="mt-2 flex items-center gap-2">
                <input
                  value={newKeytermInput}
                  onChange={(event) => setNewKeytermInput(event.target.value)}
                  placeholder="add important term"
                  className="h-8 flex-1 rounded-lg border border-gray-200 bg-white px-2.5 text-xs text-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-100 focus:border-indigo-400"
                />
                <button
                  type="button"
                  onClick={handleAddKeyterm}
                  className="h-8 rounded-lg border border-gray-200 bg-white px-2.5 text-xs text-gray-600 hover:bg-gray-100"
                >
                  add
                </button>
              </div>
            </div>

            <div className="rounded-xl border border-gray-100 bg-gray-50 px-3 py-3">
              <p className="text-xs font-medium text-gray-700">recent corrections</p>
              <p className="mt-1 text-[11px] text-gray-500">
                learned from transcript edits; used to improve future transcription hints.
              </p>
              <div className="mt-2 space-y-1.5">
                {recentCorrections.length > 0 ? (
                  recentCorrections.slice(0, 12).map((pair) => (
                    <p key={`${pair.original}=>${pair.corrected}`} className="text-xs text-gray-600">
                      "{pair.original}" → "{pair.corrected}" ({Number(pair.count || 0)}x)
                    </p>
                  ))
                ) : (
                  <p className="text-xs text-gray-400">no correction history yet</p>
                )}
              </div>
            </div>

            {error ? <p className="text-sm text-red-500">{error}</p> : null}
            {generationWarning ? <p className="text-sm text-amber-600">{generationWarning}</p> : null}

            <div className="pt-2">
              <button
                type="button"
                onClick={handleSave}
                disabled={saving || regenerating}
                className="w-full h-11 rounded-xl bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {saving ? 'saving context...' : 'save context'}
              </button>
              <button
                type="button"
                onClick={onSkip}
                disabled={saving}
                className="mt-2 w-full h-10 rounded-xl text-sm text-gray-500 hover:text-gray-700 transition-colors"
              >
                skip for now
              </button>
            </div>

            <p className="text-xs text-gray-300">
              saved terms are used to improve transcription and summaries.
            </p>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function Field({ label, value, onChange, placeholder, helper }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-2">{label}</label>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        rows={3}
        className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-indigo-100 focus:border-indigo-400 resize-y"
      />
      <p className="mt-1 text-xs text-gray-400">{helper}</p>
    </div>
  )
}

function listToInput(list) {
  if (!Array.isArray(list) || list.length === 0) return ''
  return list.join(', ')
}

function uniqueTerms(values) {
  const list = Array.isArray(values) ? values : []
  const out = []
  const seen = new Set()

  for (const raw of list) {
    const value = String(raw || '')
      .replace(/\s+/g, ' ')
      .trim()
    if (!value) continue
    if (value.length > 60) continue
    if (value.split(' ').length > 8) continue
    const key = value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(value)
    if (out.length >= 200) break
  }

  return out
}
