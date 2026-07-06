// End-to-end adapter suite — REAL @codemirror/state + @codemirror/language
// machinery (EditorState transactions, Language.state fragments), headless.
// This is ADR-001 Appendix A wiring 2 exercised as CM will exercise it:
// one parse feeds CM's tree AND the semantic layer; edits flow through
// CM's TreeFragments; state carries across transactions.
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { measureNumber, noteSound } from "@tab-edit/plugins";
import {
  midiFile,
  midiOfSelection,
  musicXml,
  readTabProp,
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
  expect(ensureSyntaxTree(state, doc.length, 10_000)).not.toBeNull();
  return state;
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
  const s2 = tr.state;
  expect(ensureSyntaxTree(s2, s2.doc.length, 10_000)).not.toBeNull();
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
  const s2 = s1.update(dispatched!).state;
  expect(ensureSyntaxTree(s2, s2.doc.length, 10_000)).not.toBeNull();
  expect(s2.doc.toString()).toMatch(/^e\|--3--\|\n[A-Za-z]\|-----\|\n$/);
  expect(tabDiagnostics(s2)).toEqual([]);
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
  const s2 = s1.update({ changes: edits.map((e) => ({ ...e })) }).state;
  expect(ensureSyntaxTree(s2, s2.doc.length, 10_000)).not.toBeNull();
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
