// ADR-003 M-R0 — the protocol-shaped semantic surface. Between keystrokes
// the UI renders a SemanticSnapshot: passive, serializable VALUE data
// (exactly what crosses the wire in M-R1 — no TabNode, no engine objects).
// This module is the home of BOTH sides of that boundary:
//   producers — the pure tree-reading cores + computeSnapshot/snapshotOf
//   (LOCAL, in-process engine reads; in M-R1 the session host runs the
//   same shape server-side and streams the result), and
//   resolvers — pure data functions answering cursor/selection questions
//   from snapshot data alone, so a remote client resolves at 0 ms without
//   a tree. Their range algebra replicates TabTree.nodesInRanges
//   (ast core/tree.ts) — keep the two in lockstep.

import type { EditorState } from "@codemirror/state";
import type { TabTree } from "@tab-edit/ast";
import { blockKind, directiveEntries, segmentKind } from "@tab-edit/plugins";
import { tabTree } from "./language.js";
import { readTabProp, tabStateDiagnostics } from "./state-layer.js";
import type { NodeRanges, SemanticSnapshot } from "./snapshot-model.js";

// The value model + resolvers + snapshotSource seam live in
// snapshot-model.ts (pure, engine-free — the slim client entry's half);
// re-exported here so the fat surface is unchanged.
export {
  selectionHighlightsAt,
  snapshotOf,
  snapshotSource,
  soundRangesAt,
} from "./snapshot-model.js";
export type {
  DirectiveSpan,
  NodeRanges,
  SemanticSnapshot,
  SnapshotRange,
  SnapshotSource,
} from "./snapshot-model.js";

// ─── Producers (LOCAL: in-process engine reads) ──────────────────────────

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

/** Pure core (headless-testable): line starts that should render RECEDED
 *  (.cm-tabProse): lines of prose-kind blocks, whole prose sections
 *  (covers ownerless skipped rows), and #-comment lines. Music untouched;
 *  DIRECTIVE blocks stay full strength — they are load-bearing config.
 *  Driven by the CLAIM verdicts (blockKind/segmentKind), so a pack that
 *  re-claims a block — or the user's `kind:` escape hatch — restyles it
 *  automatically: plugin-level presentation via the claims algebra. */
export function recededLineStarts(state: EditorState): number[] {
  const tree = tabTree(state);
  if (!tree) return [];
  const doc = state.doc;
  const starts = new Set<number>();
  const addSpan = (from: number, to: number): void => {
    let pos = Math.min(from, doc.length);
    // Node ranges include the trailing newline — treat `to` as EXCLUSIVE
    // of the line that merely STARTS there (found-by-test: the section
    // ending at 18 dimmed the music line beginning at 18).
    const end = Math.min(to, doc.length);
    while (pos < end) {
      const line = doc.lineAt(pos);
      starts.add(line.from);
      if (line.to >= end) break;
      pos = line.to + 1;
    }
  };
  for (const section of tree.topNode.getChildren("Section")) {
    if (readTabProp(state, segmentKind, section) === "prose") {
      addSpan(section.rangeFrom(0), section.rangeTo(section.rangeCount - 1));
      continue;
    }
    for (const block of section.getChildren("Block")) {
      if (readTabProp(state, blockKind, block) !== "prose") continue;
      for (let i = 0; i < block.rangeCount; i++) {
        addSpan(block.rangeFrom(i), block.rangeTo(i));
      }
    }
  }
  for (const comment of tree.topNode.getChildren("Comment")) {
    addSpan(comment.rangeFrom(0), comment.rangeTo(comment.rangeCount - 1));
  }
  // A line the system RECOGNIZED as a directive never recedes — it is
  // load-bearing config even when its block reads prose (the tokenizer
  // splits bare "Title: Demo Song" lines into prose fragments; the
  // directive-entry scan still sees the whole line). Keeps the dotted
  // underline and full strength consistent with each other.
  for (const r of directiveAnnotationRanges(state)) {
    starts.delete(doc.lineAt(r.from).from);
  }
  return [...starts].sort((a, b) => a - b);
}

/** The local snapshot producer: one engine pass over the state's current
 *  TabTree (null while no tree exists yet). In M-R1 the session host runs
 *  this same shape server-side and streams the result. */
export function computeSnapshot(state: EditorState): SemanticSnapshot | null {
  const tree = tabTree(state);
  if (!tree) return null;
  const whole = [{ from: 0, to: state.doc.length }];
  const rangesOf = (type: string): NodeRanges[] =>
    tree.nodesInRanges(whole, type).map((node) => ({
      ranges: Array.from({ length: node.rangeCount }, (_, i) => ({
        from: node.rangeFrom(i),
        to: node.rangeTo(i),
      })),
    }));
  return {
    sounds: rangesOf("Sound"),
    measures: rangesOf("Measure"),
    directives: directiveAnnotationRanges(state),
    recededLineStarts: recededLineStarts(state),
    diagnostics: tabStateDiagnostics(state),
  };
}

/** Snapshot rides the tree the way the TabTree rides the base tree: one
 *  compute per tree, cached by identity. Selection/viewport updates hit the
 *  cache; a reparse (new tree) recomputes lazily on first read. This is the
 *  LOCAL SemanticsClient — tablature() installs it as the snapshotSource. */
const snapshots = new WeakMap<TabTree, SemanticSnapshot>();
export function localSnapshotOf(state: EditorState): SemanticSnapshot | null {
  const tree = tabTree(state);
  if (!tree) return null;
  const cached = snapshots.get(tree);
  if (cached) return cached;
  const snap = computeSnapshot(state)!;
  snapshots.set(tree, snap);
  return snap;
}
