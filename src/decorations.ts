// Semantic decorations (ADR-001 App-A: token coloring is the BASE tree's
// styleTags job; SEMANTIC styling is the decoration domain). v1 ships the
// chord highlighter: the Sound under the main cursor lights up on EVERY
// line it touches — multi-range semantic nodes made visible.

import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { EditorState, Extension } from "@codemirror/state";
import { tabTree } from "./language.js";

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
