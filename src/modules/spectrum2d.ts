/**
 * MODULE [02A // 2D FFT PRECISION SPECTRUM + WATERFALL]
 *
 * Retina-scaled 2D Canvas covering 20 Hz to 22 kHz on a true logarithmic X-axis
 * and -90 dB to 0 dB on the Y-axis.
 *
 * Renders 3 synchronized layers:
 *  (1) Live filled spectrum polygon (#EDEDED at 15% fill, 1.5px solid #EDEDED stroke)
 *  (2) Persistent Peak-Hold maximum envelope trace (1px dashed #8A8A8A)
 *  (3) Bottom 25% sub-panel: scrolling monochrome + #FF4D00 thermal Waterfall Spectrogram
 *
 * Includes explicit vertical reference markers at:
 *  · 16.0 kHz [MP3 128 LIMIT] (#FF4D00)
 *  · 19.0 kHz [MP3 320 LIMIT] (#FF4D00)
 */

import { RADAR_THRESHOLD_DB, TelemetryFrame } from '../audio/engine';
import { clamp, fmtDb, fmtHz, noteName } from '../util/format';
import { observeViewport, ViewportSize } from '../util/resize';

const F_MIN = 20;
const F_MAX = 22000;
const LOG_MIN = Math.log10(F_MIN);
const LOG_MAX = Math.log10(F_MAX);
const LOG_SPAN = LOG_MAX - LOG_MIN;

const DB_MIN = -90;
const DB_MAX = 0;
const DB_SPAN = DB_MAX - DB_MIN;

const FREQ_GRID = [20, 30, 50, 70, 100, 200, 300, 500, 700, 1000, 2000, 3000, 5000, 7000, 10000, 14000, 20000];
const FREQ_LABELS: Array<[number, string]> = [
  [20, '20'],
  [50, '50'],
  [100, '100'],
  [200, '200'],
  [500, '500'],
  [1000, '1k'],
  [2000, '2k'],
  [5000, '5k'],
  [10000, '10k'],
  [16000, '16k'],
  [19000, '19k'],
  [22000, '22k'],
];
const DB_GRID = [0, -6, -12, -18, -24, -36, -48, -60, -72, -84];

/** Precomputed 256-entry monochrome + signal-orange thermal LUT (RGBA). */
const WATERFALL_LUT = (() => {
  const lut = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let r = 5;
    let g = 5;
    let b = 5;
    if (t < 0.52) {
      // Void #050505 -> Technical charcoal #3A3A3A
      const u = t / 0.52;
      const v = Math.round(5 + u * u * 58);
      r = v;
      g = v;
      b = v;
    } else if (t < 0.82) {
      // Charcoal -> Crisp monochrome #EDEDED
      const u = (t - 0.52) / 0.3;
      const v = Math.round(63 + u * 174);
      r = v;
      g = v;
      b = v;
    } else {
      // High energy -> Signal Orange #FF4D00
      const u = (t - 0.82) / 0.18;
      r = Math.round(237 + u * 18);
      g = Math.round(237 - u * 160);
      b = Math.round(237 - u * 237);
    }
    const o = i * 4;
    lut[o] = r;
    lut[o + 1] = g;
    lut[o + 2] = b;
    lut[o + 3] = 255;
  }
  return lut;
})();

export class Spectrum2DModule {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private size: ViewportSize = { width: 1, height: 1, dpr: 1, pxWidth: 1, pxHeight: 1 };

  // Offscreen canvas for pixel-exact scrolling waterfall spectrogram
  private readonly wfCanvas: HTMLCanvasElement;
  private readonly wfCtx: CanvasRenderingContext2D;
  private wfRowImage: ImageData | null = null;
  private wfWidth = 0;
  private wfHeight = 0;

  private hoverX: number | null = null;
  private hoverY: number | null = null;

  constructor(container: HTMLElement) {
    this.canvas = container.querySelector('canvas')!;
    this.ctx = this.canvas.getContext('2d', { alpha: false })!;

    this.wfCanvas = document.createElement('canvas');
    this.wfCtx = this.wfCanvas.getContext('2d', { alpha: false })!;

    observeViewport(container, (sz) => {
      this.size = sz;
    });

    container.addEventListener('pointermove', (e) => {
      const rect = container.getBoundingClientRect();
      this.hoverX = e.clientX - rect.left;
      this.hoverY = e.clientY - rect.top;
    });

    container.addEventListener('pointerleave', () => {
      this.hoverX = null;
      this.hoverY = null;
    });
  }

  private ensureWaterfallBuffer(w: number, h: number): void {
    const pw = Math.max(1, Math.floor(w));
    const ph = Math.max(1, Math.floor(h));
    if (pw === this.wfWidth && ph === this.wfHeight && this.wfRowImage) return;
    this.wfWidth = pw;
    this.wfHeight = ph;
    this.wfCanvas.width = pw;
    this.wfCanvas.height = ph;
    this.wfCtx.fillStyle = '#050505';
    this.wfCtx.fillRect(0, 0, pw, ph);
    this.wfRowImage = this.wfCtx.createImageData(pw, 1);
  }

  /** Sample FFT array at logarithmic pixel X (with linear interpolation for low bins & peak pooling for dense high bins). */
  private sampleLogSpectrum(arr: Float32Array, px: number, plotW: number, binHz: number): number {
    const f0 = Math.pow(10, LOG_MIN + (px / plotW) * LOG_SPAN);
    const f1 = Math.pow(10, LOG_MIN + ((px + 1) / plotW) * LOG_SPAN);
    const b0 = f0 / binHz;
    const b1 = f1 / binHz;
    const maxIdx = arr.length - 1;

    if (b1 - b0 <= 1.0) {
      const idx = clamp(Math.floor(b0), 0, maxIdx - 1);
      const frac = b0 - idx;
      return arr[idx] * (1 - frac) + arr[idx + 1] * frac;
    }

    const iStart = clamp(Math.floor(b0), 0, maxIdx);
    const iEnd = clamp(Math.ceil(b1), iStart, maxIdx);
    let peak = -120;
    for (let i = iStart; i <= iEnd; i++) {
      if (arr[i] > peak) peak = arr[i];
    }
    return peak;
  }

  render(frame: TelemetryFrame): void {
    const { width: w, height: h, dpr } = this.size;
    const ctx = this.ctx;
    ctx.save();
    ctx.scale(dpr, dpr);

    // Clear void
    ctx.fillStyle = '#050505';
    ctx.fillRect(0, 0, w, h);

    const padL = 38;
    const padR = 12;
    const padT = 10;
    const padB = 18;
    const scaleStripH = 18; // Frequency axis strip separating FFT and Waterfall
    const plotW = Math.max(32, w - padL - padR);
    const availH = Math.max(64, h - padT - padB - scaleStripH);

    // Top 74% = 2D Logarithmic FFT + Peak Hold; Bottom 26% = Waterfall Spectrogram
    const fftH = Math.floor(availH * 0.74);
    const wfTop = padT + fftH + scaleStripH;
    const wfH = Math.max(24, availH - fftH);

    const fToX = (f: number) => padL + ((Math.log10(clamp(f, F_MIN, F_MAX)) - LOG_MIN) / LOG_SPAN) * plotW;
    const xToF = (x: number) => Math.pow(10, LOG_MIN + clamp((x - padL) / plotW, 0, 1) * LOG_SPAN);
    const dbToY = (db: number) => padT + (1 - clamp((db - DB_MIN) / DB_SPAN, 0, 1)) * fftH;
    const yToDb = (y: number) => DB_MAX - clamp((y - padT) / fftH, 0, 1) * DB_SPAN;

    // ── 1. Technical Gridlines (#141414) ──
    ctx.strokeStyle = '#141414';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const f of FREQ_GRID) {
      const x = Math.floor(fToX(f)) + 0.5;
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + fftH);
    }
    for (const db of DB_GRID) {
      const y = Math.floor(dbToY(db)) + 0.5;
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
    }
    ctx.stroke();

    // -78 dBFS Radar threshold horizontal reference
    const yRadar = Math.floor(dbToY(RADAR_THRESHOLD_DB)) + 0.5;
    ctx.strokeStyle = '#262626';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(padL, yRadar);
    ctx.lineTo(padL + plotW, yRadar);
    ctx.stroke();
    ctx.setLineDash([]);

    // ── 2. Explicit Vertical Reference Markers: 16.0 kHz & 19.0 kHz (#FF4D00) ──
    const refMarkers: Array<{ hz: number; label: string }> = [
      { hz: 16000, label: '16.0 kHz [MP3 128 LIMIT]' },
      { hz: 19000, label: '19.0 kHz [MP3 320 LIMIT]' },
    ];

    for (let i = 0; i < refMarkers.length; i++) {
      const m = refMarkers[i];
      const rx = Math.floor(fToX(m.hz)) + 0.5;
      ctx.strokeStyle = i === 0 ? '#FF4D00' : 'rgba(255, 77, 0, 0.72)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(rx, padT);
      ctx.lineTo(rx, padT + fftH);
      ctx.stroke();
      ctx.setLineDash([]);

      // Label tag at top of marker
      const tagY = padT + 6 + i * 16;
      ctx.font = '500 9px "JetBrains Mono", monospace';
      const tw = ctx.measureText(m.label).width + 8;
      const tagX = Math.max(padL + 4, rx - tw - 4);
      ctx.fillStyle = '#0A0A0A';
      ctx.fillRect(tagX, tagY, tw, 13);
      ctx.strokeStyle = '#FF4D00';
      ctx.strokeRect(tagX + 0.5, tagY + 0.5, tw - 1, 12);
      ctx.fillStyle = '#FF4D00';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(m.label, tagX + 4, tagY + 7);
    }

    // ── 3. Persistent Peak-Hold Maximum Envelope Trace (1px dashed #8A8A8A) ──
    const bins = frame.fftDb.length;
    const binHz = frame.nyquist / bins;

    ctx.save();
    ctx.beginPath();
    ctx.rect(padL, padT, plotW, fftH);
    ctx.clip();

    ctx.strokeStyle = '#8A8A8A';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    for (let px = 0; px <= plotW; px += 2) {
      const db = this.sampleLogSpectrum(frame.maxSpectrumHold, px, plotW, binHz);
      const y = dbToY(db);
      if (px === 0) ctx.moveTo(padL + px, y);
      else ctx.lineTo(padL + px, y);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // ── 4. Live Filled Spectrum Polygon (#EDEDED at 15% fill, 1.5px solid #EDEDED stroke) ──
    ctx.beginPath();
    ctx.moveTo(padL, padT + fftH);
    for (let px = 0; px <= plotW; px++) {
      const db = this.sampleLogSpectrum(frame.fftDb, px, plotW, binHz);
      const y = dbToY(db);
      ctx.lineTo(padL + px, y);
    }
    ctx.lineTo(padL + plotW, padT + fftH);
    ctx.closePath();
    ctx.fillStyle = 'rgba(237, 237, 237, 0.15)';
    ctx.fill();

    ctx.strokeStyle = '#EDEDED';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let px = 0; px <= plotW; px++) {
      const db = this.sampleLogSpectrum(frame.fftDb, px, plotW, binHz);
      const y = dbToY(db);
      if (px === 0) ctx.moveTo(padL + px, y);
      else ctx.lineTo(padL + px, y);
    }
    ctx.stroke();

    // Live Peak-Locked Ceiling vertical badge indicator
    if (frame.peakCeilingHz >= F_MIN) {
      const cx = Math.floor(fToX(frame.peakCeilingHz)) + 0.5;
      const ceilColor =
        frame.diagnostic === 'lossless'
          ? '#00E676'
          : frame.diagnostic === 'lossy'
            ? '#FFB300'
            : '#FF1744';
      ctx.strokeStyle = ceilColor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx, padT);
      ctx.lineTo(cx, padT + fftH);
      ctx.stroke();
    }

    ctx.restore();

    // ── 5. Bottom 25% Sub-Panel: Scrolling Waterfall Spectrogram ──
    this.ensureWaterfallBuffer(plotW, wfH);
    if (frame.active && this.wfRowImage) {
      // Shift existing spectrogram down by 1 pixel
      this.wfCtx.drawImage(this.wfCanvas, 0, 0, this.wfWidth, this.wfHeight - 1, 0, 1, this.wfWidth, this.wfHeight - 1);
      const data = this.wfRowImage.data;
      for (let px = 0; px < this.wfWidth; px++) {
        const db = this.sampleLogSpectrum(frame.fftDb, px, this.wfWidth, binHz);
        const norm = clamp((db - DB_MIN) / DB_SPAN, 0, 1);
        const lutIdx = Math.min(255, Math.floor(norm * 255)) * 4;
        const o = px * 4;
        data[o] = WATERFALL_LUT[lutIdx];
        data[o + 1] = WATERFALL_LUT[lutIdx + 1];
        data[o + 2] = WATERFALL_LUT[lutIdx + 2];
        data[o + 3] = 255;
      }
      this.wfCtx.putImageData(this.wfRowImage, 0, 0);
    }

    ctx.drawImage(this.wfCanvas, padL, wfTop, plotW, wfH);

    // Subtle reference markers over waterfall at 16.0 kHz & 19.0 kHz
    for (const m of refMarkers) {
      const rx = Math.floor(fToX(m.hz)) + 0.5;
      ctx.strokeStyle = 'rgba(255, 77, 0, 0.45)';
      ctx.beginPath();
      ctx.moveTo(rx, wfTop);
      ctx.lineTo(rx, wfTop + wfH);
      ctx.stroke();
    }

    // Waterfall sub-header tag
    ctx.fillStyle = 'rgba(10, 10, 10, 0.85)';
    ctx.fillRect(padL + 4, wfTop + 4, 178, 13);
    ctx.font = '500 8px "JetBrains Mono", monospace';
    ctx.fillStyle = '#686868';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('WATERFALL // THERMAL SPECTROGRAM', padL + 8, wfTop + 10.5);

    // ── 6. Technical Scales & Frames ──
    ctx.strokeStyle = '#222222';
    ctx.lineWidth = 1;
    ctx.strokeRect(padL + 0.5, padT + 0.5, plotW - 1, fftH - 1);
    ctx.strokeRect(padL + 0.5, wfTop + 0.5, plotW - 1, wfH - 1);

    // Y-axis dBFS labels
    ctx.font = '500 9px "JetBrains Mono", monospace';
    ctx.fillStyle = '#686868';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const db of DB_GRID) {
      ctx.fillText(`${db}`, padL - 5, dbToY(db));
    }

    // Waterfall time depth labels on left margin
    ctx.fillText('0s', padL - 5, wfTop + 6);
    ctx.fillText(`-${(wfH / 60).toFixed(1)}s`, padL - 5, wfTop + wfH - 6);

    // X-axis logarithmic frequency labels in the separator strip
    const scaleY = padT + fftH + scaleStripH * 0.5;
    ctx.textBaseline = 'middle';
    for (const [hz, txt] of FREQ_LABELS) {
      const x = fToX(hz);
      ctx.fillStyle = hz === 16000 || hz === 19000 ? '#FF4D00' : '#686868';
      ctx.textAlign = hz === 20 ? 'left' : hz === 22000 ? 'right' : 'center';
      ctx.fillText(txt, x, scaleY);
    }

    // ── 7. Interactive Precision Crosshair Inspection ──
    if (
      this.hoverX !== null &&
      this.hoverY !== null &&
      this.hoverX >= padL &&
      this.hoverX <= padL + plotW &&
      this.hoverY >= padT &&
      this.hoverY <= wfTop + wfH
    ) {
      const hx = Math.floor(this.hoverX) + 0.5;
      const hy = Math.floor(this.hoverY) + 0.5;
      const freq = xToF(this.hoverX);
      const px = clamp(this.hoverX - padL, 0, plotW);
      const liveDb = this.sampleLogSpectrum(frame.fftDb, px, plotW, binHz);
      const holdDb = this.sampleLogSpectrum(frame.maxSpectrumHold, px, plotW, binHz);
      const cursorDb = this.hoverY <= padT + fftH ? fmtDb(yToDb(this.hoverY), 1) : 'WF';

      ctx.strokeStyle = 'rgba(237, 237, 237, 0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(hx, padT);
      ctx.lineTo(hx, wfTop + wfH);
      if (this.hoverY <= padT + fftH) {
        ctx.moveTo(padL, hy);
        ctx.lineTo(padL + plotW, hy);
      }
      ctx.stroke();

      // Highlight dot on live FFT curve
      const curveY = dbToY(liveDb);
      ctx.fillStyle = '#FF4D00';
      ctx.fillRect(hx - 2.5, curveY - 2.5, 5, 5);

      const readout = `${fmtHz(freq)} (${noteName(freq)})  LIVE ${fmtDb(liveDb, 1)} dB  HOLD ${fmtDb(holdDb, 1)} dB  CUR ${cursorDb}`;
      ctx.font = '500 9px "JetBrains Mono", monospace';
      const boxW = ctx.measureText(readout).width + 12;
      const boxH = 16;
      const bx = clamp(this.hoverX + 10, padL + 4, padL + plotW - boxW - 4);
      const by = clamp(this.hoverY - 22, padT + 4, padT + fftH - boxH - 4);

      ctx.fillStyle = '#0A0A0A';
      ctx.fillRect(bx, by, boxW, boxH);
      ctx.strokeStyle = '#3A3A3A';
      ctx.strokeRect(bx + 0.5, by + 0.5, boxW - 1, boxH - 1);
      ctx.fillStyle = '#EDEDED';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(readout, bx + 6, by + boxH * 0.5);
    }

    ctx.restore();
  }
}
