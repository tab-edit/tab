# @tab-edit/cm

**The complete tablature editing system for CodeMirror 6.** Live incremental parsing
with reuse, a semantic layer (instruments, pitch, exact rational time, techniques),
lint with one-click fixes, column selections that map to chords, audio playback,
live sheet-music preview, and MusicXML/MIDI export — as one extension.

```ts
import { basicSetup, EditorView } from "codemirror";
import { tablature, musicXml, midiFile, midiOfSelection } from "@tab-edit/cm";

const view = new EditorView({
  doc: "e|--0--2--|\nB|3--------|\n…",
  extensions: [basicSetup, tablature()],
});

musicXml(view.state);        // → MusicXML 4.0 string (open in MuseScore)
midiFile(view.state);        // → playable format-0 SMF bytes
midiOfSelection(view.state); // → events for the (column) selection
```

## See it: the demo app

```bash
npm install && npm run demo
```

A full editor with a live **sheet pane** (OpenSheetMusicDisplay rendering
`musicXml(state)` as you type), selection-aware **playback** with a score-following
cursor, an **inspector** (per-node semantic values and why they computed), lint
diagnostics with working fix buttons, sample tabs, and export downloads. It is also
the verification harness: `npm run verify:demo` drives it with Playwright.

## How it works

- **One parse, two consumers**: CodeMirror gets the base Lezer tree (native syntax
  highlighting, folding), the semantic `TabTree` rides along — zero double work.
- **Edits carry**: editing one section reuses every other section's parse artifacts
  by identity and its semantic values through proven carry gates — no stale
  state, ever.
- **Everything renders snapshots**: decorations and lint read plain-data
  `SemanticSnapshot` values, not the engine — which is what makes remote mode
  (below) a one-line swap.
- **Lint fixes are actions**: "Name this line 'D'" injects the text, reparses
  incrementally, diagnostic clears — all through CM's normal transaction flow, undoable.
- **Column selections are first-class**: rectangular selections (one range per line)
  map straight to chords/sounds via `selectedNodes(state, "Sound")`.

## Remote mode

The same editor can run with the semantic engine on a server instead of in the
bundle: `remoteSemantics()` installs a `RemoteClient` that streams your edits to a
per-document session (see the [remote repo](https://github.com/tab-edit/remote)) and
feeds every decoration/lint/export surface from wire snapshots. Typing stays 100%
local. Try it: start the remote repo's dev server, then open the demo with
`?remote=ws://localhost:8787`. `npm run verify:remote` runs the browser→WebSocket→
session E2E.

## Theming

The editor's look is data: a theme pack is one flat `TabThemeSpec` record of semantic
color slots, compiled by `tabTheme()` into a CM extension —

```ts
import { tabTheme, tablature, type TabThemeSpec } from "@tab-edit/cm";
const midnight: TabThemeSpec = { dark: true, colors: { fret: "#bfd3ee", lattice: "#6a7280", /* … */ } };
new EditorView({ extensions: [basicSetup, tablature({ theme: tabTheme(midnight) })] });
```

Every slot doubles as a CSS variable (`--tabedit-fret`, …) so hosts can retheme with
plain CSS, no code. The defaults dim the ~70% of tab characters that are dash/barline
lattice so notes pop by contrast, not by rainbow. Full slot list: `src/highlight.ts`.

## Developing

```bash
npm run type-check && npm test   # headless suites on real CM machinery
npm run verify:demo              # Playwright over the running demo
npm run bump:engine              # pull pushed engine changes (git deps @ main)
```

Engine repos install from GitHub `@ main` — local changes to `parse`/`ast`/`plugins`
reach this repo only when pushed.

## Where to jump

- **[CLAUDE.md](CLAUDE.md)** — the source-file map (which file owns decorations,
  lint, remote, exports) plus commands and critical facts.
- **The demo source** ([demo/main.ts](demo/main.ts)) — a complete, real integration
  to crib from.
- **`tests/`** — headless suites on real CodeMirror machinery; the remote suite
  doubles as the protocol's client-side behavioral spec.
