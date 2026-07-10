// @tab-edit/cm — CodeMirror 6 integration (ADR-001 Appendix A wiring 2).
//
//   import { tablature } from "@tab-edit/cm";
//   new EditorView({ extensions: [basicSetup, tablature()] });
//
// Token highlighting is native (the base tree carries styleTags); the
// semantic layer, lint-with-fixes, and the chord highlighter ride on top.

import { LanguageSupport } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import { rectangularSelection } from "@codemirror/view";
import { selectionNodeHighlight, soundHighlight } from "./decorations.js";
import { tabLanguage } from "./language.js";
import { tabLint } from "./lint.js";

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
   *  needed (default true). Verified live with Playwright: `eventFilter:
   *  () => true` (matching literally what was asked) captures EVERY
   *  mousedown, including a double-click's second one, before CM's own
   *  dblclick word-select runs — a real regression. Gating on
   *  `event.detail === 1` fixes it: single-click drags still start a
   *  column selection (the feature), while double/triple clicks
   *  (detail >= 2) fall through to native word/line select untouched.
   *  Set false for CM's stock Alt-drag-only rectangular selection. */
  readonly columnSelection?: boolean;
}

/** The complete tablature editing system as one extension. */
export function tablature(options: TablatureOptions = {}): Extension {
  const extras: Extension[] = [];
  if (options.lint !== false) extras.push(tabLint());
  if (options.highlightSounds !== false) extras.push(soundHighlight());
  if (options.highlightSelection !== false) extras.push(selectionNodeHighlight());
  if (options.multipleSelections !== false) {
    extras.push(EditorState.allowMultipleSelections.of(true));
  }
  if (options.columnSelection !== false) {
    extras.push(rectangularSelection({ eventFilter: (e) => e.detail === 1 }));
  }
  return new LanguageSupport(tabLanguage, extras);
}

export { tabLanguage, tabTree } from "./language.js";
export {
  computeActivity,
  configureTabHost,
  corePlugins,
  inspectNode,
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
export { midiOfSelection, selectedNodes } from "./selection.js";
export { importMusicXml, midiFile, musicXml } from "./export.js";
export {
  selectedNodeHighlightRanges,
  selectionNodeHighlight,
  soundHighlight,
  soundRangesAtCursor,
} from "./decorations.js";
