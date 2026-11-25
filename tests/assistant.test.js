// The panel's assistant: what it reads from the session and how it keeps things. No network.
import { describe, expect, it } from 'vitest';
import { Luna } from '../server/luna.mjs';

globalThis.Luna = Luna;
await import('../logic.js');
await import('../audio.js');
await import('../engine.js');
await import('../tools.js');
await import('../assistant.js');
const { pageIo, loadSettings, saveSettings, barsOf, requestText, sectionLabel, systemPrompt, context } = globalThis.SparkAssistant;

const memory = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }; };
const timeline = { barBeat: (tick) => ({ bar: Math.floor(tick / 4) + 1 }), tickAtBar: (bar) => (bar - 1) * 4 };

describe('what the person is pointing at', () => {
  it('reads a range as the ruler does', () => {
    expect(barsOf(timeline, 64, 80)).toEqual({ startBar: 17, endBar: 21 });
  });

  it('counts a part-bar ending as reaching the next bar', () => {
    expect(barsOf(timeline, 64, 79)).toEqual({ startBar: 17, endBar: 21 });
    expect(barsOf(timeline, 64, 81)).toEqual({ startBar: 17, endBar: 22 });
  });

  it('is never less than a bar', () => {
    expect(barsOf(timeline, 64, 65)).toEqual({ startBar: 17, endBar: 18 });
  });

  it('reads a real session without a section', async () => {
    const engine = new Luna.MockEngine();
    engine.addSession('abc', { name: 'Demo', tracks: ['Drums'] });
    await engine.settled();
    const luna = await Luna.connect({ port_: engine.port() });
    const session = await luna.session();
    expect(context(session).section).toBeNull();
  });

  it('labels a section, or nothing', () => {
    expect(sectionLabel({ startBar: 17, endBar: 21 })).toBe('Bars 17-21');
    expect(sectionLabel(null)).toBe('');
  });
});

describe('which server a provider uses', () => {
  it('names the hosted APIs, and reads a local server from its URL', () => {
    const { serverFor, isLocal } = globalThis.SparkAssistant;
    expect(serverFor('anthropic')).toBe('api.anthropic.com');
    expect(serverFor('openai')).toBe('api.openai.com');
    expect(serverFor('compatible', 'http://localhost:11434/v1')).toBe('localhost');
    expect(serverFor('compatible', 'not a url')).toBeNull();
    expect(isLocal('127.0.0.1')).toBe(true);
    expect(isLocal('api.openai.com')).toBe(false);
  });
});

describe('what goes to the model', () => {
  it('adds the track and section to their words', () => {
    expect(requestText('more explosive', { track: 'Drums', section: { startBar: 17, endBar: 21, from: 'loop' } })).toBe('[Selected track: Drums. Section: bars 17 to 21, from their loop.]\nmore explosive');
  });

  it('sends their words alone when nothing is selected', () => {
    expect(requestText('hello', { track: null, section: null })).toBe('hello');
  });

  it('tells the model to protect the blind test', () => {
    expect(systemPrompt()).toMatch(/Never name or describe a candidate while it is blind/);
    expect(systemPrompt()).toContain(globalThis.SparkTools.INSTRUCTIONS);
  });
});

describe('what the panel keeps', () => {
  it('names prints flat in /tmp, since a page cannot make folders', () => {
    const io = pageIo({}, memory());
    expect(io.path(io.scratch('abc'), 'dry-0.wav')).toBe('/tmp/spark-mcp-abc-dry-0.wav');
  });

  it('records a pick once', () => {
    const io = pageIo({}, memory());
    expect(io.recordPicks([{ id: 'a' }])).toBe(1);
    expect(io.recordPicks([{ id: 'a' }, { id: 'b' }])).toBe(1);
    expect(io.readPicks().map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('survives damaged storage', () => {
    const storage = memory();
    storage.setItem('com.cp.spark.picks', 'not json');
    storage.setItem('com.cp.spark.settings', 'not json');
    expect(pageIo({}, storage).readPicks()).toEqual([]);
    expect(loadSettings(storage).provider).toBe('anthropic');
  });

  it('keeps model settings', () => {
    const storage = memory();
    saveSettings({ provider: 'openai', models: { openai: 'gpt-5' }, baseUrls: {} }, storage);
    expect(loadSettings(storage).models.openai).toBe('gpt-5');
  });

  it('never stores a key in settings', () => {
    const storage = memory();
    saveSettings(loadSettings(storage), storage);
    expect(storage.getItem('com.cp.spark.settings')).not.toMatch(/key/i);
  });
});
