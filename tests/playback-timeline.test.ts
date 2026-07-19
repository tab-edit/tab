// Demo timeline contract — HEADLESS (the Playwright driver cannot hear
// audio, and the first bend regression was exactly here: absolute bend
// times slid off their note when the timeline normalized start times).
import { EditorState } from "@codemirror/state";
import { tablature } from "../src/index.js";
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
