import type { TranscriptResult } from './types.js';

/** Only an addressed, standalone stop interrupts a running action or spoken reply. */
export function detectStopCommand(text: string, wakeWord: string) {
  const escaped = wakeWord.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `^\\s*(?:hey[\\s,.!?]+)?${escaped}[\\s,.:;!?—]+(?:please\\s+)?stop(?:\\s+please)?[\\s.!?]*$`,
    'i',
  ).test(text);
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
