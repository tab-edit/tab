// Rendering a tab-edit MusicXML export with OSMD/VexFlow — the shared
// pre-flight both front-ends need (extracted from the demo 2026-07-25 so
// the product app is equally crash-proof). Engine-free by construction:
// pure DOM-over-XML-string work, no tree, no props.
//
// Two jobs: (1) TAB↔standard presentation, (2) drop the constructs VexFlow
// THROWS on. MuseScore tolerates them; VexFlow is the stricter oracle, so
// the display path sanitizes rather than letting one bad measure blank the
// whole score. Everything removed is reported so the UI can say so.

export type SheetMode = "tab" | "standard";

/** Make the export OSMD-renderable.
 *
 *  TAB mode: misgrouped stray lines (grammar backlog #18/#19) export
 *  sections whose "instrument" has ONE course → <staff-lines>1</staff-lines>
 *  (VexFlow: "Invalid number of lines: 1") — drop those measures; and
 *  string numbers past the section's staff lines (mixed groupings) →
 *  VexFlow "Invalid note initialization object" — drop just the technical,
 *  the pitch still renders. Attributes persist across a section, so track
 *  the CURRENT staff-lines while walking each part.
 *
 *  STANDARD mode: TAB clefs become G clefs, staff-details (tab tunings) and
 *  technical string/fret go away — pitches are already in the export, so
 *  what remains is ordinary notation. Percussion clefs stay. */
export function sanitizeForOsmd(
  xmlText: string,
  mode: SheetMode
): { xml: string; removed: number } {
  const dom = new DOMParser().parseFromString(xmlText, "application/xml");
  let removed = 0;
  if (mode === "standard") {
    for (const clef of [...dom.querySelectorAll("clef")]) {
      const sign = clef.querySelector("sign");
      if (sign?.textContent === "TAB") {
        sign.textContent = "G";
        const line = clef.querySelector("line");
        if (line) line.textContent = "2";
      }
    }
    for (const details of [...dom.querySelectorAll("staff-details")]) details.remove();
    for (const technical of [...dom.querySelectorAll("technical")]) technical.remove();
  } else {
    for (const part of [...dom.querySelectorAll("part")]) {
      let staffLines = 5;
      for (const measure of [...part.querySelectorAll(":scope > measure")]) {
        const declared = measure.querySelector("staff-lines");
        if (declared) staffLines = Number(declared.textContent);
        if (staffLines < 2) {
          measure.remove();
          removed++;
          continue;
        }
        for (const technical of [...measure.querySelectorAll("technical")]) {
          const string = Number(technical.querySelector("string")?.textContent ?? "1");
          if (!(string >= 1 && string <= staffLines)) technical.remove();
        }
      }
    }
  }
  // Zero-length notes are undrawable (dialect gaps — e.g. RTP colon-frets —
  // can misparse sounds onto one column); VexFlow throws on them.
  for (const note of [...dom.querySelectorAll("note")]) {
    if (Number(note.querySelector("duration")?.textContent ?? "1") <= 0) {
      note.remove();
      removed++;
    }
  }
  // A measure with NO note element at all — not even a rest — makes VexFlow
  // build a StaveNote from nothing and throw "Invalid note initialization
  // object: {}", which blanks the entire score. Tom Sawyer's kit hit exactly
  // this (5 of its 212 measures) once percussion connectors became hits.
  //
  // REPAIRED, not dropped: a bar with nothing in it IS a bar of silence, so
  // saying so in MusicXML keeps the music's timing. Dropping it would shift
  // everything after it. `divisions` and `time` persist across a part, so
  // track them the way staff-lines are tracked above.
  for (const part of [...dom.querySelectorAll("part")]) {
    let divisions = 1;
    let beats = 4;
    let beatType = 4;
    for (const measure of [...part.querySelectorAll(":scope > measure")]) {
      const d = measure.querySelector("divisions");
      if (d) divisions = Number(d.textContent) || divisions;
      const beatsEl = measure.querySelector("time > beats");
      const typeEl = measure.querySelector("time > beat-type");
      if (beatsEl) beats = Number(beatsEl.textContent) || beats;
      if (typeEl) beatType = Number(typeEl.textContent) || beatType;
      if (measure.querySelector("note")) continue;
      const note = dom.createElement("note");
      const rest = dom.createElement("rest");
      rest.setAttribute("measure", "yes");
      const duration = dom.createElement("duration");
      duration.textContent = String(Math.max(1, Math.round((divisions * 4 * beats) / beatType)));
      const voice = dom.createElement("voice");
      voice.textContent = "1";
      note.append(rest, duration, voice);
      measure.append(note);
      removed++;
    }
  }
  return { xml: new XMLSerializer().serializeToString(dom), removed };
}
