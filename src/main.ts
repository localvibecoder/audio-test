/**
 * REF-01 // AUDIO QUALITY INSPECTOR & ACOUSTIC FIELD ANALYZER
 * Main application bootstrap, hardware transport wiring, drag-and-drop controller,
 * and locked 60fps requestAnimationFrame render scheduler.
 */

import { AudioEngine } from './audio/engine';
import { Ferrofluid3DModule } from './modules/ferrofluid3d';
import { GoniometerModule } from './modules/goniometer';
import { MetersModule } from './modules/meters';
import { TranscodeRadarModule } from './modules/radar';
import { WaveformScrubber } from './modules/scrubber';
import { Spectrum2DModule } from './modules/spectrum2d';
import { fmtTime } from './util/format';

const engine = new AudioEngine();

// ── Instantiate Rack Modules ──
const scrubber = new WaveformScrubber(document.getElementById('scrubber')!, engine);
const radar = new TranscodeRadarModule();
const view2dEl = document.getElementById('view-2d')!;
const view3dEl = document.getElementById('view-3d')!;
const spectrum2d = new Spectrum2DModule(view2dEl);
const ferrofluid3d = new Ferrofluid3DModule(view3dEl);
const goniometer = new GoniometerModule();
const meters = new MetersModule(engine);

// ── DOM References ──
const btnLoad = document.getElementById('btn-load') as HTMLButtonElement;
const fileInput = document.getElementById('file-input') as HTMLInputElement;
const btnSynth = document.getElementById('btn-synth') as HTMLButtonElement;
const btnPlay = document.getElementById('btn-play') as HTMLButtonElement;
const btnStop = document.getElementById('btn-stop') as HTMLButtonElement;
const btnLoop = document.getElementById('btn-loop') as HTMLButtonElement;
const btnReset = document.getElementById('btn-reset') as HTMLButtonElement;
const btnTranscode = document.getElementById('btn-transcode') as HTMLButtonElement;

const timePosEl = document.getElementById('time-pos')!;
const timeDurEl = document.getElementById('time-dur')!;
const fileNameEl = document.getElementById('file-name')!;

const ppSr = document.getElementById('pp-sr')!;
const ppCh = document.getElementById('pp-ch')!;
const ppBits = document.getElementById('pp-bits')!;
const ppContainer = document.getElementById('pp-container')!;
const ppCodec = document.getElementById('pp-codec')!;
const ppDur = document.getElementById('pp-dur')!;

const btnMode2d = document.getElementById('mode-2d') as HTMLButtonElement;
const btnMode3d = document.getElementById('mode-3d') as HTMLButtonElement;

const stLed = document.getElementById('st-led')!;
const stEngine = document.getElementById('st-engine')!;
const stCtx = document.getElementById('st-ctx')!;
const stFft = document.getElementById('st-fft')!;
const stLat = document.getElementById('st-lat')!;
const stMsg = document.getElementById('st-msg')!;
const stFps = document.getElementById('st-fps')!;
const monVol = document.getElementById('mon-vol') as HTMLInputElement;
const monVal = document.getElementById('mon-val')!;
const dropOverlay = document.getElementById('drop-overlay')!;

let viewportMode: '2d' | '3d' = '2d';

function setViewportMode(mode: '2d' | '3d'): void {
  viewportMode = mode;
  btnMode2d.setAttribute('aria-pressed', mode === '2d' ? 'true' : 'false');
  btnMode3d.setAttribute('aria-pressed', mode === '3d' ? 'true' : 'false');
  view2dEl.classList.toggle('hidden', mode !== '2d');
  view3dEl.classList.toggle('hidden', mode !== '3d');
  // Trigger resize dispatch so newly visible viewport measures immediately
  window.dispatchEvent(new Event('resize'));
}

btnMode2d.addEventListener('click', () => setViewportMode('2d'));
btnMode3d.addEventListener('click', () => setViewportMode('3d'));

// ── Top Bar Transport Wiring ──
btnLoad.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) {
    void engine.loadFile(file);
    fileInput.value = '';
  }
});

btnSynth.addEventListener('click', () => {
  engine.setSynthActive(!engine.isSynthActive);
});

btnPlay.addEventListener('click', () => {
  engine.togglePlay();
});

btnStop.addEventListener('click', () => {
  engine.stop();
});

btnLoop.setAttribute('aria-pressed', engine.isLoop ? 'true' : 'false');
btnLoop.addEventListener('click', () => {
  engine.setLoop(!engine.isLoop);
});

btnReset.addEventListener('click', () => {
  engine.resetPeaks();
  stMsg.textContent = 'Peak-hold envelope, cutoff ceiling, clip latches, and integrated LUFS reset.';
});

btnTranscode.addEventListener('click', () => {
  engine.setTranscodeSim(!engine.isTranscodeSim);
});

monVol.addEventListener('input', () => {
  const db = parseFloat(monVol.value);
  engine.setMonitorDb(db);
  monVal.textContent = db <= -59.5 ? 'MUTE' : `${db.toFixed(1)} dB`;
});

// ── Engine State & Passport Subscription ──
engine.on('state', (s) => {
  btnSynth.setAttribute('aria-pressed', s.synthActive ? 'true' : 'false');
  btnSynth.querySelector('[data-state]')!.textContent = s.synthActive ? 'ON' : 'OFF';

  btnTranscode.setAttribute('aria-pressed', s.transcodeSim ? 'true' : 'false');
  btnTranscode.querySelector('[data-state]')!.textContent = s.transcodeSim ? 'ON' : 'OFF';

  btnLoop.setAttribute('aria-pressed', s.loop ? 'true' : 'false');

  const canPlay = engine.hasFile || s.synthActive;
  btnPlay.disabled = !canPlay;
  btnStop.disabled = !canPlay;

  const isRunning = s.playing || s.synthActive;
  btnPlay.querySelector('[data-icon-play]')!.classList.toggle('hidden', isRunning);
  btnPlay.querySelector('[data-icon-pause]')!.classList.toggle('hidden', !isRunning);
  btnPlay.querySelector('[data-label]')!.textContent = isRunning ? 'Pause' : 'Play';

  fileNameEl.textContent = s.fileName ?? 'No media loaded';

  // Populate File Passport
  const p = s.passport;
  if (p) {
    ppSr.textContent = p.sampleRate ? `${(p.sampleRate / 1000).toFixed(1)} kHz` : '—';
    ppCh.textContent =
      p.channels === 1 ? 'MONO (1)' : p.channels === 2 ? 'STEREO (2)' : p.channels ? `${p.channels} CH` : '—';
    ppBits.textContent = p.bitDepth ? `${p.bitDepth}-BIT` : 'LOSSY';
    ppContainer.textContent = p.container;
    ppCodec.textContent = p.bitrateKbps ? `${p.codec} · ${p.bitrateKbps}k` : p.codec;
    ppDur.textContent = p.duration ? fmtTime(p.duration) : '—';
  }

  // Update footer engine status
  const ctx = engine.context;
  if (ctx) {
    stLed.style.backgroundColor = isRunning ? '#00E676' : '#FFB300';
    stEngine.textContent = isRunning ? 'DSP Active' : 'DSP Standby';
    stCtx.textContent = `CTX ${ctx.sampleRate} Hz`;
    stFft.textContent = `FFT 8192 · Δf ${(ctx.sampleRate / 8192).toFixed(2)} Hz`;
    const latMs = ((ctx.baseLatency || 0) + (ctx.outputLatency || 0)) * 1000;
    stLat.textContent = `LAT ${(latMs > 0 ? latMs : 5.3).toFixed(1)} ms`;
  }
});

engine.on('status', (msg) => {
  stMsg.textContent = msg;
});

// ── Full-Window Drag-and-Drop Controller ──
let dragDepth = 0;

window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  e.preventDefault();
  dragDepth++;
  dropOverlay.classList.remove('hidden');
});

window.addEventListener('dragover', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});

window.addEventListener('dragleave', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  e.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropOverlay.classList.add('hidden');
});

window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropOverlay.classList.add('hidden');
  const file = e.dataTransfer?.files?.[0];
  if (file) {
    void engine.loadFile(file);
  }
});

// ── Global Hardware Keyboard Shortcuts ──
window.addEventListener('keydown', (e) => {
  const tag = (e.target as HTMLElement | null)?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

  if (e.code === 'Space') {
    e.preventDefault();
    if (engine.hasFile || engine.isSynthActive) engine.togglePlay();
    else engine.setSynthActive(true);
  } else if (e.code === 'Escape') {
    e.preventDefault();
    engine.stop();
  } else if (e.code === 'KeyT') {
    e.preventDefault();
    engine.setTranscodeSim(!engine.isTranscodeSim);
  } else if (e.code === 'KeyV') {
    e.preventDefault();
    setViewportMode(viewportMode === '2d' ? '3d' : '2d');
  } else if (e.code === 'KeyG') {
    e.preventDefault();
    engine.setSynthActive(!engine.isSynthActive);
  } else if (e.code === 'KeyR') {
    e.preventDefault();
    engine.resetPeaks();
  } else if (e.code === 'KeyL') {
    e.preventDefault();
    engine.setLoop(!engine.isLoop);
  }
});

// ── 60fps Master Render & Telemetry Loop ──
let fpsFrames = 0;
let fpsAccumMs = 0;
let fpsLastStamp = performance.now();

function tick(now: number): void {
  const frameStart = performance.now();

  const frame = engine.sample(now);

  // Update transport timestamps
  const cur = engine.currentTime;
  const dur = engine.duration;
  timePosEl.textContent = fmtTime(cur);
  timeDurEl.textContent = fmtTime(dur);

  // Render all active rack units
  scrubber.render();
  radar.render(frame);
  if (viewportMode === '2d') {
    spectrum2d.render(frame);
  } else {
    ferrofluid3d.render(frame);
  }
  goniometer.render(frame);
  meters.render(frame);

  // Frame-rate & frame-budget telemetry
  const workMs = performance.now() - frameStart;
  fpsFrames++;
  fpsAccumMs += workMs;
  if (now - fpsLastStamp >= 400) {
    const fps = (fpsFrames * 1000) / (now - fpsLastStamp);
    const avgMs = fpsAccumMs / fpsFrames;
    stFps.textContent = `${Math.min(60, fps).toFixed(1)} FPS · ${avgMs.toFixed(2)} ms`;
    fpsFrames = 0;
    fpsAccumMs = 0;
    fpsLastStamp = now;
  }

  requestAnimationFrame(tick);
}

requestAnimationFrame(tick);

