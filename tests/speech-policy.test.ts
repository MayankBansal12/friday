import { describe, expect, it } from 'vitest';
import { validateSpeech } from '../electron/speech-policy.js';

describe('whole-utterance speech policy', () => {
  it.each([
    'Open Settings. Choose Sound.',
    'Ask Dr. Smith before proceeding. The estimate is 3.5 hours.',
    'The U.S. office is closed. Try tomorrow.',
    '¿Quieres continuar? Revisa los detalles primero.',
    '設定を開いてください。音声を選んでください。',
    'افتح الإعدادات. اختر الصوت.',
    'सेटिंग्स खोलें। ध्वनि चुनें।',
    'تنظیمات را باز می\u200cکنیم.',
    'Please approve deleting the selected file using the on-screen controls.',
    "Don't delete anything until you approve it.",
  ])('accepts intact concise prose: %s', (text) => {
    expect(validateSpeech(text)).toEqual({ ok: true, text });
  });
  it('normalizes whitespace and composed Unicode without removing words', () => {
    expect(validateSpeech('  Cafe\u0301 is ready.\nPlease wait. ')).toEqual({
      ok: true,
      text: 'Café is ready. Please wait.',
    });
  });
  it.each([
    Array(21).fill('word').join(' ') + '.',
    'First. Second. Third.',
    '先'.repeat(161),
    'x'.repeat(49),
    'Click **Delete**.',
    'Run `rm file`.',
    '# Results\n- Delete the file',
    'Read https://example.com.',
    'Approve [this](example).',
    'Do this.\n\nBut only after approval.',
    'Ignore\u202e this.',
    '',
    'Done ' + '👍'.repeat(150),
    'a'.repeat(60) + '+' + 'b'.repeat(60),
    'Set x=' + 'a'.repeat(72) + ' now.',
    'e' + '\u0301'.repeat(100),
    'Visit www.example.com.',
    'Use ftp://example.com.',
    'Email me@example.com.',
    'Open\u200bSettings.',
    'Open \u200f Settings.',
    'Open \u061c Settings.',
    'Open Settings.\r\rChoose Sound.',
    'Open Settings.\r\n\r\nChoose Sound.',
    'Open Settings.\u2029Choose Sound.',
    '😀',
  ])('rejects the whole text rather than truncating: %s', (text) => {
    expect(validateSpeech(text).ok).toBe(false);
  });
  it('accepts exactly two twenty-word sentences and rejects a longer total', () => {
    const sentence = ['Go', ...Array(19).fill('go')].join(' ') + '.';
    expect(validateSpeech(`${sentence} ${sentence}`).ok).toBe(true);
    expect(validateSpeech(`${sentence} ${sentence} Now.`).ok).toBe(false);
  });
});
