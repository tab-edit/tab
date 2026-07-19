// Semantic decorations (ADR-001 App-A: token coloring is the BASE tree's
// styleTags job; SEMANTIC styling is the decoration domain). Since ADR-003
// M-R0 every plugin here renders from SNAPSHOT DATA (semantics.ts) — the
// build() bodies never touch the tree or the engine, which is exactly what
// lets M-R1 swap the snapshot's origin for the wire. Each plugin also
// rebuilds when the SNAPSHOT identity changes (a reparse finishing without
// a doc/selection/viewport change used to leave stale decorations until the
// next trigger — the snapshot check closes that latent gap).

import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { EditorState, Extension } from "@codemirror/state";
import {
  selectionHighlightsAt,
  snapshotOf,
  soundRangesAt,
} from "./snapshot-model.js";

const snapshotChanged = (update: ViewUpdate): boolean =>
  snapshotOf(update.state) !== snapshotOf(update.startState);

const soundMark = Decoration.mark({ class: "cm-tabSound" });

const soundHighlightPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = this.build(view.state);
    }

    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged ||
        snapshotChanged(update)
      ) {
        this.decorations = this.build(update.state);
      }
    }

    private build(state: EditorState): DecorationSet {
      const snap = snapshotOf(state);
      const ranges = snap ? soundRangesAt(snap, state.selection.main.head) : [];
      return Decoration.set(
        ranges.filter((r) => r.to > r.from).map((r) => soundMark.range(r.from, r.to))
      );
    }
  },
  { decorations: (v) => v.decorations }
);

const soundHighlightTheme = EditorView.baseTheme({
  ".cm-tabSound": { backgroundColor: "#ffd54f55", outline: "1px solid #ffb30088" },
});

/** Chord highlighter extension for `tablature()`. */
export function soundHighlight(): Extension {
  return [soundHighlightPlugin, soundHighlightTheme];
}

const selectedSoundMark = Decoration.mark({ class: "cm-tab-selected-sound" });
const selectedMeasureMark = Decoration.mark({ class: "cm-tab-selected-measure" });

const selectionNodeHighlightPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = this.build(view.state);
    }

    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged ||
        snapshotChanged(update)
      ) {
        this.decorations = this.build(update.state);
      }
    }

    private build(state: EditorState): DecorationSet {
      const snap = snapshotOf(state);
      const spans = state.selection.ranges.map((r) => ({ from: r.from, to: r.to }));
      return Decoration.set(
        (snap ? selectionHighlightsAt(snap, spans) : [])
          .filter((r) => r.to > r.from)
          .map((r) =>
            (r.cls === "cm-tab-selected-sound" ? selectedSoundMark : selectedMeasureMark).range(
              r.from,
              r.to
            )
          ),
        true
      );
    }
  },
  { decorations: (v) => v.decorations }
);

const selectionNodeHighlightTheme = EditorView.baseTheme({
  ".cm-tab-selected-sound": { backgroundColor: "rgba(91, 157, 250, 0.25)" },
  ".cm-tab-selected-measure": { backgroundColor: "rgba(91, 157, 250, 0.10)" },
});

/** Selection highlighter extension for `tablature()`: lights up every Sound
 *  and Measure the current (possibly column/rectangular) selection touches. */
export function selectionNodeHighlight(): Extension {
  return [selectionNodeHighlightPlugin, selectionNodeHighlightTheme];
}

const directiveAnnotationPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = this.build(view.state);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged || snapshotChanged(update)) {
        this.decorations = this.build(update.state);
      }
    }

    private build(state: EditorState): DecorationSet {
      const snap = snapshotOf(state);
      return Decoration.set(
        (snap ? snap.directives : [])
          .filter((r) => r.to > r.from)
          .map((r) =>
            Decoration.mark({
              class: "cm-tabDirective",
              attributes: { title: `directive: ${r.key} = ${r.value}` },
            }).range(r.from, r.to)
          ),
        true
      );
    }
  },
  { decorations: (v) => v.decorations }
);

// Quiet on purpose (Stan 2026-07-14): style EXISTING characters only —
// widgets/inlays would shift visual columns, sacrilege in a column-based
// notation. A dotted underline + native hover title says "picked up:
// tempo = 120" without shouting.
const directiveAnnotationTheme = EditorView.baseTheme({
  ".cm-tabDirective": { borderBottom: "1px dotted #7f9fcf99" },
});

/** Recognized-directive annotations extension for `tablature()`. */
export function directiveAnnotations(): Extension {
  return [directiveAnnotationPlugin, directiveAnnotationTheme];
}

const prosLine = Decoration.line({ class: "cm-tabProse" });

const kindStylingPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = this.build(view.state);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged || snapshotChanged(update)) {
        this.decorations = this.build(update.state);
      }
    }

    private build(state: EditorState): DecorationSet {
      const snap = snapshotOf(state);
      return Decoration.set((snap ? snap.recededLineStarts : []).map((pos) => prosLine.range(pos)));
    }
  },
  { decorations: (v) => v.decorations }
);

// Prose recedes the way comments do in every serious editor: ONE perceptual
// move (brightness hierarchy) applied by MEANING. The single dim color also
// neutralizes token hues inside (higher specificity than highlight classes)
// — prose is literally not syntax-highlighted. No backgrounds, no italics,
// no size changes, no widgets: columns and quietness stay sacred.
const kindStylingTheme = EditorView.baseTheme({
  "&dark .cm-tabProse, &dark .cm-tabProse span": { color: "#7d8590" },
  "&light .cm-tabProse, &light .cm-tabProse span": { color: "#9ba1a8" },
});

/** Kind-driven line styling (prose recession) for `tablature()`. */
export function kindStyling(): Extension {
  return [kindStylingPlugin, kindStylingTheme];
}
