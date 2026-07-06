// Export commands: the live document → MusicXML string / playable SMF
// bytes. Both are prop reads (documentXml is a per-section-cached fold, so
// live preview after a keystroke recomputes one section + the concat).

import type { EditorState } from "@codemirror/state";
import { documentMidi, documentXml, encodeSmf, tempo } from "@tab-edit/plugins";
import { tabTree } from "./language.js";
import { readTabProp, runTabCommand } from "./state-layer.js";

/** MusicXML 4.0 (open in MuseScore — it renders the TAB staff and plays). */
export function musicXml(state: EditorState): string {
  const tree = tabTree(state);
  if (!tree) return "";
  return readTabProp(state, documentXml, tree.topNode);
}

/** Format-0 Standard MIDI File bytes (any player). */
export function midiFile(state: EditorState): Uint8Array {
  const tree = tabTree(state);
  if (!tree) return new Uint8Array();
  const sections = tree.topNode.getChildren("Section");
  const firstMusic =
    sections.find((s) =>
      s.getChildren("Block").some((b) => b.getChildren("Measure").length > 0)
    ) ?? sections[0];
  const bpm = firstMusic ? readTabProp(state, tempo, firstMusic).bpm : 120;
  return encodeSmf(readTabProp(state, documentMidi, tree.topNode), { bpm });
}

/** Import a MusicXML document: returns the TextEdits appending its tab
 *  rendering (ADR-002 §9 producer; EXACT round trip with musicXml()).
 *  Apply with `view.dispatch({ changes: edits.map(e => ({...e})) })`. */
export function importMusicXml(state: EditorState, xml: string) {
  return runTabCommand(state, "musicxml-import.import", { xml });
}
