/**
 * MODULE [05 // DUAL-CHANNEL PRECISION PEAK & RMS METERS]
 *
 * Segmented vertical digital bar meters for L and R channels (-60 dBFS to 0.0 dBFS)
 * with calibrated scale markings (0, -3, -6, -12, -18, -24, -36, -48).
 *
 * Shows simultaneous:
 *  · Solid RMS body (#EDEDED)
 *  · Instantaneous Peak bar
 *  · Floating Peak-Hold tick (#FF4D00)
 *  · Latching [CLIP] LED indicators (>= -0.1 dBFS, click to reset)
 *  · Numeric readouts for PEAK dBFS, RMS dBFS, PEAK HOLD dBFS, and LUFS (ST-EST)
 */

import { AudioEngine, TelemetryFrame } from '../audio/engine';
import { clamp, fmtDb } from '../util/format';
import { observeViewport, ViewportSize } from '../util/resize';

const METER_MIN_DB = -60;
const METER_MAX_DB = 0;
const SCALE_MARKS = [0, -3, -6, -12, -18, -24, -36, -48, -60];

export class MetersModule {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private size: ViewportSize = { width: 1, height: 1, dpr: 1, pxWidth: 1, pxHeight: 1 };

  private readonly clipLEl: HTMLButtonElement;
  private readonly clipREl: HTMLButtonElement;
  private readonly rdPeakL: HTMLElement;
  private readonly rdPeakR: HTMLElement;
  private readonly rdRmsL: HTMLElement;
  private readonly rdRmsR: HTMLElement;
  private readonly rdHoldL: HTMLElement;
  private readonly rdHoldR: HTMLElement;
  private readonly rdLufsS: HTMLElement;
  private readonly rdLufsM: HTMLElement;
  private readonly rdLufsI: HTMLElement;
  private readonly rdPlr: HTMLElement;

  constructor(engine: AudioEngine) {
    const wrap = document.getElementById('meters')!;
    this.canvas = wrap.querySelector('canvas')!;
    this.ctx = this.canvas.getContext('2d', { alpha: false })!;

    observeViewport(wrap, (sz) => {
      this.size = sz;
    });

    this.clipLEl = document.getElementById('clip-l') as HTMLButtonElement;
    this.clipREl = document.getElementById('clip-r') as HTMLButtonElement;
    this.rdPeakL = document.getElementById('rd-peak-l')!;
    this.rdPeakR = document.getElementById('rd-peak-r')!;
    this.rdRmsL = document.getElementById('rd-rms-l')!;
    this.rdRmsR = document.getElementById('rd-rms-r')!;
    this.rdHoldL = document.getElementById('rd-hold-l')!;
    this.rdHoldR = document.getElementById('rd-hold-r')!;
    this.rdLufsS = document.getElementById('rd-lufs-s')!;
    this.rdLufsM = document.getElementById('rd-lufs-m')!;
    this.rdLufsI = document.getElementById('rd-lufs-i')!;
    this.rdPlr = document.getElementById('rd-plr')!;

    this.clipLEl.addEventListener('click', () => engine.resetClip('L'));
    this.clipREl.addEventListener('click', () => engine.resetClip('R'));
  }

  /** Map dBFS (-60..0) with upper-half resolution emphasis so -18..0 dBFS is spacious. */
  private dbToNorm(db: number): number {
    const lin = clamp((db - METER_MIN_DB) / (METER_MAX_DB - METER_MIN_DB), 0, 1);
    return Math.pow(lin, 1.35);
  }

  render(frame: TelemetryFrame): void {
    // Latching CLIP LEDs
    this.clipLEl.dataset.on = frame.clipL ? 'true' : 'false';
    this.clipREl.dataset.on = frame.clipR ? 'true' : 'false';

    // Numeric readouts
    this.rdPeakL.textContent = fmtDb(frame.peakDbL, 1, -90);
    this.rdPeakR.textContent = fmtDb(frame.peakDbR, 1, -90);
    this.rdRmsL.textContent = fmtDb(frame.rmsDbL, 1, -90);
    this.rdRmsR.textContent = fmtDb(frame.rmsDbR, 1, -90);
    this.rdHoldL.textContent = fmtDb(frame.peakHoldDbL, 1, -90);
    this.rdHoldR.textContent = fmtDb(frame.peakHoldDbR, 1, -90);

    this.rdLufsS.textContent = fmtDb(frame.lufsShortTerm, 1, -90);
    this.rdLufsM.textContent = fmtDb(frame.lufsMomentary, 1, -90);
    this.rdLufsI.textContent = fmtDb(frame.lufsIntegrated, 1, -90);
    this.rdPlr.textContent = Number.isFinite(frame.plrDb) ? `${frame.plrDb.toFixed(1)} dB` : '--.-';

    // Render vertical segmented bar meters
    const { width: w, height: h, dpr } = this.size;
    const ctx = this.ctx;
    ctx.save();
    ctx.scale(dpr, dpr);

    ctx.fillStyle = '#050505';
    ctx.fillRect(0, 0, w, h);

    const padT = 6;
    const padB = 16;
    const scaleW = 30;
    const barGap = 4;
    const barW = Math.max(12, Math.floor((w - scaleW - barGap * 3) / 2));
    const xL = scaleW + barGap;
    const xR = xL + barW + barGap;
    const plotH = Math.max(20, h - padT - padB);

    const dbToY = (db: number) => padT + (1 - this.dbToNorm(db)) * plotH;

    // Calibrated dB scale markings
    ctx.font = '500 8px "JetBrains Mono", monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const db of SCALE_MARKS) {
      const y = Math.floor(dbToY(db)) + 0.5;
      ctx.strokeStyle = '#1C1C1C';
      ctx.beginPath();
      ctx.moveTo(scaleW - 3, y);
      ctx.lineTo(w - 4, y);
      ctx.stroke();

      ctx.fillStyle = db === 0 ? '#FF1744' : db >= -6 ? '#EDEDED' : '#686868';
      ctx.fillText(`${db}`, scaleW - 5, y);
    }

    this.drawChannelBar(ctx, xL, padT, barW, plotH, frame.rmsDbL, frame.peakDbL, frame.peakHoldDbL);
    this.drawChannelBar(ctx, xR, padT, barW, plotH, frame.rmsDbR, frame.peakDbR, frame.peakHoldDbR);

    // Channel footers
    ctx.fillStyle = '#686868';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText('L', xL + barW * 0.5, h - 2);
    ctx.fillText('R', xR + barW * 0.5, h - 2);

    ctx.restore();
  }

  private drawChannelBar(
    ctx: CanvasRenderingContext2D,
    x: number,
    top: number,
    w: number,
    h: number,
    rmsDb: number,
    peakDb: number,
    holdDb: number,
  ): void {
    // Unlit segmented track
    const segH = 2;
    const segStep = 3;
    ctx.fillStyle = '#111111';
    for (let sy = top; sy < top + h - 1; sy += segStep) {
      ctx.fillRect(x, sy, w, segH);
    }

    const rmsNorm = this.dbToNorm(rmsDb);
    const peakNorm = this.dbToNorm(peakDb);
    const holdNorm = this.dbToNorm(holdDb);
    const warnNorm = this.dbToNorm(-3);
    const clipNorm = this.dbToNorm(-0.5);

    // Instantaneous Peak segmented column (between RMS and Peak)
    if (peakNorm > 0.002) {
      const yPeak = top + (1 - peakNorm) * h;
      for (let sy = top + h - segH; sy >= yPeak; sy -= segStep) {
        const segNorm = 1 - (sy - top) / h;
        ctx.fillStyle = segNorm >= clipNorm ? '#FF1744' : segNorm >= warnNorm ? '#FF4D00' : '#7A7A7A';
        ctx.fillRect(x, sy, w, segH);
      }
    }

    // Solid RMS body (#EDEDED)
    if (rmsNorm > 0.002) {
      const rmsH = rmsNorm * h;
      const yRms = top + h - rmsH;
      ctx.fillStyle = '#EDEDED';
      ctx.fillRect(x + 1, yRms, w - 2, rmsH);
    }

    // Floating Peak-Hold tick (#FF4D00)
    if (holdNorm > 0.002) {
      const yHold = Math.round(top + (1 - holdNorm) * h);
      ctx.fillStyle = holdDb >= -0.1 ? '#FF1744' : '#FF4D00';
      ctx.fillRect(x, yHold, w, 2);
    }

    // Hairline border around channel slot
    ctx.strokeStyle = '#222222';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, top + 0.5, w - 1, h - 1);
  }
}

