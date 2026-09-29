import type { EchoEntry } from '../electron/types';

/**
 * Self-trigger prevention for continuous listening. Browser echo cancellation removes
 * most of Friday's voice from the microphone; this catches what leaks through by
 * comparing a transcript with what Friday was saying when that speech began.
 *
 * Timing uses absolute timestamps published by the host (`endedAt`), checked against
 * this renderer's clock. A quiet room never extends the window, and a user repeating
 * Friday's words after the acoustic tail is never treated as echo.
 */

/** Microphone speech that starts this long after Friday stopped cannot be its echo. */
export const echoTailMs = 1500;
/** Batch recognition can deliver a final this long after the speech began. */
export const echoWindowMs = 8000;

export function words(text: string) {
  return (
    text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .match(/[\p{L}\p{N}']+/gu)
      ?.map((word) => word.replace(/'/g, ''))
      .filter(Boolean) ?? []
  );
}

function commonSubsequence(a: string[], b: string[]) {
  const row = new Array<number>(b.length + 1).fill(0);
  for (const word of a) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j];
      row[j] = word === b[j - 1] ? diagonal + 1 : Math.max(row[j], row[j - 1]);
      diagonal = above;
    }
  }
  return row[b.length];
}

function includesRun(haystack: string[], needle: string[]) {
  if (!needle.length) return false;
  for (let i = 0; i + needle.length <= haystack.length; i++)
    if (needle.every((word, j) => haystack[i + j] === word)) return true;
  return false;
}

/** Words that change a request's meaning; never discounted as recognition slips. */
const corrections = new Set([
  'no',
  'not',
  'dont',
  'doesnt',
  'didnt',
  'isnt',
  'cant',
  'wont',
  'never',
  'nope',
  'stop',
  'wait',
  'instead',
  'actually',
  'other',
  'wrong',
  'cancel',
  'undo',
  'but',
  'rather',
]);

function count(list: string[], word: string) {
  return list.reduce((total, item) => total + (item === word ? 1 : 0), 0);
}

export interface EchoCheck {
  /** Recognized text. */
  text: string;
  /** Wall-clock time the microphone speech began (renderer Date.now()). */
  speechStartedAt: number;
  /** Renderer Date.now() when the check runs. */
  now: number;
  wakeWord?: string;
  /**
   * When Friday was last seen to stop speaking (renderer clock). Applied to entries still
   * marked as playing, so a missed host update cannot keep an entry live forever.
   */
  speakingEndedAt?: number;
}

/**
 * Whether `text` is most likely Friday's own voice. An utterance counts only while it is
 * playing or if the user's speech began within `echoTailMs` of its end, and never after
 * `echoWindowMs`. Most recognized words must follow Friday's wording in order; a wake word
 * Friday did not say marks the speech as the user's.
 */
export function isEcho(entries: EchoEntry[] | undefined, check: EchoCheck) {
  const heard = words(check.text);
  if (!heard.length || !entries?.length) return false;
  const wake = check.wakeWord ? words(check.wakeWord) : [];
  return entries.some((entry) => {
    const endedAt = entry.endedAt ?? check.speakingEndedAt;
    if (endedAt !== undefined) {
      if (check.now > endedAt + echoWindowMs) return false;
      if (check.speechStartedAt > endedAt + echoTailMs) return false;
    }
    const said = words(entry.text);
    if (wake.length && includesRun(heard, wake) && !includesRun(said, wake)) return false;
    // "Not the blue button" is a correction, not a slip in recognizing Friday's own words.
    if (heard.some((word) => corrections.has(word) && count(heard, word) > count(said, word))) return false;
    return commonSubsequence(heard, said) / heard.length >= 0.8;
  });
}

/**
 * Whether a revisable partial transcript should interrupt Friday's playback. Engaged
 * conversations need at least two words; otherwise the user must address Friday by name.
 */
export function shouldBargeIn(partial: string, engaged: boolean, addressed: boolean) {
  if (addressed) return true;
  return engaged && words(partial).length >= 2;
}
