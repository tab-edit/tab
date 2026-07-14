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

## Theming (theme packs)

The editor's look is data. A theme pack is a `TabThemeSpec` — one flat record of
this editor's semantic color slots (`fret`, `lineName`, `technique`, `lattice`,
`prose`, …) — compiled by `tabTheme()` into a CM extension:

```ts
import { tabTheme, tablature, type TabThemeSpec } from "@tab-edit/cm";

const midnight: TabThemeSpec = {
  dark: true,
  colors: {
    lattice: "#6a7280", fret: "#bfd3ee", lineName: "#9fb3ba",
    technique: "#c2a884", embellishment: "#afa8c9", modifier: "#c2a884",
    scaffold: "#868d99", comment: "#7d8590", prose: "#7d8590",
    directiveUnderline: "#5b9dfa73", directiveText: "#d7dbe0",
  },
};

new EditorView({ extensions: [basicSetup, tablature({ theme: tabTheme(midnight) })] });
```

Publish the spec (or the compiled extension) as an npm package and it installs like
any VS Code theme. Two design rules the defaults encode: ~70% of tab characters are
dash/barline **lattice**, so the theme dims untagged content and lets tagged tokens
carry brightness (notes pop by contrast, not by rainbow); and hue stays desaturated
so the editor matches restrained host UIs.

**No-JS channel**: every slot is also a CSS variable — hosts can retheme with plain
CSS, no code:

```css
.cm-editor { --tabedit-fret: #ffd9a0; --tabedit-lattice: #5f6672; }
```

Headless-tested against real `@codemirror/state`/`@codemirror/language` machinery.
