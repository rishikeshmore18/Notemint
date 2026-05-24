const STATUS_LABELS = {
  queued: 'queued',
  transcribing: 'transcribing',
  summarizing: 'summarizing',
  done: 'done',
  failed: 'failed',
}

export default function CompareResultsScreen({
  results,
  history,
  bestTranscriptProvider,
  bestSummaryProvider,
  onSelectBestTranscript,
  onSelectBestSummary,
  onContinueWithProvider,
  onUpdateProviderRating,
  onSaveEvaluations,
  onNewMeeting,
}) {
  const list = Array.isArray(results) ? results : []
  const recent = Array.isArray(history) ? history : []
  const hasPending = list.some((item) => item.status === 'queued' || item.status === 'transcribing' || item.status === 'summarizing')
  const doneProviders = list.filter((item) => item.status === 'done')
  const selectedProvider =
    doneProviders.find((item) => item.provider === bestTranscriptProvider)?.provider ||
    doneProviders[0]?.provider ||
    ''

  return (
    <div className="min-h-screen bg-white max-w-6xl mx-auto px-4 md:px-8 py-5">
      <header className="mb-4 flex items-center justify-between">
        <h1 className="text-sm font-medium text-gray-900">compare models (internal)</h1>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onSaveEvaluations?.()}
            className="rounded-lg border border-emerald-200 px-2.5 py-1.5 text-xs text-emerald-700 hover:bg-emerald-50"
          >
            save evaluation
          </button>
          <button
            type="button"
            onClick={() => selectedProvider && onContinueWithProvider?.(selectedProvider)}
            disabled={!selectedProvider}
            className="rounded-lg border border-indigo-200 px-2.5 py-1.5 text-xs text-indigo-700 hover:bg-indigo-50 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            continue with selected transcript
          </button>
          <button
            type="button"
            onClick={onNewMeeting}
            className="text-xs text-gray-500 hover:text-gray-700 transition-colors"
          >
            new meeting
          </button>
        </div>
      </header>

      <div className="mb-4 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2">
        <p className="text-xs text-gray-600">
          {hasPending ? 'processing providers in parallel...' : 'processing complete. mark best transcript and summary.'}
        </p>
      </div>

      <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-3">
        <KpiCard
          label="runs saved"
          value={String(new Set(recent.map((item) => item.compare_run_id || item.created_at?.slice(0, 16))).size || 0)}
          helper="recent compare runs"
        />
        <KpiCard
          label="avg duration"
          value={computeAvgDurationLabel(recent)}
          helper="across recent providers"
        />
        <KpiCard
          label="top transcript provider"
          value={findTopProvider(recent, 'best_transcript')}
          helper="based on saved picks"
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {list.map((item) => (
          <article key={item.provider} className="rounded-2xl border border-gray-200 bg-white p-3">
            <div className="mb-2 flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold text-gray-900">{providerLabel(item.provider)}</p>
                <p className="text-[11px] text-gray-400">{item.model || '-'}</p>
              </div>
              <StatusPill status={item.status} />
            </div>

            <div className="mb-3 grid grid-cols-2 gap-2 text-[11px] text-gray-500">
              <p>duration: {formatMs(item.durationMs)}</p>
              <p>speakers: {item.speakerCount ?? 0}</p>
              <p>segments: {item.segmentCount ?? 0}</p>
              <p>keyterms: {item.keytermCount ?? 0}</p>
            </div>

            {item.error ? (
              <p className="mb-3 rounded-lg bg-red-50 px-2 py-1.5 text-xs text-red-600">{item.error}</p>
            ) : null}

            <div className="mb-3 space-y-2">
              <div>
                <p className="mb-1 text-[11px] font-medium uppercase tracking-[0.12em] text-gray-400">summary</p>
                <p className="max-h-28 overflow-y-auto text-xs leading-relaxed text-gray-700 whitespace-pre-wrap">
                  {item.summary || (item.status === 'failed' ? '-' : 'processing...')}
                </p>
              </div>
              <div>
                <p className="mb-1 text-[11px] font-medium uppercase tracking-[0.12em] text-gray-400">transcript</p>
                <p className="max-h-36 overflow-y-auto text-xs leading-relaxed text-gray-700 whitespace-pre-wrap">
                  {previewTranscript(item.segments)}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => onSelectBestTranscript(item.provider)}
                disabled={item.status !== 'done'}
                className={`rounded-lg px-2 py-2 text-xs transition-colors ${
                  bestTranscriptProvider === item.provider
                    ? 'bg-indigo-600 text-white'
                    : 'border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed'
                }`}
              >
                {bestTranscriptProvider === item.provider ? 'best transcript' : 'mark transcript'}
              </button>
              <button
                type="button"
                onClick={() => onSelectBestSummary(item.provider)}
                disabled={item.status !== 'done'}
                className={`rounded-lg px-2 py-2 text-xs transition-colors ${
                  bestSummaryProvider === item.provider
                    ? 'bg-emerald-600 text-white'
                    : 'border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed'
                }`}
              >
                {bestSummaryProvider === item.provider ? 'best summary' : 'mark summary'}
              </button>
            </div>

            <div className="mt-3 grid grid-cols-2 gap-2">
              <label className="text-[11px] text-gray-500">
                transcript rating
                <select
                  value={item.transcriptRating ?? ''}
                  onChange={(event) =>
                    onUpdateProviderRating?.(item.provider, {
                      transcriptRating: event.target.value ? Number(event.target.value) : null,
                    })
                  }
                  className="mt-1 h-8 w-full rounded-md border border-gray-200 bg-white px-2 text-xs text-gray-700"
                >
                  <option value="">not rated</option>
                  <option value="1">1</option>
                  <option value="2">2</option>
                  <option value="3">3</option>
                  <option value="4">4</option>
                  <option value="5">5</option>
                </select>
              </label>
              <label className="text-[11px] text-gray-500">
                summary rating
                <select
                  value={item.summaryRating ?? ''}
                  onChange={(event) =>
                    onUpdateProviderRating?.(item.provider, {
                      summaryRating: event.target.value ? Number(event.target.value) : null,
                    })
                  }
                  className="mt-1 h-8 w-full rounded-md border border-gray-200 bg-white px-2 text-xs text-gray-700"
                >
                  <option value="">not rated</option>
                  <option value="1">1</option>
                  <option value="2">2</option>
                  <option value="3">3</option>
                  <option value="4">4</option>
                  <option value="5">5</option>
                </select>
              </label>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <label className="text-[11px] text-gray-500">
                correction count
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={Number.isFinite(Number(item.correctionCount)) ? Number(item.correctionCount) : 0}
                  onChange={(event) =>
                    onUpdateProviderRating?.(item.provider, {
                      correctionCount: Math.max(0, Number(event.target.value) || 0),
                    })
                  }
                  className="mt-1 h-8 w-full rounded-md border border-gray-200 bg-white px-2 text-xs text-gray-700"
                />
              </label>
              <label className="text-[11px] text-gray-500">
                manual speaker fixes
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={Number.isFinite(Number(item.manualSpeakerFixes)) ? Number(item.manualSpeakerFixes) : 0}
                  onChange={(event) =>
                    onUpdateProviderRating?.(item.provider, {
                      manualSpeakerFixes: Math.max(0, Number(event.target.value) || 0),
                    })
                  }
                  className="mt-1 h-8 w-full rounded-md border border-gray-200 bg-white px-2 text-xs text-gray-700"
                />
              </label>
            </div>
            <label className="mt-2 block text-[11px] text-gray-500">
              notes
              <textarea
                value={item.notes || ''}
                onChange={(event) =>
                  onUpdateProviderRating?.(item.provider, {
                    notes: event.target.value,
                  })
                }
                rows={2}
                maxLength={300}
                className="mt-1 w-full rounded-md border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-700 resize-y"
                placeholder="what worked / what failed"
              />
            </label>
          </article>
        ))}
      </div>
    </div>
  )
}

function providerLabel(provider) {
  if (provider === 'assemblyai') return 'AssemblyAI'
  if (provider === 'deepgram') return 'Deepgram'
  return 'Grok'
}

function formatMs(value) {
  const ms = Number(value)
  if (!Number.isFinite(ms) || ms <= 0) return '-'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function previewTranscript(segments) {
  if (!Array.isArray(segments) || segments.length === 0) return 'processing...'
  return segments
    .slice(0, 8)
    .map((segment) => `[${segment.speaker === 0 ? 'you' : `person ${segment.speaker}`}]: ${segment.text}`)
    .join('\n')
}

function StatusPill({ status }) {
  const label = STATUS_LABELS[status] || status || 'queued'
  const classes =
    status === 'done'
      ? 'bg-emerald-100 text-emerald-700'
      : status === 'failed'
        ? 'bg-red-100 text-red-700'
        : 'bg-amber-100 text-amber-700'

  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${classes}`}>{label}</span>
}

function KpiCard({ label, value, helper }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white px-3 py-2">
      <p className="text-[11px] uppercase tracking-[0.12em] text-gray-400">{label}</p>
      <p className="mt-1 text-sm font-semibold text-gray-900">{value || '-'}</p>
      <p className="mt-0.5 text-[11px] text-gray-500">{helper}</p>
    </div>
  )
}

function computeAvgDurationLabel(history) {
  const list = Array.isArray(history) ? history : []
  const samples = list
    .map((item) => Number(item?.duration_ms))
    .filter((value) => Number.isFinite(value) && value > 0)
  if (samples.length === 0) return '-'
  const avg = samples.reduce((sum, value) => sum + value, 0) / samples.length
  if (avg < 1000) return `${Math.round(avg)}ms`
  return `${(avg / 1000).toFixed(1)}s`
}

function findTopProvider(history, field) {
  const list = Array.isArray(history) ? history : []
  const counts = new Map()
  for (const row of list) {
    if (!row || !row[field]) continue
    const key = String(row.provider || '')
    if (!key) continue
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  let best = ''
  let max = 0
  for (const [provider, count] of counts.entries()) {
    if (count > max) {
      max = count
      best = provider
    }
  }
  if (!best) return '-'
  return providerLabel(best)
}
