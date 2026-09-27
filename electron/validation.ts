import { resolve } from 'node:path';
import type { BuddySettings, ListeningState } from './types.js';

const listeningStates = new Set<ListeningState>(['idle', 'listening', 'transcribing', 'armed', 'error']);
const idPattern = /^[a-zA-Z0-9_.:-]{1,128}$/;
const modelPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,199}$/;

export function validId(value: unknown) {
  if (typeof value !== 'string' || !idPattern.test(value)) throw new Error('Invalid request identifier.');
  return value;
}

export function validPrompt(value: unknown) {
  if (typeof value !== 'string') throw new Error('The request must be text.');
  const prompt = value.trim();
  if (!prompt) throw new Error('Tell Friday what you want done.');
  if (prompt.length > 8_000) throw new Error('The request is too long (maximum 8,000 characters).');
  return prompt;
}

export function validAudio(value: unknown, mimeType: unknown) {
  if (!(value instanceof ArrayBuffer)) throw new Error('Invalid audio data.');
  if (value.byteLength > 25 * 1024 * 1024) throw new Error('Audio is too large to transcribe.');
  if (typeof mimeType !== 'string' || !/^audio\/[a-z0-9.+-]{1,64}(?:;[a-z0-9=.+-]{1,80})?$/i.test(mimeType))
    throw new Error('Unsupported audio type.');
  return { audio: value, mimeType };
}

export function validListeningState(value: unknown): ListeningState {
  if (!listeningStates.has(value as ListeningState)) throw new Error('Invalid listening state.');
  return value as ListeningState;
}

export function validSettings(value: unknown): Partial<BuddySettings> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid settings.');
  const input = value as Record<string, unknown>;
  const allowed = new Set<keyof BuddySettings>(['defaultCwd', 'launchAtLogin', 'wakeWord', 'model', 'autoSpeak']);
  if (Object.keys(input).some((key) => !allowed.has(key as keyof BuddySettings))) throw new Error('Unknown setting.');
  const result: Partial<BuddySettings> = {};
  if ('autoSpeak' in input) {
    if (typeof input.autoSpeak !== 'boolean') throw new Error('Spoken replies must be on or off.');
    result.autoSpeak = input.autoSpeak;
  }
  if ('launchAtLogin' in input) {
    if (typeof input.launchAtLogin !== 'boolean') throw new Error('Launch-at-login must be on or off.');
    result.launchAtLogin = input.launchAtLogin;
  }
  if ('wakeWord' in input) {
    if (typeof input.wakeWord !== 'string' || !input.wakeWord.trim() || input.wakeWord.trim().length > 40)
      throw new Error('Wake word must be between 1 and 40 characters.');
    result.wakeWord = input.wakeWord.trim();
  }
  if ('model' in input) {
    if (typeof input.model !== 'string' || !modelPattern.test(input.model.trim()))
      throw new Error('Enter a valid OpenCode Go model ID.');
    result.model = input.model.trim();
  }
  if ('defaultCwd' in input) {
    if (typeof input.defaultCwd !== 'string' || !input.defaultCwd.trim() || input.defaultCwd.length > 4_096)
      throw new Error('Invalid working folder.');
    const cwd = input.defaultCwd.trim();
    result.defaultCwd = resolve(cwd);
  }
  return result;
}
