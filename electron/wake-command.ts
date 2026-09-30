import type { TranscriptResult } from './types.js';

function editDistance(a: string, b: string) {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++)
      next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}

/** How recognizers spell an accented wake word: "Freddy", "Fred" or "Fray" for Friday. */
function soundsLike(word: string, wakeWord: string) {
  const heard = word.toLowerCase();
  const wanted = wakeWord.toLowerCase();
  const distance = editDistance(heard, wanted);
  return heard[0] === wanted[0] && distance <= Math.min(3, Math.floor(wanted.length / 2));
}

/**
 * A local detector heard "Hey <wake word>", but the recording starts a moment earlier and may
 * begin with unrelated words. Returns the text from the last greeting on, with a misspelled
 * name ("Hey Freddy") normalized to the wake word, or undefined without a greeting (a false wake).
 */
export function fromWakeWord(text: string, wakeWord: string) {
  const greetings = [...text.matchAll(/(?<![\p{L}\p{N}])(hey[\s,.!?]+)([\p{L}']+)(?=$|[\s,.:;!?—])/giu)];
  const greeting = greetings.filter((match) => soundsLike(match[2], wakeWord)).at(-1);
  if (greeting?.index === undefined) return undefined;
  const rest = text.slice(greeting.index + greeting[0].length);
  return `${greeting[1]}${wakeWord}${rest}`;
}

/** A greeting can carry a command; a bare name is only a wake-only utterance. */
export function detectWakeCommand(text: string, wakeWord: string, armed: boolean) {
  if (armed) return { result: { text, wakeDetected: true, command: text } as TranscriptResult, armed: false };
  const escaped = wakeWord.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const greeting = text.match(new RegExp(`^\\s*hey[\\s,.!?]+${escaped}(?=$|[\\s,.:;!?—])[\\s,.:;!?—]*(.*)$`, 'i'));
  const bareName = new RegExp(`^\\s*${escaped}[\\s.!?]*$`, 'i').test(text);
  if (!greeting && !bareName) return { result: { text, wakeDetected: false } as TranscriptResult, armed: false };
  const command = greeting?.[1].trim() || undefined;
  return { result: { text, wakeDetected: true, command } as TranscriptResult, armed: !command };
}
