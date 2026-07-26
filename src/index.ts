// @tab-edit/cm — CodeMirror 6 integration (ADR-001 Appendix A wiring 2).
//
//   import { tablature } from "@tab-edit/cm";
//   new EditorView({ extensions: [basicSetup, tablature()] });
//
// Token highlighting is native (the base tree carries styleTags); the
// semantic layer, lint-with-fixes, and the chord highlighter ride on top.

import { LanguageSupport } from "@codemirror/language";
import type { EditorState, Extension } from "@codemirror/state";
import { tablatureSupport, type TablatureOptions } from "./client.js";
import { midiEvents, midiFile, musicXml, importMusicXml } from "./export.js";
import type { TabSemantics } from "./facade.js";
import { tabLanguage } from "./language.js";
import { localSnapshotOf } from "./semantics.js";
import { snapshotSource } from "./snapshot-model.js";
import { localActivityFrame, localInspectionFrame } from "./state-layer.js";

export type { TablatureOptions } from "./client.js";

/** The complete tablature editing system as one extension — the LOCAL
 *  configuration: full engine in-process. The support extras are shared
 *  verbatim with remoteTablature() (client.ts); the only local-mode
 *  additions are the semantic language (wiring 2) and the local snapshot
 *  source (default precedence — a remote store outranks it, see
 *  snapshot-model.ts). */
export function tablature(options: TablatureOptions = {}): Extension {
  return new LanguageSupport(tabLanguage, [
    snapshotSource.of(localSnapshotOf),
    ...tablatureSupport(options),
  ]);
}

/** The local implementation of the facade — the open-source / offline
 *  configuration. Its remote twin is createRemoteSemantics
 *  (@tab-edit/cm/client); an app flips between them by swapping one
 *  re-export line (facade.ts contract). */
export function createLocalSemantics(options: TablatureOptions = {}): TabSemantics {
  return {
    extension: tablature(options),
    musicXml: async (state: EditorState) => musicXml(state),
    midiFile: async (state: EditorState) => midiFile(state),
    midiEvents: async (state: EditorState) => midiEvents(state),
    importMusicXml: async (state: EditorState, xml: string) =>
      importMusicXml(state, xml).map((e) => ({ from: e.from, to: e.to, insert: e.insert })),
    // The engine is in-process, so these resolve immediately — same frames,
    // same projectors, same panes. A null frame means the syntax tree has
    // not been produced yet (CM parses asynchronously); an empty frame is
    // the honest answer for a caller that cannot wait.
    inspectNode: async (state: EditorState, params) =>
      localInspectionFrame(state, params) ?? {
        version: 0,
        pos: params.pos,
        chain: [],
        installWarnings: [],
      },
    computeActivity: async (state: EditorState, params) =>
      localActivityFrame(state, params) ?? {
        version: 0,
        passId: 0,
        sincePass: 0,
        segments: [],
        docRecomputes: [],
        totalRecomputes: 0,
        unattributed: 0,
        savings: {
          recomputedProps: 0,
          carriedProps: 0,
          elapsedMs: 0,
          baselineProps: 0,
          baselineMs: 0,
        },
      },
  };
}

export { tabLanguage, tabTree } from "./language.js";
export {
  computeActivity,
  configureTabHost,
  corePlugins,
  deepestNodeAt,
  inspectNode,
  localActivityFrame,
  localInspectionFrame,
  readTabProp,
  runTabCommand,
  tabStateDiagnostics,
} from "./state-layer.js";
export type {
  ComputeReport,
  NodeInspection,
  PropInspection,
  SegmentActivity,
  TraceStep,
} from "./state-layer.js";
export { tabDiagnostics, tabLint } from "./lint.js";
export {
  defaultDarkTabTheme,
  defaultLightTabTheme,
  tabHighlighting,
  tabTheme,
} from "./highlight.js";
export type { TabThemeSpec } from "./highlight.js";
export { midiOfSelection, selectedNodes } from "./selection.js";
export { importMusicXml, midiEvents, midiFile, musicXml } from "./export.js";
export {
  baseTabLanguage,
  createRemoteSemantics,
  remoteTablature,
  tablatureSupport,
} from "./client.js";
export { sanitizeForOsmd } from "./osmd.js";
export type { SheetMode } from "./osmd.js";
export {
  buildTimeline,
  createPlayer,
  cursorAt,
  schedulableThrough,
  secToWholeNotes,
} from "./playback.js";
export type {
  PlaybackProgress,
  PlaybackRange,
  PlaybackSource,
  Player,
  Span,
  TimedEvent,
  Timbre,
} from "./playback.js";
export type { RemoteSemantics, RemoteSemanticsOptions } from "./client.js";
export type {
  ActivityFrame,
  ComputeActivityParams,
  InspectionFrame,
  InspectNodeParams,
  MidiEvents,
  PlaybackBend,
  PlaybackEvent,
  TabSemantics,
  TextEditData,
} from "./facade.js";
export {
  buildRows,
  claimPairs,
  costRows,
  filterRows,
  indexActivity,
  orderRows,
  outcomeNameFor,
  packChips,
  rangesInValue,
  recomputeTints,
  savingsLine,
  segmentRows,
  splitPropId,
  stateChips,
  summarizeValue,
} from "./inspector-model.js";
export type {
  ActivityIndex,
  ClaimPair,
  CostRow,
  OrderedRows,
  PackChip,
  PropRow,
  PropStability,
  PropState,
  RecomputeTint,
  RowFilters,
  RowOrder,
  SavingsLine,
  SegmentRow,
  StateChip,
  TintKind,
} from "./inspector-model.js";
export {
  directiveAnnotations,
  kindStyling,
  selectionNodeHighlight,
  soundHighlight,
} from "./decorations.js";
export {
  directiveAnnotationRanges,
  recededLineStarts,
  selectedNodeHighlightRanges,
  soundRangesAtCursor,
} from "./semantics.js";
export {
  computeSnapshot,
  localSnapshotOf,
  selectionHighlightsAt,
  snapshotOf,
  snapshotSource,
  soundRangesAt,
} from "./semantics.js";
export type {
  DirectiveSpan,
  NodeRanges,
  SemanticSnapshot,
  SnapshotRange,
  SnapshotSource,
} from "./semantics.js";
export {
  applyRemoteSnapshot,
  chaosTransport,
  mapSnapshot,
  RemoteClient,
  remoteSemantics,
  remoteSnapshotField,
  sessionTransport,
  webSocketTransport,
} from "./remote.js";
export type {
  ChaosOptions,
  ChaosTransport,
  RemoteClientOptions,
  RemoteStatus,
  RemoteTransport,
} from "./remote.js";
