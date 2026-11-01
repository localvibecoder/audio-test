/**
 * Container / codec header inspection ("file passport") and a native PCM decoder
 * for AIFF / AIFC (not decodable by Chromium/Firefox decodeAudioData) and as a
 * fallback for exotic WAV variants.
 */

export interface FilePassport {
  container: string;
  codec: string;
  sampleRate: number | null;
  channels: number | null;
  bitDepth: number | null;
  /** Nominal / average bitrate in kbps for compressed formats. */
  bitrateKbps: number | null;
  /** True when bitrate is variable (Xing/VBRI header). */
  vbr: boolean;
  /** Duration estimate from headers (s), refined after decoding. */
  duration: number | null;
  /** Byte layout of raw PCM when we can decode natively. */
  pcm: PcmLayout | null;
}

export interface PcmLayout {
  format: 'int' | 'float';
  bits: number;
  littleEndian: boolean;
  channels: number;
  sampleRate: number;
  dataOffset: number;
  dataLength: number;
}

const MPEG_BITRATES: Record<string, number[]> = {
  // [version][layer] tables (kbps), index 0 = free, 15 = bad
  'V1L1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  'V1L2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  'V1L3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  'V2L1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  'V2L2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  'V2L3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const MPEG_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000], // MPEG-1
  2: [22050, 24000, 16000], // MPEG-2
  0: [11025, 12000, 8000], // MPEG-2.5
};

const fourCC = (v: DataView, o: number) =>
  o + 4 <= v.byteLength ? String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3)) : '';

function emptyPassport(container: string): FilePassport {
  return { container, codec: '—', sampleRate: null, channels: null, bitDepth: null, bitrateKbps: null, vbr: false, duration: null, pcm: null };
}

/** IEEE 754 80-bit extended (AIFF sample rate). */
function readExtended(v: DataView, o: number): number {
  const expon = v.getUint16(o) & 0x7fff;
  const hi = v.getUint32(o + 2);
  const lo = v.getUint32(o + 6);
  if (expon === 0 && hi === 0 && lo === 0) return 0;
  const sign = v.getUint16(o) & 0x8000 ? -1 : 1;
  return sign * (hi * Math.pow(2, expon - 16383 - 31) + lo * Math.pow(2, expon - 16383 - 63));
}

function parseWav(v: DataView, rf64: boolean): FilePassport {
  const p = emptyPassport(rf64 ? 'RF64 / WAV' : 'WAV / RIFF');
  let o = 12;
  let fmt: { tag: number; ch: number; sr: number; byteRate: number; bits: number; subTag: number } | null = null;
  let ds64Data = 0;
  while (o + 8 <= v.byteLength) {
    const id = fourCC(v, o);
    let size = v.getUint32(o + 4, true);
    const body = o + 8;
    if (id === 'ds64' && body + 16 <= v.byteLength) {
      ds64Data = v.getUint32(body + 8, true) + v.getUint32(body + 12, true) * 2 ** 32;
    } else if (id === 'fmt ' && body + 16 <= v.byteLength) {
      const tag = v.getUint16(body, true);
      fmt = {
        tag,
        ch: v.getUint16(body + 2, true),
        sr: v.getUint32(body + 4, true),
        byteRate: v.getUint32(body + 8, true),
        bits: v.getUint16(body + 14, true),
        subTag: tag === 0xfffe && size >= 40 && body + 26 <= v.byteLength ? v.getUint16(body + 24, true) : tag,
      };
    } else if (id === 'data') {
      if (rf64 && size === 0xffffffff) size = ds64Data;
      const length = Math.min(size, v.byteLength - body);
      if (fmt) {
        const isFloat = fmt.subTag === 3;
        const isPcm = fmt.subTag === 1;
        p.sampleRate = fmt.sr;
        p.channels = fmt.ch;
        p.bitDepth = fmt.bits;
        p.codec = isFloat ? `IEEE FLOAT ${fmt.bits}` : isPcm ? `LPCM ${fmt.bits}-BIT` : `FMT 0x${fmt.subTag.toString(16).toUpperCase()}`;
        p.bitrateKbps = Math.round((fmt.byteRate * 8) / 1000);
        if (fmt.byteRate > 0) p.duration = size / fmt.byteRate;
        if (isPcm || isFloat) {
          p.pcm = {
            format: isFloat ? 'float' : 'int',
            bits: fmt.bits,
            littleEndian: true,
            channels: fmt.ch,
            sampleRate: fmt.sr,
            dataOffset: body,
            dataLength: length,
          };
        }
      }
      break;
    }
    o = body + size + (size & 1);
  }
  return p;
}

function parseAiff(v: DataView, aifc: boolean): FilePassport {
  const p = emptyPassport(aifc ? 'AIFF-C' : 'AIFF');
  let o = 12;
  let comm: { ch: number; frames: number; bits: number; sr: number; comp: string } | null = null;
  while (o + 8 <= v.byteLength) {
    const id = fourCC(v, o);
    const size = v.getUint32(o + 4, false);
    const body = o + 8;
    if (id === 'COMM' && body + 18 <= v.byteLength) {
      comm = {
        ch: v.getUint16(body, false),
        frames: v.getUint32(body + 2, false),
        bits: v.getUint16(body + 6, false),
        sr: readExtended(v, body + 8),
        comp: aifc && body + 22 <= v.byteLength ? fourCC(v, body + 18) : 'NONE',
      };
    } else if (id === 'SSND' && comm) {
      const offset = v.getUint32(body, false);
      const dataOffset = body + 8 + offset;
      const comp = comm.comp.toLowerCase();
      let format: 'int' | 'float' = 'int';
      let bits = comm.bits;
      let little = false;
      let ok = true;
      if (comp === 'none' || comp === 'twos') { /* big-endian int */ }
      else if (comp === 'sowt') little = true;
      else if (comp === 'fl32') { format = 'float'; bits = 32; }
      else if (comp === 'fl64') { format = 'float'; bits = 64; }
      else ok = false;
      p.sampleRate = Math.round(comm.sr);
      p.channels = comm.ch;
      p.bitDepth = bits;
      p.codec = format === 'float' ? `FLOAT ${bits} ${comm.comp.toUpperCase()}` : `LPCM ${bits}-BIT ${little ? 'LE' : 'BE'}`;
      p.duration = comm.sr > 0 ? comm.frames / comm.sr : null;
      p.bitrateKbps = Math.round((comm.sr * comm.ch * bits) / 1000);
      if (ok) {
        const frameBytes = Math.ceil(bits / 8) * comm.ch;
        p.pcm = {
          format,
          bits,
          littleEndian: little,
          channels: comm.ch,
          sampleRate: Math.round(comm.sr),
          dataOffset,
          dataLength: Math.min(comm.frames * frameBytes, v.byteLength - dataOffset),
        };
      }
      break;
    }
    o = body + size + (size & 1);
  }
  if (!p.pcm && comm) {
    p.sampleRate = Math.round(comm.sr);
    p.channels = comm.ch;
    p.bitDepth = comm.bits;
    p.codec = comm.comp.toUpperCase();
  }
  return p;
}

function skipId3(v: DataView): number {
  if (fourCC(v, 0).slice(0, 3) !== 'ID3' || v.byteLength < 10) return 0;
  const size = ((v.getUint8(6) & 0x7f) << 21) | ((v.getUint8(7) & 0x7f) << 14) | ((v.getUint8(8) & 0x7f) << 7) | (v.getUint8(9) & 0x7f);
  const footer = v.getUint8(5) & 0x10 ? 10 : 0;
  return 10 + size + footer;
}

function parseFlac(v: DataView, start: number): FilePassport {
  const p = emptyPassport('FLAC');
  const o = start + 4; // after 'fLaC'
  if (o + 4 + 18 > v.byteLength) return p;
  const type = v.getUint8(o) & 0x7f;
  if (type !== 0) return p;
  const b = o + 4;
  const sr = (v.getUint8(b + 10) << 12) | (v.getUint8(b + 11) << 4) | (v.getUint8(b + 12) >> 4);
  const ch = ((v.getUint8(b + 12) >> 1) & 0x07) + 1;
  const bps = (((v.getUint8(b + 12) & 0x01) << 4) | (v.getUint8(b + 13) >> 4)) + 1;
  const total = (v.getUint8(b + 13) & 0x0f) * 2 ** 32 + v.getUint32(b + 14, false);
  p.sampleRate = sr;
  p.channels = ch;
  p.bitDepth = bps;
  p.codec = `FLAC ${bps}-BIT`;
  if (sr > 0 && total > 0) {
    p.duration = total / sr;
    p.bitrateKbps = Math.round((v.byteLength * 8) / p.duration / 1000);
  }
  return p;
}

function parseMpeg(v: DataView, start: number): FilePassport {
  const p = emptyPassport('MPEG AUDIO');
  const limit = Math.min(v.byteLength - 4, start + 256 * 1024);
  for (let o = start; o < limit; o++) {
    if (v.getUint8(o) !== 0xff || (v.getUint8(o + 1) & 0xe0) !== 0xe0) continue;
    const h = v.getUint32(o, false);
    const ver = (h >> 19) & 3;
    const layer = (h >> 17) & 3;
    const brIdx = (h >> 12) & 15;
    const srIdx = (h >> 10) & 3;
    const pad = (h >> 9) & 1;
    const mode = (h >> 6) & 3;
    if (ver === 1 || layer === 0 || brIdx === 15 || brIdx === 0 || srIdx === 3) continue;
    const layerNum = 4 - layer;
    const key = `${ver === 3 ? 'V1' : 'V2'}L${layerNum}`;
    const kbps = MPEG_BITRATES[key][brIdx];
    const sr = MPEG_RATES[ver][srIdx];
    const samplesPerFrame = layerNum === 1 ? 384 : layerNum === 3 && ver !== 3 ? 576 : 1152;
    const frameLen = layerNum === 1 ? Math.floor((12 * kbps * 1000) / sr + pad) * 4 : Math.floor(((samplesPerFrame / 8) * kbps * 1000) / sr) + pad;
    // Validate by checking the next frame sync.
    const next = o + frameLen;
    if (next + 1 < v.byteLength && !(v.getUint8(next) === 0xff && (v.getUint8(next + 1) & 0xe0) === 0xe0)) continue;
    p.sampleRate = sr;
    p.channels = mode === 3 ? 1 : 2;
    p.bitrateKbps = kbps;
    p.container = 'MP3 / MPEG';
    const vname = ver === 3 ? 'MPEG-1' : ver === 2 ? 'MPEG-2' : 'MPEG-2.5';
    // Xing / Info header (VBR)
    const sideInfo = ver === 3 ? (mode === 3 ? 17 : 32) : mode === 3 ? 9 : 17;
    const xo = o + 4 + sideInfo;
    const tag = fourCC(v, xo);
    let frames = 0;
    if ((tag === 'Xing' || tag === 'Info') && xo + 12 <= v.byteLength) {
      const flags = v.getUint32(xo + 4, false);
      if (flags & 1) frames = v.getUint32(xo + 8, false);
      p.vbr = tag === 'Xing';
    } else if (fourCC(v, o + 36) === 'VBRI' && o + 50 <= v.byteLength) {
      frames = v.getUint32(o + 36 + 14, false);
      p.vbr = true;
    }
    const audioBytes = v.byteLength - o;
    if (frames > 0) {
      p.duration = (frames * samplesPerFrame) / sr;
      if (p.vbr) p.bitrateKbps = Math.round((audioBytes * 8) / p.duration / 1000);
    } else if (kbps > 0) {
      p.duration = (audioBytes * 8) / (kbps * 1000);
    }
    p.codec = `${vname} L${layerNum} ${p.vbr ? 'VBR' : 'CBR'}`;
    return p;
  }
  return p;
}

function parseOgg(v: DataView): FilePassport {
  const p = emptyPassport('OGG');
  if (v.byteLength < 28) return p;
  const nseg = v.getUint8(26);
  const pkt = 27 + nseg;
  if (pkt + 30 > v.byteLength) return p;
  const head = String.fromCharCode(...Array.from({ length: 8 }, (_, i) => v.getUint8(pkt + i)));
  if (head.startsWith('\x01vorbis')) {
    p.codec = 'VORBIS';
    p.channels = v.getUint8(pkt + 11);
    p.sampleRate = v.getUint32(pkt + 12, true);
    const nominal = v.getInt32(pkt + 20, true);
    p.bitrateKbps = nominal > 0 ? Math.round(nominal / 1000) : null;
    p.vbr = true;
  } else if (head === 'OpusHead') {
    p.codec = 'OPUS';
    p.container = 'OGG / OPUS';
    p.channels = v.getUint8(pkt + 9);
    // Opus always decodes at 48 kHz; the input rate is informational only.
    p.sampleRate = 48000;
    p.vbr = true;
  } else if (head.startsWith('\x7fFLAC')) {
    p.codec = 'OGG FLAC';
  }
  // Duration from last page granule position.
  const tailStart = Math.max(0, v.byteLength - 65536);
  for (let o = v.byteLength - 14; o >= tailStart; o--) {
    if (v.getUint8(o) === 0x4f && fourCC(v, o) === 'OggS') {
      const granule = v.getUint32(o + 6, true) + v.getUint32(o + 10, true) * 2 ** 32;
      const rate = p.codec === 'OPUS' ? 48000 : p.sampleRate;
      if (rate && granule > 0 && granule < 2 ** 52) {
        p.duration = granule / rate;
        if (!p.bitrateKbps) p.bitrateKbps = Math.round((v.byteLength * 8) / p.duration / 1000);
      }
      break;
    }
  }
  return p;
}

function parseMp4(v: DataView): FilePassport {
  const p = emptyPassport('MP4 / M4A');
  p.codec = 'AAC / ALAC';
  // Find 'mdhd' for timescale & duration, and 'stsd' sample entry for rate/channels.
  const u8 = new Uint8Array(v.buffer, v.byteOffset, Math.min(v.byteLength, 4 * 1024 * 1024));
  const find = (tag: string) => {
    const t = [...tag].map((c) => c.charCodeAt(0));
    for (let i = 4; i < u8.length - 4; i++) if (u8[i] === t[0] && u8[i + 1] === t[1] && u8[i + 2] === t[2] && u8[i + 3] === t[3]) return i;
    return -1;
  };
  const mp4a = find('mp4a');
  const alac = find('alac');
  const entry = mp4a >= 0 ? mp4a : alac;
  if (entry >= 0 && entry + 28 < u8.length) {
    p.codec = mp4a >= 0 ? 'AAC (MP4A)' : 'ALAC';
    p.channels = v.getUint16(entry + 20, false);
    p.bitDepth = alac >= 0 && mp4a < 0 ? v.getUint16(entry + 22, false) : null;
    p.sampleRate = v.getUint16(entry + 28, false);
  }
  const mdhd = find('mdhd');
  if (mdhd >= 0 && mdhd + 24 < u8.length) {
    const version = u8[mdhd + 4];
    if (version === 0) {
      const ts = v.getUint32(mdhd + 16, false);
      const dur = v.getUint32(mdhd + 20, false);
      if (ts > 0) p.duration = dur / ts;
    }
    if (p.duration) p.bitrateKbps = Math.round((v.byteLength * 8) / p.duration / 1000);
  }
  return p;
}

export function inspectFile(buf: ArrayBuffer, fileName: string): FilePassport {
  const v = new DataView(buf);
  const riff = fourCC(v, 0);
  const form = fourCC(v, 8);
  if ((riff === 'RIFF' || riff === 'RIFX') && form === 'WAVE') return parseWav(v, false);
  if (riff === 'RF64' && form === 'WAVE') return parseWav(v, true);
  if (riff === 'FORM' && (form === 'AIFF' || form === 'AIFC')) return parseAiff(v, form === 'AIFC');
  if (riff === 'OggS') return parseOgg(v);
  if (fourCC(v, 4) === 'ftyp') return parseMp4(v);
  const id3 = skipId3(v);
  if (fourCC(v, id3) === 'fLaC') return parseFlac(v, id3);
  if (riff === 'fLaC') return parseFlac(v, 0);
  const mp = parseMpeg(v, id3);
  if (mp.sampleRate) return mp;
  const ext = fileName.split('.').pop()?.toUpperCase() ?? '—';
  return emptyPassport(ext);
}

/** Decode raw PCM (int 8/16/24/32, float 32/64) into an AudioBuffer. */
export function decodePcm(buf: ArrayBuffer, layout: PcmLayout, ctx: BaseAudioContext): AudioBuffer {
  const { bits, channels, littleEndian, format, dataOffset } = layout;
  const bytes = Math.ceil(bits / 8);
  const frameBytes = bytes * channels;
  const frames = Math.floor(layout.dataLength / frameBytes);
  if (frames <= 0 || channels <= 0) throw new Error('PCM stream is empty');
  const out = ctx.createBuffer(channels, frames, layout.sampleRate);
  const v = new DataView(buf, dataOffset, frames * frameBytes);
  const chData: Float32Array[] = [];
  for (let c = 0; c < channels; c++) chData.push(out.getChannelData(c));
  const le = littleEndian;
  // 8-bit WAV is unsigned; 8-bit AIFF is signed.
  const unsigned8 = le && bits <= 8;
  for (let i = 0, o = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++, o += bytes) {
      let s: number;
      if (format === 'float') {
        s = bits === 64 ? v.getFloat64(o, le) : v.getFloat32(o, le);
      } else if (bytes === 1) {
        s = unsigned8 ? (v.getUint8(o) - 128) / 128 : v.getInt8(o) / 128;
      } else if (bytes === 2) {
        s = v.getInt16(o, le) / 32768;
      } else if (bytes === 3) {
        const b0 = v.getUint8(o), b1 = v.getUint8(o + 1), b2 = v.getUint8(o + 2);
        let x = le ? b0 | (b1 << 8) | (b2 << 16) : b2 | (b1 << 8) | (b0 << 16);
        if (x & 0x800000) x |= ~0xffffff;
        s = x / 8388608;
      } else {
        s = v.getInt32(o, le) / 2147483648;
      }
      chData[c][i] = s;
    }
  }
  return out;
}

