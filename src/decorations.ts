// Semantic decorations (ADR-001 App-A: token coloring is the BASE tree's
// styleTags job; SEMANTIC styling is the decoration domain). v1 ships the
// chord highlighter: the Sound under the main cursor lights up on EVERY
// line it touches — multi-range semantic nodes made visible.

import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { EditorState, Extension } from "@codemirror/state";
import { directiveEntries } from "@tab-edit/plugins";
import { tabTree } from "./language.js";
import { readTabProp } from "./state-layer.js";

/** Pure core (headless-testable): ranges of the Sound at the main cursor. */
export function soundRangesAtCursor(state: EditorState): { from: number; to: number }[] {
  const tree = tabTree(state);
  if (!tree) return [];
  const head = state.selection.main.head;
  const sound = tree.nodesInRanges([{ from: head, to: head }], "Sound")[0];
  if (!sound) return [];
  return Array.from({ length: sound.rangeCount }, (_, i) => ({
    from: sound.rangeFrom(i),
    to: sound.rangeTo(i),
  }));
}

const soundMark = Decoration.mark({ class: "cm-tabSound" });

const soundHighlightPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = this.build(view.state);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = this.build(update.state);
      }
    }

    private build(state: EditorState): DecorationSet {
      return Decoration.set(
        soundRangesAtCursor(state)
          .filter((r) => r.to > r.from)
          .map((r) => soundMark.range(r.from, r.to))
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

/** Pure core (headless-testable): the Sounds and Measures intersecting the
 *  CURRENT selection, one range per (node × line it spans). Empty when the
 *  selection is a plain caret (no non-empty range) — this is a SELECTION
 *  highlighter, distinct from the cursor-driven chord highlighter above. */
export function selectedNodeHighlightRanges(
  state: EditorState
): { from: number; to: number; cls: string }[] {
  const tree = tabTree(state);
  if (!tree) return [];
  const ranges = state.selection.ranges;
  if (!ranges.some((r) => !r.empty)) return [];
  const spans = ranges.map((r) => ({ from: r.from, to: r.to }));

  const out: { from: number; to: number; cls: string }[] = [];
  for (const [type, cls] of [
    ["Sound", "cm-tab-selected-sound"],
    ["Measure", "cm-tab-selected-measure"],
  ] as const) {
    for (const node of tree.nodesInRanges(spans, type)) {
      for (let i = 0; i < node.rangeCount; i++) {
        out.push({ from: node.rangeFrom(i), to: node.rangeTo(i), cls });
      }
    }
  }
  return out;
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
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = this.build(update.state);
      }
    }

    private build(state: EditorState): DecorationSet {
      return Decoration.set(
        selectedNodeHighlightRanges(state)
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

/** Pure core (headless-testable): absolute spans of every recognized
 *  directive (key start → value end), read from the directiveEntries
 *  evidence prop — the adapter never re-derives parsing. */
export function directiveAnnotationRanges(
  state: EditorState
): { from: number; to: number; key: string; value: string }[] {
  const tree = tabTree(state);
  if (!tree) return [];
  const top = tree.topNode;
  const out: { from: number; to: number; key: string; value: string }[] = [];
  for (const node of [...top.getChildren("Section"), ...top.getChildren("Comment")]) {
    const base = node.rangeFrom(0);
    for (const e of readTabProp(state, directiveEntries, node)) {
      out.push({ from: base + e.from, to: base + e.to, key: e.key, value: e.value });
    }
  }
  return out.sort((a, b) => a.from - b.from);
}

const directiveAnnotationPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = this.build(view.state);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = this.build(update.state);
      }
    }

    private build(state: EditorState): DecorationSet {
      return Decoration.set(
        directiveAnnotationRanges(state)
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
