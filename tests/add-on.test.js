// Runs against Luna.MockEngine: no LUNA needed. `npm test`. tests/live-shootout.mjs covers the
// engine behaviour a mock can't: printing, undo position and plugin state.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { Luna } from '../server/luna.mjs';

globalThis.Luna = Luna; // logic.js is a classic script that reads the Luna global
await import('../logic.js');
const logic = globalThis.AddOnLogic;

async function connected() {
  const engine = new Luna.MockEngine();
  engine.addSession('abc', { name: 'Demo', tracks: ['Vocal', 'Bass'] });
  await engine.settled();
  const luna = await Luna.connect({ port_: engine.port() });
  const session = await luna.session();
  await logic.loadState(session);
  return { engine, luna, session };
}

const change = { lufs: 1, peakDb: 0, crestDb: -1.4, correlation: 0, bands: { sub: 0, low: -0.2, low_mid: -2.1, mid: 0.1, high_mid: 1.2, high: 0.4, air: 0 } };
const record = (extra = {}) => ({
  id: 'one',
  status: 'ready',
  trackUid: 't',
  trackName: 'Vocal',
  role: 'lead vocal',
  problem: 'lost in the chorus',
  section: { startTick: 0, stopTick: 1, label: 'Bars 17-25' },
  listening: '0',
  blind: true,
  blindAll: true,
  candidates: [
    { key: '1', pluginId: 'a', name: 'LA-2A', presetName: 'Lead Vox', why: 'Smooth', change, verdict: 'changed', trimDb: 1 },
    { key: '2', pluginId: 'b', name: '1176', presetName: null, why: 'Forward', change, verdict: 'quiet', trimDb: 0 },
  ],
  ...extra,
});

describe('the page', () => {
  it('loads scripts that all parse', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
    expect(scripts).toContain('main.js');
    for (const src of scripts) expect(() => new Script(readFileSync(new URL(`../${src}`, import.meta.url), 'utf8'), { filename: src })).not.toThrow();
  });
});

describe('the server', () => {
  it('has files that all parse', () => {
    for (const file of ['server/index.mjs', 'server/engine.mjs', 'server/measure.mjs', 'server/taste.mjs', 'engine.js', 'audio.js', 'tools.js']) {
      expect(() => execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })).not.toThrow();
    }
  });
});

describe('the shared record', () => {
  it('starts empty and reaches a second client', async () => {
    const { engine, luna, session } = await connected();
    expect(logic.current(session)).toBeNull();
    const other = await (await Luna.connect({ port_: engine.port() })).session();
    await logic.loadState(other);
    await logic.saveCurrent(session, record());
    await engine.settled();
    await luna.settled();
    await logic.prefs(other).load();
    expect(logic.current(other).id).toBe('one');
  });

  it('refuses to listen, keep or cancel with nothing open', async () => {
    const { luna, session } = await connected();
    await expect(logic.listen(luna, session, '1')).rejects.toThrow(/No shootout/);
    await expect(logic.keep(luna, session, '1')).rejects.toThrow(/No shootout/);
    await expect(logic.cancel(luna, session)).rejects.toThrow(/No shootout/);
  });

  it('calls a print stalled only once its server has gone quiet', () => {
    const now = 1000000;
    expect(logic.isStalled(record({ status: 'printing', heartbeatAt: now - 1000 }), now)).toBe(false);
    expect(logic.isStalled(record({ status: 'printing', heartbeatAt: now - logic.STALE_PRINT_MS - 1 }), now)).toBe(true);
    expect(logic.isStalled(record({ heartbeatAt: 0 }), now)).toBe(false);
    expect(logic.view(record({ status: 'printing', heartbeatAt: 0 }), true, now).phase).toBe('stalled');
  });

  it('will not switch to a candidate that has gone from the track', async () => {
    const { luna, session } = await connected();
    const track = session.visibleTracks[0];
    await logic.saveCurrent(session, record({ trackUid: track.id, originalTrimDb: 0, candidates: [{ key: '1', pluginId: 'a', name: 'LA-2A', slotId: 'effect_0', trimDb: 0 }] }));
    await expect(logic.listen(luna, session, '1')).rejects.toThrow(/no longer on the track/);
  });

  it('rounds long decimals so LUNA stores what was written, and leaves ticks alone', () => {
    const stored = logic.storable({ a: 1 / 7, tick: 6144000000000, nested: [{ value: 0.6662487983703613 }], text: '0.123456789', none: null });
    expect(stored).toEqual({ a: 0.142857, tick: 6144000000000, nested: [{ value: 0.666249 }], text: '0.123456789', none: null });
  });

  it('treats printing and ready as open, and finished as closed', () => {
    expect(logic.isOpen(record())).toBe(true);
    expect(logic.isOpen(record({ status: 'printing' }))).toBe(true);
    expect(logic.isOpen(record({ status: 'kept' }))).toBe(false);
    expect(logic.isOpen(null)).toBe(false);
  });
});

describe('what the panel shows', () => {
  it('hides everything that names a plugin while blind', () => {
    const view = logic.view(record());
    expect(view.candidates.map((c) => c.title)).toEqual(['Candidate 1', 'Candidate 2']);
    expect(JSON.stringify(view.candidates)).not.toMatch(/LA-2A|1176|Lead Vox|Smooth/);
    expect(view.candidates[1].check).toBe(false);
  });

  it('reveals names, reasons and what changed when not blind', () => {
    const view = logic.view(record({ blind: false }));
    expect(view.candidates[0]).toMatchObject({ title: 'LA-2A', preset: 'Lead Vox', why: 'Smooth' });
    expect(view.candidates[1]).toMatchObject({ preset: 'Default settings', check: true });
    expect(view.candidates[0].change).toContain('low mids -2.1 dB');
  });

  it('only offers Keep once a candidate is being heard', () => {
    expect(logic.view(record()).canKeep).toBe(false);
    const view = logic.view(record({ listening: '2' }));
    expect(view.canKeep).toBe(true);
    expect(view.candidates.map((c) => c.on)).toEqual([false, true]);
  });

  it('names the pick afterwards, and says whether it was blind', () => {
    const view = logic.view(record({ status: 'kept', keptKey: '1' }));
    expect(view.word).toBe('KEPT');
    expect(view.done).toEqual({ title: 'LA-2A', sub: 'Lead Vox', blind: true });
  });

  it('covers offline, idle, printing and a stopped shootout', () => {
    expect(logic.view(null, false).state).toBe('offline');
    expect(logic.view(null).phase).toBe('idle');
    expect(logic.view(record({ status: 'printing', heartbeatAt: Date.now(), progress: 'Printing candidate 2 of 3' })).detail).toBe('Printing candidate 2 of 3');
    expect(logic.view(record({ status: 'error', error: 'No audio' })).notice).toBe('No audio');
  });
});

describe('the tools', () => {
  it('all have a schema, a line to show a person, and something to run', async () => {
    await import('../audio.js').catch(() => {});
    await import('../tools.js');
    const { TOOLS } = globalThis.SparkTools;
    expect(TOOLS.map((tool) => tool.name)).toEqual(['session_brief', 'find_plugins', 'analyze', 'shootout', 'shootout_status', 'finish_shootout', 'taste']);
    for (const tool of TOOLS) {
      expect(tool.schema.type).toBe('object');
      expect(typeof tool.describe({ track: 'Drums', candidates: [] })).toBe('string');
      expect(typeof tool.run).toBe('function');
    }
  });
});

describe('what a tool answers', () => {
  it('keeps lists as lists', async () => {
    await import('../tools.js');
    expect(globalThis.SparkTools.present([{ a: 1 }]).result).toEqual([{ a: 1 }]);
  });

  it('takes a spectrogram apart from the numbers', async () => {
    await import('../tools.js');
    expect(globalThis.SparkTools.present({ lufs: -20, spectrogram: 'png' })).toEqual({ result: { lufs: -20 }, spectrogram: 'png' });
    expect(globalThis.SparkTools.present({ lufs: -20 })).toEqual({ result: { lufs: -20 }, spectrogram: null });
  });
});

describe('switching without a click', () => {
  it('fades down to silence and back up in matching steps', () => {
    expect(logic.dbAt(-3, 1)).toBe(-3);
    expect(logic.dbAt(-3, 0.5)).toBeCloseTo(-9.02, 1);
    expect(logic.dbAt(-3, 0)).toBe(logic.SILENT_DB);
    expect(logic.FADE_GAINS.at(-1)).toBe(0);
    expect([...logic.FADE_GAINS].sort((a, b) => b - a)).toEqual(logic.FADE_GAINS);
  });

  it('switches at once, with no fade, when nothing is playing', async () => {
    const calls = [];
    const fake = { raw: { set: async (path, value) => calls.push(value) } };
    const session = { transport: { playing: { value: false } } };
    const track = { main: { controls: { byId: () => ({ path: '/trim' }) } } };
    await logic.fadeSwitch(fake, session, track, 2, async () => calls.push('swap'));
    expect(calls.map((c) => (typeof c === 'string' ? c : Number(c.value ?? c)))).toEqual(['swap', 2]);
  });
});

describe('words', () => {
  it('leads with the biggest tonal moves and the dynamics', () => {
    expect(logic.changeLine(change)).toBe('low mids -2.1 dB · high mids +1.2 dB · tighter 1.4 dB');
  });

  it('leads with the compression when a compressor is working', () => {
    expect(logic.changeLine({ crestDb: 0, bands: {} }, 5.84)).toBe('compressing 5.8 dB');
  });

  it('says so when next to nothing moved', () => {
    expect(logic.changeLine({ crestDb: 0.1, bands: { low: 0.2 } })).toBe('Very little change in level or tone');
  });

  it('signs decibels', () => {
    expect(logic.formatDb(1.25)).toBe('+1.3 dB');
    expect(logic.formatDb(-2)).toBe('-2.0 dB');
    expect(logic.formatDb(null)).toBe('-');
  });
});

describe('the taste record', () => {
  it('logs what was kept against what was passed over', () => {
    const event = logic.historyEvent(record({ status: 'kept', keptKey: '2', finishedAt: 5 }));
    expect(event).toMatchObject({ id: 'one', at: 5, role: 'lead vocal', blind: true, kept: { pluginId: 'b' } });
    expect(event.passed.map((p) => p.pluginId)).toEqual(['a']);
  });

  it('logs nothing for a shootout called off', () => {
    expect(logic.historyEvent(record({ status: 'cancelled' }))).toBeNull();
  });

  it('stops counting a pick as blind once the names were shown', async () => {
    const { session } = await connected();
    await logic.saveCurrent(session, record());
    await logic.setBlind(session, false);
    await logic.setBlind(session, true);
    expect(logic.current(session)).toMatchObject({ blind: true, blindAll: false });
  });
});

describe('shuffling', () => {
  it('keeps every candidate', () => {
    expect(logic.shuffled(['a', 'b', 'c']).sort()).toEqual(['a', 'b', 'c']);
  });

  it('moves them, given a random source', () => {
    expect(logic.shuffled(['a', 'b', 'c'], () => 0)).toEqual(['b', 'c', 'a']);
  });
});
