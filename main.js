// Spark MCP: connects the panel to LUNA. A shootout lives in session storage, whether this panel's
// own assistant set it up or an outside agent did through the MCP server. This page follows it and does
// the listening and the deciding.

let luna = null;
let session = null;
let releases = [];
let busy = false;
let problem = null;
let engine = null;
let agent = null;
let io = null;

const { PROVIDERS, checkBaseUrl } = Providers;
const settings = SparkAssistant.loadSettings();
const apiKeys = {};
const assistant = { working: false, status: '', reply: '' };
let settingsOpen = false;
let addOn = null;

const panel = SparkPanel.createPanel(document.getElementById('app'), {
  onListen: (key) => listen(key),
  onLoop: () => act(() => toggleLoop()),
  onBlind: () => act(() => AddOnLogic.setBlind(session, !AddOnLogic.current(session)?.blind)),
  onKeep: () => {
    const record = AddOnLogic.current(session);
    if (record?.listening && record.listening !== AddOnLogic.ORIGINAL) act(() => AddOnLogic.keep(luna, session, record.listening));
  },
  onCancel: () => act(() => AddOnLogic.cancel(luna, session)),
  onPrompt: (text) => prompt(text),
  onSettings: (open = !settingsOpen) => { settingsOpen = open; paint(); },
  onProvider: (id) => { settings.provider = id; SparkAssistant.saveSettings(settings); paint(); },
  onSaveSettings: (values) => saveModelSettings(values),
});

const modelFor = (id) => settings.models[id] ?? PROVIDERS[id].defaultModel;

/** Why a request can't be sent yet, or null. */
function modelProblem() {
  const id = settings.provider;
  const p = PROVIDERS[id];
  if (!modelFor(id)) return 'Choose a model first.';
  if (p.needsKey && !apiKeys[id]) return `Add your ${p.label} API key first.`;
  if (p.needsBaseUrl && !settings.baseUrls[id]) return 'Set the model server URL first.';
  return checkBaseUrl(settings.baseUrls[id]) ?? networkProblem(id);
}

/**
 * LUNA only lets the page reach the servers its manifest lists, once the user allows them, plus
 * this computer. Say so before a request fails with nothing more than "Load failed".
 */
function networkProblem(id) {
  const host = SparkAssistant.serverFor(id, settings.baseUrls[id]);
  if (!host || SparkAssistant.isLocal(host)) return null;
  const asked = addOn?.network.value;
  const allowed = addOn?.networkAllowed.value;
  if (asked === undefined || allowed === undefined) return null;
  if (!asked.includes(host)) return `Spark MCP can only reach Anthropic, OpenAI or a model server on this computer, not ${host}.`;
  if (!allowed.includes(host)) return `LUNA hasn't allowed Spark MCP to reach ${host}. Allow it in LUNA's Settings > Add Ons > Servers.`;
  return null;
}

async function loadKeys() {
  for (const [id, p] of Object.entries(PROVIDERS)) {
    apiKeys[id] = (await luna.secrets.get(p.secret).catch(() => null)) ?? '';
  }
}

async function saveModelSettings({ key, model, baseUrl }) {
  const id = settings.provider;
  settings.models[id] = model;
  settings.baseUrls[id] = baseUrl;
  SparkAssistant.saveSettings(settings);
  // An empty box keeps the saved key: the box never shows it.
  if (key) {
    await luna.secrets.set(PROVIDERS[id].secret, key);
    apiKeys[id] = key;
  }
  settingsOpen = false;
  problem = null;
  paint();
}

function settingsView() {
  if (!settingsOpen) return null;
  const id = settings.provider;
  const p = PROVIDERS[id];
  const shorts = { anthropic: 'CLAUDE', openai: 'OPENAI', compatible: 'OTHER' };
  return {
    providers: Object.entries(PROVIDERS).map(([pid, v]) => ({ id: pid, label: v.label, short: shorts[pid] ?? v.label })),
    provider: id,
    key: '',
    keyPlaceholder: apiKeys[id] ? 'Saved in your keychain' : p.needsKey ? 'Paste your API key' : 'Optional',
    model: modelFor(id),
    baseUrl: settings.baseUrls[id] ?? '',
    needsBaseUrl: p.needsBaseUrl === true,
    note: id === 'compatible'
      ? 'A model server on this computer, such as Ollama or LM Studio. Your requests and the measurements go there, never your audio.'
      : 'Your key stays in your keychain and only goes to the provider you choose. Your requests and the measurements go there too, never your audio.',
  };
}

function makeAgent() {
  const tools = SparkTools.TOOLS.map((t) => ({ name: t.name, description: t.description, schema: t.schema, mode: 'read', describe: t.describe, run: t.run }));
  return new AgentCore.Agent({
    provider() {
      const id = settings.provider;
      return { stream: PROVIDERS[id].stream, apiKey: apiKeys[id], baseUrl: settings.baseUrls[id], model: modelFor(id) };
    },
    system: () => SparkAssistant.systemPrompt(),
    tools,
    approve: async (calls) => calls.map(() => true),
    async execute(calls) {
      const out = [];
      for (const { tool, input } of calls) {
        try {
          out.push({ content: SparkTools.present(await tool.run(engine, input)).result, isError: false });
        } catch (error) {
          out.push({ content: error.message, isError: true });
        }
      }
      return out;
    },
  });
}

/** Send the person's words to the model. False keeps their text in the box. */
function prompt(text) {
  if (assistant.working || !session) return false;
  const blocked = modelProblem();
  if (blocked) {
    problem = blocked;
    settingsOpen = true;
    paint();
    return false;
  }
  run(text);
  return true;
}

async function run(text) {
  Object.assign(assistant, { working: true, status: 'Thinking', reply: '' });
  problem = null;
  paint();
  try {
    const result = await agent.send(SparkAssistant.requestText(text, SparkAssistant.context(session)), {
      onTurnStart: () => { assistant.status = 'Thinking'; paint(); },
      onText: (delta) => { assistant.reply += delta; paint(); },
      onCalls: (entries) => {
        assistant.reply = '';
        assistant.status = entries.at(-1)?.summary ?? 'Working';
        paint();
      },
    });
    if (result.outcome === 'refused') problem = 'The model declined that request.';
    else if (result.outcome === 'cut-off') problem = 'The reply was cut off. Try asking again.';
    else if (result.outcome === 'turn-limit') problem = 'That took too many steps, so it stopped.';
  } catch (error) {
    problem = error.message;
  } finally {
    Object.assign(assistant, { working: false, status: '' });
    paint();
  }
}

// Only the newest press matters: someone flicking between candidates must never lose one.
let wanted = null;
let switching = false;
async function listen(key) {
  wanted = key;
  if (switching || !session) return;
  switching = true;
  while (wanted !== null) {
    const next = wanted;
    wanted = null;
    try {
      problem = null;
      await AddOnLogic.listen(luna, session, next);
    } catch (error) {
      problem = error.message;
    }
    paint();
  }
  switching = false;
}

async function toggleLoop() {
  const t = session.transport;
  if (t.playing.value && t.looping.value) return t.stop();
  return AddOnLogic.loop(session);
}

async function act(move) {
  if (busy || !session) return;
  busy = true;
  problem = null;
  try {
    await move();
  } catch (error) {
    problem = error.message;
  } finally {
    busy = false;
    paint();
  }
}

function paint() {
  const connected = luna?.status.value === 'connected' && !!session;
  const record = connected ? AddOnLogic.current(session) : null;
  const view = AddOnLogic.view(record, connected);
  if (connected && view.phase === 'idle' && !AddOnLogic.isOpen(record)) {
    // Between shootouts, these show what a request would apply to.
    const where = SparkAssistant.context(session);
    view.track = where.track ?? '';
    view.section = SparkAssistant.sectionLabel(where.section);
  }
  if (assistant.working && view.phase !== 'printing') {
    view.state = 'thinking';
    view.word = 'WORKING';
    view.detail = assistant.status;
  }
  if (problem) view.notice = problem;
  if (problem && view.phase !== 'idle') view.detail = problem;
  const events = connected ? AddOnLogic.prefs(session).value('history', 'events').value ?? [] : [];
  const t = session?.transport;
  panel.render(view, [...events].reverse().slice(0, 5), {
    looping: t?.playing.value === true && t?.looping.value === true,
    reply: assistant.reply,
    working: assistant.working,
    needsKey: connected && modelProblem() !== null,
    settings: settingsView(),
  });
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && settingsOpen) {
    event.preventDefault();
    settingsOpen = false;
    paint();
    return;
  }
  if (event.key === 'Escape' && assistant.working) {
    event.preventDefault();
    agent?.stop();
    return;
  }
  // Typing is typing: numbers in a prompt must not switch candidates.
  if (event.target?.tagName === 'INPUT') {
    if (event.key === 'Escape') event.target.blur();
    return;
  }
  const record = session ? AddOnLogic.current(session) : null;
  if (event.key === 'Escape' && AddOnLogic.isStalled(record)) {
    event.preventDefault();
    act(() => AddOnLogic.cancel(luna, session));
    return;
  }
  if (record?.status !== 'ready' || event.metaKey || event.ctrlKey || event.altKey) return;
  const has = (key) => key === AddOnLogic.ORIGINAL || record.candidates.some((c) => c.key === key);
  if (has(event.key)) listen(event.key);
  else if (event.key === 'Enter') document.querySelector('.spk-keep').click();
  else if (event.key === 'Escape') act(() => AddOnLogic.cancel(luna, session));
  else if (event.key === 'b' || event.key === 'B') act(() => AddOnLogic.setBlind(session, !record.blind));
  else if (event.key === 'l' || event.key === 'L') act(() => toggleLoop());
  else return;
  event.preventDefault();
});

async function bindSession() {
  for (const release of releases) release();
  releases = [];
  session = luna.sessions.current();
  if (session) {
    await session.ready();
    await AddOnLogic.loadState(session);
    const prefs = AddOnLogic.prefs(session);
    const t = session.transport;
    const c = session.context;
    for (const prop of [prefs.value('shootout', 'current'), prefs.value('history', 'events'), t.playing, t.looping, t.loopStart, t.loopStop, c.selectionStart, c.selectionStop, session.focusedTrack]) releases.push(prop.onChange(paint));
    const events = prefs.value('history', 'events');
    releases.push(events.onChange(() => io.recordPicks(events.value ?? [])));
    io.recordPicks(events.value ?? []);
  }
  paint();
}

async function connect() {
  paint();
  for (;;) {
    try {
      luna = await Luna.connect();
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
  // Which servers LUNA lets this page reach. Outside LUNA there is no policy to read.
  const me = await luna.gui.thisInstance().catch(() => undefined);
  if (me) {
    await luna.gui.addOns.watch().ready;
    addOn = luna.gui.addOns.byId(me.addOnId) ?? null;
    addOn?.networkAllowed.onChange(paint);
  }
  io = SparkAssistant.pageIo(luna);
  engine = new SparkEngine(luna, io);
  agent = makeAgent();
  await loadKeys();
  Luna.bindShortcuts(luna);
  await luna.sessions.ready();
  luna.sessions.focused.onChange(bindSession);
  luna.sessions.items.onChange(bindSession);
  luna.status.onChange(paint);
  await bindSession();
}

// A stalled print has nothing to announce it, so look now and then.
setInterval(() => {
  if (session && AddOnLogic.current(session)?.status === 'printing') paint();
}, 5000);

connect();
