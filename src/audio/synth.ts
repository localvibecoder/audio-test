/**
 * Procedural reference synthesizer — fully offline, no external assets.
 *
 * 124 BPM A-minor loop:
 *  · 55 Hz sub-kick pulse on every beat (pitch-swept punch → sustained 55 Hz sine)
 *  · Off-beat sub-bass following the chord roots
 *  · Syncopated, detuned stereo saw chord stabs (hard L/R voices) + ping-pong delay
 *  · Clap/snare body on 2 & 4 for the mid band
 *  · White-noise hi-hats, open hats and a 4-bar crash, spanning up to Nyquist (22 kHz+)
 */

const BPM = 124;
const STEP = 60 / BPM / 4; // 16th note
const LOOKAHEAD = 0.16; // seconds scheduled in advance
const TICK_MS = 25;

const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

const CHORDS: number[][] = [
  [57, 60, 64, 67, 71], // Am9
  [53, 57, 60, 64, 67], // Fmaj9
  [48, 55, 59, 62, 64], // Cmaj9
  [55, 59, 62, 64, 69], // G6/9
];
const ROOTS = [45, 41, 48, 43]; // bass roots (A2, F2, C3, G2)
const STAB_STEPS = new Set([3, 6, 10, 13]);
const BASS_STEPS = new Set([2, 6, 10, 14]);

export class ReferenceSynth {
  readonly output: GainNode;
  private readonly ctx: AudioContext;
  private readonly bus: GainNode;
  private readonly comp: DynamicsCompressorNode;
  private readonly delayL: DelayNode;
  private readonly delayR: DelayNode;
  private readonly delaySend: GainNode;
  private readonly noise: AudioBuffer;
  private timer: number | null = null;
  private nextTime = 0;
  private step = 0;
  private startTime = 0;
  running = false;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.output = ctx.createGain();
    this.output.gain.value = 0;

    this.bus = ctx.createGain();
    this.bus.gain.value = 0.62;
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -9;
    this.comp.knee.value = 6;
    this.comp.ratio.value = 4;
    this.comp.attack.value = 0.004;
    this.comp.release.value = 0.12;
    this.bus.connect(this.comp).connect(this.output);

    // Ping-pong delay (3/16 L, 3/8 R) for chord width.
    this.delaySend = ctx.createGain();
    this.delaySend.gain.value = 0.32;
    this.delayL = ctx.createDelay(2);
    this.delayR = ctx.createDelay(2);
    this.delayL.delayTime.value = STEP * 3;
    this.delayR.delayTime.value = STEP * 3;
    const fb = ctx.createGain();
    fb.gain.value = 0.42;
    const damp = ctx.createBiquadFilter();
    damp.type = 'lowpass';
    damp.frequency.value = 4200;
    const merger = ctx.createChannelMerger(2);
    this.delaySend.connect(this.delayL);
    this.delayL.connect(damp);
    damp.connect(this.delayR);
    this.delayR.connect(fb);
    fb.connect(this.delayL);
    this.delayL.connect(merger, 0, 0);
    this.delayR.connect(merger, 0, 1);
    merger.connect(this.bus);

    // 2 s of independent stereo white noise (decorrelated L/R = genuinely wide hats).
    const len = Math.floor(ctx.sampleRate * 2);
    this.noise = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = this.noise.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
  }

  /** Musical position of the loop (bars.beats) for transport readout. */
  get elapsed(): number {
    return this.running ? Math.max(0, this.ctx.currentTime - this.startTime) : 0;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const t = this.ctx.currentTime;
    this.output.gain.cancelScheduledValues(t);
    this.output.gain.setValueAtTime(this.output.gain.value, t);
    this.output.gain.linearRampToValueAtTime(1, t + 0.03);
    this.step = 0;
    this.nextTime = t + 0.06;
    this.startTime = this.nextTime;
    this.schedule();
    this.timer = window.setInterval(() => this.schedule(), TICK_MS);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    const t = this.ctx.currentTime;
    this.output.gain.cancelScheduledValues(t);
    this.output.gain.setValueAtTime(this.output.gain.value, t);
    this.output.gain.linearRampToValueAtTime(0, t + 0.04);
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
  }

  dispose(): void {
    this.stop();
    this.output.disconnect();
  }

  private schedule(): void {
    const horizon = this.ctx.currentTime + LOOKAHEAD;
    // If the tab was throttled, jump forward instead of bursting stale notes.
    if (this.nextTime < this.ctx.currentTime - 0.2) this.nextTime = this.ctx.currentTime + 0.02;
    while (this.nextTime < horizon) {
      this.playStep(this.step, this.nextTime);
      this.nextTime += STEP;
      this.step = (this.step + 1) % 256;
    }
  }

  private playStep(step: number, t: number): void {
    const s16 = step % 16;
    const bar = Math.floor(step / 16) % 4;
    const swing = s16 % 2 === 1 ? STEP * 0.08 : 0;
    const tt = t + swing;

    if (s16 % 4 === 0) this.kick(t);
    if (s16 === 4 || s16 === 12) this.clap(t);
    if (BASS_STEPS.has(s16)) this.bass(t, ROOTS[bar]);
    if (STAB_STEPS.has(s16)) this.stab(tt, CHORDS[bar], s16 === 13 ? 0.7 : 1);

    // Hats: closed 16ths with accents, open hat on the off-beat 8ths.
    if (s16 % 4 === 2) this.hat(tt, 0.34, 0.22, 7000, 0.25 * (s16 === 6 ? -1 : 1));
    else this.hat(tt, s16 % 2 === 0 ? 0.26 : 0.15, 0.032 + Math.random() * 0.012, 8500, (s16 % 2 ? 0.45 : -0.45));

    // Air shaker layer (12 kHz+) on every 16th, very quiet.
    this.hat(tt + 0.004, 0.07, 0.05, 12500, s16 % 2 ? -0.7 : 0.7);

    if (s16 === 0 && Math.floor(step / 16) % 4 === 0) this.crash(t);
  }

  private env(g: AudioParam, t: number, peak: number, attack: number, decay: number): void {
    g.setValueAtTime(0, t);
    g.linearRampToValueAtTime(peak, t + attack);
    g.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  private kick(t: number): void {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(160, t);
    osc.frequency.exponentialRampToValueAtTime(55, t + 0.045);
    const g = ctx.createGain();
    this.env(g.gain, t, 0.95, 0.002, 0.5);
    osc.connect(g).connect(this.bus);
    osc.start(t);
    osc.stop(t + 0.56);

    // Transient click for definition.
    const click = ctx.createBufferSource();
    click.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 3200;
    bp.Q.value = 0.8;
    const cg = ctx.createGain();
    this.env(cg.gain, t, 0.18, 0.0005, 0.012);
    click.connect(bp).connect(cg).connect(this.bus);
    click.start(t, Math.random() * 1.5, 0.03);
  }

  private bass(t: number, midi: number): void {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = mtof(midi - 12);
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = mtof(midi - 12);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(900, t);
    lp.frequency.exponentialRampToValueAtTime(160, t + 0.18);
    const g = ctx.createGain();
    this.env(g.gain, t, 0.36, 0.006, 0.22);
    osc.connect(lp);
    sub.connect(lp);
    lp.connect(g).connect(this.bus);
    osc.start(t);
    sub.start(t);
    osc.stop(t + 0.3);
    sub.stop(t + 0.3);
  }

  private stab(t: number, chord: number[], vel: number): void {
    const ctx = this.ctx;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 4;
    lp.frequency.setValueAtTime(700, t);
    lp.frequency.exponentialRampToValueAtTime(5200, t + 0.012);
    lp.frequency.exponentialRampToValueAtTime(900, t + 0.28);
    const g = ctx.createGain();
    this.env(g.gain, t, 0.085 * vel, 0.004, 0.34);
    lp.connect(g);
    g.connect(this.bus);
    g.connect(this.delaySend);
    for (const m of chord) {
      for (const side of [-1, 1]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = mtof(m);
        o.detune.value = side * (6 + Math.random() * 3);
        const p = ctx.createStereoPanner();
        p.pan.value = side * 0.85;
        o.connect(p).connect(lp);
        o.start(t);
        o.stop(t + 0.42);
      }
    }
  }

  private clap(t: number): void {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1700;
    bp.Q.value = 0.9;
    const g = ctx.createGain();
    // Triple-flam clap envelope.
    g.gain.setValueAtTime(0, t);
    for (let k = 0; k < 3; k++) {
      const s = t + k * 0.011;
      g.gain.linearRampToValueAtTime(0.42, s + 0.001);
      g.gain.exponentialRampToValueAtTime(0.06, s + 0.01);
    }
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
    src.connect(bp).connect(g).connect(this.bus);
    src.start(t, Math.random() * 1.5, 0.3);

    const body = ctx.createOscillator();
    body.type = 'triangle';
    body.frequency.setValueAtTime(220, t);
    body.frequency.exponentialRampToValueAtTime(170, t + 0.08);
    const bg = ctx.createGain();
    this.env(bg.gain, t, 0.16, 0.002, 0.1);
    body.connect(bg).connect(this.bus);
    body.start(t);
    body.stop(t + 0.14);
  }

  private hat(t: number, level: number, decay: number, hp: number, pan: number): void {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = hp;
    f.Q.value = 0.5;
    const g = ctx.createGain();
    this.env(g.gain, t, level, 0.0008, decay);
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    src.connect(f).connect(g).connect(p).connect(this.bus);
    src.start(t, Math.random() * 1.6, decay + 0.05);
  }

  private crash(t: number): void {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 4200;
    const g = ctx.createGain();
    this.env(g.gain, t, 0.16, 0.002, 1.8);
    src.connect(f).connect(g).connect(this.bus);
    src.start(t, Math.random());
    src.stop(t + 1.9);
  }
}

