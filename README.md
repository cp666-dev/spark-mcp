# Spark MCP

A LUNA panel for picking plugins by ear. Tell it what a track needs, like "make these drums more explosive", and it prints your track through three UADx plugins you own, sets the compressors to work equally hard, level matches them and lets you flip between them blind. Keep the one you like and it lands on the track sounding the way you heard it.

It also runs as an MCP server, so Claude Code or any other MCP agent can set up the same shootouts.

## What you need

- LUNA 3.1.2 or later, on macOS
- Some UADx plugins. It only ever offers plugins you have installed and licensed.
- An API key from Anthropic or OpenAI, or a model server on your own computer, such as Ollama or LM Studio

## Install

Install Spark MCP from LUNA's Add On showcase. Or download `Spark-MCP.lunaaddon` from the [latest release](https://github.com/cp666-dev/spark-mcp/releases/latest) and double-click it.

1. Open a session, then **Add Ons > Browsers > Spark MCP**. It opens in the panel beside the Timeline.
2. LUNA asks to let Spark MCP reach `api.anthropic.com` and `api.openai.com`. Allow the one you use. You can change this later in **Settings > Add Ons > Servers**.
3. Click the gear, pick Claude or OpenAI and paste your key. It's kept in your keychain.

## Use it

1. Click a track and loop or select a few bars where it plays. The panel shows both at the top.
2. Type what it needs in the box at the bottom and press Return.
3. When the candidates are ready, click the panel, press `L` to loop, and switch with the number keys.
4. Press Return to keep the one you're hearing, or Esc to put the track back. You can also type "heavier" or "try something else" for a new round.

| Key | Does |
|---|---|
| `0` | Hear the track as it was |
| `1` `2` `3` | Hear a candidate, level matched |
| `L` | Loop the section |
| `B` | Show or hide the names |
| Return | Keep the one you're hearing |
| Esc | Put the track back, or stop the assistant while it works |

A few things to know:

- **Switching dips for a moment.** The track fades out for a fraction of a second, switches and fades back in. Switching instantly clicked.
- **Keep and Esc stop playback** while plugins go on or come off, so nothing glitches mid-loop.
- **Compressors are set to work equally hard**, 2 to 4 dB for a gentle request and up to about 10 dB for "slammed". Other plugins run on the preset the assistant picked.
- **Levels are matched on the track's Volume Trim**, which LUNA limits to +12 dB.
- **Showing the names** means that pick no longer counts as blind in your taste record.

## Privacy

Your requests and the measurements Spark takes go to the model provider you choose, and your audio never leaves your computer. Prints are written to `/tmp` as `spark-mcp-*`, and macOS clears them.

## The MCP server

For using Spark from Claude Code or another MCP agent. Needs Node 22 or later.

```sh
npm install
claude mcp add spark-mcp -- "$PWD/server/start.sh"
```

Then open the Spark MCP panel in LUNA and ask your agent for a shootout. You listen and choose in the panel as usual. The server's tools:

| Tool | Does |
|---|---|
| `session_brief` | Tracks, inserts, free slots, markers, tempo, loop. |
| `find_plugins` | UADx effects you have installed and licensed, with presets and tags. |
| `analyze` | Prints a track and the rest of the mix to temporary files and measures them. Adds nothing to the session. |
| `shootout` | Loads up to three candidates, prints each alone, and opens them in the panel. |
| `shootout_status` | Where the shootout stands. While it's blind, results don't say which number is which. |
| `finish_shootout` | Keeps one or calls it off, when you say so. |
| `taste` | What you've picked, per role and plugin, with blind picks counted apart. |

## Developing

| File | Purpose |
|---|---|
| `logic.js` | The shootout's state and moves, including the fades. Shared by the panel and the server. |
| `audio.js` | Loudness (BS.1770), peak, crest, correlation, bands, masking, gain reduction. Shared. |
| `engine.js` | Printing and measuring a shootout, given an `io` for files. Shared. |
| `tools.js` | The seven tools an agent has. Shared. |
| `assistant.js` | The panel's `io` and what it tells the model. |
| `providers.js`, `agent.js` | The model adapters and the conversation loop. |
| `main.js`, `ui/` | The panel. |
| `server/` | The MCP server. `luna.mjs` loads the SDK from `vendor/`, so nothing else is needed. |
| `vendor/` | The LUNA Builder SDK 3.1.2.74 bundle, with its license. |
| `tests/` | Unit tests, the live check, and `preview.html`, which shows every panel state. |

```sh
npm install
npm test
```

`npm test` doesn't need LUNA. The live check does, with a session you don't mind changing and a track that has audio in the bars you name. It works on a temporary copy of that track's first clip, removes the copy with undo afterwards, and never saves.

```sh
node tests/live-shootout.mjs Drums 17 21
```

To package for LUNA, leave out the server, which a `.lunaaddon` can't run:

```sh
rsync -a --exclude server --exclude node_modules ./ /tmp/spark-pack/
node "<LUNA Builder SDK>/dist/cli.js" pack /tmp/spark-pack --out Spark-MCP.lunaaddon
```

## What LUNA does that shaped this

Measured on LUNA 3.1.1 and 3.1.2, by printing and reading the files.

- **Switching mid-playback clicks.** On a steady test tone, switching instantly gave clicks up to 33 dB over the tone. Fading the trim out over about 30 ms, switching, waiting 60 ms and fading back in left nothing over 12 dB.
- **Printing is clean and fast.** A 12-second section takes about 0.6 s offline. With `outputPaths`, a print adds no undo entry and no source. It does move the loop marks, so they're read first and put back.
- **`undo_uid` is an exact restore point.** Undo steps back to it precisely.
- **Listening writes no undo.** A write to `normalized_value` or `real_value` with no touch changes the sound and adds no undo entry. These writes don't reach the SDK's cached props, so `readControl` asks the engine.
- **`slot.in` reads backwards on UADx.** It says false while power is on, so the bypass control and its polarity come from the plugin's manifest.
- **A slot remembers control values by id across loads.** A plugin can inherit them, so `loadCandidate` resets every parameter to its default first. A preset asked for in `setPlugin` printed dry, so the preset loads after the reset with `loadPreset`.
- **Some rewinds leave the next plain load in a slot printing dry.** That happened after a plugin was switched off, after a preset was asked for in `setPlugin`, and after a clear and reload. `readyToRewind` switches each candidate on, and that rewinds cleanly. Candidates audition in the last free slots, and Keep loads the winner into the first free slot.
- **Keep takes two undo steps, or three with a preset.** LUNA records a plugin load on its own, outside any transaction.
- **A long decimal in session storage makes the write look like it failed**, because LUNA stores it with different rounding. `storable` rounds to six places.
- **LUNA's render dialog can stay up after a print and block playback.** `print` holds it back with `add_progress_suppression` and deletes each finished render. The panel shows progress instead.
- **A print after the fader obeys solo**, so `analyze` prints before the fader and applies the fader's level itself.
- **Compressor presets assume a hot signal.** On a quiet track, two candidates did nothing but add make-up gain. Spark measures real gain reduction and moves each compressor's input or threshold until it's working as hard as asked.

## License

MIT, see `LICENSE`. The LUNA Builder SDK bundle in `vendor/` is Universal Audio's, under the Apache License 2.0 (`vendor/LICENSE`, `vendor/NOTICE`).
