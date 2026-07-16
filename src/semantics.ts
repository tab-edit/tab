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
import type { Diagnostic, TabTree } from "@tab-edit/ast";
import { blockKind, directiveEntries, segmentKind } from "@tab-edit/plugins";
import { tabTree } from "./language.js";
import { readTabProp, tabStateDiagnostics } from "./state-layer.js";

export interface SnapshotRange {
  readonly from: number;
  readonly to: number;
}

/** One node's full range set (multi-range = chord Sound / multi-line
 *  Measure), in the tree's pre-order — order is part of the contract
 *  (cursor resolution returns the FIRST pre-order hit). */
export interface NodeRanges {
  readonly ranges: readonly SnapshotRange[];
}

export interface DirectiveSpan {
  readonly from: number;
  readonly to: number;
  readonly key: string;
  readonly value: string;
}

export interface SemanticSnapshot {
  /** Every Sound's range set, pre-order — the sound map (ADR-003 §4). */
  readonly sounds: readonly NodeRanges[];
  /** Every Measure's range set, pre-order. */
  readonly measures: readonly NodeRanges[];
  readonly directives: readonly DirectiveSpan[];
  readonly recededLineStarts: readonly number[];
  readonly diagnostics: readonly Diagnostic[];
}

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
 *  LOCAL SemanticsClient: consumers already render pure snapshot data, so
 *  M-R1's remote client only swaps WHERE the snapshot comes from. */
const snapshots = new WeakMap<TabTree, SemanticSnapshot>();
export function snapshotOf(state: EditorState): SemanticSnapshot | null {
  const tree = tabTree(state);
  if (!tree) return null;
  const cached = snapshots.get(tree);
  if (cached) return cached;
  const snap = computeSnapshot(state)!;
  snapshots.set(tree, snap);
  return snap;
}

// ─── Resolvers (pure data — the remote client's 0 ms half) ───────────────

// Node range [a,b) vs selection [f,t): carets probe containment; zero-width
// node ranges count when their point lies inside; otherwise plain half-open
// overlap. Verbatim TabTree.nodesInRanges (ast core/tree.ts).
const overlaps = (a: number, b: number, f: number, t: number): boolean =>
  f === t ? a <= f && f < b : a === b ? f <= a && a < t : a < t && f < b;

const nodeMatches = (
  entry: NodeRanges,
  spans: readonly { readonly from: number; readonly to: number }[]
): boolean =>
  entry.ranges.some(({ from, to }) => spans.some((s) => overlaps(from, to, s.from, s.to)));

/** Cursor→chord from snapshot data: the range set of the first (pre-order)
 *  Sound containing the caret — soundRangesAtCursor without a tree. */
export function soundRangesAt(
  snapshot: SemanticSnapshot,
  head: number
): { from: number; to: number }[] {
  const probe = [{ from: head, to: head }];
  const hit = snapshot.sounds.find((s) => nodeMatches(s, probe));
  return hit ? hit.ranges.map((r) => ({ ...r })) : [];
}

/** Selection highlights from snapshot data: every range of every Sound and
 *  Measure the selection intersects — selectedNodeHighlightRanges without a
 *  tree. Pass ALL selection ranges (carets included: they probe containment
 *  exactly as nodesInRanges treats them); a selection with no non-empty
 *  range highlights nothing, matching the live highlighter's contract. */
export function selectionHighlightsAt(
  snapshot: SemanticSnapshot,
  selection: readonly { readonly from: number; readonly to: number }[]
): { from: number; to: number; cls: string }[] {
  if (!selection.some((r) => r.to > r.from)) return [];
  const out: { from: number; to: number; cls: string }[] = [];
  for (const [entries, cls] of [
    [snapshot.sounds, "cm-tab-selected-sound"],
    [snapshot.measures, "cm-tab-selected-measure"],
  ] as const) {
    for (const entry of entries) {
      if (!nodeMatches(entry, selection)) continue;
      for (const r of entry.ranges) out.push({ from: r.from, to: r.to, cls });
    }
  }
  return out;
}
