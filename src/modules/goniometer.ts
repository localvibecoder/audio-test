/**
 * MODULE [04 // LISSAJOUS STEREO GONIOMETER (PHASE SCOPE)]
 *
 * Dual-layer Retina Canvas:
 *  · Bottom layer: Phosphor persistence scope (fillStyle = 'rgba(5, 5, 5, 0.28)' per frame)
 *    plotting stereo time-domain samples rotated by 45°:
 *      x = (R - L) * 0.70710678
 *      y = (L + R) * 0.70710678
 *    in crisp #EDEDED and #FF4D00 for peak transients.
 *  · Top layer: Static calibrated M/S (+M, -S, L, R) axes and circular dB rings.
 *  · Bottom bar: Smoothed Pearson Phase Correlation Meter (-1.0 to +1.0) + Stereo Width %.
 */

import { TelemetryFrame } from '../audio/engine';
import { clamp, fmtSigned } from '../util/format';
import { observeViewport, ViewportSize } from '../util/resize';

export class GoniometerModule {
  private readonly phosCanvas: HTMLCanvasElement;
  private readonly phosCtx: CanvasRenderingContext2D;
  private readonly overCanvas: HTMLCanvasElement;
  private readonly overCtx: CanvasRenderingContext2D;
  private scopeSize: ViewportSize = { width: 1, height: 1, dpr: 1, pxWidth: 1, pxHeight: 1 };

  private readonly corrCanvas: HTMLCanvasElement;
  private readonly corrCtx: CanvasRenderingContext2D;
  private corrSize: ViewportSize = { width: 1, height: 1, dpr: 1, pxWidth: 1, pxHeight: 1 };

  private readonly corrValEl: HTMLElement;
  private readonly widthValEl: HTMLElement;

  private agcEnabled = false;
  private agcGain = 1.0;

  constructor() {
    const gonioWrap = document.getElementById('gonio')!;
    this.phosCanvas = gonioWrap.querySelector('canvas[data-layer="phosphor"]')!;
    this.overCanvas = gonioWrap.querySelector('canvas[data-layer="overlay"]')!;
    this.phosCtx = this.phosCanvas.getContext('2d', { alpha: false })!;
    this.overCtx = this.overCanvas.getContext('2d')!;

    observeViewport(gonioWrap, (sz) => {
      this.scopeSize = sz;
      this.phosCtx.fillStyle = '#050505';
      this.phosCtx.fillRect(0, 0, sz.pxWidth, sz.pxHeight);
      this.drawOverlayGraticule();
    });

    const corrWrap = document.getElementById('corr-meter')!;
    this.corrCanvas = corrWrap.querySelector('canvas')!;
    this.corrCtx = this.corrCanvas.getContext('2d', { alpha: false })!;
    observeViewport(corrWrap, (sz) => {
      this.corrSize = sz;
    });

    this.corrValEl = document.getElementById('corr-val')!;
    this.widthValEl = document.getElementById('width-val')!;

    const btnFixed = document.getElementById('gonio-fixed')!;
    const btnAgc = document.getElementById('gonio-agc')!;
    btnFixed.addEventListener('click', () => {
      this.agcEnabled = false;
      btnFixed.setAttribute('aria-pressed', 'true');
      btnAgc.setAttribute('aria-pressed', 'false');
    });
    btnAgc.addEventListener('click', () => {
      this.agcEnabled = true;
      btnFixed.setAttribute('aria-pressed', 'false');
      btnAgc.setAttribute('aria-pressed', 'true');
    });
  }

  private drawOverlayGraticule(): void {
    const { width: w, height: h, dpr } = this.scopeSize;
    const ctx = this.overCtx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.overCanvas.width, this.overCanvas.height);
    ctx.scale(dpr, dpr);

    const cx = w * 0.5;
    const cy = h * 0.5;
    const r = Math.max(16, Math.min(w, h) * 0.44);

    // Circular dB rings: 0 dBFS (1.0), -6 dBFS (0.5), -12 dBFS (0.25)
    ctx.strokeStyle = '#181818';
    ctx.lineWidth = 1;
    for (const frac of [1.0, 0.707, 0.5, 0.25]) {
      ctx.beginPath();
      ctx.arc(cx, cy, r * frac, 0, Math.PI * 2);
      ctx.stroke();
    }

    // +M (vertical) and -S/+S (horizontal) crosshairs
    ctx.strokeStyle = '#1F1F1F';
    ctx.beginPath();
    ctx.moveTo(cx, cy - r - 6);
    ctx.lineTo(cx, cy + r + 6);
    ctx.moveTo(cx - r - 6, cy);
    ctx.lineTo(cx + r + 6, cy);
    ctx.stroke();

    // L and R 45° diagonal axes
    const d = r * 0.70710678;
    ctx.strokeStyle = '#222222';
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(cx - d, cy - d);
    ctx.lineTo(cx + d, cy + d);
    ctx.moveTo(cx + d, cy - d);
    ctx.lineTo(cx - d, cy + d);
    ctx.stroke();
    ctx.setLineDash([]);

    // Technical axis labels (+M, -S, L, R)
    ctx.font = '500 9px "JetBrains Mono", monospace';
    ctx.fillStyle = '#686868';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('+M', cx, Math.max(9, cy - r - 9));
    ctx.fillText('-M', cx, Math.min(h - 8, cy + r + 9));
    ctx.fillText('-S', Math.max(11, cx - r - 11), cy);
    ctx.fillText('+S', Math.min(w - 11, cx + r + 11), cy);

    ctx.fillStyle = '#8A8A8A';
    ctx.fillText('L', cx - d - 8, cy - d - 7);
    ctx.fillText('R', cx + d + 8, cy - d - 7);

    ctx.restore();
  }

  render(frame: TelemetryFrame): void {
    const { width: w, height: h, dpr } = this.scopeSize;
    const ctx = this.phosCtx;
    ctx.save();
    ctx.scale(dpr, dpr);

    // Phosphor persistence decay (exact specification: rgba(5, 5, 5, 0.28))
    ctx.fillStyle = 'rgba(5, 5, 5, 0.28)';
    ctx.fillRect(0, 0, w, h);

    const cx = w * 0.5;
    const cy = h * 0.5;
    const radius = Math.max(16, Math.min(w, h) * 0.44);

    const timeL = frame.timeL;
    const timeR = frame.timeR;
    const len = timeL.length;

    // Optional AGC normalization
    if (this.agcEnabled && frame.active) {
      let peak = 0.01;
      for (let i = 0; i < len; i += 4) {
        const m = Math.max(Math.abs(timeL[i]), Math.abs(timeR[i]));
        if (m > peak) peak = m;
      }
      const target = clamp(0.85 / peak, 1.0, 12.0);
      this.agcGain += (target - this.agcGain) * 0.1;
    } else {
      this.agcGain = 1.0;
    }

    const scale = radius * this.agcGain;

    // Main Lissajous trace (#EDEDED)
    ctx.strokeStyle = 'rgba(237, 237, 237, 0.85)';
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    for (let i = 0; i < len; i++) {
      const l = timeL[i];
      const r = timeR[i];
      const x = cx + (r - l) * 0.70710678 * scale;
      const y = cy - (l + r) * 0.70710678 * scale;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Highlight peak transients in Signal Orange (#FF4D00)
    ctx.fillStyle = '#FF4D00';
    for (let i = 0; i < len; i += 2) {
      const l = timeL[i];
      const r = timeR[i];
      if (Math.abs(l) > 0.62 || Math.abs(r) > 0.62) {
        const x = cx + (r - l) * 0.70710678 * scale;
        const y = cy - (l + r) * 0.70710678 * scale;
        ctx.fillRect(x - 1, y - 1, 2, 2);
      }
    }

    ctx.restore();

    // Update numeric readouts & Pearson Phase Correlation bar
    const corr = frame.phaseCorrelation;
    this.corrValEl.textContent = fmtSigned(corr, 2);
    this.corrValEl.style.color = corr < -0.15 ? '#FF1744' : corr < 0.15 ? '#FFB300' : '#EDEDED';
    this.widthValEl.textContent = `${Math.round(frame.stereoWidthPct)}%`;

    this.renderCorrelationBar(corr);
  }

  private renderCorrelationBar(corr: number): void {
    const { width: w, height: h, dpr } = this.corrSize;
    const ctx = this.corrCtx;
    ctx.save();
    ctx.scale(dpr, dpr);

    ctx.fillStyle = '#050505';
    ctx.fillRect(0, 0, w, h);

    const midX = Math.floor(w * 0.5) + 0.5;
    const q1 = Math.floor(w * 0.25) + 0.5;
    const q3 = Math.floor(w * 0.75) + 0.5;

    // Out-of-phase danger zone tint on left half
    ctx.fillStyle = 'rgba(255, 23, 68, 0.08)';
    ctx.fillRect(0, 0, midX, h);

    // Tick lines at -0.5, 0, +0.5
    ctx.strokeStyle = '#222222';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(q1, 0);
    ctx.lineTo(q1, h);
    ctx.moveTo(midX, 0);
    ctx.lineTo(midX, h);
    ctx.moveTo(q3, 0);
    ctx.lineTo(q3, h);
    ctx.stroke();

    // Correlation bar from center (0) to current corr (-1..+1)
    const cx = clamp((corr + 1) * 0.5 * w, 2, w - 2);
    const barColor = corr < -0.15 ? '#FF1744' : corr < 0.15 ? '#FFB300' : '#00E676';
    const x0 = Math.min(midX, cx);
    const bw = Math.max(2, Math.abs(cx - midX));
    ctx.fillStyle = barColor;
    ctx.fillRect(x0, 2, bw, h - 4);

    // Crisp pointer tick
    ctx.fillStyle = '#EDEDED';
    ctx.fillRect(Math.round(cx) - 1, 0, 2, h);

    ctx.restore();
  }
}

