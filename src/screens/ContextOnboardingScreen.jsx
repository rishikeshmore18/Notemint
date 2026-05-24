import { useEffect, useMemo, useState } from 'react'
import {
  INDUSTRY_OPTIONS,
  MEETING_TYPE_OPTIONS,
  ROLE_OPTIONS,
  getContextProfile,
  parseTerms,
  upsertContextProfile,
} from '../lib/contextProfile'
import { supabase } from '../lib/supabase'

export default function ContextOnboardingScreen({ user, mode = 'initial', onComplete, onSkip }) {
  const [industry, setIndustry] = useState('')
  const [role, setRole] = useState('')
  const [meetingTypes, setMeetingTypes] = useState([])
  const [participantNamesInput, setParticipantNamesInput] = useState('')
  const [organizationTermsInput, setOrganizationTermsInput] = useState('')
  const [customTermsInput, setCustomTermsInput] = useState('')
  const [correctionTermsInput, setCorrectionTermsInput] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  const title = mode === 'edit' ? 'edit work context' : 'set your work context'
  const subtitle =
    mode === 'edit'
      ? 'update this anytime to improve transcript accuracy.'
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

  async function handleSave() {
    if (!user?.id) return
    setSaving(true)
    setError(null)
    try {
      await upsertContextProfile(supabase, user.id, {
        industry,
        role,
        meetingTypes,
        participantNames: parsedParticipantNames,
        organizationTerms: parsedOrganizationTerms,
        customTerms: parsedCustomTerms,
        correctionTerms: parsedCorrectionTerms,
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

  return (
    <div className="min-h-screen bg-white px-6 py-8">
      <div className="mx-auto w-full max-w-xl">
        <h1 className="text-xl font-semibold text-gray-900">{title}</h1>
        <p className="mt-1 text-sm text-gray-400">{subtitle}</p>

        {loading ? <p className="mt-6 text-sm text-gray-400">loading context...</p> : null}

        {!loading ? (
          <div className="mt-6 space-y-5">
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
            <Field
              label="words often transcribed wrong (optional)"
              value={correctionTermsInput}
              onChange={setCorrectionTermsInput}
              placeholder="staffing issue, fraud prevention"
              helper="comma or new line separated"
            />

            {error ? <p className="text-sm text-red-500">{error}</p> : null}

            <div className="pt-2">
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
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
