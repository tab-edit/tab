// ADR-003 M-R0 — the snapshot model's fidelity contract. A SemanticSnapshot
// is passive value data (what will cross the wire in M-R1); these tests
// prove the snapshot RESOLVERS answer cursor/selection questions identically
// to the live tree queries — the in-process seed of ADR-003 I2 (convergence).
// The caret sweep is exhaustive: every position in the document.
import { forceParsed } from "./force-parse.js";
import { EditorSelection, EditorState } from "@codemirror/state";
import {
  computeSnapshot,
  directiveAnnotationRanges,
  recededLineStarts,
  selectedNodeHighlightRanges,
  selectionHighlightsAt,
  snapshotOf,
  soundRangesAt,
  soundRangesAtCursor,
  tabDiagnostics,
  tablature,
  tabStateDiagnostics,
} from "../src/index.js";

// Directive header + two systems (col-4 digits align across lines → a real
// multi-range chord Sound) + prose + a comment: every overlay kind present.
const WIDE = "-".repeat(48);
const SYSTEM = [
  `e|--0--2--${WIDE}|`,
  `B|--0-----${WIDE}|`,
  `G|--------${WIDE}|`,
  `D|--------${WIDE}|`,
  `A|--------${WIDE}|`,
  `E|3-------${WIDE}|`,
].join("\n");
const DOC = [
  "Tempo: 120",
  "",
  SYSTEM,
  "",
  "A lovely little melody for the snapshot suite.",
  "",
  SYSTEM,
  "",
  "# closing comment",
  "",
].join("\n");

function stateOf(doc: string, selection?: EditorSelection): EditorState {
  const state = EditorState.create({
    doc,
    ...(selection ? { selection } : {}),
    extensions: [tablature()],
  });
  return forceParsed(state);
}

test("snapshot exists once the tree does, and is pure wire-ready data", () => {
  const state = stateOf(DOC);
  const snap = computeSnapshot(state)!;
  expect(snap).not.toBeNull();
  expect(snap.sounds.length).toBeGreaterThan(0);
  expect(snap.measures.length).toBeGreaterThan(0);
  // The M-R1 seam: everything in a snapshot must survive serialization —
  // no engine objects, no functions, no cycles.
  expect(JSON.parse(JSON.stringify(snap))).toEqual(snap);
});

test("chord Sound is multi-range in the sound map (col-aligned digits)", () => {
  const snap = computeSnapshot(stateOf(DOC))!;
  expect(snap.sounds.some((s) => s.ranges.length > 1)).toBe(true);
});

test("caret resolution from the snapshot ≡ live tree query at EVERY doc position", () => {
  const s0 = stateOf(DOC);
  const snap = computeSnapshot(s0)!;
  for (let pos = 0; pos <= s0.doc.length; pos++) {
    const s = s0.update({ selection: EditorSelection.single(pos) }).state;
    expect(soundRangesAt(snap, pos)).toEqual(soundRangesAtCursor(s));
  }
});

test("selection highlights from the snapshot ≡ live tree query (windows, column, mixed)", () => {
  const s0 = stateOf(DOC);
  const snap = computeSnapshot(s0)!;
  const len = s0.doc.length;

  const selections: EditorSelection[] = [];
  for (const width of [1, 3, 9, 40]) {
    for (let from = 0; from + width <= len; from += 7) {
      selections.push(EditorSelection.single(from, from + width));
    }
  }
  // Column selection: same column span on three adjacent staff lines.
  const line3 = s0.doc.line(3); // first system's top line
  if (line3.to + 1 < len) {
    selections.push(
      EditorSelection.create(
        [1, 2, 3].map((i) => {
          const l = s0.doc.line(2 + i);
          return EditorSelection.range(l.from + 2, Math.min(l.from + 6, l.to));
        })
      )
    );
  }
  // Mixed: one real range + one caret probe (carets DO probe containment
  // inside nodesInRanges — the data resolver must copy that).
  selections.push(
    EditorSelection.create([
      EditorSelection.range(line3.from + 2, line3.from + 8),
      EditorSelection.cursor(Math.min(line3.from + 20, len)),
    ])
  );
  // All-caret selection: highlighter contract says EMPTY.
  selections.push(EditorSelection.create([EditorSelection.cursor(4), EditorSelection.cursor(9)]));

  for (const sel of selections) {
    const s = s0.update({ selection: sel }).state;
    const spans = s.selection.ranges.map((r) => ({ from: r.from, to: r.to }));
    expect(selectionHighlightsAt(snap, spans)).toEqual(selectedNodeHighlightRanges(s));
  }
});

test("snapshotOf rides the tree: cached by identity, fresh after an edit", () => {
  const s1 = stateOf(DOC);
  const snapA = snapshotOf(s1)!;
  expect(snapshotOf(s1)).toBe(snapA); // repeat read: same object
  // Selection-only update: same tree → same snapshot (no recompute).
  const s2 = s1.update({ selection: EditorSelection.single(5) }).state;
  expect(snapshotOf(s2)).toBe(snapA);
  // A real edit inside the first system: new tree → new snapshot.
  const editAt = s1.doc.line(4).from + 4;
  const s3 = forceParsed(s1.update({ changes: { from: editAt, to: editAt + 1, insert: "7" } }).state);
  const snapB = snapshotOf(s3)!;
  expect(snapB).not.toBe(snapA);
  expect(snapB).toEqual(computeSnapshot(s3));
});

test("lint source renders snapshot diagnostics (reroute is lossless)", () => {
  const state = stateOf(DOC);
  const viaSnapshot = tabDiagnostics(state).map((d) => ({
    from: d.from,
    to: d.to,
    severity: d.severity,
    message: d.message,
  }));
  const viaEngine = tabStateDiagnostics(state).map((d) => ({
    from: d.from,
    to: d.to,
    severity: d.severity,
    message: d.message,
  }));
  expect(viaSnapshot).toEqual(viaEngine);
});

test("directive/receded/diagnostic surfaces ride the snapshot unchanged", () => {
  const state = stateOf(DOC);
  const snap = computeSnapshot(state)!;
  expect(snap.directives).toEqual(directiveAnnotationRanges(state));
  expect(snap.recededLineStarts).toEqual(recededLineStarts(state));
  expect(snap.diagnostics).toEqual(tabStateDiagnostics(state));
  expect(snap.directives.some((d) => d.key.toLowerCase() === "tempo")).toBe(true);
  expect(snap.recededLineStarts.length).toBeGreaterThan(0); // prose + comment recede
});
