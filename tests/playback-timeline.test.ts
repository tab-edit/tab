// Demo timeline contract — HEADLESS (the Playwright driver cannot hear
// audio, and the first bend regression was exactly here: absolute bend
// times slid off their note when the timeline normalized start times).
import { EditorState } from "@codemirror/state";
import { tablature } from "../src/index.js";
import { secToWholeNotes, timeline } from "../demo/playback.js";

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
