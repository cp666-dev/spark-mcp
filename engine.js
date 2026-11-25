// Spark MCP: a shootout's printing and measuring, shared by the panel and the MCP server. It prints
// with LUNA's renderer and measures what came out. The listening and the decision are in logic.js.
// How a printed file gets read is the only difference between the two, so that is passed in as io.

// Classic scripts share one global scope, so each file keeps its names to itself.
(() => {
const logic = globalThis.AddOnLogic;
const { delta, gainReduction, isSilent, masking, matchedNull, measure, nullDepth, sum, withGain } = globalThis.SparkAudio;
const uuid = () => 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));

// Printing many channels in one render has stalled LUNA's engine (found building InterDAW).
const STEMS_PER_RENDER = 4;
// LUNA's Volume Trim stops at +12 dB, and a match beyond that would be cut short.
const MAX_TRIM_DB = 12;
// How long a switched plugin takes to reach the renderer. 60 ms printed the old state.
const SWITCH_SETTLE_MS = 400;
const HIDDEN_TYPES = new Set(['Instrument', 'Synthesizer']);
const DEFAULT_WORK_DB = 4;
const WORK_TOLERANCE_DB = 1;
const DRIVE_STEPS = 7;
// Once the best overall gain is taken out, a difference this far down is make-up gain and nothing else.
const GAIN_ONLY_NULL_DB = -45;

// The control that sets how hard each compressor works. A preset's threshold assumes a hot signal,
// so on a quiet track it may never trigger. Read from each plugin in a never-used slot.
const DRIVE_CONTROLS = {
  uaudio_175_b: 'input', uaudio_176: 'input', uaudio_api_2500: 'threshold', uaudio_api_vision_channel_strip: '225_thresh',
  'uaudio_avalon_vt-737sp': 'comp_thresh', uaudio_century_channel_strip: 'compression', uaudio_dbx_160: 'thresh', uaudio_distressor: 'input',
  uaudio_fairchild_660: 'thresh', uaudio_fairchild_670: 'l_thresh', uaudio_la3a: 'peak_reduction', uaudio_manley_variable_mu: 'l_thresh',
  uaudio_manley_voxbox: 'comp_thresh', uaudio_ssl_e_channel_strip: 'comp_thresh', uaudio_ssl_g_bus_compressor: 'thresh', 'uaudio_teletronix_la-2': 'peak_reduct',
  'uaudio_teletronix_la-2a_gray': 'peak_reduct', 'uaudio_teletronix_la-2a_silver': 'peak_reduct', uaudio_ua_1176_rev_a: 'input', uaudio_ua_1176ae: 'input', uaudio_ua_1176ln_rev_e: 'input',
};

class SparkEngine {
  /** @param io files: { scratch(name), path(dir, file), read(path), clean(dir), spectrogram?(audio) } */
  constructor(luna, io) {
    this.luna = luna;
    this.io = io;
  }

  close() {
    return this.luna.close();
  }

  async session() {
    const session = await this.luna.session();
    await session.ready();
    await logic.loadState(session);
    return session;
  }

  findTrack(session, name) {
    const wanted = String(name).trim().toLowerCase();
    const tracks = session.visibleTracks;
    const track = tracks.find((t) => t.id === name) ?? tracks.find((t) => t.name.value?.toLowerCase() === wanted);
    if (!track) throw new Error(`No track called "${name}". Tracks: ${tracks.map((t) => t.name.value).join(', ')}`);
    return track;
  }

  /** startBar is inclusive, endBar exclusive, as a loop reads on the ruler. */
  section(session, { startBar, endBar }) {
    const timeline = session.musical.timeline;
    if (!(endBar > startBar)) throw new Error('endBar has to be after startBar.');
    return { startTick: timeline.tickAtBar(startBar), stopTick: timeline.tickAtBar(endBar), label: `Bars ${startBar}-${endBar}` };
  }

  async print(session, channels, section, recordPoint, dir, name) {
    const files = channels.map((c, i) => this.io.path(dir, `${name}-${i}.wav`));
    // LUNA's own render dialog can stay up after a print, blocking the transport until someone
    // cancels it. The panel shows the progress, so hold the dialog back, and clear each finished
    // render, which is what the dialog waits on.
    const suppression = uuid();
    await this.luna.raw.post('/gui/add_progress_suppression', { suppression_uid: suppression }).catch(() => {});
    try {
      for (let start = 0; start < channels.length; start += STEMS_PER_RENDER) {
        const { render } = await session.bounce({
          channelUids: channels.slice(start, start + STEMS_PER_RENDER).map((c) => c.id),
          range: { startTick: section.startTick, stopTick: section.stopTick },
          outputPaths: files.slice(start, start + STEMS_PER_RENDER),
          recordPoint,
          name: `Spark MCP ${name}`,
        });
        try {
          await render.done(10 * 60 * 1000);
        } finally {
          await this.luna.raw.post('/renders/delete', { uid: render.id }).catch(() => {});
        }
      }
    } finally {
      await this.luna.raw.post('/gui/remove_progress_suppression', { suppression_uid: suppression }).catch(() => {});
    }
    return files;
  }

  driveControl(slot, pluginId) {
    let id = DRIVE_CONTROLS[pluginId];
    if (pluginId === 'uaudio_la_6176') id = slot.params.find((p) => p.id === 'dyn_mode')?.display.value === '1176' ? '1176_input' : 'la2a_pk_red';
    return id ? slot.params.find((p) => p.id === id) ?? null : null;
  }

  /**
   * Set a compressor to do the asked-for amount of work, judged by printing. Which way the control
   * runs is measured, not assumed. Touched writes, so a rewind takes them away cleanly.
   */
  async driveTo({ session, track, section, dir, slot, pluginId, dry, target, name, say }) {
    const control = this.driveControl(slot, pluginId);
    if (!control) return null;
    let printed = 0;
    const seen = [];
    const workAt = async (position) => {
      await control.normalized.set(position);
      await logic.wait(SWITCH_SETTLE_MS);
      const [file] = await this.print(session, [track], section, 'post_effects', dir, `${name}-d${printed++}`);
      const work = gainReduction(dry, await this.io.read(file));
      seen.push({ position, work });
      return work;
    };
    const closeEnough = (work) => Math.abs(work - target) <= WORK_TOLERANCE_DB;
    const start = control.normalized.value;
    await say();
    if (!closeEnough(await workAt(start))) {
      const [low, high] = [await workAt(0), await workAt(1)];
      const most = high >= low ? 1 : 0;
      let gentle = 1 - most, hard = most;
      if (Math.max(low, high) >= target - WORK_TOLERANCE_DB) {
        for (let step = 0; step < DRIVE_STEPS; step++) {
          const middle = (gentle + hard) / 2;
          const work = await workAt(middle);
          if (closeEnough(work)) break;
          if (work < target) gentle = middle; else hard = middle;
        }
      }
    }
    const best = seen.reduce((a, b) => (Math.abs(b.work - target) < Math.abs(a.work - target) ? b : a));
    await control.normalized.set(best.position);
    await logic.wait(SWITCH_SETTLE_MS);
    return { control: control.id, position: best.position };
  }

  /** Tracks, what is on them, markers and tempo: enough for an agent to talk about the song. */
  async brief() {
    const session = await this.session();
    const tracks = [];
    for (const t of session.visibleTracks) {
      await t.loadStrip();
      await t.effects.load();
      const clips = session.playlistFor(t);
      await clips?.clips.load();
      const inserts = [];
      for (const slot of t.effects.items) {
        const id = slot.pluginId.value;
        if (id && slot.id.startsWith('effect_') && !id.startsWith('alias.')) inserts.push({ slot: slot.id, pluginId: id, preset: slot.presetName.value ?? null, in: await logic.isCandidateIn(this.luna, slot) });
      }
      tracks.push({
        name: t.name.value,
        type: t.trackType.value,
        format: t.stemFormat?.value ?? null,
        faderDb: t.gain.real.value,
        muted: t.mute.on,
        hasAudio: (clips?.clips.items.length ?? 0) > 0,
        inserts,
        freeSlots: t.effects.items.filter((s) => s.id.startsWith('effect_') && s.isEmpty).length,
      });
    }
    const timeline = session.musical.timeline;
    return {
      session: session.name.value,
      tempo: session.transport.tempo.value,
      timeSignature: session.transport.timeSignature.value,
      loop: session.transport.looping.value ? { start: timeline.formatBarBeat(session.transport.loopStart.value), stop: timeline.formatBarBeat(session.transport.loopStop.value) } : null,
      markers: session.markers.sorted.map((m) => ({ name: m.name.value, bar: timeline.barBeat(m.tick?.value ?? m.location?.value ?? 0).bar })),
      tracks,
      open: logic.isOpen(logic.current(session)),
    };
  }

  /** Only UA's: waiting on every plugin stalls on Audio Units that never answer LUNA. */
  async loadPlugins() {
    await this.luna.plugins.load();
    await Promise.all(this.luna.plugins.items.filter((p) => p.id.startsWith('uaudio_')).map((p) => p.load()));
  }

  /** Effects this person can load, narrowed by category or name, with presets for each. */
  async findPlugins({ category, search, presetSearch, limit = 12 }) {
    await this.loadPlugins();
    const wanted = category?.toLowerCase();
    const needle = search?.toLowerCase();
    const found = this.luna.plugins.items.filter((p) => {
      const categories = p.categories.value ?? p.categories ?? [];
      if (!p.id.startsWith('uaudio_') || !categories.length || categories.some((c) => HIDDEN_TYPES.has(c))) return false;
      if (p.authorized?.value === false || p.installed?.value === false) return false;
      if (wanted && !categories.some((c) => c.toLowerCase().includes(wanted))) return false;
      return !needle || p.name.value?.toLowerCase().includes(needle) || p.id.includes(needle);
    }).slice(0, limit);
    const out = [];
    for (const p of found) {
      const presets = await this.luna.presets.query({ pluginId: p.id, search: presetSearch, withTags: true }).catch(() => []);
      out.push({
        pluginId: p.id,
        name: p.name.value,
        categories: p.categories.value ?? p.categories,
        presets: presets.slice(0, 25).map((row) => ({ name: row.name, tags: row.tags ?? [] })),
      });
    }
    return out;
  }

  /** Print the track and everything else, measure both, and say what is sitting on top of it. */
  async analyze({ track: name, startBar, endBar }) {
    const session = await this.session();
    if (logic.isOpen(logic.current(session))) throw new Error('A shootout is open, so this would measure whatever is switched in. Keep one or call it off first.');
    const section = this.section(session, { startBar, endBar });
    const track = this.findTrack(session, name);
    const dir = this.io.scratch(`analyze-${uuid()}`);
    const loopBefore = await logic.captureLoop(this.luna, session);
    try {
      if (session.transport.playing.value) await session.transport.stop();
      await Promise.all(session.visibleTracks.map((t) => t.loadStrip()));
      const others = session.visibleTracks.filter((t) => t.id !== track.id && !t.mute.on);
      // Printed before the fader, because a print after it obeys solo: with anything soloed, every
      // other track comes out silent. The fader goes back on here, as its level at this moment.
      const atFader = async (file, channel) => withGain(await this.io.read(file), channel.gain.real.value ?? 0);
      const [targetFile] = await this.print(session, [track], section, 'post_effects', dir, 'target');
      const target = await atFader(targetFile, track);
      const measured = measure(target);
      if (isSilent(measured)) throw new Error(`${track.name.value} has no audio in ${section.label}.`);
      const files = await this.print(session, others, section, 'post_effects', dir, 'rest');
      const stems = [];
      for (const [i, file] of files.entries()) stems.push(await atFader(file, others[i]));
      const rest = sum(stems);
      return {
        track: track.name.value,
        section: section.label,
        measured,
        maskedBy: rest ? masking(target, rest) : [],
        restOfMix: rest ? { tracks: others.map((t) => t.name.value), measured: measure(rest) } : null,
        note: 'Levels use each fader as it stands now, ignoring solo, pan and automation. Rest of mix is the other unmuted tracks. Buses and sends are not in it.',
        spectrogram: this.io.spectrogram?.(target),
      };
    } finally {
      await logic.restoreLoop(session, { loopBefore });
      this.io.clean(dir);
    }
  }

  async resolvePreset(pluginId, preset) {
    if (!preset) return null;
    const rows = await this.luna.presets.query({ pluginId, search: preset });
    const row = rows.find((r) => r.name.toLowerCase() === preset.toLowerCase()) ?? rows[0];
    if (!row) throw new Error(`${pluginId} has no preset matching "${preset}".`);
    return row;
  }

  /**
   * Load up to three candidates on the track, print each alone, and hand them to the panel. On
   * any failure the track goes back as it was: nothing half-built stays in someone's session.
   */
  async shootout({ track: name, startBar, endBar, role, problem, candidates, workDb = DEFAULT_WORK_DB }) {
    const session = await this.session();
    const openNow = logic.current(session);
    if (logic.isStalled(openNow)) await logic.cancel(this.luna, session);
    else if (logic.isOpen(openNow)) throw new Error('A shootout is already open. Keep one or call it off first.');
    if (!candidates?.length || candidates.length > logic.MAX_CANDIDATES) throw new Error(`Give between 1 and ${logic.MAX_CANDIDATES} candidates.`);
    await this.loadPlugins();
    const section = this.section(session, { startBar, endBar });
    const track = this.findTrack(session, name);
    await logic.track(session, track.id);
    const free = track.effects.items.filter((s) => s.id.startsWith('effect_') && s.isEmpty);
    if (free.length < candidates.length) throw new Error(`${track.name.value} has ${free.length} free insert slots and this needs ${candidates.length}.`);

    const order = logic.shuffled(candidates);
    const record = {
      id: uuid(),
      status: 'printing',
      trackUid: track.id,
      trackName: track.name.value,
      role: role ?? track.name.value,
      problem: problem ?? null,
      section,
      baseUndoUid: await logic.undoUid(this.luna, session),
      originalTrimDb: (await logic.readTrim(this.luna, track)) ?? 0,
      loopBefore: await logic.captureLoop(this.luna, session),
      listening: logic.ORIGINAL,
      blind: true,
      blindAll: true,
      progress: 'Printing the track as it is',
      candidates: [],
      startedAt: Date.now(),
      heartbeatAt: Date.now(),
    };
    await logic.saveCurrent(session, record);
    const dir = this.io.scratch(record.id);
    const loaded = [];
    // Only a progress line, so failing to show one is no reason to stop.
    const say = (progress) => logic.saveCurrent(session, { ...record, progress, candidates: loaded, heartbeatAt: Date.now() }).catch(() => {});
    try {
      if (session.transport.playing.value) await session.transport.stop();
      const [dryFile] = await this.print(session, [track], section, 'post_effects', dir, 'dry');
      const dry = await this.io.read(dryFile);
      const dryMeasure = measure(dry);
      if (isSilent(dryMeasure)) throw new Error(`${track.name.value} has no audio in ${section.label}. Pick a section where it plays.`);

      for (const [i, wanted] of order.entries()) {
        const plugin = this.luna.plugins.byId(wanted.pluginId);
        if (!plugin || plugin.installed.value === false || plugin.authorized.value === false) throw new Error(`${wanted.pluginId} is not available to load. find_plugins lists what is.`);
        await say(`Loading candidate ${i + 1} of ${order.length}`);
        const preset = await this.resolvePreset(wanted.pluginId, wanted.preset);
        // The last free slots: a slot's history can reach the next plugin loaded in it, so stay away
        // from the ones a person reaches for first. Keep puts the winner in the first free slot.
        const slot = free[free.length - order.length + i];
        loaded.push({
          key: String(i + 1),
          pluginId: wanted.pluginId,
          name: plugin.name.value ?? wanted.pluginId,
          presetUid: preset?.uid ?? null,
          presetName: preset?.name ?? null,
          params: wanted.params ?? {},
          why: wanted.why ?? '',
          slotId: slot.id,
        });
        // On the list before it loads, so a failure part way through still takes it off.
        await say(`Loading candidate ${i + 1} of ${order.length}`);
        await logic.loadCandidate(this.luna, session, slot, wanted.pluginId, preset?.uid);
        await logic.applyParams(slot, wanted.params);
      }

      const slots = loaded.map((c) => track.effects.byId(c.slotId));
      for (const [i, candidate] of loaded.entries()) {
        await say(`Printing candidate ${i + 1} of ${loaded.length}`);
        for (const [j, slot] of slots.entries()) await logic.setCandidateIn(this.luna, slot, i === j);
        await logic.wait(SWITCH_SETTLE_MS);
        const driven = await this.driveTo({ session, track, section, dir, slot: slots[i], pluginId: candidate.pluginId, dry, target: workDb, name: `c${candidate.key}`, say: () => say(`Setting candidate ${i + 1} of ${loaded.length}`) });
        if (driven) {
          candidate.params = { ...candidate.params, [driven.control]: driven.position };
          await say(`Printing candidate ${i + 1} of ${loaded.length}`);
        }
        const [file] = await this.print(session, [track], section, 'post_effects', dir, `c${candidate.key}`);
        const wet = await this.io.read(file);
        const measured = measure(wet);
        const depth = nullDepth(dry, wet);
        candidate.measured = measured;
        candidate.change = delta(dryMeasure, measured);
        candidate.nullDb = Number.isFinite(depth) ? Number(depth.toFixed(1)) : null;
        const work = gainReduction(dry, wet);
        const beyondGain = matchedNull(dry, wet);
        candidate.workDb = Number(work.toFixed(1));
        candidate.isCompressor = Boolean(driven);
        // Make-up gain alone changes a print without changing the sound once levels match.
        candidate.verdict = !Number.isFinite(depth) || depth < logic.QUIET_NULL_DB || beyondGain < GAIN_ONLY_NULL_DB || (driven && work < 1) ? 'quiet' : 'changed';
        candidate.trimDb = dryMeasure.lufs !== null && measured.lufs !== null ? Math.max(-MAX_TRIM_DB, Math.min(MAX_TRIM_DB, Number((dryMeasure.lufs - measured.lufs).toFixed(1)))) : 0;
        candidate.parameters = slots[i].params.map((p) => ({ id: p.id, value: p.normalized.value, shown: p.display.value }));
      }

      // Start on the track as it was, so the first thing heard is the reference.
      for (const slot of slots) await logic.setCandidateIn(this.luna, slot, false);
      await logic.wait(SWITCH_SETTLE_MS);
      const [offFile] = await this.print(session, [track], section, 'post_effects', dir, 'off');
      const offDepth = nullDepth(dry, await this.io.read(offFile));
      await logic.restoreLoop(session, record);
      const ready = {
        ...record,
        status: 'ready',
        progress: null,
        dry: dryMeasure,
        referenceNullDb: Number.isFinite(offDepth) ? Number(offDepth.toFixed(1)) : null,
        candidates: loaded,
        expectedUndoUid: await logic.undoUid(this.luna, session),
      };
      await logic.saveCurrent(session, ready);
      return this.publicRecord(ready);
    } catch (error) {
      await this.unwind(session, record, loaded, track);
      await logic.saveCurrent(session, { ...record, status: 'error', error: error.message, candidates: [], progress: null });
      throw error;
    } finally {
      this.io.clean(dir);
    }
  }

  async unwind(session, record, loaded, track) {
    await logic.setTrim(this.luna, track, record.originalTrimDb).catch(() => {});
    await logic.restoreLoop(session, record).catch(() => {});
    for (const c of loaded) await logic.readyToRewind(this.luna, track.effects.byId(c.slotId)).catch(() => {});
    const rewound = await logic.undoTo(this.luna, session, record.baseUndoUid).catch(() => false);
    if (rewound) return;
    for (const c of loaded) await track.effects.byId(c.slotId)?.clear().catch(() => {});
  }

  /**
   * What the agent gets back. While the person is listening blind it can't know which number is
   * which, so it can't give that away: no numbers, and in an order that says nothing.
   */
  publicRecord(record) {
    if (!record) return { status: 'none' };
    const { baseUndoUid, expectedUndoUid, loopBefore, trackUid, ...rest } = record;
    const candidates = record.candidates.map(({ slotId, presetUid, ...c }) => c);
    if (record.blind === true && logic.isOpen(record)) {
      return {
        ...rest,
        listening: record.listening === logic.ORIGINAL ? 'the original' : 'a candidate',
        candidates: candidates.map(({ key, ...c }) => c).sort((a, b) => a.pluginId.localeCompare(b.pluginId)),
        note: 'The person is listening blind, so you are not told which number is which. Keep it that way.',
      };
    }
    return { ...rest, candidates };
  }

  async status() {
    const session = await this.session();
    return this.publicRecord(logic.current(session));
  }

  async keep(key) {
    const session = await this.session();
    return this.publicRecord(await logic.keep(this.luna, session, key));
  }

  async cancel() {
    const session = await this.session();
    return this.publicRecord(await logic.cancel(this.luna, session));
  }

  /** Picks made in this session, for the taste record. */
  async picks() {
    const session = await this.session();
    return logic.prefs(session).value('history', 'events').value ?? [];
  }

  /** Hand over each pick as it is made in the panel, in case the session is never saved. */
  async followPicks(onPicks) {
    const session = await this.session();
    if (this.followed === session.uid) return;
    this.stopFollowing?.();
    this.followed = session.uid;
    const events = logic.prefs(session).value('history', 'events');
    this.stopFollowing = events.onChange(() => onPicks(events.value ?? []));
    onPicks(events.value ?? []);
  }
}

globalThis.SparkEngine = SparkEngine;
})();
