import { useEffect, useMemo, useState } from 'react'
import {
  getCorrectionMemory,
  getContextProfile,
  parseTerms,
  upsertContextProfile,
} from '../lib/contextProfile'
import { supabase } from '../lib/supabase'
import { generateContextKeyterms } from '../lib/api'

export default function ContextOnboardingScreen({ user, mode = 'initial', onComplete, onSkip }) {
  const [industrySelection, setIndustrySelection] = useState('')
  const [roleSelection, setRoleSelection] = useState('')
  const [importantTermsInput, setImportantTermsInput] = useState('')
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
  const [savePhase, setSavePhase] = useState('idle')
  const [previewKeyterms, setPreviewKeyterms] = useState([])

  const title = mode === 'edit' ? 'edit work context' : mode === 'dictionary' ? 'correction dictionary' : 'set your work context'
  const subtitle = mode === 'dictionary'
    ? 'review corrections and refresh term suggestions from real edits.'
    : 'quick setup to improve names, domain terms, and meeting summaries.'
  const isDictionaryMode = mode === 'dictionary'
  const isWorkContextMode = !isDictionaryMode
  const isEditMode = mode === 'edit'
  const showGeneratedSuggestionsPanel = isDictionaryMode || isEditMode

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        const existing = await getContextProfile(supabase, user?.id)
        if (cancelled || !existing) return

        setIndustrySelection(String(existing.industry || '').trim())
        setRoleSelection(String(existing.role || '').trim())
        const mergedTerms = uniqueTerms([
          ...toStringList(existing.participant_names),
          ...toStringList(existing.organization_terms),
          ...toStringList(existing.custom_terms),
        ])
        setImportantTermsInput(listToInput(mergedTerms))
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

  const parsedImportantTerms = useMemo(() => parseTerms(importantTermsInput), [importantTermsInput])
  const normalizedIndustry = useMemo(() => {
    return String(industrySelection || '').trim()
  }, [industrySelection])
  const normalizedRole = useMemo(() => {
    return String(roleSelection || '').trim()
  }, [roleSelection])
  const normalizedGeneratedKeyterms = useMemo(
    () =>
      uniqueTerms(generatedKeyterms)
        .filter((term) => term.split(' ').length <= 6)
        .slice(0, 200),
    [generatedKeyterms],
  )

  async function runRegenerateSuggestions(options = {}) {
    const silent = options.silent === true
    setRegenerating(true)
    setGenerationWarning('')
    try {
      const generated = await generateContextKeyterms({
        industry: normalizedIndustry,
        role: normalizedRole,
        meetingTypes: [],
        participantNames: parsedImportantTerms,
        organizationTerms: parsedImportantTerms,
        customTerms: parsedImportantTerms,
        correctionTerms: [],
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
      const message = String(err?.message || '')
      if (!silent) {
        if (message.toLowerCase().includes('session expired') || message.toLowerCase().includes('not authenticated')) {
          setGenerationWarning('session expired. please sign in again and retry.')
        } else {
          setGenerationWarning('could not regenerate suggestions right now')
        }
      }
      console.warn('[ContextOnboarding] Keyterm regeneration failed:', message || err)
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
    setSavePhase('saving')
    try {
      let finalGeneratedKeyterms = normalizedGeneratedKeyterms
      let finalSummaryContext = generatedSummaryContext
      let finalDoNotInfer = generatedDoNotInfer

      if (isWorkContextMode) {
        // Save typed context first, then generate suggestions from saved context.
        await upsertContextProfile(supabase, user.id, {
          industry: normalizedIndustry,
          role: normalizedRole,
          meetingTypes: [],
          participantNames: parsedImportantTerms,
          organizationTerms: parsedImportantTerms,
          customTerms: parsedImportantTerms,
          correctionTerms: [],
          generatedKeyterms: finalGeneratedKeyterms,
          summaryContext: finalSummaryContext,
          doNotInfer: finalDoNotInfer,
        })

        setSavePhase('generating')
        const regenerated = await runRegenerateSuggestions({ silent: true })
        if (regenerated) {
          finalGeneratedKeyterms = uniqueTerms(regenerated.keyterms)
            .filter((term) => term.split(' ').length <= 6)
            .slice(0, 200)
          finalSummaryContext = String(regenerated.summaryContext || '')
          finalDoNotInfer = Array.isArray(regenerated.doNotInfer) ? regenerated.doNotInfer : []
        }
        await upsertContextProfile(supabase, user.id, {
          industry: normalizedIndustry,
          role: normalizedRole,
          meetingTypes: [],
          participantNames: parsedImportantTerms,
          organizationTerms: parsedImportantTerms,
          customTerms: parsedImportantTerms,
          correctionTerms: [],
          generatedKeyterms: finalGeneratedKeyterms,
          summaryContext: finalSummaryContext,
          doNotInfer: finalDoNotInfer,
        })

        const { data: savedRow, error: verifyError } = await supabase
          .from('user_context_profiles')
          .select('id')
          .eq('user_id', user.id)
          .maybeSingle()
        if (verifyError || !savedRow?.id) {
          throw new Error('Could not confirm saved context profile')
        }

        setGeneratedKeyterms(finalGeneratedKeyterms)
        setGeneratedSummaryContext(finalSummaryContext)
        setGeneratedDoNotInfer(finalDoNotInfer)
        setPreviewKeyterms(finalGeneratedKeyterms)
        setSavePhase('preview')
        await sleep(2500)
        setSavePhase('saved')
        await sleep(800)
        onComplete?.()
      } else {
        await upsertContextProfile(supabase, user.id, {
          industry: normalizedIndustry,
          role: normalizedRole,
          meetingTypes: [],
          participantNames: parsedImportantTerms,
          organizationTerms: parsedImportantTerms,
          customTerms: parsedImportantTerms,
          correctionTerms: [],
          generatedKeyterms: finalGeneratedKeyterms,
          summaryContext: finalSummaryContext,
          doNotInfer: finalDoNotInfer,
        })
        onComplete?.()
      }
    } catch (err) {
      const message = String(err?.message || '')
      if (message.toLowerCase().includes('row-level security')) {
        setError('session check failed. please sign in again, then save context.')
      } else {
        setError(message || 'Could not save context profile')
      }
      setSavePhase('idle')
    } finally {
      setSaving(false)
    }
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
      {isWorkContextMode && (savePhase === 'saving' || savePhase === 'generating') ? (
        <div className="fixed inset-x-0 top-4 z-40 mx-auto w-[92%] max-w-md rounded-2xl border border-indigo-100 bg-white/95 px-4 py-3 shadow-lg backdrop-blur">
          <p className="text-sm font-medium text-indigo-700">
            {savePhase === 'saving'
              ? 'saving your context...'
              : 'suggestions being generated based on your inputs...'}
          </p>
        </div>
      ) : null}

      {isWorkContextMode && (savePhase === 'preview' || savePhase === 'saved') ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-white px-6 py-8">
          <div className="w-full max-w-2xl text-center">
            <p className="text-sm font-medium text-indigo-600">
              {savePhase === 'preview' ? 'suggestions generated from your context' : 'context saved'}
            </p>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
              {(previewKeyterms.length > 0 ? previewKeyterms : normalizedGeneratedKeyterms).slice(0, 32).map((term, index) => (
                <span
                  key={`${term}-${index}`}
                  className={`inline-flex rounded-full px-3 py-1 text-indigo-700 transition-all ${
                    index % 4 === 0
                      ? 'bg-indigo-100 text-base font-semibold'
                      : index % 4 === 1
                        ? 'bg-indigo-50 text-sm font-medium'
                        : index % 4 === 2
                          ? 'bg-sky-50 text-xs font-medium'
                          : 'bg-violet-50 text-[11px]'
                  }`}
                >
                  {term}
                </span>
              ))}
            </div>
            <p className="mt-8 text-xs text-gray-500">
              {savePhase === 'preview' ? 'verifying and saving context...' : 'redirecting to homepage...'}
            </p>
          </div>
        </div>
      ) : null}

      <div className="mx-auto w-full max-w-xl">
        <h1 className="text-xl font-semibold text-gray-900">{title}</h1>
        <p className="mt-1 text-sm text-gray-400">{subtitle}</p>

        {loading ? <p className="mt-6 text-sm text-gray-400">loading context...</p> : null}

        {!loading ? (
          <div className="mt-6 space-y-5">
            {mode !== 'dictionary' ? (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">industry</label>
                <input
                  value={industrySelection}
                  onChange={(event) => setIndustrySelection(event.target.value)}
                  placeholder="Banking"
                  className="w-full h-11 rounded-xl border border-gray-200 bg-white px-3 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-indigo-100 focus:border-indigo-400"
                />
              </div>
            ) : null}

            {mode !== 'dictionary' ? (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">role</label>
                <input
                  value={roleSelection}
                  onChange={(event) => setRoleSelection(event.target.value)}
                  placeholder="Financial Analyst"
                  className="w-full h-11 rounded-xl border border-gray-200 bg-white px-3 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-indigo-100 focus:border-indigo-400"
                />
              </div>
            ) : null}

            {mode !== 'dictionary' ? (
              <Field
                label="important names / terms"
                value={importantTermsInput}
                onChange={setImportantTermsInput}
                placeholder="Tom, Sarah, Notemint, fraud hold, CDs"
                helper="comma or new line separated"
              />
            ) : null}

            {isWorkContextMode ? (
              <div className="pt-1">
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={saving || regenerating || savePhase === 'preview' || savePhase === 'saved'}
                  className="w-full h-11 rounded-xl bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {savePhase === 'saving'
                    ? 'saving context...'
                    : savePhase === 'generating'
                      ? 'suggestions being generated based on your inputs...'
                      : savePhase === 'saved'
                        ? 'context saved'
                        : 'save context'}
                </button>
                {savePhase === 'preview' ? (
                  <div className="mt-3 rounded-xl border border-indigo-100 bg-indigo-50/40 px-3 py-3">
                    <p className="text-xs font-medium text-indigo-700">suggestions generated</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {normalizedGeneratedKeyterms.slice(0, 24).map((term, index) => (
                        <span
                          key={`${term}-${index}`}
                          className={`rounded-full bg-white/80 px-2.5 py-1 text-indigo-700 ${
                            index % 3 === 0 ? 'text-xs font-semibold' : index % 3 === 1 ? 'text-[11px]' : 'text-[10px]'
                          }`}
                        >
                          {term}
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}

            {showGeneratedSuggestionsPanel ? (
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
              {isEditMode ? (
                <p className="mt-2 text-[11px] text-gray-500">
                  these suggestions will be refreshed automatically when you save.
                </p>
              ) : null}
              </div>
            ) : null}

            {isDictionaryMode ? (
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
            ) : null}

            {error ? <p className="text-sm text-red-500">{error}</p> : null}
            {generationWarning ? <p className="text-sm text-amber-600">{generationWarning}</p> : null}

            <div className="pt-2">
              {isDictionaryMode ? (
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={saving || regenerating}
                  className="w-full h-11 rounded-xl bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {saving ? 'saving context...' : 'save context'}
                </button>
              ) : null}
              <button
                type="button"
                onClick={onSkip}
                disabled={saving}
                className="mt-2 w-full h-10 rounded-xl text-sm text-gray-500 hover:text-gray-700 transition-colors"
              >
                {isDictionaryMode ? 'skip for now' : 'cancel'}
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

function toStringList(value) {
  return Array.isArray(value)
    ? value
        .map((item) => String(item || '').trim())
        .filter(Boolean)
    : []
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
