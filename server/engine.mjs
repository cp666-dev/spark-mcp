// The server's way of reading prints: files in the system's temp folder, deleted afterward. The
// shootout itself is in engine.js, which the panel runs too.

import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Luna } from './luna.mjs';
import { readWav, spectrogramPng } from './measure.mjs';
import { readPicks, recordPicks } from './taste.mjs';

globalThis.Luna = Luna;
await import('../logic.js');
await import('../engine.js');

const io = {
  scratch(name) {
    const dir = join(tmpdir(), 'spark-mcp', name);
    mkdirSync(dir, { recursive: true });
    return dir;
  },
  path: (dir, file) => join(dir, file),
  read: async (path) => readWav(path),
  clean: (dir) => rmSync(dir, { recursive: true, force: true }),
  readPicks,
  recordPicks,
  spectrogram: (audio) => spectrogramPng(audio).toString('base64'),
};

export class SparkEngine extends globalThis.SparkEngine {
  constructor(luna) {
    super(luna, io);
  }

  static async connect(options) {
    return new SparkEngine(await Luna.connect(options));
  }
}

await import('../tools.js');

export const connectEngine = async (options) => new globalThis.SparkEngine(await Luna.connect(options), io);
