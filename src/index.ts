// @tab-edit/cm — CodeMirror 6 integration (ADR-001 Appendix A wiring 2).
//
//   import { tablature } from "@tab-edit/cm";
//   new EditorView({ extensions: [basicSetup, tablature()] });
//
// Token highlighting is native (the base tree carries styleTags); the
// semantic layer, lint-with-fixes, and the chord highlighter ride on top.

import { LanguageSupport } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import { soundHighlight } from "./decorations.js";
import { tabLanguage } from "./language.js";
import { tabLint } from "./lint.js";

export interface TablatureOptions {
  /** Lint panel/gutter integration (default true). */
  readonly lint?: boolean;
  /** Chord highlight under the cursor (default true). */
  readonly highlightSounds?: boolean;
  /** Allow rectangular/multi-range selections (default true — column
   *  selections are how tab editing works). */
  readonly multipleSelections?: boolean;
}

/** The complete tablature editing system as one extension. */
export function tablature(options: TablatureOptions = {}): Extension {
  const extras: Extension[] = [];
  if (options.lint !== false) extras.push(tabLint());
  if (options.highlightSounds !== false) extras.push(soundHighlight());
  if (options.multipleSelections !== false) {
    extras.push(EditorState.allowMultipleSelections.of(true));
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
export { soundHighlight, soundRangesAtCursor } from "./decorations.js";
