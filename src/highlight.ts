// Explicit token colors for the tab grammar (Stan 2026-07-14: highlighting
// was silently broken and NOTHING asserted it — the base tree carries tags,
// minimalSetup's fallback default style just never rendered them). The
// adapter ships its OWN HighlightStyle: token colors become deliberate,
// dark/light aware, and regression-checked instead of inherited from a
// generic code theme's fallback path.
//
// Rules target the BASE lezer tags the grammar's tabTags DERIVE from
// (grammar: `Tag.define(t.integer)` etc. — styles match derived tags), so
// no parse-package export surface is needed until finer targeting is.
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { tags as t } from "@lezer/highlight";

// Frets/glyph hits are THE content — they get the clearest color; the
// scaffold (dividers, attributions) stays quiet by design.
const rules = (c: {
  fret: string;
  name: string;
  technique: string;
  embellishment: string;
  multiplier: string;
  modifier: string;
  scaffold: string;
  comment: string;
}) => [
  { tag: t.number, color: c.fret }, // frets + GlyphNote hits
  { tag: t.propertyName, color: c.name }, // measure-line names
  { tag: t.arithmeticOperator, color: c.technique }, // h p s b r …
  { tag: t.bitwiseOperator, color: c.embellishment }, // grace, harmonic
  { tag: t.updateOperator, color: c.multiplier },
  { tag: t.annotation, color: c.modifier }, // TimeSig / Repeat attributes
  { tag: t.separator, color: c.scaffold }, // dividers, delimiters
  { tag: t.documentMeta, color: c.scaffold }, // attributions
  { tag: t.comment, color: c.comment },
];

const darkStyle = HighlightStyle.define(
  rules({
    fret: "#6cb6ff",
    name: "#7ee787",
    technique: "#e3b341",
    embellishment: "#d2a8ff",
    multiplier: "#ffa657",
    modifier: "#ffa657",
    scaffold: "#8b949e",
    comment: "#7d8590",
  }),
  { themeType: "dark" }
);

const lightStyle = HighlightStyle.define(
  rules({
    fret: "#0550ae",
    name: "#116329",
    technique: "#953800",
    embellishment: "#6639ba",
    multiplier: "#bc4c00",
    modifier: "#bc4c00",
    scaffold: "#6e7781",
    comment: "#6e7781",
  }),
  { themeType: "light" }
);

/** Deliberate tab token coloring for `tablature()` (both theme types). */
export function tabHighlighting(): Extension {
  return [syntaxHighlighting(darkStyle), syntaxHighlighting(lightStyle)];
}
