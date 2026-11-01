/**
 * REF-01 // Unified Web Audio API DSP Graph & Telemetry Engine
 *
 * Routing architecture:
 *   [AudioBufferSourceNode / MediaElementAudioSourceNode] ─┐
 *   [ReferenceSynth (Procedural Loop)]                    ─┴─► masterInputGain
 *     ─► brickwallSimulatorFilter (cascaded 15.8 kHz low-pass filter bank)
 *     ─► masterAnalyserBus
 *          ├─► masterAnalyser (fftSize = 8192, smoothingTimeConstant = 0.75)
 *          ├─► ChannelSplitterNode(2)
 *          │     ├─► leftAnalyser  (fftSize = 2048, time-domain & peak/RMS)
 *          │     └─► rightAnalyser (fftSize = 2048, time-domain & peak/RMS)
 *          └─► monitorGain ─► ctx.destination
 */

import { Emitter } from '../util/emitter';
import { clamp, dbToGain, gainToDb } from '../util/format';
import { decodePcm, FilePassport, inspectFile } from './fileinfo';
import { ReferenceSynth } from './synth';

export type DiagnosticClass = 'idle' | 'lossless' | 'lossy' | 'transcode';

export interface TelemetryFrame {
  /** Whether audio (file or synth) is currently playing. */
  active: boolean;
  /** AudioContext sample rate (Hz). */
  sampleRate: number;
  /** Nyquist frequency (Hz). */
  nyquist: number;
  /** Live FFT magnitude spectrum in dBFS (length = 4096 for fftSize 8192). */
  fftDb: Float32Array;
  /** Persistent Peak-Hold spectrum envelope in dBFS (length = 4096). */
  maxSpectrumHold: Float32Array;
  /** Left channel time-domain samples (-1..+1, length = 2048). */
  timeL: Float32Array;
  /** Right channel time-domain samples (-1..+1, length = 2048). */
  timeR: Float32Array;

  // Module 01: Transcode & Cutoff Radar
  /** Instantaneous roll-off frequency (Hz) where spectrum stays above -78 dBFS. */
  liveCutoffHz: number;
  /** Peak-locked maximum ceiling frequency (Hz) captured in maxSpectrumHold above -78 dBFS. */
  peakCeilingHz: number;
  /** Seconds of active signal accumulated since last peak reset. */
  acquiredSeconds: number;
  /** Diagnostic classification based on Peak Ceiling. */
  diagnostic: DiagnosticClass;
  /** Spectral centroid in Hz. */
  spectralCentroidHz: number;
  /** Dynamic crest factor (Peak dB − RMS dB). */
  dynamicCrestDb: number;
  /** Ratio of energy above 16 kHz to total broadband energy (0..100 %). */
  hfEnergyRatioPct: number;
  /** Integrated RMS level of bins above 16 kHz in dBFS. */
  hfEnergyDb: number;

  // Multi-band energy for 3D Ferrofluid Acoustic Core (0..1 normalized + dB)
  subEnergy: number;
  subDb: number;
  midEnergy: number;
  midDb: number;
  highEnergy: number;
  highDb: number;

  // Module 04: Lissajous & Phase Correlation
  /** Smoothed Pearson phase correlation (-1..+1). */
  phaseCorrelation: number;
  /** Stereo width percentage (0..100+ % based on Side/Mid energy). */
  stereoWidthPct: number;

  // Module 05: Dual-Channel Precision Peak, RMS & Loudness
  peakDbL: number;
  peakDbR: number;
  rmsDbL: number;
  rmsDbR: number;
  peakHoldDbL: number;
  peakHoldDbR: number;
  clipL: boolean;
  clipR: boolean;
  /** Momentary (400 ms), Short-Term (3 s) and Integrated K-weighted loudness estimates (LUFS). */
  lufsMomentary: number;
  lufsShortTerm: number;
  lufsIntegrated: number;
  /** Peak-to-Loudness Ratio (Peak dBFS − Integrated LUFS). */
  plrDb: number;
}

export interface EngineEvents {
  state: {
    playing: boolean;
    synthActive: boolean;
    transcodeSim: boolean;
    loop: boolean;
    fileName: string | null;
    passport: FilePassport | null;
  };
  waveform: {
    peaksMin: Float32Array;
    peaksMax: Float32Array;
    duration: number;
  };
  status: string;
}

const FFT_SIZE = 8192;
const TD_SIZE = 2048;
/** Cutoff threshold specified in Module 01: -78 dBFS. */
export const RADAR_THRESHOLD_DB = -78;

export class AudioEngine extends Emitter<EngineEvents> {
  private ctx: AudioContext | null = null;
  private masterInputGain: GainNode | null = null;
  /** Two primary cascaded low-pass BiquadFilterNodes + steepening cascade. */
  private brickwallFilters: BiquadFilterNode[] = [];
  /** Stopband elliptic notch filters (switched to allpass when simulator is OFF). */
  private stopbandNotches: BiquadFilterNode[] = [];
  private masterAnalyserBus: GainNode | null = null;
  private masterAnalyser: AnalyserNode | null = null;
  private splitter: ChannelSplitterNode | null = null;
  private leftAnalyser: AnalyserNode | null = null;
  private rightAnalyser: AnalyserNode | null = null;
  private monitorGain: GainNode | null = null;
  private synth: ReferenceSynth | null = null;

  // File playback state
  private audioBuffer: AudioBuffer | null = null;
  private bufferSource: AudioBufferSourceNode | null = null;
  private fileName: string | null = null;
  private passport: FilePassport | null = null;
  private playStartCtxTime = 0;
  private pauseOffset = 0;
  private isPlayingFile = false;
  private loopFile = true;
  private synthActive = false;
  private transcodeSim = false;
  private monitorDb = -6;

  // Pre-allocated typed arrays for zero-GC 60fps analysis
  private readonly fftDb = new Float32Array(FFT_SIZE / 2);
  private readonly maxSpectrumHold = new Float32Array(FFT_SIZE / 2);
  private readonly timeL = new Float32Array(TD_SIZE);
  private readonly timeR = new Float32Array(TD_SIZE);
  /** Rolling waveform peaks when Synth Test Loop is active. */
  private readonly synthWaveMin = new Float32Array(600);
  private readonly synthWaveMax = new Float32Array(600);
  private synthWaveWrite = 0;

  // Smoothed & latched telemetry state
  private peakHoldDbL = -Infinity;
  private peakHoldDbR = -Infinity;
  private peakHoldTimeL = 0;
  private peakHoldTimeR = 0;
  private clipL = false;
  private clipR = false;
  private smoothedCorr = 0;
  private smoothedWidth = 0;
  private smoothedCrest = 0;
  private smoothedCentroid = 0;
  private smoothedLiveCutoff = 0;
  private peakCeilingHz = 0;
  private acquiredSeconds = 0;
  private lastFrameSec = 0;

  // Short-term (3 s @ 60 fps = 180 frames) and Momentary (400 ms = 24 frames) K-weighted power rings
  private readonly momRing = new Float32Array(24);
  private readonly stRing = new Float32Array(180);
  private momIdx = 0;
  private stIdx = 0;
  private momCount = 0;
  private stCount = 0;
  private integratedPowerSum = 0;
  private integratedPowerCount = 0;

  constructor() {
    super();
    this.maxSpectrumHold.fill(-120);
  }

  /** Lazily initialize or resume the Web Audio graph on user gesture. */
  ensureContext(): AudioContext {
    if (!this.ctx) {
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctor({ latencyHint: 'interactive' });
      this.ctx = ctx;

      this.masterInputGain = ctx.createGain();
      this.masterInputGain.gain.value = 1.0;

      // Brickwall Transcode Simulator:
      // Two primary cascaded low-pass BiquadFilterNode units (plus 4 auxiliary
      // cascaded Butterworth stages in series so the 15.8 kHz roll-off reaches
      // below -85 dBFS by 16.2 kHz, matching a true MP3 128 kbps polyphase/MDCT shelf).
      // Note: Web Audio lowpass BiquadFilterNode Q parameter is in dB; Butterworth Q = -3.0103 dB.
      const qDbValues = [-5.0, 3.5, -5.0, 3.5, -3.0, 5.5];
      this.brickwallFilters = qDbValues.map((qDb) => {
        const f = ctx.createBiquadFilter();
        f.type = 'lowpass';
        f.Q.value = qDb;
        f.frequency.value = Math.min(22050, ctx.sampleRate * 0.495);
        return f;
      });

      const notchSpecs: Array<[number, number]> = [
        [16300, 7.5],
        [16750, 4.8],
        [17450, 3.2],
        [18700, 2.0],
      ];
      this.stopbandNotches = notchSpecs.map(([freq, q]) => {
        const n = ctx.createBiquadFilter();
        n.type = 'allpass';
        n.frequency.value = freq;
        n.Q.value = q;
        return n;
      });

      this.masterAnalyserBus = ctx.createGain();
      this.masterAnalyserBus.gain.value = 1.0;

      // Wire masterInputGain -> cascaded low-pass filters -> stopband notches -> masterAnalyserBus
      let head: AudioNode = this.masterInputGain;
      for (const f of this.brickwallFilters) {
        head.connect(f);
        head = f;
      }
      for (const n of this.stopbandNotches) {
        head.connect(n);
        head = n;
      }
      head.connect(this.masterAnalyserBus);

      // Master high-resolution FFT analyser
      this.masterAnalyser = ctx.createAnalyser();
      this.masterAnalyser.fftSize = FFT_SIZE;
      this.masterAnalyser.smoothingTimeConstant = 0.75;
      this.masterAnalyser.minDecibels = -110;
      this.masterAnalyser.maxDecibels = 0;

      // True stereo splitter + L/R analysers
      this.splitter = ctx.createChannelSplitter(2);
      this.leftAnalyser = ctx.createAnalyser();
      this.rightAnalyser = ctx.createAnalyser();
      this.leftAnalyser.fftSize = TD_SIZE;
      this.rightAnalyser.fftSize = TD_SIZE;
      this.leftAnalyser.smoothingTimeConstant = 0.2;
      this.rightAnalyser.smoothingTimeConstant = 0.2;

      this.monitorGain = ctx.createGain();
      this.monitorGain.gain.value = dbToGain(this.monitorDb);

      this.masterAnalyserBus.connect(this.masterAnalyser);
      this.masterAnalyserBus.connect(this.splitter);
      this.splitter.connect(this.leftAnalyser, 0);
      this.splitter.connect(this.rightAnalyser, 1);
      this.masterAnalyserBus.connect(this.monitorGain);
      this.monitorGain.connect(ctx.destination);

      // Connect procedural reference synth into the unified masterInputGain
      this.synth = new ReferenceSynth(ctx);
      this.synth.output.connect(this.masterInputGain);

      this.applyTranscodeFilter(false);
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
    return this.ctx;
  }

  get context(): AudioContext | null {
    return this.ctx;
  }

  get isActive(): boolean {
    return this.isPlayingFile || this.synthActive;
  }

  get isPlaying(): boolean {
    return this.isPlayingFile;
  }

  get isSynthActive(): boolean {
    return this.synthActive;
  }

  get isTranscodeSim(): boolean {
    return this.transcodeSim;
  }

  get isLoop(): boolean {
    return this.loopFile;
  }

  get hasFile(): boolean {
    return this.audioBuffer !== null;
  }

  get duration(): number {
    if (this.synthActive && !this.isPlayingFile) return 15.48387; // 8 bars @ 124 BPM
    return this.audioBuffer?.duration ?? 0;
  }

  get currentTime(): number {
    if (this.synthActive && !this.isPlayingFile && this.synth) {
      const loopDur = 15.48387;
      return this.synth.elapsed % loopDur;
    }
    if (!this.audioBuffer) return 0;
    if (!this.isPlayingFile || !this.ctx) return this.pauseOffset;
    const elapsed = this.ctx.currentTime - this.playStartCtxTime;
    const dur = this.audioBuffer.duration;
    if (dur <= 0) return 0;
    return this.loopFile ? ((elapsed % dur) + dur) % dur : Math.min(dur, elapsed);
  }

  setMonitorDb(db: number): void {
    this.monitorDb = clamp(db, -60, 0);
    if (this.monitorGain && this.ctx) {
      const gain = this.monitorDb <= -59.5 ? 0 : dbToGain(this.monitorDb);
      this.monitorGain.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.015);
    }
  }

  /** Toggle the 128 kbps MP3 brickwall cutoff simulator (15.8 kHz cascade). */
  setTranscodeSim(enabled: boolean): void {
    this.ensureContext();
    this.transcodeSim = enabled;
    this.applyTranscodeFilter(true);
    // Reset Peak-Hold & Peak Ceiling so the new spectral ceiling locks immediately
    this.maxSpectrumHold.fill(-120);
    this.peakCeilingHz = 0;
    this.acquiredSeconds = 0;
    this.emitState();
    this.emit(
      'status',
      enabled
        ? '16kHz Transcode Simulator ENGAGED — cascaded 15.8 kHz low-pass brickwall active on master DSP bus.'
        : '16kHz Transcode Simulator BYPASSED — full 22.05 kHz passband restored.',
    );
  }

  private applyTranscodeFilter(smooth: boolean): void {
    if (!this.ctx || this.brickwallFilters.length === 0) return;
    const t = this.ctx.currentTime;
    const nyqSafe = Math.min(22050, this.ctx.sampleRate * 0.495);
    // When ON: 15800 Hz cutoff across cascaded stages with steep roll-off.
    // When OFF: 22050 Hz (clamped to safe Nyquist) with flat passband.
    const targetHz = this.transcodeSim ? 15800 : nyqSafe;
    const qOn = [-5.0, 3.5, -5.0, 3.5, -3.0, 5.5];
    const qOff = [-3.01, -3.01, -3.01, -3.01, -3.01, -3.01];
    this.brickwallFilters.forEach((f, i) => {
      const q = this.transcodeSim ? qOn[i] : qOff[i];
      f.frequency.cancelScheduledValues(t);
      f.Q.cancelScheduledValues(t);
      if (smooth) {
        f.frequency.setTargetAtTime(targetHz, t, 0.012);
        f.Q.setTargetAtTime(q, t, 0.012);
      } else {
        f.frequency.setValueAtTime(targetHz, t);
        f.Q.setValueAtTime(q, t);
      }
    });
    for (const n of this.stopbandNotches) {
      n.type = this.transcodeSim ? 'notch' : 'allpass';
    }
  }

  /** Toggle procedural reference synthesizer loop. */
  setSynthActive(active: boolean): void {
    this.ensureContext();
    if (active === this.synthActive) return;
    if (active && this.isPlayingFile) {
      this.stopBufferSource(true);
    }
    this.synthActive = active;
    if (active) {
      this.synth?.start();
      this.resetPeaks();
      const sr = this.ctx!.sampleRate;
      const synthPassport: FilePassport = {
        container: 'INTERNAL DSP',
        codec: 'SYNTH 32-BIT FLOAT',
        sampleRate: sr,
        channels: 2,
        bitDepth: 32,
        bitrateKbps: Math.round((sr * 2 * 32) / 1000),
        vbr: false,
        duration: 15.48387,
        pcm: null,
      };
      this.emit('state', {
        playing: this.isPlayingFile,
        synthActive: true,
        transcodeSim: this.transcodeSim,
        loop: this.loopFile,
        fileName: 'REF-01 // INTERNAL REFERENCE SYNTH (124 BPM)',
        passport: synthPassport,
      });
      this.emit('status', 'Reference Synth Loop active — 55 Hz sub-bass + wide stereo chords + 22 kHz white-noise hi-hats.');
    } else {
      this.synth?.stop();
      this.emitState();
      this.emit('status', 'Reference Synth Loop stopped.');
    }
  }

  /** Decode and load a local audio file (WAV, FLAC, AIFF, MP3, OGG, M4A). */
  async loadFile(file: File): Promise<void> {
    const ctx = this.ensureContext();
    this.emit('status', `Decoding "${file.name}" (${(file.size / (1024 * 1024)).toFixed(2)} MB)...`);

    if (this.synthActive) {
      this.synth?.stop();
      this.synthActive = false;
    }
    this.stopBufferSource(false);

    const rawBuffer = await file.arrayBuffer();
    const passport = inspectFile(rawBuffer, file.name);

    let decoded: AudioBuffer | null = null;
    const isAiff = passport.container === 'AIFF' || passport.container === 'AIFF-C';

    // Try native PCM decode first for AIFF/AIFC (not natively supported by Chromium decodeAudioData).
    if (isAiff && passport.pcm) {
      try {
        decoded = decodePcm(rawBuffer, passport.pcm, ctx);
      } catch {
        decoded = null;
      }
    }

    if (!decoded) {
      try {
        // Slice buffer because decodeAudioData detaches its input ArrayBuffer.
        decoded = await ctx.decodeAudioData(rawBuffer.slice(0));
      } catch (err) {
        if (passport.pcm) {
          decoded = decodePcm(rawBuffer, passport.pcm, ctx);
        } else {
          const msg = err instanceof Error ? err.message : 'Unsupported audio encoding';
          this.emit('status', `ERROR decoding "${file.name}": ${msg}`);
          throw err;
        }
      }
    }

    this.audioBuffer = decoded;
    this.fileName = file.name;
    passport.duration = decoded.duration;
    if (!passport.sampleRate) passport.sampleRate = decoded.sampleRate;
    if (!passport.channels) passport.channels = decoded.numberOfChannels;
    if (!passport.bitrateKbps && decoded.duration > 0) {
      passport.bitrateKbps = Math.round((file.size * 8) / decoded.duration / 1000);
    }
    this.passport = passport;
    this.pauseOffset = 0;

    this.resetPeaks();
    this.computeWaveformPeaks(decoded);
    this.startBufferSource(0);
    this.emitState();
    this.emit(
      'status',
      `Loaded "${file.name}" — ${passport.container} · ${passport.codec} · ${(passport.sampleRate / 1000).toFixed(1)} kHz · ${decoded.numberOfChannels} ch.`,
    );
  }

  play(): void {
    this.ensureContext();
    if (!this.audioBuffer) {
      if (!this.synthActive) this.setSynthActive(true);
      return;
    }
    if (this.synthActive) {
      this.synth?.stop();
      this.synthActive = false;
    }
    if (!this.isPlayingFile) {
      this.startBufferSource(this.pauseOffset);
      this.emitState();
    }
  }

  pause(): void {
    if (!this.isPlayingFile) return;
    this.stopBufferSource(true);
    this.emitState();
  }

  togglePlay(): void {
    if (this.synthActive && !this.audioBuffer) {
      this.setSynthActive(false);
      return;
    }
    if (this.isPlayingFile) this.pause();
    else this.play();
  }

  stop(): void {
    if (this.synthActive) {
      this.synth?.stop();
      this.synthActive = false;
    }
    this.stopBufferSource(false);
    this.pauseOffset = 0;
    this.emitState();
    this.emit('status', 'Transport stopped — playhead returned to 00:00.000.');
  }

  setLoop(loop: boolean): void {
    this.loopFile = loop;
    if (this.bufferSource) {
      this.bufferSource.loop = loop;
    }
    this.emitState();
  }

  seek(seconds: number): void {
    if (!this.audioBuffer) return;
    const clamped = clamp(seconds, 0, Math.max(0, this.audioBuffer.duration - 0.001));
    this.pauseOffset = clamped;
    if (this.isPlayingFile) {
      this.startBufferSource(clamped);
    }
  }

  /** Reset all peak-hold traces, radar max ceiling, clip latches, and integrated loudness. */
  resetPeaks(): void {
    this.maxSpectrumHold.fill(-120);
    this.peakCeilingHz = 0;
    this.acquiredSeconds = 0;
    this.peakHoldDbL = -Infinity;
    this.peakHoldDbR = -Infinity;
    this.clipL = false;
    this.clipR = false;
    this.integratedPowerSum = 0;
    this.integratedPowerCount = 0;
    this.momCount = 0;
    this.stCount = 0;
  }

  resetClip(channel: 'L' | 'R' | 'both' = 'both'): void {
    if (channel === 'L' || channel === 'both') this.clipL = false;
    if (channel === 'R' || channel === 'both') this.clipR = false;
  }

  private startBufferSource(offset: number): void {
    if (!this.ctx || !this.audioBuffer || !this.masterInputGain) return;
    this.stopBufferSource(false);

    const src = this.ctx.createBufferSource();
    src.buffer = this.audioBuffer;
    src.loop = this.loopFile;
    src.connect(this.masterInputGain);
    src.onended = () => {
      if (this.bufferSource === src && !this.loopFile) {
        this.isPlayingFile = false;
        this.pauseOffset = 0;
        this.bufferSource = null;
        this.emitState();
      }
    };
    const now = this.ctx.currentTime;
    src.start(now, offset);
    this.bufferSource = src;
    this.playStartCtxTime = now - offset;
    this.isPlayingFile = true;
  }

  private stopBufferSource(saveOffset: boolean): void {
    if (saveOffset && this.isPlayingFile && this.ctx && this.audioBuffer) {
      const elapsed = this.ctx.currentTime - this.playStartCtxTime;
      const dur = this.audioBuffer.duration;
      this.pauseOffset = this.loopFile && dur > 0 ? ((elapsed % dur) + dur) % dur : clamp(elapsed, 0, dur);
    }
    if (this.bufferSource) {
      const src = this.bufferSource;
      this.bufferSource = null;
      src.onended = null;
      try {
        src.stop();
        src.disconnect();
      } catch {
        // Ignore if already stopped
      }
    }
    this.isPlayingFile = false;
  }

  private computeWaveformPeaks(buffer: AudioBuffer): void {
    const buckets = 900;
    const minArr = new Float32Array(buckets);
    const maxArr = new Float32Array(buckets);
    const ch0 = buffer.getChannelData(0);
    const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : ch0;
    const total = buffer.length;
    const step = Math.max(1, Math.floor(total / buckets));

    for (let b = 0; b < buckets; b++) {
      const start = b * step;
      const end = Math.min(total, start + step);
      // Sample up to 256 points per bucket for instant computation on large FLAC/WAV files
      const stride = Math.max(1, Math.floor((end - start) / 256));
      let lo = 1;
      let hi = -1;
      for (let i = start; i < end; i += stride) {
        const v = 0.5 * (ch0[i] + ch1[i]);
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      minArr[b] = lo > hi ? 0 : lo;
      maxArr[b] = hi < lo ? 0 : hi;
    }

    this.emit('waveform', {
      peaksMin: minArr,
      peaksMax: maxArr,
      duration: buffer.duration,
    });
  }

  private emitState(): void {
    this.emit('state', {
      playing: this.isPlayingFile,
      synthActive: this.synthActive,
      transcodeSim: this.transcodeSim,
      loop: this.loopFile,
      fileName: this.fileName,
      passport: this.passport,
    });
  }

  /**
   * Sample all Web Audio analyser nodes and compute every DSP metric for the current 60fps frame.
   */
  sample(nowMs: number): TelemetryFrame {
    const nowSec = nowMs * 0.001;
    const dt = this.lastFrameSec > 0 ? clamp(nowSec - this.lastFrameSec, 0.001, 0.1) : 1 / 60;
    this.lastFrameSec = nowSec;

    const sr = this.ctx?.sampleRate ?? 48000;
    const nyquist = sr * 0.5;
    const bins = this.fftDb.length; // 4096
    const binHz = nyquist / bins;
    const active = this.isActive;

    if (this.masterAnalyser && this.leftAnalyser && this.rightAnalyser && active) {
      this.masterAnalyser.getFloatFrequencyData(this.fftDb);
      this.leftAnalyser.getFloatTimeDomainData(this.timeL);
      this.rightAnalyser.getFloatTimeDomainData(this.timeR);
    } else {
      // Gentle decay when paused/idle
      for (let i = 0; i < bins; i++) {
        this.fftDb[i] = Math.max(-120, this.fftDb[i] - 90 * dt);
      }
      for (let i = 0; i < TD_SIZE; i++) {
        this.timeL[i] *= 0.78;
        this.timeR[i] *= 0.78;
      }
    }

    // ── Time-domain Peak, RMS, Phase Correlation & Stereo Width ──
    let peakL = 0;
    let peakR = 0;
    let sumSqL = 0;
    let sumSqR = 0;
    let sumLR = 0;
    let sumMidSq = 0;
    let sumSideSq = 0;

    for (let i = 0; i < TD_SIZE; i++) {
      const l = this.timeL[i];
      const r = this.timeR[i];
      const al = Math.abs(l);
      const ar = Math.abs(r);
      if (al > peakL) peakL = al;
      if (ar > peakR) peakR = ar;
      sumSqL += l * l;
      sumSqR += r * r;
      sumLR += l * r;
      const m = (l + r) * 0.70710678;
      const s = (r - l) * 0.70710678;
      sumMidSq += m * m;
      sumSideSq += s * s;
    }

    const rmsL = Math.sqrt(sumSqL / TD_SIZE);
    const rmsR = Math.sqrt(sumSqR / TD_SIZE);
    const peakDbL = gainToDb(peakL);
    const peakDbR = gainToDb(peakR);
    const rmsDbL = gainToDb(rmsL);
    const rmsDbR = gainToDb(rmsR);

    // Update synth rolling waveform buffer when in Synth mode
    if (this.synthActive && !this.isPlayingFile) {
      this.synthWaveMin[this.synthWaveWrite] = -Math.max(peakL, peakR);
      this.synthWaveMax[this.synthWaveWrite] = Math.max(peakL, peakR);
      this.synthWaveWrite = (this.synthWaveWrite + 1) % this.synthWaveMin.length;
    }

    // Clip latching (>= -0.1 dBFS)
    if (peakDbL >= -0.1) this.clipL = true;
    if (peakDbR >= -0.1) this.clipR = true;

    // Peak Hold with 1.8 s hold time then 12 dB/s falloff
    if (peakDbL >= this.peakHoldDbL) {
      this.peakHoldDbL = peakDbL;
      this.peakHoldTimeL = nowSec;
    } else if (nowSec - this.peakHoldTimeL > 1.8) {
      this.peakHoldDbL = Math.max(peakDbL, this.peakHoldDbL - 12 * dt);
    }
    if (peakDbR >= this.peakHoldDbR) {
      this.peakHoldDbR = peakDbR;
      this.peakHoldTimeR = nowSec;
    } else if (nowSec - this.peakHoldTimeR > 1.8) {
      this.peakHoldDbR = Math.max(peakDbR, this.peakHoldDbR - 12 * dt);
    }

    // Pearson Phase Correlation
    const denom = Math.sqrt(sumSqL * sumSqR);
    if (denom > 1e-7) {
      const rawCorr = clamp(sumLR / denom, -1, 1);
      this.smoothedCorr += (rawCorr - this.smoothedCorr) * Math.min(1, dt * 12);
    } else if (!active) {
      this.smoothedCorr *= 0.95;
    }

    // Stereo Width %: 0% = pure mono, 100% = equal Mid/Side energy
    const totalMS = sumMidSq + sumSideSq;
    if (totalMS > 1e-7) {
      const rawWidth = clamp((Math.sqrt(sumSideSq / totalMS) / 0.70710678) * 100, 0, 150);
      this.smoothedWidth += (rawWidth - this.smoothedWidth) * Math.min(1, dt * 10);
    } else if (!active) {
      this.smoothedWidth *= 0.94;
    }

    // Dynamic Crest Factor (dB)
    const maxPeakDb = Math.max(peakDbL, peakDbR);
    const avgRmsDb = gainToDb(Math.sqrt(0.5 * (sumSqL + sumSqR) / TD_SIZE));
    if (avgRmsDb > -75 && maxPeakDb > -75) {
      const rawCrest = Math.max(0, maxPeakDb - avgRmsDb);
      this.smoothedCrest += (rawCrest - this.smoothedCrest) * Math.min(1, dt * 8);
    }

    // ── Spectral Analysis: Peak-Hold, Cutoff Radar, Centroid, HF Ratio & Multi-Band Energy ──
    let liveCutoffBin = 0;
    let holdCutoffBin = 0;
    let weightedFreqSum = 0;
    let magSum = 0;
    let totalPower = 0;
    let hfPower = 0;

    let subPower = 0;
    let subBins = 0;
    let midPower = 0;
    let midBins = 0;
    let highPower = 0;
    let highBins = 0;

    const signalPresent = avgRmsDb > -70 && active;
    if (signalPresent) {
      this.acquiredSeconds += dt;
    }

    // Require 3 adjacent bins or smoothed continuity above -78 dBFS to reject isolated 1-bin quantization spikes
    const maxValidBin = Math.min(bins - 1, Math.floor(22050 / binHz));

    for (let i = 1; i <= maxValidBin; i++) {
      const db = this.fftDb[i];
      const f = i * binHz;

      if (signalPresent && db > this.maxSpectrumHold[i]) {
        this.maxSpectrumHold[i] = db;
      }

      // Check 2-bin neighborhood average against RADAR_THRESHOLD_DB (-78 dBFS)
      const prevDb = this.fftDb[i - 1];
      if (0.5 * (db + prevDb) >= RADAR_THRESHOLD_DB) {
        liveCutoffBin = i;
      }
      if (0.5 * (this.maxSpectrumHold[i] + this.maxSpectrumHold[i - 1]) >= RADAR_THRESHOLD_DB) {
        holdCutoffBin = i;
      }

      if (db > -110) {
        const mag = Math.pow(10, db / 20);
        const pwr = mag * mag;
        weightedFreqSum += f * mag;
        magSum += mag;
        totalPower += pwr;
        if (f >= 16000) {
          hfPower += pwr;
        }
        if (f >= 20 && f <= 120) {
          subPower += pwr;
          subBins++;
        } else if (f > 120 && f <= 4000) {
          midPower += pwr;
          midBins++;
        } else if (f >= 8000 && f <= 22050) {
          highPower += pwr;
          highBins++;
        }
      }
    }

    const rawLiveCutoff = liveCutoffBin * binHz;
    if (signalPresent) {
      this.smoothedLiveCutoff += (rawLiveCutoff - this.smoothedLiveCutoff) * Math.min(1, dt * 14);
    } else {
      this.smoothedLiveCutoff *= 0.94;
    }

    const holdHz = holdCutoffBin * binHz;
    if (holdHz > this.peakCeilingHz) {
      this.peakCeilingHz = holdHz;
    }

    if (magSum > 1e-9 && signalPresent) {
      const rawCentroid = weightedFreqSum / magSum;
      this.smoothedCentroid += (rawCentroid - this.smoothedCentroid) * Math.min(1, dt * 10);
    }

    const hfEnergyRatioPct = totalPower > 1e-12 ? clamp((hfPower / totalPower) * 100, 0, 100) : 0;
    const hfBinCount = Math.max(1, maxValidBin - Math.floor(16000 / binHz));
    const hfEnergyDb = hfPower > 0 ? 10 * Math.log10(hfPower / hfBinCount) : -120;

    // Band dB and normalized 0..1 levels for 3D Ferrofluid displacement
    const subDb = subBins > 0 && subPower > 0 ? 10 * Math.log10(subPower / subBins) : -120;
    const midDb = midBins > 0 && midPower > 0 ? 10 * Math.log10(midPower / midBins) : -120;
    const highDb = highBins > 0 && highPower > 0 ? 10 * Math.log10(highPower / highBins) : -120;

    const subEnergy = clamp((subDb + 72) / 56, 0, 1);
    const midEnergy = clamp((midDb + 78) / 56, 0, 1);
    // High/Air band mapped so lossless hi-hats drive crisp spikes while 16kHz cutoff drops sharply
    const highEnergy = clamp((highDb + 86) / 52, 0, 1) * (this.transcodeSim ? 0.08 : 1.0);

    // ── BS.1770 K-weighted Loudness Estimation (LUFS) ──
    // Approximate K-weighting using high-shelf boost (+4 dB > 1.5 kHz) + RLB high-pass (> 60 Hz)
    const blockPower = 0.5 * (sumSqL + sumSqR) * 1.35;
    if (active) {
      this.momRing[this.momIdx] = blockPower;
      this.momIdx = (this.momIdx + 1) % this.momRing.length;
      if (this.momCount < this.momRing.length) this.momCount++;

      this.stRing[this.stIdx] = blockPower;
      this.stIdx = (this.stIdx + 1) % this.stRing.length;
      if (this.stCount < this.stRing.length) this.stCount++;

      // Absolute gate at -70 LUFS
      const blockLufs = blockPower > 0 ? -0.691 + 10 * Math.log10(blockPower) : -120;
      if (blockLufs > -70) {
        this.integratedPowerSum += blockPower;
        this.integratedPowerCount++;
      }
    }

    let momMean = 0;
    for (let i = 0; i < this.momCount; i++) momMean += this.momRing[i];
    momMean = this.momCount > 0 ? momMean / this.momCount : 0;

    let stMean = 0;
    for (let i = 0; i < this.stCount; i++) stMean += this.stRing[i];
    stMean = this.stCount > 0 ? stMean / this.stCount : 0;

    const lufsMomentary = momMean > 1e-12 ? -0.691 + 10 * Math.log10(momMean) : -Infinity;
    const lufsShortTerm = stMean > 1e-12 ? -0.691 + 10 * Math.log10(stMean) : -Infinity;
    const lufsIntegrated =
      this.integratedPowerCount > 0
        ? -0.691 + 10 * Math.log10(this.integratedPowerSum / this.integratedPowerCount)
        : -Infinity;
    const maxHoldDb = Math.max(this.peakHoldDbL, this.peakHoldDbR);
    const plrDb = Number.isFinite(maxHoldDb) && Number.isFinite(lufsIntegrated) ? maxHoldDb - lufsIntegrated : NaN;

    // ── Diagnostic Classification (Module 01 thresholds) ──
    // Peak Ceiling >= 19.4 kHz -> VERIFIED LOSSLESS
    // Peak Ceiling 16.3 - 19.3 kHz -> LOSSY STREAM
    // Peak Ceiling <= 16.2 kHz -> TRANSCODE ALERT
    const ceilKHz = this.peakCeilingHz / 1000;
    let diagnostic: DiagnosticClass = 'idle';
    if (this.peakCeilingHz > 0) {
      if (ceilKHz >= 19.35) diagnostic = 'lossless';
      else if (ceilKHz >= 16.25) diagnostic = 'lossy';
      else diagnostic = 'transcode';
    }

    return {
      active,
      sampleRate: sr,
      nyquist,
      fftDb: this.fftDb,
      maxSpectrumHold: this.maxSpectrumHold,
      timeL: this.timeL,
      timeR: this.timeR,
      liveCutoffHz: this.smoothedLiveCutoff,
      peakCeilingHz: this.peakCeilingHz,
      acquiredSeconds: this.acquiredSeconds,
      diagnostic,
      spectralCentroidHz: this.smoothedCentroid,
      dynamicCrestDb: this.smoothedCrest,
      hfEnergyRatioPct,
      hfEnergyDb,
      subEnergy,
      subDb,
      midEnergy,
      midDb,
      highEnergy,
      highDb,
      phaseCorrelation: this.smoothedCorr,
      stereoWidthPct: this.smoothedWidth,
      peakDbL,
      peakDbR,
      rmsDbL,
      rmsDbR,
      peakHoldDbL: this.peakHoldDbL,
      peakHoldDbR: this.peakHoldDbR,
      clipL: this.clipL,
      clipR: this.clipR,
      lufsMomentary,
      lufsShortTerm,
      lufsIntegrated,
      plrDb,
    };
  }

  /** Rolling peaks array for the timeline scrubber when Synth Test Loop is playing. */
  getSynthWaveform(): { min: Float32Array; max: Float32Array; writeIdx: number } {
    return {
      min: this.synthWaveMin,
      max: this.synthWaveMax,
      writeIdx: this.synthWaveWrite,
    };
  }
}
