// The Node half of the measuring: reading files and drawing the spectrogram. The rest is audio.js.

import { readFileSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';

await import('../audio.js');
const { parseWav: parseBytes, spectra, mono, db, SIZE } = globalThis.SparkAudio;

export const { lufs, measure, isSilent, delta, nullDepth, matchedNull, gainReduction, withGain, sum, masking, BANDS } = globalThis.SparkAudio;

const toArrayBuffer = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
export const parseWav = (bytes) => parseBytes(toArrayBuffer(bytes));
export const readWav = (path) => parseWav(readFileSync(path));

/** A log-frequency spectrogram as a PNG buffer: time left to right, 40 Hz to 16 kHz bottom to top. */
export function spectrogramPng(audio, width = 800, height = 256) {
  const frames = spectra(mono(audio));
  const rate = audio.sampleRate;
  const row = Buffer.alloc(1 + width * 3);
  const rows = [];
  const hzAt = (y) => 40 * (16000 / 40) ** (1 - y / (height - 1));
  const gridFor = new Set([100, 1000, 10000].map((hz) => Math.round((1 - Math.log(hz / 40) / Math.log(16000 / 40)) * (height - 1))));
  for (let y = 0; y < height; y++) {
    const bin = Math.max(1, Math.min(SIZE / 2 - 1, Math.round(hzAt(y) / (rate / SIZE))));
    row[0] = 0;
    for (let x = 0; x < width; x++) {
      const frame = frames[Math.floor((x / width) * frames.length)];
      const level = frame ? db(frame[bin]) : -Infinity;
      let v = Math.max(0, Math.min(1, (level + 96) / 72));
      if (gridFor.has(y)) v = Math.max(v, 0.25);
      row[1 + x * 3] = Math.round(27 + 228 * Math.min(1, v * 1.4));
      row[2 + x * 3] = Math.round(29 + 200 * v * v);
      row[3 + x * 3] = Math.round(31 + 60 * v ** 4);
    }
    rows.push(Buffer.from(row));
  }
  const chunk = (type, data) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(body));
    return Buffer.concat([head, body, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}
