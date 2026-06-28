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
    <div className="nm-screen-pad">
      {isWorkContextMode && (savePhase === 'saving' || savePhase === 'generating') ? (
        <div className="fixed inset-x-0 top-4 z-40 mx-auto w-[92%] max-w-md rounded-[22px] border border-[var(--line)] bg-white/95 px-4 py-3 shadow-[var(--sh-md)] backdrop-blur">
          <p className="text-sm font-bold text-[var(--mint-d)]">
            {savePhase === 'saving'
              ? 'saving your context...'
              : 'suggestions being generated based on your inputs...'}
          </p>
        </div>
      ) : null}

      {isWorkContextMode && (savePhase === 'preview' || savePhase === 'saved') ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(243,247,244,.96)] px-6 py-8 backdrop-blur">
          <div className="nm-card-strong nm-pop-in w-full max-w-2xl px-5 py-8 text-center">
            <p className="text-sm font-bold text-[var(--mint-d)]">
              {savePhase === 'preview' ? 'suggestions generated from your context' : 'context saved'}
            </p>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
              {(previewKeyterms.length > 0 ? previewKeyterms : normalizedGeneratedKeyterms).slice(0, 32).map((term, index) => (
                <span
                  key={`${term}-${index}`}
                  className={`inline-flex rounded-full px-3 py-1 text-[var(--mint-d)] transition-all ${
                    index % 4 === 0
                      ? 'bg-[var(--mint-soft)] text-base font-bold'
                      : index % 4 === 1
                        ? 'bg-emerald-50 text-sm font-semibold'
                        : index % 4 === 2
                          ? 'bg-sky-50 text-xs font-semibold'
                          : 'bg-white text-[11px]'
                  }`}
                >
                  {term}
                </span>
              ))}
            </div>
            <p className="mt-8 text-xs font-medium text-[var(--ink3)]">
              {savePhase === 'preview' ? 'verifying and saving context...' : 'redirecting to homepage...'}
            </p>
          </div>
        </div>
      ) : null}

      <div className="nm-container nm-fade-in">
        <h1 className="nm-title text-3xl">{title}</h1>
        <p className="mt-2 text-sm font-medium text-[var(--ink3)]">{subtitle}</p>

        {loading ? <p className="mt-6 text-sm font-medium text-[var(--ink3)]">loading context...</p> : null}

        {!loading ? (
          <div className="mt-6 space-y-5">
            {mode !== 'dictionary' ? (
              <div>
                <label className="mb-2 block text-sm font-bold text-[var(--ink)]">industry</label>
                <input
                  value={industrySelection}
                  onChange={(event) => setIndustrySelection(event.target.value)}
                  placeholder="Banking"
                  className="nm-input text-sm"
                />
              </div>
            ) : null}

            {mode !== 'dictionary' ? (
              <div>
                <label className="mb-2 block text-sm font-bold text-[var(--ink)]">role</label>
                <input
                  value={roleSelection}
                  onChange={(event) => setRoleSelection(event.target.value)}
                  placeholder="Financial Analyst"
                  className="nm-input text-sm"
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
                  className="nm-btn nm-btn-primary w-full text-sm disabled:cursor-not-allowed disabled:opacity-50"
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
                  <div className="nm-card mt-3 px-3 py-3">
                    <p className="text-xs font-bold text-[var(--mint-d)]">suggestions generated</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {normalizedGeneratedKeyterms.slice(0, 24).map((term, index) => (
                        <span
                          key={`${term}-${index}`}
                          className={`rounded-full bg-[var(--mint-soft)] px-2.5 py-1 text-[var(--mint-d)] ${
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
              <div className="nm-card px-3 py-3">
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs font-bold text-[var(--ink)]">generated keyterms</p>
                <button
                  type="button"
                  onClick={() => void runRegenerateSuggestions()}
                  disabled={regenerating}
                  className="text-xs font-bold text-[var(--mint-d)] underline disabled:cursor-not-allowed disabled:opacity-40"
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
                      className="rounded-full border border-[var(--line)] bg-white px-2.5 py-1 text-[11px] font-semibold text-[var(--ink2)] hover:bg-[var(--paper)]"
                      title="remove term"
                    >
                      {term} ×
                    </button>
                  ))
                ) : (
                  <p className="text-xs text-[var(--ink3)]">no generated keyterms yet</p>
                )}
              </div>
              <div className="mt-2 flex items-center gap-2">
                <input
                  value={newKeytermInput}
                  onChange={(event) => setNewKeytermInput(event.target.value)}
                  placeholder="add important term"
                  className="nm-input min-h-9 flex-1 px-3 py-1 text-xs"
                />
                <button
                  type="button"
                  onClick={handleAddKeyterm}
                  className="nm-btn nm-btn-soft min-h-9 px-3 py-1 text-xs"
                >
                  add
                </button>
              </div>
              {isEditMode ? (
                <p className="mt-2 text-[11px] text-[var(--ink3)]">
                  these suggestions will be refreshed automatically when you save.
                </p>
              ) : null}
              </div>
            ) : null}

            {isDictionaryMode ? (
              <div className="nm-card px-3 py-3">
              <p className="text-xs font-bold text-[var(--ink)]">recent corrections</p>
              <p className="mt-1 text-[11px] text-[var(--ink3)]">
                learned from transcript edits; used to improve future transcription hints.
              </p>
              <div className="mt-2 space-y-1.5">
                {recentCorrections.length > 0 ? (
                  recentCorrections.slice(0, 12).map((pair) => (
                    <p key={`${pair.original}=>${pair.corrected}`} className="text-xs text-[var(--ink2)]">
                      "{pair.original}" → "{pair.corrected}" ({Number(pair.count || 0)}x)
                    </p>
                  ))
                ) : (
                  <p className="text-xs text-[var(--ink3)]">no correction history yet</p>
                )}
              </div>
              </div>
            ) : null}

            {error ? <p className="rounded-2xl bg-red-50 px-3 py-2 text-sm font-medium text-red-500">{error}</p> : null}
            {generationWarning ? <p className="rounded-2xl bg-amber-50 px-3 py-2 text-sm font-medium text-amber-600">{generationWarning}</p> : null}

            <div className="pt-2">
              {isDictionaryMode ? (
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={saving || regenerating}
                  className="nm-btn nm-btn-primary w-full text-sm disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {saving ? 'saving context...' : 'save context'}
                </button>
              ) : null}
              <button
                type="button"
                onClick={onSkip}
                disabled={saving}
                className="mt-2 h-10 w-full rounded-xl text-sm font-semibold text-[var(--ink3)] transition-colors hover:text-[var(--ink)]"
              >
                {isDictionaryMode ? 'skip for now' : 'cancel'}
              </button>
            </div>

            <p className="text-xs font-medium text-[var(--ink3)]">
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
      <label className="mb-2 block text-sm font-bold text-[var(--ink)]">{label}</label>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        rows={3}
        className="nm-input resize-y text-sm"
      />
      <p className="mt-1 text-xs font-medium text-[var(--ink3)]">{helper}</p>
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
