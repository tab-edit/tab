// The ONE interface an application codes against — the open-source
// reversibility seam (Stan directive 2026-07-18). Two implementations:
//   createRemoteSemantics (client.ts, the ENGINE-FREE entry) — semantics
//     from a session host over the wire;
//   createLocalSemantics (index.ts, the fat entry) — the in-process engine.
// An app picks ONE via a single re-export line (see app/semantics-mode.ts);
// the bundler then includes or drops the engine automatically. Flipping
// the product to local-everything is editing that one line.
import type { EditorState, Extension } from "@codemirror/state";
import type {
  ActivityFrame,
  ComputeActivityParams,
  InspectionFrame,
  InspectNodeParams,
} from "@tab-edit/protocol";

export interface PlaybackBend {
  readonly tick: number;
  readonly semitones: number;
}

/** One playable note — structurally the plugins SmfNote (the differential
 *  suites pin wire ≡ engine, so this local declaration cannot drift
 *  silently). */
export interface PlaybackEvent {
  readonly tick: number;
  readonly durationTicks: number;
  readonly midi: number;
  readonly velocity?: number;
  readonly bend?: readonly PlaybackBend[];
  readonly percussion?: boolean;
  readonly sourceFrom?: number;
  readonly sourceTo?: number;
}

/** The playback timeline's inputs (selection windowing stays a pure
 *  client-side computation over these + the snapshot sound map). */
export interface MidiEvents {
  readonly bpm: number;
  readonly ppq: number;
  readonly events: readonly PlaybackEvent[];
}

export interface TextEditData {
  readonly from: number;
  readonly to: number;
  readonly insert: string;
}

/** Everything an application needs from tab-edit semantics. All async —
 *  local implementations resolve immediately; remote ones round-trip.
 *  Methods take the current EditorState so the LOCAL implementation can
 *  read it; the remote one answers from the session's mirror (R3: results
 *  are computed at ≥ the version on screen either way). */
export interface TabSemantics {
  /** The whole editor wiring: language + highlighting + lint + semantic
   *  decorations (+ the snapshot source / wire client). */
  readonly extension: Extension;
  musicXml(state: EditorState): Promise<string>;
  midiFile(state: EditorState): Promise<Uint8Array>;
  midiEvents(state: EditorState): Promise<MidiEvents>;
  /** Returns edits against the CURRENT doc, ready to dispatch. */
  importMusicXml(state: EditorState, xml: string): Promise<readonly TextEditData[]>;
  /** ENGINE INSPECTION (the plugin author's debugger — see
   *  docs/design/inspector-over-the-wire.md for why a hidden engine is
   *  allowed to show this): the ancestor chain at a position, with every
   *  prop's declared chain, declared reads, value, and cache outcome.
   *
   *  Both implementations answer the SAME frame type through the SAME
   *  projectors, so the panes never branch on mode. The remote one FLUSHES
   *  first and cites its version, so the frame's ranges are in the
   *  coordinates on screen (see client.ts for that reasoning). */
  inspectNode(state: EditorState, params: InspectNodeParams): Promise<InspectionFrame>;
  /** What the engine ACTUALLY did over a window of passes: per-segment
   *  reuse, per-prop runs with a taxonomy-level reason, timings, and the
   *  savings counterfactual. Ask AFTER the reads you want attributed, and
   *  pass your own `sincePass` — the unaddressed window is a destructive
   *  read shared by every caller. */
  computeActivity(state: EditorState, params?: ComputeActivityParams): Promise<ActivityFrame>;
}

export type {
  ActivityFrame,
  ComputeActivityParams,
  InspectionFrame,
  InspectNodeParams,
} from "@tab-edit/protocol";
