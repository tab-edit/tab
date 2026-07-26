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
  return { xml: new XMLSerializer().serializeToString(dom), removed };
}
