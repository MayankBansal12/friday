import { useEffect, useRef, useState } from 'react';
import './mascot.css';

export type FridayMood =
  'idle' | 'listening' | 'thinking' | 'speaking' | 'pleased' | 'peeking' | 'sleepy' | 'muted' | 'worried';

/** How far the eyes may travel from center, in viewBox units. */
const gazeReach = { x: 1.8, y: 1.4 };
/** Moods she is startled out of when she starts listening; after speaking or pleased she is already engaged. */
const wakesFrom = new Set<FridayMood>(['sleepy', 'peeking', 'muted', 'idle']);

/**
 * Friday's mark: a flat squircle with two eye slits that follow the pointer while she is
 * awake. State is shown only through the eyes, a slow pulse and color; motion is CSS so
 * the notch stays cheap.
 */
export function FridayMascot({ mood = 'idle', className = '' }: { mood?: FridayMood; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [previous, setPrevious] = useState(mood);
  const [startled, setStartled] = useState(false);
  if (mood !== previous) {
    setPrevious(mood);
    setStartled(mood === 'listening' && wakesFrom.has(previous));
  }
  useEffect(
    () =>
      window.buddy?.onPointer?.((pointer) => {
        const element = ref.current;
        if (!element) return;
        const rect = element.getBoundingClientRect();
        const dx = pointer.x - (rect.left + rect.width / 2);
        const dy = pointer.y - (rect.top + rect.height / 2);
        const distance = Math.hypot(dx, dy);
        // Full reach once the pointer is a few hundred pixels away; centered when on top of her.
        const reach = distance ? Math.min(1, distance / 240) / distance : 0;
        element.style.setProperty('--gaze-x', `${(dx * reach * gazeReach.x).toFixed(2)}px`);
        element.style.setProperty('--gaze-y', `${(dy * reach * gazeReach.y).toFixed(2)}px`);
      }),
    [],
  );
  return (
    <span
      ref={ref}
      className={`friday-mascot mood-${mood} ${startled ? 'startled' : ''} ${className}`}
      aria-hidden="true"
    >
      <svg viewBox="0 0 32 32" width="100%" height="100%">
        <rect className="mascot-shape" x="3" y="3" width="26" height="26" rx="9" />
        <g className="mascot-gaze">
          <g className="mascot-eyes">
            <rect x="11.4" y="12.7" width="2.4" height="6.6" rx="1.2" />
            <rect x="18.2" y="12.7" width="2.4" height="6.6" rx="1.2" />
          </g>
        </g>
      </svg>
    </span>
  );
}
