export default function ResultsScreen({ segments, onNewMeeting }) {
  const count = Array.isArray(segments) ? segments.length : 0

  return (
    <div className="min-h-screen bg-white">
      <div className="mx-auto flex min-h-screen w-full max-w-[640px] flex-col items-center justify-center px-6 text-center">
        <p className="text-gray-900">results coming soon</p>
        <p className="mt-2 text-sm text-gray-500">{count} transcript segments recorded</p>
        <button
          type="button"
          onClick={onNewMeeting}
          className="mt-6 h-10 rounded-lg bg-indigo-600 px-4 text-sm font-medium text-white"
        >
          new meeting
        </button>
      </div>
    </div>
  )
}
