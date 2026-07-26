// THE ENGINE-FREE CLIENT ENTRY (@tab-edit/cm/client) — what the shipped
// product bundles (ADR-003: the engine never ships to browsers). Reachable
// from here: CodeMirror, the COMPILED base grammar tables (@tab-edit/parse
// dist — styleTags ride the grammar, so highlighting is native), the wire
// contract (@tab-edit/protocol), and the pure snapshot model + RemoteClient.
// NOT reachable: @tab-edit/ast, @tab-edit/plugins, the semantic parser —
// tests/client-bundle.test.ts is the mechanical audit of that claim.
//
// The fat entry (./index.ts) layers the local engine ON TOP of this module
// (tablature() = base language + these same extras + the local snapshot
// source) — so open-sourcing / going local-everything swaps one facade
// re-export line and nothing else (see facade.ts).

import { LanguageSupport, LRLanguage } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import { rectangularSelection } from "@codemirror/view";
import { parser as baseParser } from "@tab-edit/parse";
import {
  directiveAnnotations,
  kindStyling,
  selectionNodeHighlight,
  soundHighlight,
} from "./decorations.js";
import type {
  ActivityFrame,
  ComputeActivityParams,
  InspectionFrame,
  InspectNodeParams,
  MidiEvents,
  TabSemantics,
  TextEditData,
} from "./facade.js";
import { tabHighlighting } from "./highlight.js";
import { tabLint } from "./lint.js";
import {
  RemoteClient,
  webSocketTransport,
  type RemoteTransport,
  type WebSocketTransportOptions,
} from "./remote.js";

export interface TablatureOptions {
  /** Lint panel/gutter integration (default true). */
  readonly lint?: boolean;
  /** Chord highlight under the cursor (default true). */
  readonly highlightSounds?: boolean;
  /** Highlight the Sounds and Measures the current selection intersects —
   *  including every range of a column selection (default true). */
  readonly highlightSelection?: boolean;
  /** Allow rectangular/multi-range selections (default true — column
   *  selections are how tab editing works). */
  readonly multipleSelections?: boolean;
  /** Plain mouse-drag makes a column (rectangular) selection — no Alt
   *  needed (default true; `event.detail === 1` gating keeps double/triple
   *  click word/line select native — see index.ts history). */
  readonly columnSelection?: boolean;
  /** Dotted-underline + hover on recognized `Key: value` directives. */
  readonly annotateDirectives?: boolean;
  /** The adapter's own deliberate token colors (default on). */
  readonly tokenColors?: boolean;
  /** An installed theme pack; replaces the default themes entirely. */
  readonly theme?: Extension;
  /** Kind-driven line styling: prose/comments recede (default on). */
  readonly kindStyling?: boolean;
}

/** The support extras every tablature editor gets — all SNAPSHOT-driven,
 *  shared verbatim between the fat tablature() and remoteTablature(). */
export function tablatureSupport(options: TablatureOptions = {}): Extension[] {
  const extras: Extension[] = [];
  if (options.lint !== false) extras.push(tabLint());
  if (options.theme) extras.push(options.theme);
  else if (options.tokenColors !== false) extras.push(tabHighlighting());
  if (options.highlightSounds !== false) extras.push(soundHighlight());
  if (options.annotateDirectives !== false) extras.push(directiveAnnotations());
  if (options.kindStyling !== false) extras.push(kindStyling());
  if (options.highlightSelection !== false) extras.push(selectionNodeHighlight());
  if (options.multipleSelections !== false) {
    extras.push(EditorState.allowMultipleSelections.of(true));
  }
  if (options.columnSelection !== false) {
    extras.push(rectangularSelection({ eventFilter: (e) => e.detail === 1 }));
  }
  return extras;
}

/** BASE-grammar language: the compiled LR tables alone — instant syntax
 *  highlighting/folding with zero semantic code (ADR-003 §2.2). The fat
 *  entry's wiring-2 parser (language.ts, which also runs the semantic
 *  parse in-process) must never reach a shipped bundle. */
export const baseTabLanguage = LRLanguage.define({
  name: "tablature",
  parser: baseParser.configure({ bufferLength: 32 }),
  languageData: { commentTokens: { line: "#" } },
});

/** The tablature editing system with WIRE-fed semantics: base-grammar
 *  language + the same snapshot-driven surfaces tablature() installs.
 *  Pair with a RemoteClient's extension (createRemoteSemantics bundles
 *  both). */
export function remoteTablature(options: TablatureOptions = {}): Extension {
  return new LanguageSupport(baseTabLanguage, tablatureSupport(options));
}

export interface RemoteSemanticsOptions extends TablatureOptions {
  /** Session host endpoint (ws:// or wss://). */
  readonly url?: string;
  /** Custom transport (tests, loopback) — overrides url. */
  readonly transport?: RemoteTransport;
  readonly webSocket?: WebSocketTransportOptions;
  readonly coalesceMs?: number;
}

export interface RemoteSemantics extends TabSemantics {
  readonly client: RemoteClient;
}

const decodeBase64 = (data: string): Uint8Array =>
  Uint8Array.from(atob(data), (c) => c.charCodeAt(0));

/** The remote implementation of the facade — the product configuration.
 *  Its local twin is createLocalSemantics (fat entry); an app flips
 *  between them by swapping one re-export (facade.ts contract). */
export function createRemoteSemantics(options: RemoteSemanticsOptions): RemoteSemantics {
  const transport =
    options.transport ??
    webSocketTransport(
      options.url ?? (() => {
        throw new Error("createRemoteSemantics: pass url or transport");
      })(),
      options.webSocket
    );
  const client = new RemoteClient(transport, {
    ...(options.coalesceMs !== undefined ? { coalesceMs: options.coalesceMs } : {}),
  });
  return {
    client,
    extension: [remoteTablature(options), client.extension],
    musicXml: () => client.query("musicXml") as Promise<string>,
    midiFile: async () => decodeBase64((await client.query("midiFile")) as string),
    midiEvents: () => client.query("midiEvents") as Promise<MidiEvents>,
    importMusicXml: (_state, xml) =>
      client.command("musicxml-import.import", { xml }) as Promise<readonly TextEditData[]>,
    // INSPECTION, and the atVersion decision (deliberate — see facade.ts).
    // query() does not flush, so an unflushed keystroke would leave the
    // session answering about a document the user has already left: the
    // frame's ranges would be in coordinates that no longer exist on
    // screen, and every "click a range to select it" affordance would jump
    // to the wrong text. So flush FIRST and cite the version we flushed —
    // the channel is ordered and we are the only writer, so the session
    // processes those updates before this query and answers at exactly
    // this version. Citing it is not redundant: if the session is behind
    // for any other reason (a resync in flight), it says so with
    // `approximate` instead of quietly answering in stale coordinates.
    // Cost is one debounced flush on an explicitly-requested debug read —
    // never the typing path (I3 intact).
    inspectNode: (_state, params) => {
      client.flush();
      return client.query("inspectNode", {
        ...params,
        atVersion: client.version,
      }) as Promise<InspectionFrame>;
    },
    computeActivity: (_state, params) =>
      client.query("computeActivity", params) as Promise<ActivityFrame>,
  };
}

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
  WebSocketTransportOptions,
} from "./remote.js";
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
export { sanitizeForOsmd } from "./osmd.js";
export type { SheetMode } from "./osmd.js";
export {
  buildRows,
  claimPairs,
  causeOf,
  costRows,
  filterRows,
  indexActivity,
  orderRows,
  outcomeNameFor,
  packChips,
  rangesInValue,
  savingsLine,
  splitPropId,
  stateChips,
  summarizeValue,
} from "./inspector-model.js";
export type {
  ActivityIndex,
  CauseEdge,
  CauseView,
  ClaimPair,
  CostRow,
  OrderedRows,
  PackChip,
  PropRow,
  PropStability,
  PropState,
  RowFilters,
  RowOrder,
  SavingsLine,
  StateChip,
} from "./inspector-model.js";
export {
  selectionHighlightsAt,
  snapshotOf,
  snapshotSource,
  soundRangesAt,
} from "./snapshot-model.js";
export type {
  DirectiveSpan,
  NodeRanges,
  SemanticSnapshot,
  SnapshotRange,
  SnapshotSource,
} from "./snapshot-model.js";
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
  directiveAnnotations,
  kindStyling,
  selectionNodeHighlight,
  soundHighlight,
} from "./decorations.js";
export { tabHighlighting, tabTheme, defaultDarkTabTheme, defaultLightTabTheme } from "./highlight.js";
export type { TabThemeSpec } from "./highlight.js";
export { tabDiagnostics, tabLint } from "./lint.js";
