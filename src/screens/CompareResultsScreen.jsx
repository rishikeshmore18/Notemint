const STATUS_LABELS = {
  queued: 'queued',
  transcribing: 'transcribing',
  summarizing: 'summarizing',
  done: 'done',
  failed: 'failed',
}

export default function CompareResultsScreen({
  results,
  bestTranscriptProvider,
  bestSummaryProvider,
  onSelectBestTranscript,
  onSelectBestSummary,
  onNewMeeting,
}) {
  const list = Array.isArray(results) ? results : []
  const hasPending = list.some((item) => item.status === 'queued' || item.status === 'transcribing' || item.status === 'summarizing')

  return (
    <div className="min-h-screen bg-white max-w-6xl mx-auto px-4 md:px-8 py-5">
      <header className="mb-4 flex items-center justify-between">
        <h1 className="text-sm font-medium text-gray-900">compare models (internal)</h1>
        <button
          type="button"
          onClick={onNewMeeting}
          className="text-xs text-gray-500 hover:text-gray-700 transition-colors"
        >
          new meeting
        </button>
      </header>

      <div className="mb-4 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2">
        <p className="text-xs text-gray-600">
          {hasPending ? 'processing providers in parallel...' : 'processing complete. mark best transcript and summary.'}
        </p>
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
