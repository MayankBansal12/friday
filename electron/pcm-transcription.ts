/** The normal interactive path is mono PCM16 at 16 kHz, never encoded audio. */
export interface PcmRequest {
  segment: string;
  revision: number;
  coverage: number;
  audio: ArrayBuffer;
}
export interface PcmResult {
  segment: string;
  revision: number;
  coverage: number;
  text: string;
  inferenceMs: number;
  cancelled?: boolean;
}
export function validPcmRequest(value: unknown): PcmRequest {
  if (!value || typeof value !== 'object') throw new Error('Invalid PCM request.');
  const v = value as PcmRequest;
  if (
    typeof v.segment !== 'string' ||
    !/^[a-zA-Z0-9-]{1,80}$/.test(v.segment) ||
    !Number.isSafeInteger(v.revision) ||
    v.revision < 1 ||
    !Number.isSafeInteger(v.coverage) ||
    v.coverage < 1 ||
    v.coverage > 400_000 ||
    !(v.audio instanceof ArrayBuffer) ||
    v.audio.byteLength !== v.coverage * 2
  )
    throw new Error('Invalid or oversized PCM request.');
  return v;
}
