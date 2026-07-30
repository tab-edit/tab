// Demo timeline contract — HEADLESS (the Playwright driver cannot hear
// audio, and the first bend regression was exactly here: absolute bend
// times slid off their note when the timeline normalized start times).
import { EditorState } from "@codemirror/state";
import { localSnapshotOf, tablature } from "../src/index.js";
import { secAtPos, type TimedEvent } from "../src/playback.js";
import { cursorAt, schedulableThrough, secToWholeNotes, timeline } from "../demo/playback.js";

const GUITAR = (top: string) =>
  [top, "B|--------|", "G|--------|", "D|--------|", "A|--------|", "E|--------|", ""].join("\n");

test("bend curves are NOTE-RELATIVE: they survive start normalization", () => {
  // 7 at interior col 2 → the timeline shifts everything so it plays at 0.
  const state = EditorState.create({ doc: GUITAR("e|--7b9---|"), extensions: [tablature()] });
  const { events, baseSec } = timeline(state, []);
  expect(events.length).toBe(1); // the arrival is absorbed into the curve
  const [attack] = events;
  expect(attack.atSec).toBe(0); // normalized
  // Score time survives normalization: the 7 sits at interior col 2 of an
  // 8-wide 4/4 measure = 1/4 whole note in; at 120 bpm that's 0.5s of base.
  expect(baseSec).toBeCloseTo(0.5, 6);
  expect(secToWholeNotes(baseSec + 0, 120)).toBeCloseTo(0.25, 9);
  expect(attack.bend).toBeDefined();
  // Offsets from the note's own start: flat at 0, arriving +2 mid-note —
  // strictly inside [0, durSec] no matter what normalization did.
  expect(attack.bend![0]).toEqual({ atSec: 0, semitones: 0 });
  expect(attack.bend![1].semitones).toBe(2);
  expect(attack.bend![1].atSec).toBeGreaterThan(0);
  expect(attack.bend![1].atSec).toBeLessThan(attack.durSec);
});

test("technique dynamics reach the timeline: hammer target is softer", () => {
  const state = EditorState.create({ doc: GUITAR("e|--3h5---|"), extensions: [tablature()] });
  const { events } = timeline(state, []);
  expect(events.length).toBe(2);
  expect(events[0].velocity).toBe(0x60); // picked
  expect(events[1].velocity).toBe(0x43); // hammered into
});

// —— Windowed scheduling core (2026-07-19 audio-breakup fix): the player
// schedules JUST-IN-TIME — live nodes scale with polyphony, never piece
// length (the pulled full-song scores put 1,800+ events in one timeline;
// scheduling them all at once starved the render thread for EVERYTHING).
// The cursor math is the pure, headless-testable core.

const EV = (atSec: number, durSec: number) =>
  ({ atSec, durSec, midi: 60, velocity: 0x60, percussion: false, spans: [] }) as const;

test("schedulableThrough: advances the cursor only through the horizon, monotonically", () => {
  const events = [EV(0, 1), EV(0.5, 1), EV(2, 1), EV(10, 1)];
  expect(schedulableThrough(events, 0, 1.2)).toBe(2); // 0 and 0.5 in; 2 > 1.2 stays out
  expect(schedulableThrough(events, 0, 0.6)).toBe(2);
  expect(schedulableThrough(events, 2, 2.0)).toBe(3);
  expect(schedulableThrough(events, 3, 9.9)).toBe(3); // nothing new inside horizon
  expect(schedulableThrough(events, 3, 10)).toBe(4); // inclusive at the boundary
  expect(schedulableThrough(events, 4, 99)).toBe(4); // exhausted stays exhausted
});

test("cursorAt: seek lands on the first event still sounding at the offset", () => {
  const events = [EV(0, 1), EV(0.5, 1), EV(2, 1), EV(10, 1)];
  expect(cursorAt(events, 0)).toBe(0);
  expect(cursorAt(events, 0.9)).toBe(0); // EV(0,1) still sounding at 0.9
  expect(cursorAt(events, 1.2)).toBe(1); // EV(0.5,1) sounds through 1.5
  expect(cursorAt(events, 3)).toBe(3);
  expect(cursorAt(events, 999)).toBe(4); // past the end: nothing left
});

// —— Caret → time (2026-07-30 "play from here starts at the top" bug): a
// caret on a DASH used to search its own LINE only, so a click on a silent
// string — or past the last note of its string — answered undefined and the
// app fell back to 0. The grid's x axis is the COLUMN and the sibling set is
// the MEASURE (one range per line of its system), so the scan is now
// cross-string.

const GRID = [
  //   col 0123456789012345678901234
  "e|--3---5---|--7-------|",
  "B|----7-----|----------|",
  "G|----------|----------|",
  "D|----------|----------|",
  "A|----------|----------|",
  "E|--0-------|--3-------|",
  "",
].join("\n");

function grid() {
  const state = EditorState.create({ doc: GRID, extensions: [tablature()] });
  const { events } = timeline(state, []);
  const doc = state.doc;
  const measures = localSnapshotOf(state)!.measures;
  const at = (lineNo: number, col: number) => doc.line(lineNo).from + col;
  /** The time the note printed at (line, col) plays — read off the timeline
   *  rather than hard-coded, so the assertions say WHICH note, not which
   *  second. */
  const noteAt = (lineNo: number, col: number): number =>
    (events as TimedEvent[]).find((e) => e.spans.some((s) => s.from === at(lineNo, col)))!.atSec;
  const seek = (lineNo: number, col: number) =>
    secAtPos(events as TimedEvent[], doc, measures, at(lineNo, col));
  return { events: events as TimedEvent[], doc, measures, seek, noteAt, at };
}

test("secAtPos: a caret on a fret digit is that sound (containment first)", () => {
  const g = grid();
  expect(g.seek(1, 8)).toBe(g.noteAt(1, 8)); // the e-string 5
  expect(g.seek(2, 6)).toBe(g.noteAt(2, 6)); // the B-string 7
});

test("secAtPos: a dash answers the earliest onset at or after its COLUMN", () => {
  const g = grid();
  // Between the e-string 3 (col 4) and 5 (col 8) sits the B-string 7 at col
  // 6. The line-local scan used to answer the 5 and SKIP the 7 — audibly
  // dropping a note the caret had not yet passed. Column order is the tab's
  // own time order, so the 7 is what plays next.
  expect(g.seek(1, 6)).toBe(g.noteAt(2, 6));
  expect(g.seek(1, 7)).toBe(g.noteAt(1, 8)); // past the 7: now the 5
});

test("secAtPos: a dash on a SILENT string finds the next onset in the measure", () => {
  const g = grid();
  // The G string carries nothing at all; col 5 is answered by the B-string
  // 7 at col 6 — the earliest onset at or after that column in measure 1.
  expect(g.seek(3, 5)).toBe(g.noteAt(2, 6));
  expect(g.seek(4, 0)).toBe(g.noteAt(1, 4)); // whole D string, from the label
});

test("secAtPos: past the last note of its OWN line, other strings still answer", () => {
  const g = grid();
  // The E string's only note in measure 1 is the 0 at col 4; col 7 is
  // answered by the e-string 5 at col 8, one line up.
  expect(g.seek(6, 7)).toBe(g.noteAt(1, 8));
});

test("secAtPos: past every onset of its measure, the NEXT measure answers", () => {
  const g = grid();
  expect(g.seek(2, 10)).toBe(g.noteAt(1, 15)); // measure 1 exhausted → measure 2
});

test("secAtPos: a caret on the tuning label starts its measure, not its string", () => {
  const g = grid();
  // col 0 is outside the measure ranges entirely. It used to snap to the
  // next onset on THAT line (the B-string 7, a beat late); it now falls to
  // the start of the measure it precedes.
  expect(g.seek(2, 0)).toBe(g.noteAt(1, 4));
});

test("secAtPos: past the last onset of the piece stays undefined", () => {
  const g = grid();
  expect(g.seek(6, 20)).toBeUndefined();
});

test("secAtPos: with no measure map it degrades to the old line-local scan", () => {
  const g = grid();
  // Snapshot not in yet (remote cold start): containment and same-line
  // forward-snap survive; the cross-string answer is simply unavailable.
  expect(secAtPos(g.events, g.doc, [], g.at(1, 6))).toBe(g.noteAt(1, 8));
  expect(secAtPos(g.events, g.doc, [], g.at(3, 5))).toBeUndefined();
});
