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

/** Openings that correct or halt Friday; they interrupt without waiting on a decision model. */
export function corrective(text: string) {
  return /^(?:no|nope|wait|stop|cancel|hold on|actually|not that|never ?mind)\b/i.test(text.trim());
}

export const repeatMs = 15_000;

/** Most of `text`'s words were in the recently ignored speech: the user is insisting. */
export function repeatsIgnored(text: string, ignored: { text: string; at: number } | undefined, now: number) {
  if (!ignored || now - ignored.at > repeatMs) return false;
  const said = [...new Set(words(text))];
  const before = new Set(words(ignored.text));
  return said.length > 0 && said.filter((word) => before.has(word)).length / said.length >= 0.7;
}

export interface GateCheck {
  text: string;
  /** Spoken with the wake phrase. */
  addressed: boolean;
  /** Merged into the request just submitted. */
  continued: boolean;
  /** Push-to-talk or another explicit capture. */
  direct: boolean;
  /** Friday is working, speaking or submitting. */
  busy: boolean;
  ignored?: { text: string; at: number };
  now: number;
}

/**
 * Whether speech must be judged before it may replace Friday's turn. Only unaddressed speech
 * while Friday is busy can be someone else, media or filler; everything else acts at once.
 */
export function needsTurnGate(check: GateCheck) {
  return (
    check.busy &&
    !check.addressed &&
    !check.continued &&
    !check.direct &&
    !corrective(check.text) &&
    !repeatsIgnored(check.text, check.ignored, check.now)
  );
}
