/**
 * Top Bar Precision Waveform / Timeline Scrubber
 * Renders either the pre-computed full-track waveform (when an audio file is loaded)
 * or a live rolling envelope (when the Reference Synth Loop is active).
 */

import { AudioEngine } from '../audio/engine';
import { clamp, fmtTime } from '../util/format';
import { observeViewport, ViewportSize } from '../util/resize';

export class WaveformScrubber {
  private readonly container: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly engine: AudioEngine;

  private size: ViewportSize = { width: 1, height: 1, dpr: 1, pxWidth: 1, pxHeight: 1 };
  private peaksMin: Float32Array | null = null;
  private peaksMax: Float32Array | null = null;
  private duration = 0;
  private hoverX: number | null = null;
  private dragging = false;

  constructor(container: HTMLElement, engine: AudioEngine) {
    this.container = container;
    this.canvas = container.querySelector('canvas')!;
    this.ctx = this.canvas.getContext('2d', { alpha: false })!;
    this.engine = engine;

    observeViewport(container, (sz) => {
      this.size = sz;
    });

    engine.on('waveform', ({ peaksMin, peaksMax, duration }) => {
      this.peaksMin = peaksMin;
      this.peaksMax = peaksMax;
      this.duration = duration;
      this.container.setAttribute('aria-valuemax', duration.toFixed(3));
    });

    const seekFromEvent = (e: PointerEvent) => {
      if (!this.engine.hasFile || this.duration <= 0) return;
      const rect = this.container.getBoundingClientRect();
      const ratio = clamp((e.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
      this.engine.seek(ratio * this.duration);
    };

    container.addEventListener('pointerdown', (e) => {
      if (!this.engine.hasFile) return;
      this.dragging = true;
      container.setPointerCapture(e.pointerId);
      seekFromEvent(e);
    });

    container.addEventListener('pointermove', (e) => {
      const rect = this.container.getBoundingClientRect();
      this.hoverX = clamp(e.clientX - rect.left, 0, rect.width);
      if (this.dragging) seekFromEvent(e);
    });

    container.addEventListener('pointerup', (e) => {
      if (this.dragging) {
        this.dragging = false;
        container.releasePointerCapture(e.pointerId);
      }
    });

    container.addEventListener('pointerleave', () => {
      this.hoverX = null;
    });

    container.addEventListener('keydown', (e) => {
      if (!this.engine.hasFile || this.duration <= 0) return;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        this.engine.seek(this.engine.currentTime - (e.shiftKey ? 10 : 2));
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        this.engine.seek(this.engine.currentTime + (e.shiftKey ? 10 : 2));
      } else if (e.key === 'Home') {
        e.preventDefault();
        this.engine.seek(0);
      }
    });
  }

  render(): void {
    const { width: w, height: h, dpr } = this.size;
    const ctx = this.ctx;
    ctx.save();
    ctx.scale(dpr, dpr);

    // Void background
    ctx.fillStyle = '#050505';
    ctx.fillRect(0, 0, w, h);

    // Subtle vertical technical gridlines + center 0-axis
    ctx.strokeStyle = '#141414';
    ctx.lineWidth = 1;
    const stepX = Math.max(24, Math.floor(w / 12));
    ctx.beginPath();
    for (let x = stepX; x < w; x += stepX) {
      const px = Math.floor(x) + 0.5;
      ctx.moveTo(px, 0);
      ctx.lineTo(px, h);
    }
    const midY = Math.floor(h * 0.5) + 0.5;
    ctx.moveTo(0, midY);
    ctx.lineTo(w, midY);
    ctx.stroke();

    const cur = this.engine.currentTime;
    const dur = this.engine.duration;
    const progress = dur > 0 ? clamp(cur / dur, 0, 1) : 0;
    const playX = Math.floor(progress * w);

    if (this.engine.isSynthActive && !this.engine.isPlaying) {
      // Rolling waveform for internal synth loop
      const { min, max, writeIdx } = this.engine.getSynthWaveform();
      const len = min.length;
      const half = h * 0.45;
      ctx.strokeStyle = '#8A8A8A';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x < w; x++) {
        const idx = (writeIdx + Math.floor((x / w) * len)) % len;
        const y0 = midY + min[idx] * half;
        const y1 = midY + max[idx] * half;
        ctx.moveTo(x + 0.5, y0);
        ctx.lineTo(x + 0.5, y1);
      }
      ctx.stroke();
    } else if (this.peaksMin && this.peaksMax && this.peaksMin.length > 0) {
      const len = this.peaksMin.length;
      const half = h * 0.44;
      for (let x = 0; x < w; x++) {
        const idx = Math.min(len - 1, Math.floor((x / w) * len));
        const y0 = midY + this.peaksMin[idx] * half;
        const y1 = midY + this.peaksMax[idx] * half;
        ctx.strokeStyle = x <= playX ? '#EDEDED' : '#444444';
        ctx.beginPath();
        ctx.moveTo(x + 0.5, Math.min(midY - 0.5, y0));
        ctx.lineTo(x + 0.5, Math.max(midY + 0.5, y1));
        ctx.stroke();
      }
    }

    // Playhead cursor (#FF4D00)
    if (dur > 0) {
      const px = clamp(playX, 1, w - 1) + 0.5;
      ctx.strokeStyle = '#FF4D00';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, h);
      ctx.stroke();

      ctx.fillStyle = '#FF4D00';
      ctx.beginPath();
      ctx.moveTo(px - 3, 0);
      ctx.lineTo(px + 3, 0);
      ctx.lineTo(px, 4);
      ctx.closePath();
      ctx.fill();
    }

    // Hover seek preview + millisecond stamp
    if (this.hoverX !== null && this.engine.hasFile && dur > 0) {
      const hx = Math.floor(this.hoverX) + 0.5;
      ctx.strokeStyle = '#8A8A8A';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(hx, 0);
      ctx.lineTo(hx, h);
      ctx.stroke();

      const hoverTime = fmtTime((this.hoverX / Math.max(1, w)) * dur);
      ctx.font = '500 9px "JetBrains Mono", monospace';
      const tw = ctx.measureText(hoverTime).width + 8;
      const bx = clamp(this.hoverX - tw * 0.5, 1, Math.max(1, w - tw - 1));
      ctx.fillStyle = '#0A0A0A';
      ctx.fillRect(bx, 1, tw, 12);
      ctx.strokeStyle = '#3A3A3A';
      ctx.strokeRect(bx + 0.5, 1.5, tw - 1, 11);
      ctx.fillStyle = '#EDEDED';
      ctx.fillText(hoverTime, bx + 4, 10);
    }

    ctx.restore();
  }
}

