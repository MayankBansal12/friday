import './mascot.css';

export type FridayMood = 'idle' | 'listening' | 'thinking' | 'speaking' | 'sleepy' | 'worried';

/**
 * Friday's mark: a flat squircle with two eye slits. State is shown only through the
 * eyes and a slow pulse; everything that moves is CSS so the notch stays cheap.
 */
export function FridayMascot({ mood = 'idle', className = '' }: { mood?: FridayMood; className?: string }) {
  return (
    <span className={`friday-mascot mood-${mood} ${className}`} aria-hidden="true">
      <svg viewBox="0 0 32 32" width="100%" height="100%">
        <rect className="mascot-shape" x="3" y="3" width="26" height="26" rx="9" />
        <g className="mascot-eyes">
          <rect x="11.4" y="12.7" width="2.4" height="6.6" rx="1.2" />
          <rect x="18.2" y="12.7" width="2.4" height="6.6" rx="1.2" />
        </g>
      </svg>
    </span>
  );
}
