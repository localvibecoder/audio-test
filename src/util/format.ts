/** Formatting helpers — fixed-width output for jitter-free tabular readouts. */

export const MINUS = '\u2212';

export function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const totalMs = Math.floor(sec * 1000 + 1e-6);
  const ms = totalMs % 1000;
  const s = Math.floor(totalMs / 1000) % 60;
  const m = Math.floor(totalMs / 60000);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

/** dB value with sign, fixed decimals, floor → "-∞". */
export function fmtDb(db: number, decimals = 1, floor = -120): string {
  if (!Number.isFinite(db) || db <= floor) return `${MINUS}\u221E`;
  const v = db.toFixed(decimals);
  if (v.startsWith('-')) return MINUS + v.slice(1);
  return (db >= 0.05 ? '+' : ' ') + v;
}

export function fmtSigned(v: number, decimals = 2): string {
  const s = Math.abs(v).toFixed(decimals);
  return (v < 0 && Number(s) !== 0 ? MINUS : '+') + s;
}

export function fmtHz(hz: number): string {
  if (!Number.isFinite(hz) || hz <= 0) return '—';
  if (hz >= 1000) return `${(hz / 1000).toFixed(hz >= 10000 ? 2 : 3)} kHz`;
  return `${hz.toFixed(1)} Hz`;
}

export function fmtKHz(hz: number, decimals = 2): string {
  if (!Number.isFinite(hz) || hz <= 0) return '--.--';
  return (hz / 1000).toFixed(decimals).padStart(5, '0');
}

const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export function noteName(hz: number): string {
  if (!(hz > 0)) return '—';
  const m = 69 + 12 * Math.log2(hz / 440);
  const r = Math.round(m);
  const cents = Math.round((m - r) * 100);
  const name = NOTES[((r % 12) + 12) % 12] + (Math.floor(r / 12) - 1);
  return `${name} ${cents >= 0 ? '+' : MINUS}${String(Math.abs(cents)).padStart(2, '0')}¢`;
}

export const dbToGain = (db: number) => Math.pow(10, db / 20);
export const gainToDb = (g: number) => (g > 0 ? 20 * Math.log10(g) : -Infinity);
export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

