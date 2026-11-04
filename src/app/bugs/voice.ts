// The spoken part of a bug report: the microphone, a recording of it, and a live transcript from
// the browser's speech recognition (Chrome sends that audio to its own speech service; ?bugspeech=0
// turns it off, and `node tools/bugs.mjs transcribe` can transcribe voice.wav locally instead).

export interface Segment {
  t0: number; // performance.now() when the phrase began to be heard
  t1: number; // ... and when it was final
  text: string;
  confidence?: number;
  /** Still being worked out when the recording stopped. */
  partial?: boolean;
}

// Just enough of the Web Speech API for this file; TypeScript's DOM library leaves it out.
interface SpeechAlternative {
  transcript: string;
  confidence: number;
}
interface SpeechResult {
  readonly isFinal: boolean;
  readonly length: number;
  [i: number]: SpeechAlternative;
}
interface SpeechResultEvent {
  resultIndex: number;
  results: { length: number; [i: number]: SpeechResult };
}
interface SpeechRec {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechResultEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
}
type SpeechCtor = new () => SpeechRec;

/** Errors that mean speech recognition will not work this time, so stop asking. */
const FATAL = new Set(['not-allowed', 'service-not-allowed', 'language-not-supported', 'audio-capture', 'bad-grammar']);

/** The first of these recording formats the browser can write, or '' for its default. */
export function pickMime(candidates: string[]): string {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const m of candidates) if (MediaRecorder.isTypeSupported(m)) return m;
  return '';
}

/** Stops a MediaRecorder and resolves with everything it recorded. */
export function stopRecorder(rec: MediaRecorder | null, chunks: Blob[]): Promise<Blob | null> {
  if (!rec) return Promise.resolve(null);
  return new Promise((resolve) => {
    const done = () => resolve(chunks.length ? new Blob(chunks, { type: rec.mimeType || chunks[0].type }) : null);
    if (rec.state === 'inactive') return done();
    rec.addEventListener('stop', done, { once: true });
    try {
      rec.stop();
    } catch {
      done();
    }
  });
}

export class Voice {
  stream: MediaStream | null = null;
  /** Why there is no microphone, if there isn't one. */
  micError = '';
  segments: Segment[] = [];
  interim = '';
  /** 'off', 'unavailable', 'listening', or the last error the recognizer gave. */
  speechStatus = 'off';
  /** When the microphone recording began (performance.now()). */
  startedAt = 0;
  onChange: (() => void) | null = null;
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private speech: SpeechRec | null = null;
  private listening = false;
  private speechDead = false;
  private failures = 0;
  private speechEnded: (() => void) | null = null;
  private cancelled = false;
  private interimAt = 0;

  /** Asks for the microphone. False (with micError set) if there is none or it was refused. */
  async open(): Promise<boolean> {
    if (!navigator.mediaDevices?.getUserMedia) {
      this.micError = 'this browser cannot record audio';
      return false;
    }
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (this.cancelled) {
        for (const t of s.getTracks()) t.stop();
        return false;
      }
      this.stream = s;
      return true;
    } catch (e) {
      const name = (e as { name?: string }).name ?? '';
      this.micError = name === 'NotAllowedError' ? 'the microphone was not allowed' : name === 'NotFoundError' ? 'no microphone was found' : String(e);
      return false;
    }
  }

  /** Gives up on a microphone request that hasn't come back yet. */
  cancel(): void {
    this.cancelled = true;
  }

  start(speech: boolean, lang: string): void {
    if (!this.stream) return;
    this.startedAt = performance.now();
    const mime = pickMime(['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']);
    try {
      this.rec = new MediaRecorder(this.stream, mime ? { mimeType: mime, audioBitsPerSecond: 96_000 } : undefined);
      this.rec.ondataavailable = (e) => {
        if (e.data.size) this.chunks.push(e.data);
      };
      this.rec.start(1000);
    } catch (e) {
      this.micError = `could not record the microphone: ${String(e)}`;
      this.rec = null;
    }
    if (speech) this.startSpeech(lang);
  }

  private startSpeech(lang: string): void {
    const w = window as unknown as { SpeechRecognition?: SpeechCtor; webkitSpeechRecognition?: SpeechCtor };
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) {
      this.speechStatus = 'unavailable';
      return;
    }
    this.listening = true;
    this.speechStatus = 'listening';
    this.runSpeech(Ctor, lang);
  }

  private runSpeech(Ctor: SpeechCtor, lang: string): void {
    let r: SpeechRec;
    try {
      r = new Ctor();
    } catch {
      this.speechStatus = 'unavailable';
      return;
    }
    r.lang = lang;
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;
    const began = new Map<number, number>();
    const final = new Set<number>();
    r.onresult = (e) => {
      const now = performance.now();
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const alt = res[0];
        const text = (alt?.transcript ?? '').trim();
        if (!began.has(i)) began.set(i, now);
        if (res.isFinal) {
          if (!final.has(i) && text) {
            final.add(i);
            this.segments.push({ t0: began.get(i)!, t1: now, text, confidence: alt.confidence || undefined });
          }
        } else if (text) {
          interim += (interim ? ' ' : '') + text;
        }
      }
      this.interim = interim;
      this.interimAt = interim ? this.interimAt || now : 0;
      // Hearing something again clears an earlier hiccup (a dropped connection, say).
      this.failures = 0;
      this.speechStatus = 'listening';
      this.onChange?.();
    };
    r.onerror = (e) => {
      // 'no-speech' and 'aborted' are routine; anything else is worth keeping in the report.
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      this.speechStatus = e.error;
      this.failures++;
      if (FATAL.has(e.error)) this.speechDead = true;
    };
    r.onend = () => {
      this.keepInterim();
      if (!this.listening || this.speechDead || this.failures > 5) {
        this.speech = null;
        this.speechEnded?.();
        return;
      }
      // Chrome ends a session after a pause or a minute of talking; keep listening.
      setTimeout(() => {
        if (this.listening) this.runSpeech(Ctor, lang);
        else this.speechEnded?.();
      }, 150);
    };
    try {
      r.start();
      this.speech = r;
    } catch (e) {
      this.speechStatus = `could not start: ${String(e)}`;
      this.speechDead = true;
    }
  }

  /** A phrase that was still being heard when the session ended is better kept than lost. */
  private keepInterim(): void {
    if (!this.interim) return;
    this.segments.push({ t0: this.interimAt || performance.now(), t1: performance.now(), text: this.interim, partial: true });
    this.interim = '';
    this.interimAt = 0;
  }

  /** Stops listening and recording; resolves with the recording (or null). */
  async stop(): Promise<Blob | null> {
    this.cancelled = true;
    this.listening = false;
    // Give the recognizer a moment to hand over the last phrase.
    const ended = this.speech
      ? new Promise<void>((resolve) => {
          this.speechEnded = resolve;
          setTimeout(resolve, 1500);
        })
      : Promise.resolve();
    try {
      this.speech?.stop();
    } catch {
      /* already stopped */
    }
    const audio = await stopRecorder(this.rec, this.chunks);
    await ended;
    this.keepInterim();
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    if (this.speechStatus === 'listening') this.speechStatus = 'ok';
    return audio;
  }
}

export interface WavInfo {
  wav: Blob;
  seconds: number;
  /** Loudest sample and root-mean-square level, 0..1: near zero means the mic heard nothing. */
  peak: number;
  rms: number;
}

/** Decodes a recording and re-encodes it as 16 kHz mono 16-bit WAV, the format whisper.cpp reads. */
export async function toWav(recording: Blob, rate = 16_000): Promise<WavInfo | null> {
  try {
    const ctx = new OfflineAudioContext(1, 1, rate);
    const audio = await ctx.decodeAudioData(await recording.arrayBuffer());
    const n = audio.length;
    const mono = new Float32Array(n);
    for (let c = 0; c < audio.numberOfChannels; c++) {
      const ch = audio.getChannelData(c);
      for (let i = 0; i < n; i++) mono[i] += ch[i] / audio.numberOfChannels;
    }
    let peak = 0;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.abs(mono[i]);
      if (a > peak) peak = a;
      sum += mono[i] * mono[i];
    }
    return { wav: encodeWav(mono, audio.sampleRate), seconds: n / audio.sampleRate, peak, rms: n ? Math.sqrt(sum / n) : 0 };
  } catch {
    return null;
  }
}

function encodeWav(samples: Float32Array, rate: number): Blob {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const text = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  text(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); // bytes per second
  v.setUint16(32, 2, true); // bytes per frame
  v.setUint16(34, 16, true); // bits per sample
  text(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}
