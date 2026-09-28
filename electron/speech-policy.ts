/** Shared producer/consumer contract. Validate whole utterances; never extract a prefix. */
export const speechLimits = { words: 40, sentenceWords: 20, sentences: 2, graphemes: 280, sentenceGraphemes: 160 };
/** Shared writing advice for the parent prompt and tool; validation below is authoritative. */
export const speechWritingGuidance =
  'Write one complete useful thought, usually a sentence of six to twelve words. Use a second short sentence only when needed. Hard limits: 1–2 sentences, 40 words total, 20 per sentence, 280 grapheme clusters total, 160 per sentence. A grapheme is a visible character cluster; Unicode word segmentation counts words, including parts of hyphenated numbers. Plain text only: no code, markup, lists, links, emoji or symbol characters. Write currency, units and symbols as words. Keep essential conditions and approval instructions; if these do not fit, show the full instruction on screen instead. Examples, only when supported by the result: "Both calculations have started." "The report is still being prepared." "The calculation now uses your new numbers." "The backup has stopped. The report is still running." "Please approve deleting the file using the on-screen controls."';
export const speechRecovery =
  'Nothing was spoken. Rewrite the complete thought once, addressing the reason above. Aim for one short sentence; at most two, 40 words total, 20 per sentence, 280 grapheme clusters total, 160 per sentence. Use plain text and write symbols as words. Keep essential conditions and approval instructions. Put full details in show_text. If the rewrite is rejected or cannot preserve meaning, use show_text only; do not keep retrying.';
const words = new Intl.Segmenter('en', { granularity: 'word' });
const sentences = new Intl.Segmenter('en', { granularity: 'sentence' });
const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });
const length = (text: string) => [...graphemes.segment(text)].length;
const wordCount = (text: string) => [...words.segment(text)].filter((part) => part.isWordLike).length;

export type SpeechDecision = { ok: true; text: string } | { ok: false; reason: string };
export function validateSpeech(value: unknown): SpeechDecision {
  const reject = (reason: string): SpeechDecision => ({ ok: false, reason });
  if (typeof value !== 'string' || !value.trim()) return reject('Speech is empty.');
  if (value.length > 2000) return reject('Speech exceeds the input safety bound.');
  // Inspect controls without stripping linguistic ZWNJ/ZWJ from the spoken text.
  if (/[\p{Cc}\p{Cf}]/u.test(value.replace(/[\t\n\r\u200c\u200d]/gu, '')))
    return reject('Speech contains control characters.');
  // Symbols/emoji can expand to long spoken names without consuming word counts.
  if (/[\p{S}\p{Extended_Pictographic}]/u.test(value))
    return reject('Write symbols and emoji as conversational words, or show them on screen.');
  if ([...graphemes.segment(value)].some((part) => [...part.segment].length > 16))
    return reject('Speech contains an unusually large character cluster.');
  const lines = value.replace(/\r\n?/gu, '\n').replace(/\u2028/gu, '\n');
  if (/[`<>{}[\]_|*#\u2029]|(?:^|\n)\s*(?:[-+•]|\d+[.)])\s|\n\s*\n/u.test(lines))
    return reject('Use plain conversational text, without code, lists, paragraphs, or markup.');
  if (/(?:\b[a-z][a-z\d+.-]*:\/\/|\bwww\.|\bmailto:|[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,})/iu.test(lines))
    return reject('Show links and email addresses on screen instead.');
  const text = lines.normalize('NFC').trim().replace(/\s+/gu, ' ');
  if (!wordCount(text)) return reject('Speech needs words.');
  if (length(text) > speechLimits.graphemes || wordCount(text) > speechLimits.words)
    return reject('Speech exceeds the total budget.');
  // ICU understands decimals and Unicode sentence boundaries. Mask common English
  // titles/abbreviations solely for counting; playback always receives original text.
  const counted = text.replace(/\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc)\.|\b(?:[A-Za-z]\.){2,}/gu, (match) =>
    match.replaceAll('.', '·'),
  );
  const parts = [...sentences.segment(counted)].map((part) => part.segment.trim()).filter(Boolean);
  if (parts.length > speechLimits.sentences) return reject('Use at most two sentences.');
  if (
    parts.some((part) => wordCount(part) > speechLimits.sentenceWords || length(part) > speechLimits.sentenceGraphemes)
  )
    return reject('A sentence exceeds its budget.');
  // Bound pathological tokens even for scripts ICU cannot segment confidently.
  if (text.split(/\s+/u).some((part) => /[\p{Script=Latin}\p{N}]/u.test(part) && length(part) > 48))
    return reject('Use conversational words rather than long tokens.');
  return { ok: true, text };
}
