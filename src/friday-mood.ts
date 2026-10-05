import type { ListeningState } from '../electron/types';
import type { FridayMood } from './FridayMascot';

export interface MoodSignals {
  /** An approval is waiting or something failed. */
  attention?: boolean;
  speaking?: boolean;
  /** A request is running or Friday is controlling the computer. */
  working?: boolean;
  listening: ListeningState;
  typing?: boolean;
  micEnabled: boolean;
}

/**
 * One face for every size of Friday. Passive wake-word listening reads as idle;
 * only a request being heard or typed reads as listening.
 */
export function fridayMood({ attention, speaking, working, listening, typing, micEnabled }: MoodSignals): FridayMood {
  if (attention || listening === 'error') return 'worried';
  if (speaking) return 'speaking';
  if (working || listening === 'transcribing') return 'thinking';
  if (typing || listening === 'starting' || listening === 'armed') return 'listening';
  return micEnabled ? 'idle' : 'muted';
}
