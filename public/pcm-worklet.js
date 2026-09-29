/* global AudioWorkletProcessor, sampleRate, registerProcessor */
/* Mono, anti-aliased 16 kHz PCM capture. Runs on the audio rendering thread.
 * 64-tap windowed-sinc polyphase FIR; phase and history persist across render quanta.
 * No audio is forwarded while paused; bounded credits detect a stalled renderer.
 */
// 100 x 20 ms / 640 bytes: tolerate up to two seconds of unacknowledged
// PCM (64 KB) while keeping a hard limit. This is a reserve, not added latency.
const FRAME_CREDITS = 100;
class FridayPcm extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.filters = Array.from({ length: 256 }, (_, phase) => {
      const coefficients = new Float64Array(64);
      const cutoff = Math.min(1, 1 / this.ratio) * 0.9;
      let sum = 0;
      for (let i = 0; i < 64; i++) {
        const x = i - 31 - phase / 256;
        const sinc = Math.abs(x) < 1e-9 ? cutoff : Math.sin(Math.PI * cutoff * x) / (Math.PI * x);
        coefficients[i] = sinc * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / 63));
        sum += coefficients[i];
      }
      return coefficients.map((v) => v / sum);
    });
    this.enabled = false;
    this.port.onmessage = ({ data }) => {
      if (data.type === 'start') {
        this.token = data.token;
        this.ring = new Float32Array(256);
        this.written = 0;
        this.position = 0;
        this.frame = new Int16Array(320);
        this.used = 0;
        this.credits = FRAME_CREDITS;
        this.enabled = true;
      } else if (data.token === this.token) {
        if (data.type === 'flush' && this.enabled) {
          this.process([[new Float32Array(64)]]);
          // Tail processing may itself exhaust the reserve. Never acknowledge
          // a complete flush after overflow or send an uncredited partial frame.
          if (!this.enabled || (this.used && !this.postFrame())) return;
          this.enabled = false;
          this.port.postMessage({ type: 'flushed', token: this.token });
        }
        if (data.type === 'pause') this.enabled = false;
        if (data.type === 'ack') this.credits = Math.min(FRAME_CREDITS, this.credits + 1);
      }
    };
  }
  postFrame() {
    if (!this.credits) {
      this.enabled = false;
      this.port.postMessage({ type: 'overflow', token: this.token });
      return false;
    }
    this.credits--;
    this.port.postMessage({ type: 'frame', token: this.token, audio: this.frame.buffer }, [this.frame.buffer]);
    this.frame = new Int16Array(320);
    this.used = 0;
    return true;
  }
  process(inputs) {
    if (!this.enabled) return true;
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let mono = 0;
      for (const channel of channels) mono += channel[i] / channels.length;
      this.ring[this.written++ % 256] = Number.isFinite(mono) ? mono : 0;
      while (Math.floor(this.position) + 32 < this.written) {
        const center = Math.floor(this.position);
        const filter = this.filters[Math.floor((this.position - center) * 256)];
        let sample = 0;
        for (let tap = 0; tap < 64; tap++) {
          const index = center + tap - 31;
          if (index >= 0) sample += this.ring[index % 256] * filter[tap];
        }
        this.frame[this.used++] = Math.round(Math.max(-1, Math.min(1, sample)) * 32767);
        this.position += this.ratio;
        if (this.used === 320) {
          if (!this.postFrame()) return true;
        }
      }
    }
    return true;
  }
}
registerProcessor('friday-pcm', FridayPcm);
