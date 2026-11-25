// Live check through the real MCP protocol: a client talks to server/index.mjs over stdio, a second
// LUNA client judges the result. Copies the named track's first clip to a temporary track and works
// there, so no real insert slot is ever used. Undo removes the copy; it never saves.
//   node tests/live-shootout.mjs <track> <startBar> <endBar>

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Luna } from '../server/luna.mjs';
import { isSilent, measure, readWav } from '../server/measure.mjs';

const [sourceName, startBar, endBar] = process.argv.slice(2);
if (!endBar) throw new Error('Usage: node tests/live-shootout.mjs <track> <startBar> <endBar>');
const trackName = 'Spark MCP check';
globalThis.Luna = Luna;
await import('../logic.js');
const logic = globalThis.AddOnLogic;

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`); if (!ok) failed++; };

const judge = await Luna.connect();
const session = await judge.session();
await session.ready();
await logic.loadState(session);
const outerUid = await logic.undoUid(judge, session);
const outerLoop = await logic.captureLoop(judge, session);
const trackCount = session.visibleTracks.length;
await session.sources.load?.();
const source = session.visibleTracks.find((t) => t.name.value === sourceName);
const sourceList = session.playlistFor(source);
await sourceList.clips.load();
const clip = sourceList.clips.items[0];
if (!clip) { await judge.close(); throw new Error(`${sourceName} has no clip to copy.`); }
await session.newTrack({ name: trackName, trackType: 'audio', stemFormat: source.stemFormat?.value ?? 'stereo' });
await Luna.settle(() => session.visibleTracks.some((t) => t.name.value === trackName), 'check track');
const track = session.visibleTracks.find((t) => t.name.value === trackName);
await session.insertClip({ trackUid: track.id, sourceUid: clip.sourceUid.value, startTick: clip.start.value, stopTick: clip.stop.value, sourceStartNs: clip.sourceStart.value, sourceStopNs: clip.sourceStop.value });
await logic.track(session, track.id);
// LUNA prepares a copied clip's audio in the background, so wait until it actually prints sound.
{
  const dir = mkdtempSync(join(tmpdir(), 'spark-ready-'));
  const timeline = session.musical.timeline;
  let heard = false;
  for (let attempt = 0; attempt < 20 && !heard; attempt++) {
    await logic.wait(1000);
    const file = join(dir, `${attempt}.wav`);
    const { render } = await session.bounce({ channelUids: [track.id], range: { startTick: timeline.tickAtBar(Number(startBar)), stopTick: timeline.tickAtBar(Number(endBar)) }, outputPaths: [file], recordPoint: 'post_effects', name: 'Spark MCP check' });
    await render.done();
    await judge.raw.post('/renders/delete', { uid: render.id }).catch(() => {});
    heard = !isSilent(measure(readWav(file)));
    console.log(`copy ready check ${attempt + 1}: ${heard ? 'has sound' : 'silent'}`);
  }
  rmSync(dir, { recursive: true, force: true });
  if (!heard) {
    await logic.undoTo(judge, session, outerUid);
    await judge.close();
    throw new Error(`The copy of ${sourceName} never printed any sound in bars ${startBar}-${endBar}.`);
  }
}
const inserts = () => track.effects.items.filter((s) => s.id.startsWith('effect_')).map((s) => s.pluginId.value ?? '-').join(',');
const trim = () => logic.readTrim(judge, track);
const near = (a, b) => Math.abs(a - b) < Luna.TICKS_PER_BEAT / 100;
const tasteDir = mkdtempSync(join(tmpdir(), 'spark-taste-'));
const historyBefore = logic.prefs(session).value('history', 'events').value ?? [];
const baseline = { uid: await logic.undoUid(judge, session), inserts: inserts(), trim: await trim(), playStart: session.transport.playStart.value, loop: [session.transport.looping.value, session.transport.loopStart.value, session.transport.loopStop.value], sources: (await session.sources.load?.(), session.sources.items.length) };
console.log('baseline', baseline);

const client = new Client({ name: 'spark-live-check', version: '1' });
try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['server/index.mjs'], stderr: 'inherit', env: { ...process.env, SPARK_TASTE_FILE: join(tasteDir, 'taste.jsonl') } }));
} catch (error) {
  await logic.undoTo(judge, session, outerUid);
  await judge.close();
  throw error;
}
const call = async (name, args = {}) => {
  const t = performance.now();
  const r = await client.callTool({ name, arguments: args });
  const text = r.content.find((c) => c.type === 'text')?.text;
  if (r.isError) throw new Error(`${name}: ${text}`);
  let value = text;
  try { value = JSON.parse(text); } catch {}
  return { value, ms: Math.round(performance.now() - t), content: r.content };
};
const settle = () => logic.wait(350);

// What a plain load prints in a slot, with no reset: this is what a person gets from it next.
const plainPlugins = ['uaudio_teletronix_la-2a_silver', 'uaudio_ua_1176ln_rev_e'];
const plainSlots = ['effect_1', 'effect_4'];
const plainDir = mkdtempSync(join(tmpdir(), 'spark-plain-'));
let plainCount = 0;
const plainLoads = async () => {
  const out = {};
  const timeline = session.musical.timeline;
  const range = { startTick: timeline.tickAtBar(Number(startBar)), stopTick: timeline.tickAtBar(Number(endBar)) };
  const loopBefore = await logic.captureLoop(judge, session);
  for (const slotId of plainSlots) {
    const slot = track.effects.byId(slotId);
    for (const plugin of plainPlugins) {
      const mark = await logic.undoUid(judge, session);
      await slot.setPlugin(plugin);
      await logic.wait(700);
      const file = join(plainDir, `p${plainCount++}.wav`);
      const { render } = await session.bounce({ channelUids: [track.id], range, outputPaths: [file], recordPoint: 'post_effects', name: 'Spark MCP check' });
      await render.done();
      await judge.raw.post('/renders/delete', { uid: render.id }).catch(() => {});
      out[`${slotId}/${plugin}`] = measure(readWav(file)).lufs;
      await logic.undoTo(judge, session, mark);
      await logic.wait(250);
    }
  }
  await logic.restoreLoop(session, { loopBefore });
  await logic.wait(200);
  return out;
};

try {
  const tools = (await client.listTools()).tools.map((t) => t.name);
  check('seven tools', tools.length === 7, tools.join(' '));

  const brief = await call('session_brief');
  check('session_brief sees the track', brief.value.tracks.some((t) => t.name === trackName), `${brief.value.session}, ${brief.value.tracks.length} tracks, ${brief.ms}ms`);

  const comps = await call('find_plugins', { category: 'Compressors', limit: 40 });
  check('find_plugins lists compressors with presets', comps.value.length > 3 && comps.value.some((p) => p.presets.length), `${comps.value.length} plugins`);
  check('find_plugins hides instruments', !comps.value.some((p) => p.categories.includes('Instrument')));

  const analysis = await call('analyze', { track: trackName, startBar: Number(startBar), endBar: Number(endBar) });
  check('analyze measures', analysis.value.measured.lufs !== null, `${analysis.value.measured.lufs} LUFS, masked ${JSON.stringify(analysis.value.maskedBy)}, ${analysis.ms}ms`);
  const image = analysis.content.find((c) => c.type === 'image');
  check('analyze returns a spectrogram', image?.mimeType === 'image/png' && Buffer.from(image.data, 'base64').subarray(1, 4).toString() === 'PNG', `${image?.data.length} b64`);
  check('analyze leaves no undo entry', (await logic.undoUid(judge, session)) === baseline.uid);
  await settle();
  check('analyze leaves the loop alone', near(session.transport.loopStart.value, baseline.loop[1]) && near(session.transport.loopStop.value, baseline.loop[2]), String(session.transport.loopStart.value));

  const presetOf = (id, words) => comps.value.find((p) => p.pluginId === id)?.presets.find((row) => words.some((w) => row.name.toLowerCase().includes(w)))?.name;
  const candidates = [
    { pluginId: 'uaudio_teletronix_la-2a_silver', preset: presetOf('uaudio_teletronix_la-2a_silver', ['vocal']), why: 'Smooth opto levelling' },
    { pluginId: 'uaudio_ua_1176ln_rev_e', why: 'Faster and more forward' },
    { pluginId: 'uaudio_distressor', preset: presetOf('uaudio_distressor', ['vocal', 'vox']), why: 'More colour' },
  ];
  const shoot = await call('shootout', { track: trackName, startBar: Number(startBar), endBar: Number(endBar), role: 'lead vocal', problem: 'live check', workDb: 6, candidates });
  check('shootout ready', shoot.value.status === 'ready', `${shoot.ms}ms`);
  check('blind results do not say which number is which', shoot.value.candidates.every((c) => !('key' in c)));
  for (const c of logic.current(session).candidates) console.log(`   ${c.key} ${c.name} preset=${c.presetName} work=${c.workDb} trim=${c.trimDb} null=${c.nullDb} ${c.verdict}: ${logic.changeLine(c.change, c.workDb)} ${JSON.stringify(c.params)}`);
  check('every compressor did the work asked for', shoot.value.candidates.every((c) => Math.abs(c.workDb - 6) <= 1.5), shoot.value.candidates.map((c) => c.workDb).join(' '));
  const distinct = new Set(shoot.value.candidates.map((c) => c.nullDb));
  check('each candidate printed alone', distinct.size === 3, [...distinct].join(' '));
  check('all candidates off nulls with the dry print', shoot.value.referenceNullDb === null || shoot.value.referenceNullDb < -80, String(shoot.value.referenceNullDb));
  check('private fields stay out of the tool result', !('baseUndoUid' in shoot.value) && !('slotId' in shoot.value.candidates[0]));
  await settle();
  const record = logic.current(session);
  check('second client sees the record', record?.status === 'ready' && record.candidates.length === 3);
  check('candidates use the last free slots', record.candidates.map((c) => c.slotId).join() === 'effect_5,effect_6,effect_7', record.candidates.map((c) => c.slotId).join());
  const inNow = () => Promise.all(record.candidates.map((c) => logic.isCandidateIn(judge, track.effects.byId(c.slotId))));
  check('every candidate is out, so it starts as it was', (await inNow()).every((v) => v === false), (await inNow()).join(','));
  check('trim unchanged while on the original', Math.abs((await trim()) - baseline.trim) < 0.01);

  const beforeListen = await logic.undoUid(judge, session);
  check('undo position as expected', beforeListen === record.expectedUndoUid);
  for (const c of record.candidates) {
    await logic.listen(judge, session, c.key);
    await settle();
    const states = await inNow();
    const on = record.candidates.filter((_, i) => states[i]).map((x) => x.key);
    const heard = await trim();
    check(`hearing ${c.key}: only it is in, level matched`, on.join() === c.key && Math.abs(heard - (baseline.trim + c.trimDb)) < 0.06, `in=${on} trim=${heard.toFixed(2)} want ${baseline.trim + c.trimDb}`);
  }
  await logic.listen(judge, session, '0');
  await settle();
  check('listening leaves undo alone', (await logic.undoUid(judge, session)) === beforeListen);

  await logic.loop(session);
  await settle();
  check('loop rolls on the section', session.transport.looping.value === true && session.transport.loopStart.value === record.section.startTick && session.transport.playing.value === true);
  check('looping leaves undo alone', (await logic.undoUid(judge, session)) === beforeListen, `${await logic.undoUid(judge, session)} vs ${beforeListen}`);
  await session.transport.stop();
  await settle();

  const off = await call('finish_shootout', { action: 'cancel' });
  await settle();
  check('cancel: back to the undo position', (await logic.undoUid(judge, session)) === baseline.uid, `rewound=${off.value.rewound}`);
  check('cancel: inserts back', inserts() === baseline.inserts, inserts());
  check('cancel: trim back', Math.abs((await trim()) - baseline.trim) < 0.01);
  check('cancel: loop back', session.transport.looping.value === baseline.loop[0] && near(session.transport.loopStart.value, baseline.loop[1]) && near(session.transport.loopStop.value, baseline.loop[2]), JSON.stringify([session.transport.looping.value, session.transport.loopStart.value, session.transport.loopStop.value]));

  // Round two: keep one, and count what it leaves.
  const again = await call('shootout', { track: trackName, startBar: Number(startBar), endBar: Number(endBar), role: 'lead vocal', problem: 'live check keep', candidates: candidates.slice(0, 2) });
  await settle();
  const key = logic.current(session).candidates.find((c) => c.pluginId === 'uaudio_ua_1176ln_rev_e').key;
  await logic.listen(judge, session, key);
  await settle();
  const heardTrim = await trim();
  const kept = await call('finish_shootout', { action: 'keep', candidate: key });
  await settle();
  check('keep: one plugin on the track, in', inserts().split(',').filter((x) => x === 'uaudio_ua_1176ln_rev_e').length === 1 && !inserts().includes('la-2a'), inserts());
  const keptSlot = track.effects.items.find((s) => s.pluginId.value === 'uaudio_ua_1176ln_rev_e');
  check('keep: the plugin is in', (await logic.isCandidateIn(judge, keptSlot)) === true);
  check('keep: it lands in the first free slot', keptSlot?.id === 'effect_0', keptSlot?.id);
  // The real test of Keep: printed again, the kept plugin must sound like the candidate did.
  {
    const dir = mkdtempSync(join(tmpdir(), 'spark-kept-'));
    const timeline = session.musical.timeline;
    const loopNow = await logic.captureLoop(judge, session);
    await logic.wait(400);
    const file = join(dir, 'kept.wav');
    const { render } = await session.bounce({ channelUids: [track.id], range: { startTick: timeline.tickAtBar(Number(startBar)), stopTick: timeline.tickAtBar(Number(endBar)) }, outputPaths: [file], recordPoint: 'post_effects', name: 'Spark MCP check' });
    await render.done();
    await judge.raw.post('/renders/delete', { uid: render.id }).catch(() => {});
    await logic.restoreLoop(session, { loopBefore: loopNow });
    const keptPrint = measure(readWav(file));
    const wanted = again.value.candidates.find((c) => c.pluginId === 'uaudio_ua_1176ln_rev_e');
    check('keep: prints the same as the candidate did', Math.abs(keptPrint.lufs - wanted.measured.lufs) <= 0.3 && Math.abs(keptPrint.crestDb - wanted.measured.crestDb) <= 0.5, `${keptPrint.lufs} vs ${wanted.measured.lufs} LUFS, crest ${keptPrint.crestDb} vs ${wanted.measured.crestDb}`);
    rmSync(dir, { recursive: true, force: true });
  }
  const keptTrim = await trim();
  check('keep: level as heard', Math.abs(keptTrim - heardTrim) < 0.06 && Math.abs(heardTrim - baseline.trim) > 0.05, `${keptTrim} vs ${heardTrim}, rewound=${kept.value.rewound}`);
  const history = logic.prefs(session).value('history', 'events').value ?? [];
  check('keep: taste event recorded', history.at(-1)?.kept.pluginId === 'uaudio_ua_1176ln_rev_e' && history.at(-1)?.blind === true);
  const taste = await call('taste', { role: 'lead vocal' });
  check('taste reads the pick', taste.value.plugins.some((p) => p.pluginId === 'uaudio_ua_1176ln_rev_e' && p.pickedBlind >= 1));

  let undos = 0;
  while ((await logic.undoUid(judge, session)) !== baseline.uid && undos < 12) { await session.undo(); await logic.wait(250); undos++; }
  await settle();
  console.log(`keep took ${undos} undo steps to reverse`);
  check('keep undoes cleanly', inserts() === baseline.inserts && Math.abs((await trim()) - baseline.trim) < 0.01);

  // Round three: keep one that has a preset.
  const third = await call('shootout', { track: trackName, startBar: Number(startBar), endBar: Number(endBar), role: 'lead vocal', problem: 'live check preset', candidates: candidates.slice(0, 2) });
  await settle();
  const presetWanted = logic.current(session).candidates.find((c) => c.presetName);
  const presetKey = presetWanted.key;
  await logic.listen(judge, session, presetKey);
  await settle();
  await call('finish_shootout', { action: 'keep', candidate: presetKey });
  await settle();
  const presetSlot = track.effects.items.find((s) => s.pluginId.value === presetWanted.pluginId);
  check('keep with a preset: the preset is on it', presetSlot?.presetName.value === presetWanted.presetName, String(presetSlot?.presetName.value));
  let presetUndos = 0;
  while ((await logic.undoUid(judge, session)) !== baseline.uid && presetUndos < 12) { await session.undo(); await logic.wait(250); presetUndos++; }
  await settle();
  console.log(`keep with a preset took ${presetUndos} undo steps to reverse`);
  check('keep with a preset undoes cleanly', inserts() === baseline.inserts);
  const plain = await plainLoads();
  console.log('   plain loads', JSON.stringify(plain));
  for (const plugin of plainPlugins) {
    check(`after every keep and undo, the first slot still loads ${plugin} like an untouched one`, Math.abs(plain[`effect_1/${plugin}`] - plain[`effect_4/${plugin}`]) <= 0.15, `${plain[`effect_1/${plugin}`]} vs ${plain[`effect_4/${plugin}`]}`);
  }
} catch (error) {
  check('run finished', false, error.message);
} finally {
  await client.close().catch(() => {});
  const open = logic.current(session);
  if (logic.isOpen(open)) await logic.cancel(judge, session).catch((e) => console.log('cleanup cancel failed', e.message));
  let n = 0;
  while ((await logic.undoUid(judge, session)) !== baseline.uid && n++ < 40) { await session.undo(); await logic.wait(250); }
  await logic.setTrim(judge, track, baseline.trim);
  await logic.saveCurrent(session, null);
  await logic.prefs(session).set('history', 'events', historyBefore);
  await session.transport.looping.set(baseline.loop[0]);
  await session.transport.seek(baseline.playStart);
  rmSync(tasteDir, { recursive: true, force: true });
  rmSync(plainDir, { recursive: true, force: true });
  await logic.wait(300);
  await session.sources.reload?.();
  check('check track as found', inserts() === baseline.inserts && (await logic.undoUid(judge, session)) === baseline.uid, inserts());
  const renders = await judge.raw.get('/renders', { children: true, levels: 1, commands: false, flatvalue: true, propfilter: ['name'] });
  check('no renders left behind', (renders.children ?? []).length === 0, String((renders.children ?? []).length));
  check('no new sources', session.sources.items.length === baseline.sources, `${baseline.sources} -> ${session.sources.items.length}`);
  await logic.undoTo(judge, session, outerUid);
  await logic.wait(400);
  await logic.restoreLoop(session, { loopBefore: outerLoop });
  await logic.wait(300);
  check('session as found', (await logic.undoUid(judge, session)) === outerUid && session.visibleTracks.length === trackCount, `${trackCount} -> ${session.visibleTracks.length} tracks`);
  await judge.close();
  console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
  process.exit(failed ? 1 : 0);
}
