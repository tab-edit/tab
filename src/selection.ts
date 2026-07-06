// Selection → semantics: the editor's selection ranges (INCLUDING
// rectangular/column mode — one range per line) go straight into
// TabTree.nodesInRanges; MIDI-of-selection is then a per-sound prop read
// (ADR-002 §7.4 capability #6 — the pull model computes nothing else).

import type { EditorState } from "@codemirror/state";
import type { TabNode } from "@tab-edit/ast";
import { soundMidi, type SoundMidiValue } from "@tab-edit/plugins";
import { tabTree } from "./language.js";
import { readTabProp } from "./state-layer.js";

/** Nodes intersecting the current selection (type/group filterable).
 *  Carets probe the node under the cursor. */
export function selectedNodes(state: EditorState, typeOrGroup?: string): TabNode[] {
  const tree = tabTree(state);
  if (!tree) return [];
  return tree.nodesInRanges(
    state.selection.ranges.map((r) => ({ from: r.from, to: r.to })),
    typeOrGroup
  );
}

/** MIDI events of the selected sounds, onset-ordered per measure. */
export function midiOfSelection(state: EditorState): SoundMidiValue[] {
  return selectedNodes(state, "Sound").map((sound) => readTabProp(state, soundMidi, sound));
}
