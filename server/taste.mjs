// Your record of what you picked, across every session. Session storage holds each session's
// picks; this file gathers them, so the agent can read them when another song is open.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

await import('../logic.js');

export const TASTE_FILE = process.env.SPARK_TASTE_FILE ?? join(homedir(), 'Library', 'Application Support', 'Spark MCP', 'taste.jsonl');

export function readPicks(file = TASTE_FILE) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

/** Add picks not yet on file. Each shootout has its own id, so running this twice is harmless. */
export function recordPicks(picks, file = TASTE_FILE) {
  const known = new Set(readPicks(file).map((p) => p.id));
  const fresh = picks.filter((p) => !known.has(p.id));
  if (fresh.length) {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, fresh.map((p) => `${JSON.stringify(p)}\n`).join(''));
  }
  return fresh.length;
}

export const summarize = globalThis.AddOnLogic.summarizePicks;
