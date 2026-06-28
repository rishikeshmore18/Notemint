export default function LoadingDot({ className = '' }) {
  return (
    <div className={`flex justify-center items-center ${className}`}>
      <div
        className="w-2 h-2 rounded-full bg-[var(--mint-d)]"
        style={{ animation: 'dotPulse 1.2s ease-in-out infinite' }}
      />
    </div>
  )
}
