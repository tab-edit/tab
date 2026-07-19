// The wire-value model, the 0 ms resolvers, and the SemanticsClient seam —
// the PURE half of the M-R0 semantics module, deliberately free of engine
// imports. This module + remote.ts (+ the base grammar) is everything the
// ENGINE-FREE client entry (client.ts) needs to render semantics; the
// producers (local engine reads) live in semantics.ts, which only the fat
// entry pulls in. The bundle-audit test pins that split.

import { Facet, type EditorState } from "@codemirror/state";
import type { DiagnosticJSON } from "@tab-edit/protocol";

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

/** The whole-document overlay frame. Diagnostics use the PROTOCOL shape —
 *  the engine's Diagnostic is structurally identical (the differential
 *  suites pin that), so local producers assign without conversion. */
export interface SemanticSnapshot {
  /** Every Sound's range set, pre-order — the sound map (ADR-003 §4). */
  readonly sounds: readonly NodeRanges[];
  /** Every Measure's range set, pre-order. */
  readonly measures: readonly NodeRanges[];
  readonly directives: readonly DirectiveSpan[];
  readonly recededLineStarts: readonly number[];
  readonly diagnostics: readonly DiagnosticJSON[];
}

/** Where snapshots come from — the SemanticsClient seam (ADR-003).
 *  tablature() installs the local engine's producer at DEFAULT precedence;
 *  remoteSemantics() installs the wire-fed store at Prec.highest, so the
 *  highest-precedence source (facet inputs sort precedence-first) wins
 *  deterministically wherever the extensions sit in the tree — flatten
 *  ORDER is not a contract (found-by-storm: the local source outranked
 *  the remote store by position, silently serving the editor's own
 *  incremental parse). Removing the remote extension (live toggle) falls
 *  straight back to the local source in the same reconfigure. */
export type SnapshotSource = (state: EditorState) => SemanticSnapshot | null;
export const snapshotSource = Facet.define<SnapshotSource, SnapshotSource | null>({
  combine: (sources) => (sources.length ? sources[0] : null),
});

export function snapshotOf(state: EditorState): SemanticSnapshot | null {
  const source = state.facet(snapshotSource);
  return source ? source(state) : null;
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
