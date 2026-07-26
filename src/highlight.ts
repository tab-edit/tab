// The tab THEME surface (Stan 2026-07-14: themes must be installable like
// VS Code's, and defaults must derive from the host palette, not a foreign
// one).
//
// Architecture — two theming channels, one vocabulary:
//   1. A theme PACK is data: a TabThemeSpec naming this editor's semantic
//      slots (fret, lineName, technique, …, lattice, prose). `tabTheme()`
//      compiles a spec into a CM extension (HighlightStyle + chrome rules).
//      Install via `tablature({ theme })` — the VS Code "install a theme"
//      story, ~15 lines of data per theme.
//   2. Every compiled value is emitted as `var(--tabedit-<slot>, fallback)`,
//      so hosts can ALSO retheme with plain CSS variables and no JS — the
//      `workbench.colorCustomizations` analog.
//
// The tab-specific design decision the defaults encode: in tablature ~70%
// of characters are dash/barline LATTICE. Untagged tokens inherit
// `.cm-content`'s color, so the theme sets the CONTENT base to a receded
// step and lets TAGGED tokens carry the brightness — notes pop out of the
// lattice by contrast (figure/ground), then a few quiet hues distinguish
// categories. Restraint over rainbow: one accent-family hue for notes, one
// warm for techniques, everything structural stays in the gray ramp.
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

/** The themable vocabulary of a tab editor. Every slot is also a CSS
 *  variable (`--tabedit-<slot>`) hosts may override without JS. */
export interface TabThemeSpec {
  readonly dark: boolean;
  readonly colors: {
    /** Untagged content — the dash/barline lattice. Receded on purpose. */
    readonly lattice: string;
    /** Frets and glyph hits — THE content, brightest voice. */
    readonly fret: string;
    readonly lineName: string;
    /** h p s b r … */
    readonly technique: string;
    /** grace, harmonic */
    readonly embellishment: string;
    /** multipliers + measure modifiers (TimeSig/Repeat) */
    readonly modifier: string;
    /** dividers, attributions */
    readonly scaffold: string;
    readonly comment: string;
    /** kind-driven recession (prose blocks, # comments) */
    readonly prose: string;
    /** dotted underline under recognized directives */
    readonly directiveUnderline: string;
    /** the recognized directive span itself — load-bearing config keeps
     *  full text strength above the receded lattice base */
    readonly directiveText: string;
  };
}

const cssVar = (slot: string, fallback: string): string => `var(--tabedit-${slot}, ${fallback})`;

/** Compile a theme spec into a CM extension (token style + chrome rules). */
export function tabTheme(spec: TabThemeSpec): Extension {
  const c = spec.colors;
  const style = HighlightStyle.define(
    [
      { tag: t.number, color: cssVar("fret", c.fret) },
      { tag: t.propertyName, color: cssVar("lineName", c.lineName) },
      { tag: t.arithmeticOperator, color: cssVar("technique", c.technique) },
      { tag: t.bitwiseOperator, color: cssVar("embellishment", c.embellishment) },
      // Measure-scope modifiers (TimeSignature, Repeat, Multiplier) are
      // LOAD-BEARING CONFIG, like a recognized directive: they retime or
      // restructure the bar. Marked by WEIGHT and brightness rather than a
      // fourth hue — this theme's rule is one hue for notes, one for
      // techniques, one for ornaments, and everything structural in the gray
      // ramp. A rare, load-bearing token earns strength, not colour.
      { tag: t.updateOperator, color: cssVar("modifier", c.modifier), fontWeight: "600" },
      { tag: t.annotation, color: cssVar("modifier", c.modifier), fontWeight: "600" },
      { tag: t.separator, color: cssVar("scaffold", c.scaffold) },
      { tag: t.documentMeta, color: cssVar("scaffold", c.scaffold) },
      { tag: t.comment, color: cssVar("comment", c.comment) },
    ],
    { themeType: spec.dark ? "dark" : "light" }
  );
  const chrome = EditorView.theme(
    {
      ".cm-content": { color: cssVar("lattice", c.lattice) },
      ".cm-tabProse, .cm-tabProse span": { color: cssVar("prose", c.prose) },
      ".cm-tabDirective": {
        color: cssVar("directiveText", c.directiveText),
        borderBottom: `1px dotted ${cssVar("directiveUnderline", c.directiveUnderline)}`,
      },
    },
    { dark: spec.dark }
  );
  return [syntaxHighlighting(style), chrome];
}

/** Default dark theme — derived from the app palette (bg #14161a, text
 *  #d7dbe0/#868d99 ramp, ONE accent #5b9dfa). The app is near-monochrome,
 *  so token colors are TINTED GRAYS: hue is a whisper for category
 *  identity; the lattice-vs-notes BRIGHTNESS hierarchy carries the design
 *  (Stan 2026-07-14: saturated palettes read foreign here). */
export const defaultDarkTabTheme: TabThemeSpec = {
  dark: true,
  colors: {
    lattice: "#79818c", // receded: dashes/bars are texture, not content
    fret: "#a9c4e8", // lightest voice, faint accent-blue memory
    lineName: "#9fb3ba", // barely-cyan gray label
    technique: "#c2a884", // muted tan — warm whisper, not amber alarm
    embellishment: "#afa8c9", // dusty lavender
    modifier: "#c9cfd8", // load-bearing config: gray ramp at strength, not a hue
    scaffold: "#868d99", // --text-dim
    comment: "#7d8590",
    prose: "#7d8590",
    directiveUnderline: "#5b9dfa73", // the one true accent, quietly
    directiveText: "#d7dbe0", // --text: config reads at full strength
  },
};

/** Default light theme — same relationships, mirrored values. */
export const defaultLightTabTheme: TabThemeSpec = {
  dark: false,
  colors: {
    lattice: "#8b939e",
    fret: "#3d6a9e",
    lineName: "#527a85",
    technique: "#8a6d43",
    embellishment: "#6f689a",
    modifier: "#2f353d", // mirrored: the gray ramp at strength, not a hue
    scaffold: "#6e7781",
    comment: "#6e7781",
    prose: "#9ba1a8",
    directiveUnderline: "#3d6a9e73",
    directiveText: "#1f2328",
  },
};

/** Both default themes; the active one follows the editor's dark facet. */
export function tabHighlighting(): Extension {
  return [tabTheme(defaultDarkTabTheme), tabTheme(defaultLightTabTheme)];
}
