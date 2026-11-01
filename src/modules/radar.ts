/**
 * MODULE [01 // TRANSCODE & CUTOFF RADAR] + MODULE [01B // HF SHELF MICROSCOPE]
 *
 * Tracks both Instantaneous Roll-Off (kHz) and Peak-Locked Max Ceiling (kHz)
 * above -78 dBFS to prevent quiet-intro false positives, and renders:
 *  1. Prominent diagnostic status badge (#00E676 / #FFB300 / #FF1744)
 *  2. Ceiling history & threshold zone gauge canvas (10–22 kHz)
 *  3. High-magnification linear 10–22 kHz HF Shelf Microscope canvas
 */

import { DiagnosticClass, RADAR_THRESHOLD_DB, TelemetryFrame } from '../audio/engine';
import { clamp, fmtDb, fmtKHz } from '../util/format';
import { observeViewport, ViewportSize } from '../util/resize';

export class TranscodeRadarModule {
  private readonly badgeEl: HTMLElement;
  private readonly badgePip: HTMLElement;
  private readonly badgeTitle: HTMLElement;
  private readonly badgeSub: HTMLElement;
  private readonly ceilingBigEl: HTMLElement;
  private readonly acqEl: HTMLElement;

  private readonly tmCeiling: HTMLElement;
  private readonly tmCutoff: HTMLElement;
  private readonly tmCentroid: HTMLElement;
  private readonly tmCrest: HTMLElement;
  private readonly tmHf: HTMLElement;
  private readonly tmHfDb: HTMLElement;

  private readonly histCanvas: HTMLCanvasElement;
  private readonly histCtx: CanvasRenderingContext2D;
  private histSize: ViewportSize = { width: 1, height: 1, dpr: 1, pxWidth: 1, pxHeight: 1 };

  private readonly zoomCanvas: HTMLCanvasElement;
  private readonly zoomCtx: CanvasRenderingContext2D;
  private zoomSize: ViewportSize = { width: 1, height: 1, dpr: 1, pxWidth: 1, pxHeight: 1 };

  // Rolling history of Live Cutoff (kHz) and Peak Ceiling (kHz)
  private readonly liveHist = new Float32Array(220);
  private readonly ceilHist = new Float32Array(220);
  private histIdx = 0;
  private lastDiag: DiagnosticClass | '' = '';

  constructor() {
    this.badgeEl = document.getElementById('radar-badge')!;
    this.badgePip = document.getElementById('radar-badge-pip')!;
    this.badgeTitle = document.getElementById('radar-badge-title')!;
    this.badgeSub = document.getElementById('radar-badge-sub')!;
    this.ceilingBigEl = document.getElementById('radar-ceiling-big')!;
    this.acqEl = document.getElementById('radar-acq')!;

    this.tmCeiling = document.getElementById('tm-ceiling')!;
    this.tmCutoff = document.getElementById('tm-cutoff')!;
    this.tmCentroid = document.getElementById('tm-centroid')!;
    this.tmCrest = document.getElementById('tm-crest')!;
    this.tmHf = document.getElementById('tm-hf')!;
    this.tmHfDb = document.getElementById('tm-hfdb')!;

    const histWrap = document.getElementById('radar-history')!;
    this.histCanvas = histWrap.querySelector('canvas')!;
    this.histCtx = this.histCanvas.getContext('2d', { alpha: false })!;
    observeViewport(histWrap, (sz) => {
      this.histSize = sz;
    });

    const zoomWrap = document.getElementById('hf-zoom')!;
    this.zoomCanvas = zoomWrap.querySelector('canvas')!;
    this.zoomCtx = this.zoomCanvas.getContext('2d', { alpha: false })!;
    observeViewport(zoomWrap, (sz) => {
      this.zoomSize = sz;
    });
  }

  render(frame: TelemetryFrame): void {
    // Push history sample when active
    if (frame.active) {
      this.liveHist[this.histIdx] = frame.liveCutoffHz * 0.001;
      this.ceilHist[this.histIdx] = frame.peakCeilingHz * 0.001;
      this.histIdx = (this.histIdx + 1) % this.liveHist.length;
    }

    // Update badge when diagnostic class changes
    if (frame.diagnostic !== this.lastDiag) {
      this.lastDiag = frame.diagnostic;
      this.updateBadge(frame.diagnostic);
    }

    // Numeric telemetry readouts
    const hasSignal = frame.peakCeilingHz > 0;
    this.ceilingBigEl.textContent = hasSignal ? fmtKHz(frame.peakCeilingHz, 2) : '--.--';
    this.acqEl.textContent = `${frame.acquiredSeconds.toFixed(1)} s`;

    this.tmCeiling.textContent = hasSignal ? fmtKHz(frame.peakCeilingHz, 2) : '--.--';
    this.tmCutoff.textContent = frame.liveCutoffHz > 100 ? fmtKHz(frame.liveCutoffHz, 2) : '--.--';
    this.tmCentroid.textContent =
      frame.spectralCentroidHz > 20 ? String(Math.round(frame.spectralCentroidHz)).padStart(4, ' ') : '----';
    this.tmCrest.textContent = frame.dynamicCrestDb > 0.1 ? frame.dynamicCrestDb.toFixed(1).padStart(4, ' ') : '--.-';
    this.tmHf.textContent = hasSignal ? frame.hfEnergyRatioPct.toFixed(3) : '-.---';
    this.tmHfDb.textContent = hasSignal ? fmtDb(frame.hfEnergyDb, 1, -115) : '---.-';

    this.renderHistoryGauge(frame);
    this.renderHfMicroscope(frame);
  }

  private updateBadge(diag: DiagnosticClass): void {
    if (diag === 'lossless') {
      this.badgeEl.style.borderColor = '#00E676';
      this.badgeEl.style.backgroundColor = '#06150D';
      this.badgePip.style.backgroundColor = '#00E676';
      this.badgeTitle.style.color = '#00E676';
      this.badgeTitle.textContent = 'VERIFIED LOSSLESS // FULL SPECTRUM (20kHz+)';
      this.badgeSub.style.color = '#8A8A8A';
      this.badgeSub.textContent = 'PEAK CEILING ≥ 19.4 kHz · TRUE MASTER BANDWIDTH';
      this.ceilingBigEl.style.color = '#00E676';
    } else if (diag === 'lossy') {
      this.badgeEl.style.borderColor = '#FFB300';
      this.badgeEl.style.backgroundColor = '#161104';
      this.badgePip.style.backgroundColor = '#FFB300';
      this.badgeTitle.style.color = '#FFB300';
      this.badgeTitle.textContent = 'LOSSY STREAM // MP3 192-320 EQUIVALENT';
      this.badgeSub.style.color = '#8A8A8A';
      this.badgeSub.textContent = 'PEAK CEILING 16.3–19.3 kHz · HIGH-SHELF ROLL-OFF';
      this.ceilingBigEl.style.color = '#FFB300';
    } else if (diag === 'transcode') {
      this.badgeEl.style.borderColor = '#FF1744';
      this.badgeEl.style.backgroundColor = '#18060A';
      this.badgePip.style.backgroundColor = '#FF1744';
      this.badgeTitle.style.color = '#FF1744';
      this.badgeTitle.textContent = 'TRANSCODE ALERT // 128 KBPS BRICKWALL CUTOFF';
      this.badgeSub.style.color = '#FF4D00';
      this.badgeSub.textContent = 'PEAK CEILING ≤ 16.2 kHz · FAKE LOSSLESS / TRANSCODE';
      this.ceilingBigEl.style.color = '#FF1744';
    } else {
      this.badgeEl.style.borderColor = '#2A2A2A';
      this.badgeEl.style.backgroundColor = '#0A0A0A';
      this.badgePip.style.backgroundColor = '#2A2A2A';
      this.badgeTitle.style.color = '#686868';
      this.badgeTitle.textContent = 'AWAITING SIGNAL // STANDBY';
      this.badgeSub.style.color = '#686868';
      this.badgeSub.textContent = 'LOAD AUDIO FILE OR ENGAGE SYNTH TEST LOOP';
      this.ceilingBigEl.style.color = '#EDEDED';
    }
  }

  /** Render horizontal cutoff ruler + rolling history trace (8 kHz to 22 kHz). */
  private renderHistoryGauge(frame: TelemetryFrame): void {
    const { width: w, height: h, dpr } = this.histSize;
    const ctx = this.histCtx;
    ctx.save();
    ctx.scale(dpr, dpr);

    ctx.fillStyle = '#050505';
    ctx.fillRect(0, 0, w, h);

    const minK = 8;
    const maxK = 22;
    const kToX = (k: number) => clamp(((k - minK) / (maxK - minK)) * w, 0, w);

    // Top bar gauge (0..28px): shows 3 diagnostic zones + live vs peak-locked ceiling bars
    const barH = 26;
    const x162 = Math.floor(kToX(16.2)) + 0.5;
    const x194 = Math.floor(kToX(19.4)) + 0.5;

    // Subtle zone backgrounds
    ctx.fillStyle = 'rgba(255, 23, 68, 0.07)';
    ctx.fillRect(0, 0, x162, barH);
    ctx.fillStyle = 'rgba(255, 179, 0, 0.06)';
    ctx.fillRect(x162, 0, x194 - x162, barH);
    ctx.fillStyle = 'rgba(0, 230, 118, 0.06)';
    ctx.fillRect(x194, 0, w - x194, barH);

    // Live cutoff fill bar
    const liveK = frame.liveCutoffHz * 0.001;
    if (liveK > minK) {
      ctx.fillStyle = 'rgba(237, 237, 237, 0.25)';
      ctx.fillRect(0, 6, kToX(liveK), 6);
    }

    // Peak-locked ceiling fill bar
    const ceilK = frame.peakCeilingHz * 0.001;
    const diagColor =
      frame.diagnostic === 'lossless'
        ? '#00E676'
        : frame.diagnostic === 'lossy'
          ? '#FFB300'
          : frame.diagnostic === 'transcode'
            ? '#FF1744'
            : '#686868';
    if (ceilK > minK) {
      ctx.fillStyle = diagColor;
      ctx.fillRect(0, 15, kToX(ceilK), 6);
    }

    // Divider below gauge
    ctx.strokeStyle = '#222222';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, barH + 0.5);
    ctx.lineTo(w, barH + 0.5);
    ctx.stroke();

    // Rolling timeline area (barH+1 .. h)
    const plotTop = barH + 4;
    const plotH = Math.max(10, h - plotTop - 13);
    const kToY = (k: number) => plotTop + (1 - clamp((k - minK) / (maxK - minK), 0, 1)) * plotH;

    // Grid lines
    ctx.strokeStyle = '#141414';
    ctx.beginPath();
    for (const k of [10, 12, 14, 16, 18, 20, 22]) {
      const x = Math.floor(kToX(k)) + 0.5;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
    }
    ctx.stroke();

    // Threshold markers at 16.2 kHz and 19.4 kHz
    ctx.strokeStyle = '#FF1744';
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    ctx.moveTo(x162, 0);
    ctx.lineTo(x162, h - 12);
    ctx.stroke();

    ctx.strokeStyle = '#00E676';
    ctx.beginPath();
    ctx.moveTo(x194, 0);
    ctx.lineTo(x194, h - 12);
    ctx.stroke();
    ctx.setLineDash([]);

    // Plot rolling Live Cutoff & Peak Ceiling curves across time
    const len = this.liveHist.length;
    ctx.strokeStyle = '#8A8A8A';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < len; i++) {
      const idx = (this.histIdx + i) % len;
      const x = (i / (len - 1)) * w;
      const y = kToY(this.liveHist[idx]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    ctx.strokeStyle = diagColor;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < len; i++) {
      const idx = (this.histIdx + i) % len;
      const x = (i / (len - 1)) * w;
      const y = kToY(this.ceilHist[idx]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Frequency scale labels along bottom strip
    ctx.font = '500 8px "JetBrains Mono", monospace';
    ctx.fillStyle = '#686868';
    ctx.textBaseline = 'bottom';
    for (const k of [10, 12, 14, 16, 18, 20, 22]) {
      const x = kToX(k);
      ctx.textAlign = k === 10 ? 'left' : k === 22 ? 'right' : 'center';
      ctx.fillText(`${k}k`, clamp(x, 2, w - 2), h - 1);
    }

    ctx.restore();
  }

  /**
   * MODULE 01B // HF Shelf Microscope
   * Linear 10 kHz – 22 kHz zoomed spectrum so the 16 kHz / 19 kHz MP3 brickwall shelf
   * can be inspected with laboratory precision.
   */
  private renderHfMicroscope(frame: TelemetryFrame): void {
    const { width: w, height: h, dpr } = this.zoomSize;
    const ctx = this.zoomCtx;
    ctx.save();
    ctx.scale(dpr, dpr);

    ctx.fillStyle = '#050505';
    ctx.fillRect(0, 0, w, h);

    const padL = 26;
    const padR = 6;
    const padT = 8;
    const padB = 16;
    const pw = Math.max(10, w - padL - padR);
    const ph = Math.max(10, h - padT - padB);

    const fMin = 10000;
    const fMax = 22000;
    const dbMin = -96;
    const dbMax = -12;

    const fToX = (f: number) => padL + ((f - fMin) / (fMax - fMin)) * pw;
    const dbToY = (db: number) => padT + (1 - clamp((db - dbMin) / (dbMax - dbMin), 0, 1)) * ph;

    // Gridlines
    ctx.strokeStyle = '#141414';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const f of [10000, 12000, 14000, 16000, 18000, 20000, 22000]) {
      const x = Math.floor(fToX(f)) + 0.5;
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + ph);
    }
    for (const db of [-24, -48, -72, -90]) {
      const y = Math.floor(dbToY(db)) + 0.5;
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + pw, y);
    }
    ctx.stroke();

    // -78 dBFS Radar threshold horizontal line
    const yThr = Math.floor(dbToY(RADAR_THRESHOLD_DB)) + 0.5;
    ctx.strokeStyle = '#3A3A3A';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(padL, yThr);
    ctx.lineTo(padL + pw, yThr);
    ctx.stroke();

    // 16.0 kHz & 19.0 kHz reference lines in #FF4D00
    for (const refHz of [16000, 19000]) {
      const rx = Math.floor(fToX(refHz)) + 0.5;
      ctx.strokeStyle = 'rgba(255, 77, 0, 0.55)';
      ctx.beginPath();
      ctx.moveTo(rx, padT);
      ctx.lineTo(rx, padT + ph);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // Plot Peak-Hold envelope (dashed #8A8A8A) and Live HF Spectrum (#EDEDED)
    const bins = frame.fftDb.length;
    const binHz = frame.nyquist / bins;

    // Peak-Hold trace
    ctx.strokeStyle = '#8A8A8A';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    for (let px = 0; px <= pw; px += 2) {
      const f = fMin + (px / pw) * (fMax - fMin);
      const bin = clamp(Math.round(f / binHz), 0, bins - 1);
      const y = dbToY(frame.maxSpectrumHold[bin]);
      if (px === 0) ctx.moveTo(padL + px, y);
      else ctx.lineTo(padL + px, y);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // Live filled polygon
    ctx.beginPath();
    ctx.moveTo(padL, padT + ph);
    for (let px = 0; px <= pw; px++) {
      const f = fMin + (px / pw) * (fMax - fMin);
      const bin = clamp(Math.round(f / binHz), 0, bins - 1);
      const y = dbToY(frame.fftDb[bin]);
      ctx.lineTo(padL + px, y);
    }
    ctx.lineTo(padL + pw, padT + ph);
    ctx.closePath();
    ctx.fillStyle = 'rgba(237, 237, 237, 0.14)';
    ctx.fill();

    // Live stroke
    ctx.strokeStyle = '#EDEDED';
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    for (let px = 0; px <= pw; px++) {
      const f = fMin + (px / pw) * (fMax - fMin);
      const bin = clamp(Math.round(f / binHz), 0, bins - 1);
      const y = dbToY(frame.fftDb[bin]);
      if (px === 0) ctx.moveTo(padL + px, y);
      else ctx.lineTo(padL + px, y);
    }
    ctx.stroke();

    // Peak-Locked Ceiling marker line
    if (frame.peakCeilingHz >= fMin) {
      const cx = Math.floor(fToX(Math.min(fMax, frame.peakCeilingHz))) + 0.5;
      const color =
        frame.diagnostic === 'lossless'
          ? '#00E676'
          : frame.diagnostic === 'lossy'
            ? '#FFB300'
            : '#FF1744';
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(cx, padT);
      ctx.lineTo(cx, padT + ph);
      ctx.stroke();
    }

    // Labels
    ctx.font = '500 8px "JetBrains Mono", monospace';
    ctx.fillStyle = '#686868';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const db of [-24, -48, -78]) {
      ctx.fillText(`${db}`, padL - 3, dbToY(db));
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    for (const k of [10, 12, 14, 16, 18, 20, 22]) {
      const x = fToX(k * 1000);
      ctx.fillStyle = k === 16 ? '#FF4D00' : '#686868';
      ctx.fillText(`${k}k`, clamp(x, padL + 8, padL + pw - 8), h - 2);
    }

    // Border frame
    ctx.strokeStyle = '#222222';
    ctx.lineWidth = 1;
    ctx.strokeRect(padL + 0.5, padT + 0.5, pw - 1, ph - 1);

    ctx.restore();
  }
}

