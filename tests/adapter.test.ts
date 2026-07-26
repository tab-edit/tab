// End-to-end adapter suite — REAL @codemirror/state + @codemirror/language
// machinery (EditorState transactions, Language.state fragments), headless.
// This is ADR-001 Appendix A wiring 2 exercised as CM will exercise it:
// one parse feeds CM's tree AND the semantic layer; edits flow through
// CM's TreeFragments; state carries across transactions.
import { syntaxTree } from "@codemirror/language";
import { forceParsed } from "./force-parse.js";
import { EditorSelection, EditorState } from "@codemirror/state";
import { measureNumber, noteSound } from "@tab-edit/plugins";
import {
  directiveAnnotationRanges,
  recededLineStarts,
  computeActivity,
  inspectNode,
  midiFile,
  midiOfSelection,
  musicXml,
  readTabProp,
  selectedNodeHighlightRanges,
  selectedNodes,
  soundRangesAtCursor,
  tabDiagnostics,
  tablature,
  tabTree,
} from "../src/index.js";

// Two big sections (each ≳350 chars, so segments become Trees at
// bufferLength 256 and IDENTITY reuse is observable across edits).
const WIDE = "-".repeat(56);
const SECTION = [
  `e|--0--2--${WIDE}|`,
  `B|3--------${WIDE}|`,
  `G|---------${WIDE}|`,
  `D|---------${WIDE}|`,
  `A|---------${WIDE}|`,
  `E|---------${WIDE}|`,
].join("\n");
const DOC = `${SECTION}\n\n${SECTION}\n`;

function stateOf(doc: string, selection?: EditorSelection): EditorState {
  const state = EditorState.create({
    doc,
    ...(selection ? { selection } : {}),
    extensions: [tablature()],
  });
  return forceParsed(state);
}

test("wiring 2: ONE parse serves both consumers — CM gets the base tree, tabTree rides it", () => {
  const state = stateOf(DOC);
  const base = syntaxTree(state);
  expect(base.length).toBe(DOC.length);
  const semantic = tabTree(state)!;
  expect(semantic).not.toBeNull();
  expect(semantic.baseTree).toBe(base); // literally the same object
  expect(semantic.topNode.name).toBe("TabDocument");
  expect(semantic.topNode.getChildren("Section")).toHaveLength(2);
});

test("props read through the editor state: measure numbers span sections", () => {
  const state = stateOf(DOC);
  const sections = tabTree(state)!.topNode.getChildren("Section");
  const measureOf = (i: number) =>
    sections[i].getChildren("Block")[0].getChildren("Measure")[0];
  expect(readTabProp(state, measureNumber, measureOf(0))).toBe(1);
  expect(readTabProp(state, measureNumber, measureOf(1))).toBe(2);
});

test("edits flow through CM's fragments: untouched section's ARTIFACT survives by identity", () => {
  const s1 = stateOf(DOC);
  const before = tabTree(s1)!;
  // Edit DEEP inside SECTION 2 — well past lezer's ~25-char reuse safety
  // margin around the fragment cut (an edit hugging the section boundary
  // legitimately blocks identity reuse; equality carry covers that case).
  const editAt = DOC.length - 100;
  const tr = s1.update({ changes: { from: editAt, to: editAt + 1, insert: "7" } });
  const s2 = forceParsed(tr.state);
  const after = tabTree(s2)!;
  expect(after).not.toBe(before);
  // Section 1's segment artifact is the SAME OBJECT — fragment-driven
  // identity reuse across real CM transactions.
  const artifactOf = (t: typeof before, i: number) => {
    const unit = t.units.filter((u) => u.kind === "segment")[i] as { artifact: unknown };
    return unit.artifact;
  };
  expect(artifactOf(after, 0)).toBe(artifactOf(before, 0));
  expect(artifactOf(after, 1)).not.toBe(artifactOf(before, 1));
  // And the semantics reflect the edit (a new note appeared in section 2).
  const note = after.topNode
    .getChildren("Section")[0]
    .getChildren("Block")[0]
    .getChildren("Measure")[0]
    .getChildren("Sound")[0]
    .getChildren("Note")[0];
  expect(readTabProp(s2, noteSound, note).kind).toBe("pitched");
});

test("lint with fixes: diagnostics surface as actions; applying the edits clears them", () => {
  // Mixed explicit/implicit line names — flagged with a fix by default.
  const doc = "e|--3--|\n|-----|\n";
  const s1 = stateOf(doc);
  const diags = tabDiagnostics(s1);
  expect(diags).toHaveLength(1);
  expect(diags[0].actions).toHaveLength(1);
  expect(diags[0].source).toBe("implicit-line-name");

  // Apply the fix the way the lint action does: dispatch its edits.
  let dispatched: import("@codemirror/state").TransactionSpec | null = null;
  diags[0].actions![0].apply(
    { dispatch: (spec: object) => void (dispatched = spec) } as never,
    diags[0].from,
    diags[0].to
  );
  expect(dispatched).not.toBeNull();
  const s2 = forceParsed(s1.update(dispatched!).state);
  expect(s2.doc.toString()).toMatch(/^e\|--3--\|\n[A-Za-z]\|-----\|\n$/);
  expect(tabDiagnostics(s2)).toEqual([]);
});

test("computeActivity: work is attributed to the edited segment; carried segments report NONE", () => {
  // Unique doc so equality against artifacts from other tests can't blur
  // the statuses (the module-level host is shared, like in a real app).
  const doc = `Title: Activity Probe\n\n${DOC}`;
  const s1 = stateOf(doc);
  tabDiagnostics(s1); // pull → computes happen here
  const first = computeActivity(s1)!;
  expect(first).not.toBeNull();
  // Fresh content: no segment can be identity-carried, and work happened.
  expect(first.segments.length).toBeGreaterThanOrEqual(3);
  expect(first.segments.every((s) => s.artifact !== "identity")).toBe(true);
  expect(first.totalRecomputes).toBeGreaterThan(0);

  // Edit DEEP in the LAST section, then pull the same reads again.
  const editAt = doc.length - 100;
  const s2 = forceParsed(s1.update({ changes: { from: editAt, to: editAt + 1, insert: "5" } }).state);
  tabDiagnostics(s2);
  const report = computeActivity(s2)!;

  const untouched = report.segments.slice(0, -1);
  const edited = report.segments[report.segments.length - 1];
  // Untouched segments: artifacts carried BY IDENTITY, zero compute runs.
  for (const s of untouched) {
    expect(s.artifact).toBe("identity");
    expect(s.recomputes.size).toBe(0);
  }
  // The edited segment re-parsed with new content and its props re-ran.
  expect(edited.artifact).toBe("new");
  let runs = 0;
  for (const n of edited.recomputes.values()) runs += n;
  expect(runs).toBeGreaterThan(0);
});

test("inspectNode: values + declared chain + ACTUAL evaluation trace, cache visible", () => {
  const state = stateOf("Title: Inspect Me\n\ne|--3--5--|\nB|1--------|\n");
  const block = tabTree(state)!
    .topNode.getChildren("Section")
    .flatMap((s) => s.getChildren("Block"))
    .find((b) => b.getChildren("Measure").length > 0)!;

  const first = inspectNode(state, block)!;
  const kind = first.props.find((p) => p.id === "core-taxonomy/blockKind")!;
  expect(kind.value).toBe("music");
  expect(kind.chain[kind.chain.length - 1]).toBe("core-taxonomy (base)");
  // First read actually COMPUTED.
  expect(kind.computed).toBe(true);
  // Claims carry provenance the UI can badge.
  const claim = first.props.find((p) => p.id === "core-taxonomy/blockKindClaim")!;
  expect(claim.value).toMatchObject({ value: "music", source: "core-taxonomy" });

  // Same read again: served from CACHE — computed:false is the visibility.
  const second = inspectNode(state, block)!;
  expect(second.props.find((p) => p.id === "core-taxonomy/blockKind")!.computed).toBe(false);

  // Deferred evaluation lists the prop without computing it.
  const deferred = inspectNode(state, tabTree(state)!.topNode, false)!;
  expect(deferred.props.length).toBeGreaterThan(0);
  expect(deferred.props.every((p) => !p.evaluated)).toBe(true);
});

test("invalid content inside music surfaces as ERROR diagnostics in the editor", () => {
  const doc = "e|--1--2--|--3--|\nB|--@#$%--|--4--|\nG|--0--0--|--0--|\n";
  const state = stateOf(doc);
  const errors = tabDiagnostics(state).filter((d) => d.source === "invalid-syntax");
  expect(errors.length).toBeGreaterThan(0);
  for (const e of errors) expect(e.severity).toBe("error");
  // Anchored to the unreadable text, not the whole block.
  const garbage = { from: doc.indexOf("@"), to: doc.indexOf("%") + 1 };
  expect(errors.some((e) => e.from < garbage.to && e.to > garbage.from)).toBe(true);
});

test("column selection → nodes → MIDI of selection (§7.4 #6 in the editor)", () => {
  const line = DOC.indexOf("\n") + 1;
  // Rectangle over columns [4,9) on all six lines of section 1.
  const selection = EditorSelection.create(
    Array.from({ length: 6 }, (_, l) => EditorSelection.range(l * line + 4, l * line + 9))
  );
  const state = stateOf(DOC, selection);
  const sounds = selectedNodes(state, "Sound");
  expect(sounds).toHaveLength(2); // e:0@col4, e:2@col7 — B:3@col2 outside
  const values = midiOfSelection(state);
  expect(values.map((v) => v.events[0].midi)).toEqual([64, 66]);
});

test("selection highlight: column selection lights up every intersecting Sound AND Measure", () => {
  const line = DOC.indexOf("\n") + 1;
  // Same rectangle as the MIDI-of-selection test: columns [4,9) on all six
  // lines of section 1 — inside the section's single Measure.
  const selection = EditorSelection.create(
    Array.from({ length: 6 }, (_, l) => EditorSelection.range(l * line + 4, l * line + 9))
  );
  const state = stateOf(DOC, selection);
  const ranges = selectedNodeHighlightRanges(state);

  const soundRanges = ranges.filter((r) => r.cls === "cm-tab-selected-sound");
  const measureRanges = ranges.filter((r) => r.cls === "cm-tab-selected-measure");
  expect(soundRanges.length).toBeGreaterThan(0);
  expect(measureRanges.length).toBeGreaterThan(0);

  // The two sounds in the rectangle (e:0@col4, e:2@col7) each surface, and
  // the Measure they live in is multi-range — decorated on every one of its
  // lines, not just the ones touched by the selection.
  const measure = selectedNodes(state, "Measure")[0]!;
  expect(measureRanges.length).toBe(measure.rangeCount);
  for (let i = 0; i < measure.rangeCount; i++) {
    expect(measureRanges.some((r) => r.from === measure.rangeFrom(i) && r.to === measure.rangeTo(i))).toBe(
      true
    );
  }
});

test("selection highlight: an empty (caret) selection highlights nothing", () => {
  const state = stateOf(DOC, EditorSelection.single(DOC.indexOf("0")));
  expect(selectedNodeHighlightRanges(state)).toEqual([]);
});

test("chord highlight: the Sound under the cursor lights up on every line it touches", () => {
  // Chord: e:0 and B:1 in the same column.
  const doc = ["e|--0---|", "B|--1---|", "G|------|"].join("\n") + "\n";
  const cursorAt = doc.indexOf("0");
  const state = stateOf(doc, EditorSelection.single(cursorAt));
  const ranges = soundRangesAtCursor(state);
  expect(ranges).toHaveLength(2); // one range per line of the chord
  expect(doc.slice(ranges[0].from, ranges[0].to)).toBe("0");
  expect(doc.slice(ranges[1].from, ranges[1].to)).toBe("1");
});

test("live exports from the editor state: MusicXML + playable SMF", () => {
  const state = stateOf(`Title: Live Demo\nTempo: 90\n\n${SECTION}\n`);
  const xml = musicXml(state);
  expect(xml).toContain('<score-partwise version="4.0">');
  expect(xml).toContain("<work-title>Live Demo</work-title>");
  expect(xml).toContain("<part-name>Guitar</part-name>");
  const smf = midiFile(state);
  expect(String.fromCharCode(...smf.slice(0, 4))).toBe("MThd");
  // Tempo directive reached the SMF meta: 60e6/90 = 666667 = 0x0A2C2B.
  const bytes = [...smf];
  const tempoAt = bytes.findIndex((b, i) => b === 0xff && bytes[i + 1] === 0x51);
  expect(bytes.slice(tempoAt + 3, tempoAt + 6)).toEqual([0x0a, 0x2c, 0x2b]);
});

test("MusicXML import command in the editor: musicXml → importMusicXml → the music round-trips", () => {
  const { importMusicXml } = require("../src/index.js") as typeof import("../src/index.js");
  const s1 = stateOf(DOC);
  const xml = musicXml(s1);
  const edits = importMusicXml(s1, xml);
  const s2 = forceParsed(s1.update({ changes: edits.map((e) => ({ ...e })) }).state);
  const sections = tabTree(s2)!.topNode.getChildren("Section");
  // 2 source sections + 2 imported single-measure systems.
  expect(sections.length).toBe(4);
  // Same pitches in source measure 1 and its imported counterpart.
  const midisOf = (section: (typeof sections)[0]) =>
    section
      .getChildren("Block")[0]
      .getChildren("Measure")[0]
      .getChildren("Sound")
      .flatMap((s) =>
        s.getChildren("Note").map((n) => {
          const v = readTabProp(s2, noteSound, n);
          return v.kind === "pitched" ? (v as { midi: number }).midi : -1;
        })
      )
      .sort((a, b) => a - b);
  expect(midisOf(sections[2])).toEqual(midisOf(sections[0]));
});

test("directive annotations: recognized Key: value lines expose absolute spans + parsed values", () => {
  // Quiet-feedback surface (Stan 2026-07-14): the editor underlines what
  // the system picked up as directives, reading the directiveEntries
  // evidence prop — never re-deriving parsing in the adapter.
  const doc = "Title: Demo Song\nTempo: 120\n\ne|--1--2--|\nB|--3--0--|\n";
  const state = stateOf(doc);
  const ranges = directiveAnnotationRanges(state);
  expect(ranges.map((r) => ({ key: r.key, value: r.value }))).toEqual([
    { key: "title", value: "Demo Song" },
    { key: "tempo", value: "120" },
  ]);
  expect(doc.slice(ranges[1].from, ranges[1].to)).toBe("Tempo: 120");
  // Music lines never annotate.
  expect(ranges.every((r) => r.to <= doc.indexOf("e|"))).toBe(true);
});

test("kind styling: prose and comments recede, music and directives keep full strength", () => {
  const doc = [
    "Title: Demo Song", // directive block — NOT receded (load-bearing)
    "",
    "e|--1--2--|",
    "B|--3--0--|",
    "",
    "these are just words, flowing like a river all the way home",
    "and one more line of them to make it unmistakably prose",
    "",
    "# a comment line",
  ].join("\n");
  const state = stateOf(doc);
  const receded = recededLineStarts(state);
  const lineOf = (text: string) => doc.indexOf(text) - 0;
  expect(receded).toContain(lineOf("these are just words"));
  expect(receded).toContain(lineOf("and one more line"));
  expect(receded).toContain(lineOf("# a comment line"));
  expect(receded).not.toContain(lineOf("Title: Demo Song"));
  expect(receded).not.toContain(lineOf("e|--1--2--|"));
  expect(receded).not.toContain(lineOf("B|--3--0--|"));
});
