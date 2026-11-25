// Spark MCP: what it measures in a printed file, in plain JavaScript with no DOM and no Node, so the
// panel and the MCP server share it. Loudness follows ITU-R BS.1770-4; tests/measure.test.js
// cross-checks it against known signals.

// Classic scripts share one global scope, so each file keeps its names to itself.
(() => {

const db = (power) => (power > 0 ? 10 * Math.log10(power) : -Infinity);
const round = (v, places = 1) => (Number.isFinite(v) ? Number(v.toFixed(places)) : null);

function parseWav(buffer) {
  const view = new DataView(buffer);
  const text = (at, length) => String.fromCharCode(...new Uint8Array(buffer, at, length));
  if (buffer.byteLength < 12 || text(0, 4) !== 'RIFF' || text(8, 4) !== 'WAVE') throw new Error('not a WAV file');
  let format = null;
  let offset = 12;
  while (offset + 8 <= buffer.byteLength) {
    const id = text(offset, 4);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      let code = view.getUint16(body, true);
      if (code === 0xfffe) code = view.getUint16(body + 24, true);
      format = { code, channels: view.getUint16(body + 2, true), sampleRate: view.getUint32(body + 4, true), bits: view.getUint16(body + 14, true) };
    } else if (id === 'data') {
      if (!format) throw new Error('WAV data before its format');
      return { sampleRate: format.sampleRate, channels: decode(view, body, Math.min(size, buffer.byteLength - body), format) };
    }
    offset = body + size + (size & 1);
  }
  throw new Error('WAV has no audio');
}

function decode(view, start, size, { code, channels, bits }) {
  const step = bits / 8;
  const frames = Math.floor(size / step / channels);
  const out = Array.from({ length: channels }, () => new Float32Array(frames));
  const read = code === 3 && bits === 32 ? (at) => view.getFloat32(at, true)
    : code === 3 && bits === 64 ? (at) => view.getFloat64(at, true)
    : code === 1 && bits === 16 ? (at) => view.getInt16(at, true) / 32768
    : code === 1 && bits === 24 ? (at) => ((view.getInt8(at + 2) << 16) | (view.getUint8(at + 1) << 8) | view.getUint8(at)) / 8388608
    : code === 1 && bits === 32 ? (at) => view.getInt32(at, true) / 2147483648
    : null;
  if (!read) throw new Error(`unsupported WAV format ${code}/${bits}`);
  for (let frame = 0, at = start; frame < frames; frame++) {
    for (let c = 0; c < channels; c++, at += step) out[c][frame] = read(at);
  }
  return out;
}

/** BS.1770's K-weighting at any sample rate: a high shelf, then a high pass. */
function kWeighted(samples, rate) {
  const biquad = (b0, b1, b2, a1, a2, x) => {
    const y = new Float32Array(x.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) {
      const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
    }
    return y;
  };
  let k = Math.tan((Math.PI * 1681.974450955533) / rate);
  const q1 = 0.7071752369554196;
  const vh = 10 ** (3.999843853973347 / 20);
  const vb = vh ** 0.4996667741545416;
  let a0 = 1 + k / q1 + k * k;
  const shelf = biquad((vh + (vb * k) / q1 + k * k) / a0, (2 * (k * k - vh)) / a0, (vh - (vb * k) / q1 + k * k) / a0, (2 * (k * k - 1)) / a0, (1 - k / q1 + k * k) / a0, samples);
  k = Math.tan((Math.PI * 38.13547087602444) / rate);
  const q2 = 0.5003270373238773;
  a0 = 1 + k / q2 + k * k;
  return biquad(1, -2, 1, (2 * (k * k - 1)) / a0, (1 - k / q2 + k * k) / a0, shelf);
}

function lufs({ channels, sampleRate }) {
  const weighted = channels.slice(0, 2).map((c) => kWeighted(c, sampleRate));
  const size = Math.round(0.4 * sampleRate);
  const hop = Math.round(0.1 * sampleRate);
  const frames = channels[0].length;
  const blocks = [];
  for (let start = 0; start + size <= frames; start += hop) {
    let sum = 0;
    for (const channel of weighted) for (let i = start; i < start + size; i++) sum += channel[i] * channel[i];
    blocks.push(sum / size);
  }
  const loudness = (power) => -0.691 + db(power);
  const mean = (list) => list.reduce((a, b) => a + b, 0) / list.length;
  const absolute = blocks.filter((p) => loudness(p) > -70);
  if (!absolute.length) return -Infinity;
  const threshold = loudness(mean(absolute)) - 10;
  const gated = absolute.filter((p) => loudness(p) > threshold);
  return gated.length ? loudness(mean(gated)) : -Infinity;
}

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const angle = (-2 * Math.PI) / size;
    const half = size >> 1;
    for (let i = 0; i < n; i += size) {
      for (let k = 0; k < half; k++) {
        const cos = Math.cos(angle * k), sin = Math.sin(angle * k);
        const a = i + k, b = a + half;
        const tr = re[b] * cos - im[b] * sin, ti = re[b] * sin + im[b] * cos;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
      }
    }
  }
}

const mono = ({ channels }) => {
  if (channels.length === 1) return channels[0];
  const out = new Float32Array(channels[0].length);
  for (const c of channels) for (let i = 0; i < out.length; i++) out[i] += c[i] / channels.length;
  return out;
};

const SIZE = 4096;
const HANN = Float32Array.from({ length: SIZE }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (SIZE - 1)));

/** Power spectra of overlapping frames: an array of Float32Array(SIZE / 2). */
function spectra(signal) {
  const hop = SIZE / 2;
  const frames = [];
  const norm = (SIZE * SIZE) / 4;
  for (let start = 0; start + SIZE <= signal.length; start += hop) {
    const re = new Float64Array(SIZE), im = new Float64Array(SIZE);
    for (let i = 0; i < SIZE; i++) re[i] = signal[start + i] * HANN[i];
    fft(re, im);
    const power = new Float32Array(SIZE / 2);
    for (let i = 0; i < SIZE / 2; i++) power[i] = (re[i] * re[i] + im[i] * im[i]) / norm;
    frames.push(power);
  }
  return frames;
}

const BANDS = [
  ['sub', 20, 60], ['low', 60, 200], ['low_mid', 200, 500], ['mid', 500, 2000],
  ['high_mid', 2000, 6000], ['high', 6000, 12000], ['air', 12000, 20000],
];

const bandPower = (frame, rate, low, high) => {
  const hz = rate / SIZE;
  let sum = 0;
  for (let i = Math.max(1, Math.ceil(low / hz)); i < Math.min(frame.length, Math.floor(high / hz)); i++) sum += frame[i];
  return sum;
};

function bandLevels(frames, rate) {
  const out = {};
  for (const [name, low, high] of BANDS) {
    let sum = 0;
    for (const frame of frames) sum += bandPower(frame, rate, low, high);
    out[name] = round(db(sum / Math.max(1, frames.length)));
  }
  return out;
}

/** The numbers an agent reads for one printed file. */
function measure(audio) {
  const { channels, sampleRate } = audio;
  let peak = 0, energy = 0;
  for (const c of channels) for (const v of c) { const a = Math.abs(v); if (a > peak) peak = a; energy += v * v; }
  const count = channels.length * channels[0].length;
  const rms = db(energy / Math.max(1, count));
  const peakDb = peak > 0 ? 20 * Math.log10(peak) : -Infinity;
  let correlation = null;
  if (channels.length > 1) {
    let lr = 0, ll = 0, rr = 0;
    for (let i = 0; i < channels[0].length; i++) { const l = channels[0][i], r = channels[1][i]; lr += l * r; ll += l * l; rr += r * r; }
    correlation = ll > 0 && rr > 0 ? round(lr / Math.sqrt(ll * rr), 2) : null;
  }
  return {
    seconds: round(channels[0].length / sampleRate, 2),
    lufs: round(lufs(audio)),
    peakDb: round(peakDb),
    rmsDb: round(rms),
    crestDb: round(peakDb - rms),
    correlation,
    bands: bandLevels(spectra(mono(audio)), sampleRate),
  };
}

const isSilent = (m) => m.rmsDb === null || m.rmsDb < -80;

/** How each number moved from `dry` to `wet`. */
function delta(dry, wet) {
  const by = (a, b) => (a === null || b === null ? null : round(b - a));
  const bands = {};
  for (const [name] of BANDS) bands[name] = by(dry.bands[name], wet.bands[name]);
  return { lufs: by(dry.lufs, wet.lufs), peakDb: by(dry.peakDb, wet.peakDb), crestDb: by(dry.crestDb, wet.crestDb), correlation: dry.correlation === null || wet.correlation === null ? null : round(wet.correlation - dry.correlation, 2), bands };
}

/** How far below `a` the difference between the two files sits, in dB. -Infinity means identical. */
function nullDepth(a, b) {
  let diff = 0, ref = 0;
  const count = Math.min(a.channels.length, b.channels.length);
  for (let c = 0; c < count; c++) {
    const x = a.channels[c], y = b.channels[c];
    const n = Math.min(x.length, y.length);
    for (let i = 0; i < n; i++) { const d = x[i] - y[i]; diff += d * d; ref += x[i] * x[i]; }
  }
  if (diff === 0) return -Infinity;
  return ref === 0 ? 0 : db(diff / ref);
}

/** How far apart two prints are once the best overall gain is taken out. Pure make-up gain nulls. */
function matchedNull(dry, wet) {
  const count = Math.min(dry.channels.length, wet.channels.length);
  let cross = 0, wetPower = 0, dryPower = 0;
  for (let c = 0; c < count; c++) {
    const x = dry.channels[c], y = wet.channels[c];
    const n = Math.min(x.length, y.length);
    for (let i = 0; i < n; i++) { cross += x[i] * y[i]; wetPower += y[i] * y[i]; dryPower += x[i] * x[i]; }
  }
  if (!wetPower || !dryPower) return 0;
  const gain = cross / wetPower;
  let diff = 0;
  for (let c = 0; c < count; c++) {
    const x = dry.channels[c], y = wet.channels[c];
    const n = Math.min(x.length, y.length);
    for (let i = 0; i < n; i++) { const d = x[i] - gain * y[i]; diff += d * d; }
  }
  return diff === 0 ? -Infinity : db(diff / dryPower);
}

/**
 * How much a compressor is really working, in dB. Over short windows of the dry signal's active
 * parts, compare the print with the dry. The least-reduced moments are the print's make-up gain,
 * and the most-reduced are that minus the gain reduction, so make-up alone reads as zero.
 */
function gainReduction(dry, wet) {
  const size = Math.round(dry.sampleRate * 0.01);
  const dryMono = mono(dry), wetMono = mono(wet);
  const frames = Math.floor(Math.min(dryMono.length, wetMono.length) / size);
  const windows = [];
  for (let f = 0; f < frames; f++) {
    let a = 0, b = 0;
    for (let i = f * size; i < (f + 1) * size; i++) { a += dryMono[i] * dryMono[i]; b += wetMono[i] * wetMono[i]; }
    if (a > 0 && b > 0) windows.push({ level: a, change: db(b) - db(a) });
  }
  if (!windows.length) return 0;
  const loudest = Math.max(...windows.map((w) => w.level));
  const active = windows.filter((w) => w.level > loudest * 1e-3).map((w) => w.change).sort((x, y) => x - y);
  if (active.length < 2) return 0;
  const at = (share) => active[Math.min(active.length - 1, Math.floor(active.length * share))];
  return Math.max(0, at(0.95) - at(0.05));
}

/** The same audio at another level. */
function withGain(audio, gainDb) {
  const gain = 10 ** (gainDb / 20);
  return { sampleRate: audio.sampleRate, channels: audio.channels.map((c) => c.map((v) => v * gain)) };
}

/** Add stems together, sample for sample. They come from the same range, so they line up. */
function sum(stems) {
  if (!stems.length) return null;
  const length = Math.max(...stems.map((s) => s.channels[0].length));
  const left = new Float32Array(length), right = new Float32Array(length);
  for (const s of stems) {
    const l = s.channels[0], r = s.channels[1] ?? s.channels[0];
    for (let i = 0; i < l.length; i++) { left[i] += l[i]; right[i] += r[i]; }
  }
  return { sampleRate: stems[0].sampleRate, channels: [left, right] };
}

const THIRDS = Array.from({ length: 22 }, (_, i) => 100 * 2 ** (i / 3));

/**
 * Where the rest of the mix sits on top of the target: per third-octave band, the share of the
 * moments the target is active in that band and the rest is louder there, and by how much.
 */
function masking(target, rest) {
  const a = spectra(mono(target)), b = spectra(mono(rest));
  const rate = target.sampleRate;
  const count = Math.min(a.length, b.length);
  const out = [];
  const edges = (center) => [center / 2 ** (1 / 6), center * 2 ** (1 / 6)];
  // A band counts only where the target has something there: within 40 dB of its loudest band.
  let top = 0;
  for (const center of THIRDS) {
    const [low, high] = edges(center);
    for (let f = 0; f < count; f++) top = Math.max(top, bandPower(a[f], rate, low, high));
  }
  for (const center of THIRDS) {
    const [low, high] = edges(center);
    let active = 0, masked = 0, over = 0;
    const levels = [];
    for (let f = 0; f < count; f++) levels.push(bandPower(a[f], rate, low, high));
    const loudest = Math.max(...levels, 0);
    if (loudest <= top * 1e-4) continue;
    for (let f = 0; f < count; f++) {
      if (levels[f] < Math.max(loudest * 0.01, top * 1e-4)) continue;
      active++;
      const r = bandPower(b[f], rate, low, high);
      if (r > levels[f]) { masked++; over += db(r) - db(levels[f]); }
    }
    if (active) out.push({ hz: Math.round(center), maskedPct: Math.round((100 * masked) / active), overDb: masked ? round(over / masked) : 0, score: (masked / active) * (masked ? over / masked : 0) });
  }
  const worst = out.sort((x, y) => y.score - x.score).slice(0, 3).filter((x) => x.maskedPct >= 25);
  return worst.map(({ hz, maskedPct, overDb }) => ({ hz, maskedPct, overDb }));
}

globalThis.SparkAudio = { parseWav, lufs, measure, isSilent, delta, nullDepth, matchedNull, gainReduction, withGain, sum, masking, spectra, mono, db, SIZE, BANDS };
})();
