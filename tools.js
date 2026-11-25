// The tools an agent has, for the MCP server and the panel alike. Each has a JSON Schema, one line for
// a person to read while it runs, and a run(engine, input) that answers plain data.

// Classic scripts share one global scope, so each file keeps its names to itself.
(() => {
const summarize = globalThis.AddOnLogic.summarizePicks;

const bars = {
  startBar: { type: 'integer', minimum: 1, description: 'First bar of the section.' },
  endBar: { type: 'integer', minimum: 2, description: 'The bar the section stops at, as on the ruler: 17 to 25 is eight bars.' },
};

const TOOLS = [
  {
    name: 'session_brief',
    description: "The open session's tracks, inserts, free slots, markers, tempo and loop. Read only.",
    schema: { type: 'object', properties: {} },
    readOnly: true,
    describe: () => 'Reading the session',
    run: (spark) => spark.brief(),
  },
  {
    name: 'find_plugins',
    description: 'UADx effects this person has installed and authorized, with factory presets and their tags. Use these ids and preset names in shootout.',
    schema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'For example: Compressors, Equalization, Reverb, Tape, Delay, Channel Strip.' },
        search: { type: 'string', description: 'Part of a plugin name.' },
        presetSearch: { type: 'string', description: 'Keep only presets whose name contains this.' },
        limit: { type: 'integer', minimum: 1, maximum: 40 },
      },
    },
    readOnly: true,
    describe: (input) => `Looking through your ${input.category ?? 'plugins'}`,
    run: (spark, input) => spark.findPlugins(input),
  },
  {
    name: 'analyze',
    description: 'Print a track and the rest of the mix to temporary files, then measure them: loudness, peak, crest, stereo correlation, level per band, the frequencies the rest of the mix masks, and a spectrogram where the client can show one (time across, 40 Hz to 16 kHz up, lines at 100 Hz, 1 kHz and 10 kHz). Adds nothing to the session. Stops playback if it is rolling.',
    schema: { type: 'object', properties: { track: { type: 'string', description: 'Track name.' }, ...bars }, required: ['track', 'startBar', 'endBar'] },
    readOnly: false,
    describe: (input) => `Measuring ${input.track}`,
    run: (spark, input) => spark.analyze(input),
  },
  {
    name: 'shootout',
    description: 'Load up to three candidates on a track, print each one alone, measure how it changed the track against the dry print, and open them in the Spark MCP panel for blind A/B, level matched. Compressors are set to do the same amount of work (workDb) whatever the level of the track, so the comparison is fair and presets do not sit idle on a quiet track. Each result reports the work it reached. Candidates are off when this returns, so the track sounds as it did. A verdict of "quiet" means the candidate barely changed the sound: choose a preset or settings that do something. Returns each candidate\'s parameters, so you can run another shootout with better settings once this one is finished. Tell the person it is ready and let them listen, without saying anything that identifies a candidate.',
    schema: {
      type: 'object',
      properties: {
        track: { type: 'string', description: 'Track name.' },
        ...bars,
        workDb: { type: 'number', minimum: 1, maximum: 20, description: 'How hard compressors should work, in dB of gain reduction. About 2 is gentle, 4 is the default, 6 to 10 is heavy and obvious. Match what they asked for.' },
        role: { type: 'string', description: 'What the track is, like "lead vocal" or "kick". Groups the taste record.' },
        problem: { type: 'string', description: 'What they asked for, in their words.' },
        candidates: {
          type: 'array',
          minItems: 1,
          maxItems: 3,
          items: {
            type: 'object',
            properties: {
              pluginId: { type: 'string', description: 'From find_plugins.' },
              preset: { type: 'string', description: 'Preset name, from find_plugins.' },
              params: { type: 'object', description: 'Parameter id to a position from 0 to 1. A previous shootout returns where each parameter sits and what it reads.', additionalProperties: { type: 'number' } },
              why: { type: 'string', description: 'One line a person reads after the blind reveal.' },
            },
            required: ['pluginId'],
          },
        },
      },
      required: ['track', 'startBar', 'endBar', 'candidates'],
    },
    readOnly: false,
    describe: (input) => `Setting up ${input.candidates?.length ?? 'the'} candidates on ${input.track}`,
    run: (spark, input) => spark.shootout(input),
  },
  {
    name: 'shootout_status',
    description: 'Where the current shootout stands: printing, ready, kept or cancelled. Read only.',
    schema: { type: 'object', properties: {} },
    readOnly: true,
    describe: () => 'Checking the shootout',
    run: async (spark) => {
      spark.io.recordPicks(await spark.picks());
      return spark.status();
    },
  },
  {
    name: 'finish_shootout',
    description: 'Keep a candidate or call the shootout off. Only call this when the person has said so, or to replace it when they ask for something different; they can also do it in the panel. Keeping leaves the track as they heard it, including the level match.',
    schema: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['keep', 'cancel'] }, candidate: { type: 'string', enum: ['1', '2', '3'], description: 'Required for keep: the number they said.' } },
      required: ['action'],
    },
    readOnly: false,
    describe: (input) => (input.action === 'keep' ? `Keeping candidate ${input.candidate}` : 'Calling the shootout off'),
    run: async (spark, { action, candidate }) => {
      if (action === 'keep' && !candidate) throw new Error('Say which candidate to keep.');
      const record = action === 'keep' ? await spark.keep(candidate) : await spark.cancel();
      spark.io.recordPicks(await spark.picks());
      return record;
    },
  },
  {
    name: 'taste',
    description: 'What this person has picked across every session: per role and plugin, how often it was offered and picked, with blind picks counted apart. Blind picks are the strong evidence. Read only.',
    schema: { type: 'object', properties: { role: { type: 'string', description: 'Narrow to a role, like "vocal".' } } },
    readOnly: true,
    describe: () => 'Checking what you tend to pick',
    run: async (spark, { role }) => {
      spark.io.recordPicks(await spark.picks().catch(() => []));
      return summarize(spark.io.readPicks(), role);
    },
  },
];

const INSTRUCTIONS =
  'Spark MCP runs plugin shootouts in the LUNA session that is open. Measurements show what a plugin did, not whether it sounds better: the person decides by ear, in the Spark MCP panel (Add Ons > Browsers). ' +
  'Usual order: session_brief, analyze the track, read taste for what this person tends to pick, find_plugins, then shootout. After that, wait for them to listen. Only call finish_shootout when they have told you what to do. ' +
  'The panel starts blind and numbers the candidates at random, and while it is blind you are not told which number is which. Say nothing that identifies a candidate until they have chosen or asked: that would spoil the blind test and their taste record.';

/** A tool's answer, with any spectrogram apart. Some answers are lists, which must stay lists. */
function present(answer) {
  if (!answer || Array.isArray(answer) || !('spectrogram' in answer)) return { result: answer, spectrogram: null };
  const { spectrogram, ...result } = answer;
  return { result, spectrogram };
}

globalThis.SparkTools = { TOOLS, INSTRUCTIONS, summarize, present };
})();
