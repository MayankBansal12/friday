import { fillerOnly, words } from './echo-guard';

/**
 * Turn-level decisions for continuous voice: which finals are requests, and when a final
 * continues the request just submitted. Pure, so the timing rules are testable.
 */

/** Words that redirect Friday even alone ("No." while it talks is a real correction). */
const redirects = new Set(['no', 'nope', 'stop', 'wait', 'cancel', 'undo', 'pause', 'nevermind']);

export interface HeardFinal {
  text: string;
  /** The user addressed Friday by its wake word. */
  addressed: boolean;
  /** Friday was playing, or had just stopped, when this speech began. */
  duringPlayback: boolean;
}

/**
 * Why a recognized final should not become a request, or undefined when it should.
 * Short replies stay valid after Friday stops talking: "yes" answers a question. While Friday
 * is talking, a lone "yeah"/"okay" is a backchannel (or its own echo residue), and submitting
 * it would cancel the answer the user is listening to.
 */
export function ignoredFinal(final: HeardFinal): 'empty' | 'filler' | 'backchannel' | undefined {
  const heard = words(final.text);
  if (!heard.length) return 'empty';
  if (final.addressed) return undefined;
  if (fillerOnly(final.text)) return 'filler';
  if (final.duringPlayback && heard.length === 1 && !redirects.has(heard[0])) return 'backchannel';
  return undefined;
}

export interface VoiceSubmission {
  text: string;
  /** Renderer Date.now() when the final was submitted. */
  at: number;
  taskId?: string;
  /** Background task the request was about, so a continuation keeps the same context. */
  childId?: string;
}

/** Speech that starts this soon after a submission, before Friday did anything, continues it. */
export const continuationMs = 2500;

/**
 * The combined request when `next` continues `previous`: the user paused mid-request long
 * enough to endpoint, then kept talking. Only while the previous request is still just
 * thinking (no tool ran, nothing was said), so nothing can be done twice.
 */
export function continuation(
  previous: VoiceSubmission | undefined,
  next: { text: string; speechStartedAt: number; addressed: boolean },
  previousStatus: string | undefined,
) {
  if (!previous || next.addressed || previousStatus !== 'thinking') return undefined;
  if (next.speechStartedAt < previous.at || next.speechStartedAt - previous.at > continuationMs) return undefined;
  const head = previous.text.trim();
  const tail = next.text.trim();
  if (!head || !tail) return undefined;
  return `${head} ${tail}`;
}
