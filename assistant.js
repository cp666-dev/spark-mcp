// Spark MCP: what the panel needs to run the shared engine and tools itself, with no DOM. A page can't
// touch files, but LUNA prints to a path and serves that path back, so nothing else has to be running.

// Classic scripts share one global scope, so each file keeps its names to itself.
(() => {
const ADD_ON_ID = 'com.cp.spark';
const SETTINGS_KEY = 'com.cp.spark.settings';
const PICKS_KEY = 'com.cp.spark.picks';
const MAX_PICKS = 500;

function readBytes(url) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('GET', url);
    request.responseType = 'arraybuffer';
    request.onload = () => (request.response ? resolve(request.response) : reject(new Error('LUNA served an empty print.')));
    request.onerror = () => reject(new Error('The panel could not read a print back from LUNA.'));
    request.send();
  });
}

/**
 * The panel's way of reading prints. They stay in /tmp, because a page can't delete a file: the
 * system clears them. The taste record lives in this panel's storage, because a page has no files.
 */
function pageIo(luna, storage = globalThis.localStorage) {
  const readPicks = () => {
    try {
      return JSON.parse(storage.getItem(PICKS_KEY) ?? '[]');
    } catch {
      return [];
    }
  };
  return {
    scratch: (name) => `/tmp/spark-mcp-${name}`,
    path: (place, file) => `${place}-${file}`,
    read: async (path) => globalThis.SparkAudio.parseWav(await readBytes(await luna.gui.serveMediaFile(ADD_ON_ID, path))),
    clean: () => {},
    readPicks,
    recordPicks(picks) {
      const known = readPicks();
      const ids = new Set(known.map((p) => p.id));
      const fresh = picks.filter((p) => !ids.has(p.id));
      if (fresh.length) storage.setItem(PICKS_KEY, JSON.stringify([...known, ...fresh].slice(-MAX_PICKS)));
      return fresh.length;
    },
  };
}

function loadSettings(storage = globalThis.localStorage) {
  const fallback = { provider: 'anthropic', models: {}, baseUrls: {} };
  try {
    return { ...fallback, ...JSON.parse(storage.getItem(SETTINGS_KEY) ?? '{}') };
  } catch {
    return fallback;
  }
}

function saveSettings(settings, storage = globalThis.localStorage) {
  storage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

/** The bars a tick range covers, as the ruler reads them: the end is the bar it stops at. */
function barsOf(timeline, startTick, stopTick) {
  const start = timeline.barBeat(startTick).bar;
  const stop = timeline.barBeat(stopTick);
  const onTheBar = timeline.tickAtBar(stop.bar) === stopTick;
  return { startBar: start, endBar: Math.max(start + 1, onTheBar ? stop.bar : stop.bar + 1) };
}

/** What the person is pointing at right now: the track they're on, and their loop or selection. */
function context(session) {
  const timeline = session.musical.timeline;
  const t = session.transport;
  const c = session.context;
  let section = null;
  if (t.looping.value === true && t.loopStop.value > t.loopStart.value) {
    section = { ...barsOf(timeline, t.loopStart.value, t.loopStop.value), from: 'loop' };
  } else if (c.selectionStop.value > c.selectionStart.value) {
    section = { ...barsOf(timeline, c.selectionStart.value, c.selectionStop.value), from: 'selection' };
  }
  return { track: session.focusedTrack.value?.name.value ?? null, section };
}

/** The server a provider's requests go to. */
function serverFor(provider, baseUrl) {
  if (provider === 'anthropic') return 'api.anthropic.com';
  if (provider === 'openai') return 'api.openai.com';
  try {
    return baseUrl ? new URL(baseUrl).hostname : null;
  } catch {
    return null;
  }
}

const isLocal = (host) => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host);

const sectionLabel = (section) => (section ? `Bars ${section.startBar}-${section.endBar}` : '');

/** The person's words, with what they're pointing at, so "more explosive" is enough. */
function requestText(text, where) {
  const parts = [];
  if (where.track) parts.push(`Selected track: ${where.track}.`);
  if (where.section) parts.push(`Section: bars ${where.section.startBar} to ${where.section.endBar}, from their ${where.section.from}.`);
  return parts.length ? `[${parts.join(' ')}]\n${text}` : text;
}

function systemPrompt() {
  return `You are the assistant in Spark MCP, a panel inside the LUNA recording software. You help someone choose plugins by ear.

${globalThis.SparkTools.INSTRUCTIONS}

How to work here:
- Each message says which track is selected and which section they have looped or selected. Use those unless they say otherwise. If there is no section, ask them to loop one, in one short sentence.
- Do the work rather than describing it. For a request like "more explosive", run the tools and open a shootout.
- Choose candidates that genuinely differ from each other. Set workDb from their words: subtle is 2 to 3, a normal request is 4, and words like explosive, slammed or crushed are 8 to 12.
- If they want something different while a shootout is open, such as "heavier" or "try something else", call finish_shootout with cancel and then run a new shootout. If they name a number and say to keep it, keep it.
- If the analysis shows a problem no plugin choice will fix, such as a track far quieter than the rest of the mix, say so plainly in one sentence.
- Reply in one to three short sentences of plain language, for someone looking at a mixer. No lists and no headings. No measurements unless they help them decide.
- When a shootout is ready, say only that it is ready, and anything general to listen for. Never name or describe a candidate while it is blind.`;
}

globalThis.SparkAssistant = { ADD_ON_ID, serverFor, isLocal, pageIo, loadSettings, saveSettings, barsOf, context, sectionLabel, requestText, systemPrompt };
})();
