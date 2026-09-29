import './mascot.css';

export type FridayMood = 'idle' | 'listening' | 'thinking' | 'speaking' | 'sleepy' | 'worried';

/**
 * Friday's mark: a flat disc with two eye slits. State is shown only through the
 * eyes and a slow pulse; everything that moves is CSS so the notch stays cheap.
 */
export function FridayMascot({ mood = 'idle', className = '' }: { mood?: FridayMood; className?: string }) {
  return (
    <span className={`friday-mascot mood-${mood} ${className}`} aria-hidden="true">
      <svg viewBox="0 0 32 32" width="100%" height="100%">
        <circle className="mascot-disc" cx="16" cy="16" r="13.5" />
        <g className="mascot-eyes">
          <rect x="11.4" y="12.7" width="2.4" height="6.6" rx="1.2" />
          <rect x="18.2" y="12.7" width="2.4" height="6.6" rx="1.2" />
        </g>
      </svg>
    </span>
  );
}
