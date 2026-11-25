// Spark MCP: the shootout's state and moves, with no DOM. The panel and the MCP server both run
// this file, so either can switch candidates, keep one or call it off. They share one record in
// session storage, which needs no extra port and adds nothing to LUNA's undo list.

const AddOnLogic = {
  CONTEXT: 'com.cp.spark',
  MAX_CANDIDATES: 3,
  ORIGINAL: '0',
  // Under this, the difference between a print and the dry track is too small to hear.
  QUIET_NULL_DB: -60,
  LOAD_SETTLE_MS: 300,
  // Switching a plugin, or jumping the level, mid-playback clicks: measured on a steady tone at up
  // to 33 dB over the tone. Fading out over these gains, switching, and fading back in measured clean.
  FADE_GAINS: [0.7, 0.5, 0.3, 0.15, 0.06, 0.02, 0],
  FADE_STEP_MS: 4,
  // How long a switched plugin takes to settle before it is heard again.
  SWITCH_SETTLE_MS: 60,
  SILENT_DB: -144,
  // A print that says nothing for this long has lost its server.
  STALE_PRINT_MS: 120000,

  prefs(session) {
    return session.storage.context(AddOnLogic.CONTEXT);
  },

  async loadState(session) {
    const prefs = AddOnLogic.prefs(session);
    await prefs.load();
    await prefs.add('shootout', 'current', null);
    await prefs.add('history', 'events', []);
    return prefs;
  },

  current(session) {
    return AddOnLogic.prefs(session).value('shootout', 'current').value ?? null;
  },

  /**
   * Six decimal places at most. LUNA rounds a long decimal differently when it stores it, so the
   * SDK's check that the write appeared never matches, and the write looks like it failed.
   */
  storable(record) {
    return JSON.parse(JSON.stringify(record, (key, value) => (typeof value === 'number' && !Number.isInteger(value) ? Number(value.toFixed(6)) : value)));
  },

  async saveCurrent(session, record) {
    const stored = AddOnLogic.storable(record);
    await AddOnLogic.prefs(session).set('shootout', 'current', stored);
    return stored;
  },

  /** Printing, but the server that was doing it has gone quiet. */
  isStalled(record, now = Date.now()) {
    return record?.status === 'printing' && now - (record.heartbeatAt ?? record.startedAt ?? 0) > AddOnLogic.STALE_PRINT_MS;
  },

  isOpen(record) {
    return record?.status === 'printing' || record?.status === 'ready';
  },

  async undoUid(luna, session) {
    const node = await luna.raw.get(session.path, { children: false, commands: false, flatvalue: true, propfilter: ['undo_uid'] });
    return node?.properties?.undo_uid ?? null;
  },

  /**
   * Step undo back to `uid`. False if it never got there: the undo position only moves through
   * this client's undo, so a position that stops moving means the history is not what we expect.
   */
  async undoTo(luna, session, uid, limit = 200) {
    for (let step = 0; step < limit; step++) {
      const here = await AddOnLogic.undoUid(luna, session);
      if (here === uid) return true;
      await session.undo();
      await AddOnLogic.wait(60);
      if ((await AddOnLogic.undoUid(luna, session)) === here) return false;
    }
    return false;
  },

  wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  },

  async track(session, uid) {
    const track = session.tracks.byId(uid);
    if (!track) throw new Error('That track is no longer in the session.');
    await track.loadStrip();
    await track.effects.load();
    return track;
  },

  trimControl(track) {
    return track.main.controls.byId('gain_trim');
  },

  /**
   * A write with no touch changes the sound and leaves undo alone (fact 85), which is what a
   * listening switch must do: hundreds of A/B clicks can't become hundreds of undo entries.
   */
  async writeSilently(luna, control, field, value) {
    await luna.raw.set(`${control.path}/${field}`, Luna.float(value));
  },

  async setTrim(luna, track, db) {
    await AddOnLogic.writeSilently(luna, AddOnLogic.trimControl(track), 'real_value', db);
  },

  /** A silent write doesn't reach the SDK's cached props, so ask the engine for the real value. */
  async readControl(luna, control, field) {
    const node = await luna.raw.get(control.path, { children: false, commands: false, flatvalue: true, propfilter: [field] });
    return node?.properties?.[field] ?? null;
  },

  readTrim(luna, track) {
    return AddOnLogic.readControl(luna, AddOnLogic.trimControl(track), 'real_value');
  },

  /**
   * A plugin's bypass control and the value that means "in", from its manifest. Right after a load
   * the slot's own bypass props aren't filled yet, and on UADx plugins `slot.in` reads backwards
   * (false while power is On), so neither can be trusted to switch a plugin.
   */
  async bypassOf(luna, slot) {
    const pluginId = slot.pluginId.value;
    AddOnLogic.bypassByPlugin ??= new Map();
    if (!AddOnLogic.bypassByPlugin.has(pluginId)) {
      const node = await luna.raw.get(`/plugins/${pluginId}`, { children: false, commands: false, flatvalue: true, propfilter: ['manifest'] });
      AddOnLogic.bypassByPlugin.set(pluginId, node?.properties?.manifest?.bypass_parameter ?? null);
    }
    const parameter = AddOnLogic.bypassByPlugin.get(pluginId);
    return parameter ? { control: { path: `${slot.path}/controls/${parameter.id}` }, inValue: parameter.bypass_value ? 0 : 1 } : null;
  },

  /** Put a candidate in or out without an undo entry, falling back to LUNA's IN switch. */
  async setCandidateIn(luna, slot, on) {
    const bypass = await AddOnLogic.bypassOf(luna, slot);
    if (!bypass) return slot.setIn(on);
    await AddOnLogic.writeSilently(luna, bypass.control, 'normalized_value', on ? bypass.inValue : 1 - bypass.inValue);
  },

  async isCandidateIn(luna, slot) {
    const bypass = await AddOnLogic.bypassOf(luna, slot);
    if (!bypass) return slot.in.value === true;
    const value = await AddOnLogic.readControl(luna, bypass.control, 'normalized_value');
    return Math.round(value) === bypass.inValue;
  },

  /** Hear one candidate, level matched, or '0' for the track as it was. */
  async listen(luna, session, key) {
    const record = AddOnLogic.current(session);
    if (record?.status !== 'ready') throw new Error('No shootout is ready to listen to.');
    const chosen = record.candidates.find((c) => c.key === key);
    if (key !== AddOnLogic.ORIGINAL && !chosen) throw new Error(`There is no candidate ${key}.`);
    const track = await AddOnLogic.track(session, record.trackUid);
    // An undo in LUNA can take a candidate away, and writing to its empty slot would stick.
    const gone = record.candidates.find((c) => track.effects.byId(c.slotId)?.pluginId.value !== c.pluginId);
    if (gone) throw new Error('A candidate is no longer on the track. Press Cancel, then run the shootout again.');
    const target = record.originalTrimDb + (chosen?.trimDb ?? 0);
    await AddOnLogic.fadeSwitch(luna, session, track, target, async () => {
      for (const c of record.candidates) {
        if (c.key !== key) await AddOnLogic.setCandidateIn(luna, track.effects.byId(c.slotId), false);
      }
      if (chosen) await AddOnLogic.setCandidateIn(luna, track.effects.byId(chosen.slotId), true);
    });
    return AddOnLogic.saveCurrent(session, { ...record, listening: key });
  },

  /** A level, from a gain relative to another level in dB. */
  dbAt(db, gain) {
    return gain > 0 ? db + 20 * Math.log10(gain) : AddOnLogic.SILENT_DB;
  },

  /**
   * Fade the track out, make the switch, let it settle and fade back in at `targetDb`, all with
   * silent writes. Stopped, nothing is heard, so it switches at once.
   */
  async fadeSwitch(luna, session, track, targetDb, swap) {
    if (session.transport.playing.value !== true) {
      await swap();
      return AddOnLogic.setTrim(luna, track, targetDb);
    }
    const from = (await AddOnLogic.readTrim(luna, track)) ?? targetDb;
    for (const gain of AddOnLogic.FADE_GAINS) {
      await AddOnLogic.setTrim(luna, track, AddOnLogic.dbAt(from, gain));
      await AddOnLogic.wait(AddOnLogic.FADE_STEP_MS);
    }
    try {
      await swap();
      await AddOnLogic.wait(AddOnLogic.SWITCH_SETTLE_MS);
    } finally {
      // Never leave the track silent, whatever the switch did.
      for (const gain of [...AddOnLogic.FADE_GAINS].reverse().slice(1)) {
        await AddOnLogic.setTrim(luna, track, AddOnLogic.dbAt(targetDb, gain));
        await AddOnLogic.wait(AddOnLogic.FADE_STEP_MS);
      }
      await AddOnLogic.setTrim(luna, track, targetDb);
    }
  },

  /** Keep and Cancel load and remove plugins, which can't be faded around: stop first instead. */
  async stopForEdits(session) {
    if (session.transport.playing.value === true) await session.transport.stop();
  },

  /** The loop and play start, from the engine: printing a range moves LUNA's marks. */
  async captureLoop(luna, session) {
    const node = await luna.raw.get(session.path, { children: false, commands: false, flatvalue: true, propfilter: ['looping', 'loop_start', 'loop_stop', 'play_start'] });
    const p = node?.properties ?? {};
    return { looping: p.looping === true, start: p.loop_start ?? null, stop: p.loop_stop ?? null, playStart: p.play_start ?? null };
  },

  /** Roll the section round and round for listening. */
  async loop(session) {
    const record = AddOnLogic.current(session);
    if (record?.status !== 'ready') return null;
    const t = session.transport;
    if (!t.playing.value) await t.seek(record.section.startTick);
    await t.setLoop(record.section.startTick, record.section.stopTick);
    await t.looping.set(true);
    if (!t.playing.value) await t.play();
    return record;
  },

  async restoreLoop(session, record) {
    const before = record.loopBefore;
    if (!before) return;
    const t = session.transport;
    await t.looping.set(before.looping);
    // With no loop on, LUNA's marks follow the playhead, so a seek is what puts them back. A
    // transport still rolling stays where it is: nobody wants Keep to jump the song.
    if (!t.playing.value && before.playStart != null) await t.seek(before.playStart).catch(() => t.playStart.set(before.playStart));
    if (before.start != null && before.stop != null && before.start !== before.stop) await t.setLoop(before.start, before.stop);
  },

  /** True when the only thing on the undo list since the shootout began is the shootout. */
  async historyIsOurs(luna, session, record) {
    return (await AddOnLogic.undoUid(luna, session)) === record.expectedUndoUid;
  },

  /** Take the candidates off: rewind if nobody else has edited, otherwise clear only our slots. */
  async removeCandidates(luna, session, record, track, spareKey = null) {
    if (await AddOnLogic.historyIsOurs(luna, session, record)) {
      for (const c of record.candidates) await AddOnLogic.readyToRewind(luna, track.effects.byId(c.slotId));
      if (await AddOnLogic.undoTo(luna, session, record.baseUndoUid)) {
        await AddOnLogic.wait(150);
        return { rewound: true };
      }
    }
    for (const c of record.candidates) {
      if (c.key === spareKey) continue;
      const slot = track.effects.byId(c.slotId);
      if (slot?.pluginId.value === c.pluginId) { await AddOnLogic.setCandidateIn(luna, slot, true); await slot.clear(); }
    }
    return { rewound: false };
  },

  /**
   * Load a plugin so it sounds the same in any slot. A slot remembers control values by id across
   * loads, and a plugin can inherit them, even mix at 0%, so every parameter goes to its default
   * first. A preset comes after: asked for in setPlugin, it printed dry.
   */
  async loadCandidate(luna, session, slot, pluginId, presetUid = null) {
    await slot.setPlugin(pluginId);
    await AddOnLogic.wait(AddOnLogic.LOAD_SETTLE_MS);
    await AddOnLogic.resetParams(session, slot);
    await AddOnLogic.setCandidateIn(luna, slot, true);
    if (presetUid) {
      await slot.loadPreset(presetUid);
      await AddOnLogic.wait(AddOnLogic.LOAD_SETTLE_MS);
      await AddOnLogic.setCandidateIn(luna, slot, true);
    }
  },

  async resetParams(session, slot) {
    await session.transaction('Spark MCP: defaults', async () => {
      for (const p of slot.params) await p.resetToDefault().catch(() => {});
    });
  },

  /**
   * Leave a slot safe for whatever goes in next. A rewind past a plugin that is switched off leaves
   * the slot's power off, so a later load of any plugin prints dry, and a silent write isn't undone
   * with the rest. Switched on, it rewinds cleanly, preset or not. Don't clear or reload it first:
   * rewinding past that left slots printing dry too.
   */
  async readyToRewind(luna, slot) {
    await AddOnLogic.setCandidateIn(luna, slot, true);
  },

  async applyParams(slot, params = {}) {
    for (const [id, value] of Object.entries(params)) {
      const control = slot.params.find((p) => p.id === id);
      if (control) await control.normalized.set(value);
    }
  },

  async finish(luna, session, record, outcome, trackEvent) {
    const finished = { ...record, ...outcome, finishedAt: Date.now() };
    await AddOnLogic.saveCurrent(session, finished);
    const events = AddOnLogic.prefs(session).value('history', 'events');
    const event = AddOnLogic.historyEvent(finished);
    if (event && trackEvent !== false) await AddOnLogic.prefs(session).set('history', 'events', [...(events.value ?? []), event].slice(-200));
    return finished;
  },

  /** Keep one candidate, and leave the track sounding the way it did when you chose it. */
  async keep(luna, session, key) {
    const record = AddOnLogic.current(session);
    if (record?.status !== 'ready') throw new Error('No shootout is ready to keep.');
    const chosen = record.candidates.find((c) => c.key === key);
    if (!chosen) throw new Error(`There is no candidate ${key}.`);
    const track = await AddOnLogic.track(session, record.trackUid);
    await AddOnLogic.stopForEdits(session);
    const historyMoved = !(await AddOnLogic.historyIsOurs(luna, session, record));
    if (historyMoved && track.effects.byId(chosen.slotId)?.pluginId.value !== chosen.pluginId) {
      throw new Error(`${chosen.name} is no longer on the track. Press Cancel, then run the shootout again.`);
    }
    await AddOnLogic.setTrim(luna, track, record.originalTrimDb);
    await AddOnLogic.restoreLoop(session, record);
    const { rewound } = await AddOnLogic.removeCandidates(luna, session, record, track, key);
    const slot = rewound ? track.effects.items.find((s) => s.id.startsWith('effect_') && s.isEmpty) : track.effects.byId(chosen.slotId);
    if (rewound) await AddOnLogic.loadCandidate(luna, session, slot, chosen.pluginId, chosen.presetUid);
    else await AddOnLogic.setCandidateIn(luna, slot, true);
    const trimmed = record.originalTrimDb + chosen.trimDb;
    const hasParams = rewound && Object.keys(chosen.params ?? {}).length > 0;
    const hasTrim = Math.abs(chosen.trimDb) >= 0.05;
    if (hasParams || hasTrim) {
      await session.transaction(`Spark MCP: ${chosen.name}`, async () => {
        if (hasParams) await AddOnLogic.applyParams(slot, chosen.params);
        if (hasTrim) await AddOnLogic.trimControl(track).real.set(trimmed);
      });
    }
    return AddOnLogic.finish(luna, session, record, { status: 'kept', keptKey: key, listening: key, rewound });
  },

  /** Call it off and put the track back as it was. */
  async cancel(luna, session) {
    const record = AddOnLogic.current(session);
    if (!AddOnLogic.isOpen(record)) throw new Error('No shootout is open.');
    const track = await AddOnLogic.track(session, record.trackUid);
    await AddOnLogic.stopForEdits(session);
    await AddOnLogic.setTrim(luna, track, record.originalTrimDb);
    await AddOnLogic.restoreLoop(session, record);
    const { rewound } = await AddOnLogic.removeCandidates(luna, session, record, track);
    return AddOnLogic.finish(luna, session, record, { status: 'cancelled', listening: AddOnLogic.ORIGINAL, rewound });
  },

  async setBlind(session, blind) {
    const record = AddOnLogic.current(session);
    if (record?.status !== 'ready') return record;
    return AddOnLogic.saveCurrent(session, { ...record, blind, blindAll: record.blindAll && blind });
  },

  /** One line for the taste record: what was offered, what was picked, and whether it was blind. */
  historyEvent(record) {
    if (record.status !== 'kept') return null;
    const kept = record.candidates.find((c) => c.key === record.keptKey);
    return {
      id: record.id,
      at: record.finishedAt ?? Date.now(),
      role: record.role ?? record.trackName,
      trackName: record.trackName,
      problem: record.problem ?? null,
      blind: record.blindAll === true,
      kept: { pluginId: kept.pluginId, name: kept.name, presetName: kept.presetName ?? null },
      passed: record.candidates.filter((c) => c.key !== record.keptKey).map((c) => ({ pluginId: c.pluginId, name: c.name, presetName: c.presetName ?? null })),
    };
  },

  /** For each role and plugin: how often it was offered and picked, counting blind picks apart. */
  summarizePicks(picks, role) {
    const wanted = role?.toLowerCase();
    const rows = new Map();
    const touch = (pickRole, plugin, field) => {
      const key = `${pickRole}\u0000${plugin.pluginId}`;
      const row = rows.get(key) ?? { role: pickRole, pluginId: plugin.pluginId, name: plugin.name, offered: 0, picked: 0, pickedBlind: 0, presets: {} };
      row.offered++;
      if (field) { row.picked++; if (field === 'blind') row.pickedBlind++; if (plugin.presetName) row.presets[plugin.presetName] = (row.presets[plugin.presetName] ?? 0) + 1; }
      rows.set(key, row);
    };
    let counted = 0;
    for (const pick of picks) {
      const pickRole = pick.role ?? pick.trackName;
      if (wanted && !pickRole?.toLowerCase().includes(wanted)) continue;
      counted++;
      touch(pickRole, pick.kept, pick.blind ? 'blind' : 'open');
      for (const passed of pick.passed) touch(pickRole, passed, null);
    }
    const summary = [...rows.values()].sort((a, b) => a.role.localeCompare(b.role) || b.pickedBlind - a.pickedBlind || b.picked - a.picked);
    return { shootouts: counted, plugins: summary };
    },

  /** Shuffle the candidates' numbers so blind listening has nothing to learn from their order. */
  shuffled(list, random = Math.random) {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  },

  formatDb(value) {
    if (value === null || value === undefined) return '-';
    return `${value > 0 ? '+' : ''}${value.toFixed(1)} dB`;
  },

  /** The one line a person reads: the biggest tonal moves, plus what happened to the dynamics. */
  changeLine(change, workDb = 0) {
    if (!change) return '';
    const names = { sub: 'sub', low: 'lows', low_mid: 'low mids', mid: 'mids', high_mid: 'high mids', high: 'highs', air: 'air' };
    const moved = Object.entries(change.bands ?? {})
      .filter(([, v]) => v !== null && Math.abs(v) >= 0.5 && Number.isFinite(v))
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
      .slice(0, 2)
      .map(([k, v]) => `${names[k]} ${AddOnLogic.formatDb(v)}`);
    const parts = [...moved];
    if (workDb >= 0.5) parts.unshift(`compressing ${workDb.toFixed(1)} dB`);
    if (change.crestDb !== null && Math.abs(change.crestDb) >= 0.5) parts.push(`${change.crestDb < 0 ? 'tighter' : 'more open'} ${Math.abs(change.crestDb).toFixed(1)} dB`);
    return parts.length ? parts.join(' · ') : 'Very little change in level or tone';
  },

  /** What the panel draws, from the shared record. Blind hides everything that names a plugin. */
  view(record, connected = true, now = Date.now()) {
    if (!connected) return { state: 'offline', word: 'OFFLINE', detail: 'Waiting for LUNA', phase: 'idle', candidates: [] };
    if (!record) return { state: 'paused', word: 'READY', detail: 'Say what the track needs', phase: 'idle', candidates: [] };
    const base = { track: record.trackName, section: record.section?.label ?? '' };
    if (AddOnLogic.isStalled(record, now)) {
      return { ...base, state: 'paused', word: 'STALLED', detail: 'The print stopped responding', phase: 'stalled', candidates: [], notice: 'The agent that was printing has gone quiet. Cancel takes any candidates off and puts the track back.' };
    }
    if (record.status === 'printing') {
      return { ...base, state: 'thinking', word: 'PRINTING', detail: record.progress ?? 'Printing candidates', phase: 'printing', candidates: [] };
    }
    if (record.status === 'error') {
      return { ...base, state: 'paused', word: 'STOPPED', detail: record.error ?? 'The shootout stopped', phase: 'idle', candidates: [], notice: record.error };
    }
    if (record.status === 'kept' || record.status === 'cancelled') {
      const kept = record.candidates.find((c) => c.key === record.keptKey);
      return {
        ...base,
        state: 'paused',
        word: record.status === 'kept' ? 'KEPT' : 'CALLED OFF',
        detail: kept ? `${kept.name}${kept.presetName ? ` · ${kept.presetName}` : ''}` : `${record.trackName} is back as it was`,
        phase: 'idle',
        candidates: [],
        done: record.status === 'kept' ? { title: kept.name, sub: kept.presetName ?? '', blind: record.blindAll === true } : null,
      };
    }
    const blind = record.blind === true;
    const listening = record.listening ?? AddOnLogic.ORIGINAL;
    return {
      ...base,
      state: 'listening',
      word: 'LISTEN',
      detail: record.problem || 'Choose by ear',
      phase: 'ready',
      blind,
      listening,
      problem: record.problem ?? '',
      canKeep: listening !== AddOnLogic.ORIGINAL,
      candidates: record.candidates.map((c) => ({
        key: c.key,
        title: blind ? `Candidate ${c.key}` : c.name,
        preset: blind ? '' : (c.presetName ?? 'Default settings'),
        why: blind ? '' : (c.why ?? ''),
        change: blind ? '' : AddOnLogic.changeLine(c.change, c.isCompressor ? c.workDb : 0),
        check: blind ? false : c.verdict === 'quiet',
        on: c.key === listening,
      })),
    };
  },
};

globalThis.AddOnLogic = AddOnLogic;
