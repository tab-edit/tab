// Export commands: the live document → MusicXML string / playable SMF
// bytes. Both are prop reads (documentXml is a per-section-cached fold, so
// live preview after a keystroke recomputes one section + the concat).

import type { EditorState } from "@codemirror/state";
import { documentMidi, documentXml, encodeSmf, MIDI_PPQ, tempo } from "@tab-edit/plugins";
import type { MidiEvents } from "./facade.js";
import { tabTree } from "./language.js";
import { readTabProp, runTabCommand } from "./state-layer.js";

/** MusicXML 4.0 (open in MuseScore — it renders the TAB staff and plays). */
export function musicXml(state: EditorState): string {
  const tree = tabTree(state);
  if (!tree) return "";
  return readTabProp(state, documentXml, tree.topNode);
}

function bpmOf(state: EditorState): number {
  const tree = tabTree(state)!;
  const sections = tree.topNode.getChildren("Section");
  const firstMusic =
    sections.find((s) =>
      s.getChildren("Block").some((b) => b.getChildren("Measure").length > 0)
    ) ?? sections[0];
  return firstMusic ? readTabProp(state, tempo, firstMusic).bpm : 120;
}

/** Format-0 Standard MIDI File bytes (any player). */
export function midiFile(state: EditorState): Uint8Array {
  const tree = tabTree(state);
  if (!tree) return new Uint8Array();
  return encodeSmf(readTabProp(state, documentMidi, tree.topNode), { bpm: bpmOf(state) });
}

/** The playback timeline's inputs — the LOCAL twin of the remote
 *  `midiEvents` query (the differential suites pin the two identical). */
export function midiEvents(state: EditorState): MidiEvents {
  const tree = tabTree(state);
  if (!tree) return { bpm: 120, ppq: MIDI_PPQ, events: [] };
  return {
    bpm: bpmOf(state),
    ppq: MIDI_PPQ,
    events: readTabProp(state, documentMidi, tree.topNode),
  };
}

/** Import a MusicXML document: returns the TextEdits appending its tab
 *  rendering (ADR-002 §9 producer; EXACT round trip with musicXml()).
 *  Apply with `view.dispatch({ changes: edits.map(e => ({...e})) })`. */
export function importMusicXml(state: EditorState, xml: string) {
  return runTabCommand(state, "musicxml-import.import", { xml });
}
