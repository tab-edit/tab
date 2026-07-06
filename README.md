# @tab-edit/cm

**The complete tablature editing system for CodeMirror 6.** Live incremental parsing
with reuse, a semantic layer (instruments, pitch, exact rational time, techniques),
lint with one-click fixes, column-selection queries, and MusicXML/MIDI export — as
one extension.

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

- **One parse, two consumers**: CodeMirror gets the base Lezer tree (native syntax
  highlighting, folding), the semantic TabTree rides along — zero double work.
- **Lint fixes are actions**: "Name this line 'D'" injects the text, reparses
  incrementally, diagnostic clears — all through CM's normal transaction flow, undoable.
- **Column selections are first-class**: rectangular selections (one range per line)
  map straight to chords/sounds via `selectedNodes(state, "Sound")`.
- **Edits carry**: editing one section reuses every other section's parse artifacts
  BY IDENTITY and its semantic values through proven carry gates (no stale state,
  by theorem — see the workspace ADRs).

Headless-tested against real `@codemirror/state`/`@codemirror/language` machinery.
