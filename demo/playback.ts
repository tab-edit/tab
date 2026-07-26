// Demo playback = the LIBRARY player (src/playback.ts, engine-free) fed
// from in-process engine reads. The synth, the timeline algorithm and the
// windowed scheduler moved into the package unchanged so the product app
// (which has no engine) plays identically over the wire; what stays here
// is only the local data-sourcing: midiEvents(state) + the local snapshot.
import type { EditorState, SelectionRange } from "@codemirror/state";
import { localSnapshotOf, midiEvents } from "../src/index.js";
import {
  buildTimeline,
  createPlayer as createLibraryPlayer,
  type PlaybackSource,
  type Player,
  type Timbre,
} from "../src/playback.js";

function sourceOf(state: EditorState): PlaybackSource {
  return { midi: midiEvents(state), snapshot: localSnapshotOf(state), doc: state.doc };
}

/** The playable timeline for a state + selection (pure). */
export function timeline(state: EditorState, ranges: readonly SelectionRange[]) {
  return buildTimeline(sourceOf(state), ranges);
}

export function createPlayer(
  state: EditorState,
  ranges: readonly SelectionRange[],
  timbre: Timbre = "plucked"
): Player | null {
  return createLibraryPlayer(sourceOf(state), ranges, timbre);
}

export {
  cursorAt,
  schedulableThrough,
  secToWholeNotes,
  type PlaybackProgress,
  type Player,
  type Span,
  type Timbre,
} from "../src/playback.js";
