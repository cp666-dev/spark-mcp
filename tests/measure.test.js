// The measurements, against signals with known answers. BS.1770's reference: a stereo 997 Hz sine
// at -23 dBFS reads -23 LUFS.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { delta, gainReduction, isSilent, lufs, masking, matchedNull, measure, nullDepth, parseWav, spectrogramPng, sum, withGain } from '../server/measure.mjs';
import { readPicks, recordPicks, summarize } from '../server/taste.mjs';

const RATE = 48000;
const sine = (hz, db, seconds = 3) => Float32Array.from({ length: RATE * seconds }, (_, i) => 10 ** (db / 20) * Math.sin((2 * Math.PI * hz * i) / RATE));
const stereo = (signal) => ({ sampleRate: RATE, channels: [signal, signal] });

function wav(code, bits, frames, channels = 1, extraChunk = false) {
  const step = bits / 8;
  const data = Buffer.alloc(frames.length * step * channels);
  frames.forEach((v, i) => {
    for (let c = 0; c < channels; c++) {
      const at = (i * channels + c) * step;
      if (code === 3) data.writeFloatLE(v, at);
      else if (bits === 16) data.writeInt16LE(Math.round(v * 32767), at);
      else data.writeIntLE(Math.round(v * 8388607), at, 3);
    }
  });
  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0, 'latin1');
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(code, 8);
  fmt.writeUInt16LE(channels, 10);
  fmt.writeUInt32LE(RATE, 12);
  fmt.writeUInt32LE(RATE * channels * step, 16);
  fmt.writeUInt16LE(channels * step, 20);
  fmt.writeUInt16LE(bits, 22);
  const junk = extraChunk ? Buffer.from('JUNK\x03\0\0\0abc\0', 'latin1') : Buffer.alloc(0);
  const head = Buffer.alloc(8);
  head.write('data', 0, 'latin1');
  head.writeUInt32LE(data.length, 4);
  return Buffer.concat([Buffer.from('RIFF\0\0\0\0WAVE', 'latin1'), junk, fmt, head, data]);
}

describe('reading a WAV', () => {
  it('reads 32-bit float, the way LUNA prints', () => {
    const { channels, sampleRate } = parseWav(wav(3, 32, [0.5, -0.25], 2));
    expect(sampleRate).toBe(RATE);
    expect(channels).toHaveLength(2);
    expect([...channels[1]]).toEqual([0.5, -0.25]);
  });

  it('reads PCM and steps over chunks it has no use for, including an odd-sized one', () => {
    const { channels } = parseWav(wav(1, 24, [0.5], 1, true));
    expect(channels[0][0]).toBeCloseTo(0.5, 3);
    expect(parseWav(wav(1, 16, [-0.5])).channels[0][0]).toBeCloseTo(-0.5, 3);
  });

  it('rejects anything else', () => {
    expect(() => parseWav(Buffer.from('not audio at all'))).toThrow(/not a WAV/);
  });
});

describe('loudness', () => {
  it('reads the BS.1770 reference tone', () => {
    expect(lufs(stereo(sine(997, -23)))).toBeCloseTo(-23, 0);
  });

  it('follows level exactly', () => {
    expect(lufs(stereo(sine(997, -13))) - lufs(stereo(sine(997, -23)))).toBeCloseTo(10, 1);
  });

  it('gates out silence, so a gap does not lower the reading', () => {
    const tone = sine(997, -23, 3);
    const gapped = new Float32Array(RATE * 6);
    gapped.set(tone);
    expect(lufs(stereo(gapped))).toBeCloseTo(lufs(stereo(tone)), 0);
  });

  it('reports nothing for silence', () => {
    expect(lufs(stereo(new Float32Array(RATE * 2)))).toBe(-Infinity);
  });
});

describe('measuring', () => {
  it('gives peak, crest, correlation and the band with the energy', () => {
    const m = measure(stereo(sine(1000, -6)));
    expect(m.peakDb).toBeCloseTo(-6, 0);
    expect(m.crestDb).toBeCloseTo(3, 0);
    expect(m.correlation).toBe(1);
    expect(Object.entries(m.bands).sort((a, b) => (b[1] ?? -999) - (a[1] ?? -999))[0][0]).toBe('mid');
  });

  it('reads out-of-phase channels as negative correlation', () => {
    const s = sine(1000, -6);
    expect(measure({ sampleRate: RATE, channels: [s, s.map((v) => -v)] }).correlation).toBe(-1);
  });

  it('calls silence silent', () => {
    expect(isSilent(measure(stereo(new Float32Array(RATE))))).toBe(true);
    expect(isSilent(measure(stereo(sine(1000, -40))))).toBe(false);
  });

  it('reports how a print moved', () => {
    const d = delta(measure(stereo(sine(1000, -12))), measure(stereo(sine(1000, -6))));
    expect(d.lufs).toBeCloseTo(6, 0);
    expect(d.bands.mid).toBeCloseTo(6, 0);
  });
});

describe('comparing prints', () => {
  it('calls identical files identical', () => {
    const a = stereo(sine(1000, -12));
    expect(nullDepth(a, a)).toBe(-Infinity);
  });

  it('measures a difference', () => {
    expect(nullDepth(stereo(sine(1000, -12)), stereo(sine(1000, -32)))).toBeCloseTo(-0.9, 1);
  });

  it('applies a fader level', () => {
    expect(measure(withGain(stereo(sine(1000, -12)), -6)).peakDb).toBeCloseTo(-18, 0);
  });

  it('sums stems and widens a mono one', () => {
    const summed = sum([{ sampleRate: RATE, channels: [Float32Array.of(0.25, 0.25)] }, stereo(Float32Array.of(0.25, 0.5))]);
    expect([...summed.channels[1]]).toEqual([0.5, 0.75]);
    expect(sum([])).toBeNull();
  });
});

describe('telling compression from make-up gain', () => {
  const dry = stereo(sine(1000, -12, 2));
  const gained = (db) => stereo(dry.channels[0].map((v) => v * 10 ** (db / 20)));
  // Louder half squeezed by 6 dB, the rest up by make-up gain.
  const bursts = Float32Array.from({ length: RATE * 2 }, (_, i) => Math.sin((2 * Math.PI * 1000 * i) / RATE) * (Math.floor(i / 4800) % 2 ? 0.5 : 0.1));
  const squeezed = bursts.map((v, i) => v * (Math.floor(i / 4800) % 2 ? 10 ** (-6 / 20) : 1) * 10 ** (4 / 20));

  it('reads make-up gain alone as no work at all', () => {
    expect(gainReduction(dry, gained(5))).toBeCloseTo(0, 1);
    expect(gainReduction(stereo(bursts), stereo(bursts.map((v) => v * 1.5)))).toBeCloseTo(0, 1);
  });

  it('reads real gain reduction, whatever the make-up gain', () => {
    expect(gainReduction(stereo(bursts), stereo(squeezed))).toBeCloseTo(6, 0);
  });

  it('nulls make-up gain, and does not null compression', () => {
    expect(matchedNull(dry, gained(4))).toBeLessThan(-100);
    expect(matchedNull(stereo(bursts), stereo(squeezed))).toBeGreaterThan(-45);
  });
});

describe('masking', () => {
  it('finds the band where the rest of the mix sits on top', () => {
    const found = masking(stereo(sine(1000, -30)), stereo(sine(1000, -10)));
    expect(found.length).toBeGreaterThan(0);
    expect(found[0].hz).toBeGreaterThan(700);
    expect(found[0].hz).toBeLessThan(1400);
    expect(found[0].overDb).toBeCloseTo(20, 0);
  });

  it('finds nothing where they do not meet', () => {
    expect(masking(stereo(sine(4000, -10)), stereo(sine(200, -10)))).toEqual([]);
  });
});

describe('the spectrogram', () => {
  it('is a real PNG of the size asked for', () => {
    const png = spectrogramPng(stereo(sine(1000, -12, 1)), 40, 20);
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect(png.readUInt32BE(16)).toBe(40);
    expect(png.readUInt32BE(20)).toBe(20);
  });
});

describe('taste', () => {
  const pick = (id, role, kept, passed, blind = true) => ({ id, role, blind, kept: { pluginId: kept, name: kept }, passed: passed.map((p) => ({ pluginId: p, name: p })) });

  it('adds a pick once, however many times it is seen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spark-taste-test-'));
    const file = join(dir, 'nested', 'taste.jsonl');
    expect(readPicks(file)).toEqual([]);
    expect(recordPicks([pick('a', 'vocal', 'x', ['y'])], file)).toBe(1);
    expect(recordPicks([pick('a', 'vocal', 'x', ['y']), pick('b', 'vocal', 'y', ['x'])], file)).toBe(1);
    expect(readPicks(file).map((p) => p.id)).toEqual(['a', 'b']);
    rmSync(dir, { recursive: true, force: true });
  });

  it('counts offers and picks per role, blind ones apart', () => {
    const { shootouts, plugins } = summarize([pick('a', 'lead vocal', 'x', ['y']), pick('b', 'lead vocal', 'x', ['y'], false), pick('c', 'kick', 'y', [])], 'vocal');
    expect(shootouts).toBe(2);
    expect(plugins.find((p) => p.pluginId === 'x')).toMatchObject({ offered: 2, picked: 2, pickedBlind: 1 });
    expect(plugins.find((p) => p.pluginId === 'y')).toMatchObject({ offered: 2, picked: 0 });
  });
});
