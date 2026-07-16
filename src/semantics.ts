// ADR-003 M-R0 — the protocol-shaped semantic surface. Between keystrokes
// the UI renders a SemanticSnapshot: passive, serializable VALUE data
// (exactly what crosses the wire in M-R1 — no TabNode, no engine objects).
// computeSnapshot is the LOCAL producer (in-process engine reads); the pure
// resolvers below answer cursor/selection questions from snapshot data
// alone, so a remote client resolves at 0 ms without a tree. Their range
// algebra replicates TabTree.nodesInRanges (ast core/tree.ts) — keep the
// two in lockstep.

import type { EditorState } from "@codemirror/state";
import type { Diagnostic } from "@tab-edit/ast";
import {
  directiveAnnotationRanges,
  recededLineStarts,
} from "./decorations.js";
import { tabTree } from "./language.js";
import { tabStateDiagnostics } from "./state-layer.js";

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
