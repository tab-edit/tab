// HOVER EXPLANATIONS — the document explaining itself.
//
// THE QUESTION IT ANSWERS (Stan): "did that character register, or am I
// typing into the void?" Tab is a dialect soup; that doubt is the single most
// common one a musician has, and it is answerable at the point of doubt with
// data already in memory.
//
// THE RULE THAT SHAPES EVERYTHING HERE (Stan, 2026-07-26): **the prop layer
// is the truth; the parse tree is a hypothesis.** The base grammar recovers
// aggressively, so a node type is what the grammar GUESSED. An uppercase `H`
// on a hi-hat line parses as `Hammer` and the semantic layer refuses it —
// percussion lines have no techniques, so it becomes an unresolved glyph and
// is dropped from playback and every export. A hover keyed on node type would
// then confirm something false, which is strictly worse than silence: the
// whole feature is a validation instrument, and a validation instrument that
// lies once is worth less than none. Node type may therefore name WHAT THE
// USER WROTE ("written as a hammer-on") but never what it DOES.
//
// TWO TIERS, and the invariant between them: the instant answer is a strict
// SUBSET of the precise one. Widen, never revise.
//
//   TIER 1 — synchronous, 0 ms, always available (snapshot data only):
//     · a diagnostic at the position → the engine's own negative, verbatim,
//       and AUTHORITATIVE (it overrides every affirmative reading);
//     · otherwise, inside a `sounds` range → "this plays". MEASURED, not
//       assumed: an unresolved glyph IS a child of its Sound (`q` at 24-25
//       sits inside a sound range while carrying its own error), so
//       sound-membership alone would confirm the exact case this exists to
//       catch. Membership counts only WITHOUT an overlapping diagnostic.
//     · otherwise nothing — silence is the default.
//
//   TIER 2 — asked once the hover COMMITS (human-paced: a ~300 ms delay and
//     one pointer cannot outrun the inspection budget), through the
//     `inspectionSource` facet. Local answers in-process, remote over the
//     wire; a page with neither is a legitimate Tier-1-only mode. It only
//     ever APPENDS a line.
//
// WHAT STAYS SILENT: lattice (dashes, `=`), barlines, prose and comment
// lines, and every construct whose reading would come from the grammar alone
// — time signatures, repeats, multipliers, bar repeats, line names. Each was
// going to be phrased from node type, which is precisely the speculation the
// rule above forbids; they come back when a prop backs them.

import { syntaxTree } from "@codemirror/language";
import {
  Facet,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
} from "@codemirror/state";
import {
  EditorView,
  hoverTooltip,
  keymap,
  showTooltip,
  type Command,
  type Tooltip,
  type TooltipView,
} from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import type { DiagnosticJSON, InspectionFrame, InspectNodeParams } from "@tab-edit/protocol";
import { snapshotOf, type SemanticSnapshot } from "./snapshot-model.js";

// ─── The Tier-2 seam ─────────────────────────────────────────────────────

/** How the hover asks for precise detail. Populated by the facade builders
 *  (createLocalSemantics / createRemoteSemantics) so an app gets it by
 *  installing the semantics extension it already installs — no app wiring.
 *  Unpopulated is a supported mode: Tier 1 stands alone. */
export type InspectionSource = (
  state: EditorState,
  params: InspectNodeParams
) => Promise<InspectionFrame>;

export const inspectionSource = Facet.define<InspectionSource, InspectionSource | null>({
  combine: (sources) => (sources.length ? sources[0] : null),
});

// ─── The vocabulary (naming only — never behaviour) ──────────────────────

/** Base-tree node name → what the user WROTE. Deliberately a short list:
 *  a name appears only for constructs whose semantic outcome this module can
 *  also report, because a "written as …" line may never stand alone. */
const WRITTEN_AS: ReadonlyMap<string, string> = new Map([
  ["Fret", "written as a fret number"],
  ["GlyphNote", "written as a note glyph"],
  ["Grace", "written as a grace note"],
  ["Hammer", "written as a hammer-on"],
  ["Pull", "written as a pull-off"],
  ["Slide", "written as a slide"],
  ["Bend", "written as a bend"],
  ["Release", "written as a bend release"],
  ["Prebend", "written as a pre-bend"],
]);

/** Semantic node names that carry a note's own resolution. */
const NOTE_NODES = new Set(["FretNote", "GlyphNote", "GhostNote"]);
/** Semantic node names for a connector glyph — routed to the binding, never
 *  to `noteSound` (which answers `unpitched` on a connector by construction
 *  and would read as "this means nothing"). */
const CONNECTOR_NODES = new Set(["Hammer", "Pull", "Slide", "Bend", "Release", "Prebend"]);

const PROP_NOTE_SOUND = "core-pitch/noteSound";
const PROP_TECHNIQUES = "core-articulation/noteTechniques";
const PROP_LINE_NAMES = "core-instrument/lineNames";
const PROP_BINDING = "core-geometry/connectorBinding";

/** What a resolved connector edge does, in a player's words. */
const CONNECTOR_COPY: ReadonlyMap<string, string> = new Map([
  ["hammer", "hammer-on — the note it lands on sounds without a new pick"],
  ["pull", "pull-off — the note it lands on sounds without a new pick"],
  ["slide", "slide — the finger stays down and slides to the next note"],
  ["bend", "bend — the note bends up into the next pitch"],
  ["release", "release — the bend falls back to where it started"],
  ["prebend", "pre-bend — bent up before it is struck"],
]);

/** What a technique event ON A NOTE means for that note. Keyed kind+role. */
const TECHNIQUE_COPY: ReadonlyMap<string, string> = new Map([
  ["ghost", "ghost note — played quietly"],
  ["palm-mute", "palm-muted"],
  ["hammer:start", "hammers on to the next note"],
  ["hammer:stop", "hammered on to from the note before"],
  ["pull:start", "pulls off to the next note"],
  ["pull:stop", "pulled off to from the note before"],
  ["slide:start", "slides to the next note"],
  ["slide:stop", "slid into from the note before"],
  ["bend:start", "bends up"],
  ["bend:stop", "where the bend arrives"],
  ["release:start", "releases the bend"],
  ["release:stop", "where the release lands"],
  ["prebend:start", "already bent when struck"],
  ["prebend:stop", "where the pre-bend lands"],
]);

const PITCH_NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];

/** MIDI number → scientific pitch (60 = C4). Pure. */
export function pitchName(midi: number): string {
  const n = Math.round(midi);
  return `${PITCH_NAMES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`;
}

/** Percussion voice ids are stable machine names; this is the ONLY place
 *  they are made readable, and it stays a transformation rather than a
 *  table so a pack's own voice never renders as a blank. */
export function voiceLabel(voiceId: string): string {
  return voiceId.replace(/-/g, " ").replace(/^hihat/, "hi-hat");
}

// ─── Tier 1: the pure, synchronous copy selection ────────────────────────

/** Everything the synchronous half knows about one position. */
export interface InstantFacts {
  /** Base-tree name at the position — a HYPOTHESIS. null = unnamed, or a
   *  construct this module deliberately stays silent about. */
  readonly written: string | null;
  /** The position lies inside a `sounds` range that no diagnostic touches. */
  readonly playing: boolean;
  /** Other undiagnosed notes struck in the same column (0 = alone). */
  readonly withOthers: number;
  /** Diagnostics overlapping the position — authoritative, verbatim. */
  readonly diagnostics: readonly DiagnosticJSON[];
  /** Prose/comment line: the recession already answers the question. */
  readonly receded: boolean;
}

/** The rendered shape. `problems` render verbatim; nothing here is ever
 *  rewritten by Tier 2, which may only add `detail`. */
export interface HoverCopy {
  readonly kind: string | null;
  readonly lead: string | null;
  readonly problems: readonly DiagnosticJSON[];
  readonly detail: string | null;
}

/** THE Tier-1 decision. `null` means show nothing at all. */
export function instantCopy(facts: InstantFacts): HoverCopy | null {
  if (facts.receded) return null;
  const kind = facts.written !== null ? (WRITTEN_AS.get(facts.written) ?? null) : null;
  if (facts.diagnostics.length > 0) {
    // The engine's own negative wins outright. The "written as" line sits
    // above it, which is the whole teaching moment: "written as a hammer-on
    // — nothing gives "H" a musical meaning here … dropped from playback
    // and every export."
    return { kind, lead: null, problems: facts.diagnostics, detail: null };
  }
  if (facts.playing) {
    const lead =
      facts.withOthers > 0
        ? `this plays · struck with ${facts.withOthers} other note${facts.withOthers > 1 ? "s" : ""}`
        : "this plays";
    return { kind, lead, problems: [], detail: null };
  }
  return null;
}

/** Is a Tier-1 silence worth one inspection ask? Only where the grammar
 *  named something whose OUTCOME a prop can report — a connector never sits
 *  inside a sound range, so it has no Tier-1 answer at all and would
 *  otherwise be permanently mute. */
export function worthRefining(written: string | null): boolean {
  return written !== null && WRITTEN_AS.has(written);
}

// ─── Tier 2: the pure frame reading ──────────────────────────────────────

interface PropLike {
  readonly id: string;
  readonly evaluated: boolean;
  readonly internal: boolean;
  readonly value?: unknown;
  readonly valueTruncated?: boolean;
  readonly error?: string;
}

/** A prop value is usable only when it is a faithful projection. A
 *  truncated value is JSON TEXT, not data — treating it as data is how a
 *  detail line would start inventing things. */
function usable(props: readonly PropLike[], id: string): unknown {
  const p = props.find((x) => x.id === id);
  if (!p || p.internal || !p.evaluated || p.valueTruncated || p.error) return undefined;
  return p.value;
}

interface FrameLike {
  readonly chain: readonly {
    readonly nodeName: string;
    readonly props: readonly PropLike[];
  }[];
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** Search the whole chain for a prop — line names live on the block, the
 *  binding on the connector group. */
function chainValue(frame: FrameLike, id: string): unknown {
  for (const node of frame.chain) {
    const v = usable(node.props, id);
    if (v !== undefined) return v;
  }
  return undefined;
}

function noteDetail(props: readonly PropLike[], lineNames: readonly string[]): string | null {
  const sound = asRecord(usable(props, PROP_NOTE_SOUND));
  if (!sound) return null;
  const course = typeof sound.course === "number" ? sound.course : -1;
  const line = lineNames[course];
  const onLine = line ? ` on the ${line} string` : "";
  const parts: string[] = [];
  switch (sound.kind) {
    case "pitched":
      parts.push(
        typeof sound.fret === "number"
          ? `fret ${sound.fret}${onLine} · sounds ${pitchName(Number(sound.midi))}`
          : `sounds ${pitchName(Number(sound.midi))}${onLine}`
      );
      break;
    case "dead":
      parts.push(`a dead note${onLine} — struck and damped, no pitch`);
      break;
    case "percussion":
      parts.push(voiceLabel(String(sound.voiceId)));
      break;
    case "unpitched":
      // Reached only when the lint gates deliberately kept quiet about this
      // glyph. Asked directly, the honest answer is still the negative one,
      // in the same words the engine uses everywhere else.
      return "nothing gives this a musical meaning here — it is left out of playback and every export";
    default:
      return null;
  }
  const events = usable(props, PROP_TECHNIQUES);
  if (Array.isArray(events)) {
    for (const raw of events) {
      const e = asRecord(raw);
      if (!e) continue;
      const key = e.role ? `${String(e.kind)}:${String(e.role)}` : String(e.kind);
      const copy = TECHNIQUE_COPY.get(key);
      if (copy && !parts.includes(copy)) parts.push(copy);
    }
  }
  return parts.join(" · ");
}

function connectorDetail(frame: FrameLike): string | null {
  const edges = chainValue(frame, PROP_BINDING);
  if (!Array.isArray(edges) || edges.length === 0) return null;
  const lines: string[] = [];
  for (const raw of edges) {
    const edge = asRecord(raw);
    if (!edge) continue;
    const copy = CONNECTOR_COPY.get(String(edge.kind));
    if (!copy) continue;
    // A dangling end is the engine being honest, and so is this: state the
    // gap, not what an exporter will do about it.
    const dangling = edge.source === undefined || edge.target === undefined;
    const text = dangling ? `${copy.split(" — ")[0]} — nothing on the other end of it` : copy;
    if (!lines.includes(text)) lines.push(text);
  }
  return lines.length > 0 ? lines.join(" · ") : null;
}

/** THE Tier-2 decision: one appended line, or nothing. Never contradicts
 *  Tier 1 — it reports the same resolution at higher resolution. */
export function refinedDetail(frame: FrameLike): string | null {
  const deepest = frame.chain[0];
  if (!deepest) return null;
  const names = chainValue(frame, PROP_LINE_NAMES);
  const lineNames: readonly string[] = Array.isArray(names) ? (names as string[]) : [];
  if (NOTE_NODES.has(deepest.nodeName)) return noteDetail(deepest.props, lineNames);
  if (CONNECTOR_NODES.has(deepest.nodeName)) return connectorDetail(frame);
  return null;
}

// ─── Gathering the facts from live state ─────────────────────────────────

const overlapsPos = (from: number, to: number, pos: number): boolean =>
  from === to ? from === pos : pos >= from && pos < to;

/** The base-tree node the pointer is on, narrowed to a name this module has
 *  a vocabulary for. Cheap: `resolveInner` walks an already-built tree. */
function writtenAt(state: EditorState, pos: number): { name: string; from: number; to: number } | null {
  const tree = syntaxTree(state);
  for (const side of [1, -1] as const) {
    let node: SyntaxNode | null = tree.resolveInner(pos, side);
    for (let depth = 0; node && depth < 4; depth++) {
      if (WRITTEN_AS.has(node.name)) return { name: node.name, from: node.from, to: node.to };
      node = node.parent;
    }
  }
  return null;
}

function factsAt(
  state: EditorState,
  pos: number
): { facts: InstantFacts; from: number; to: number } | null {
  const snap: SemanticSnapshot | null = snapshotOf(state);
  const written = writtenAt(state, pos);
  if (!snap) {
    return written ? { facts: emptyFacts(written.name), from: written.from, to: written.to } : null;
  }
  const lineStart = state.doc.lineAt(pos).from;
  const receded = snap.recededLineStarts.includes(lineStart);
  const diagnostics = snap.diagnostics.filter((d) => overlapsPos(d.from, d.to, pos));
  const clean = (from: number, to: number): boolean =>
    !snap.diagnostics.some((d) => d.from < to && from < d.to);
  const sound = snap.sounds.find((s) => s.ranges.some((r) => overlapsPos(r.from, r.to, pos)));
  const playing = !!sound && diagnostics.length === 0;
  const withOthers = playing
    ? sound.ranges.filter((r) => clean(r.from, r.to)).length - 1
    : 0;
  const facts: InstantFacts = {
    written: written?.name ?? null,
    playing,
    withOthers: Math.max(withOthers, 0),
    diagnostics,
    receded,
  };
  const span = written ?? sound?.ranges.find((r) => overlapsPos(r.from, r.to, pos)) ?? null;
  const hit = diagnostics[0];
  return {
    facts,
    from: span?.from ?? hit?.from ?? pos,
    to: span?.to ?? hit?.to ?? pos,
  };
}

/** The whole synchronous half against live state — what the tooltip shows
 *  the instant it opens, and the headless-testable seam for it. */
export function instantAt(state: EditorState, pos: number): HoverCopy | null {
  const found = factsAt(state, pos);
  return found ? instantCopy(found.facts) : null;
}

const emptyFacts = (written: string | null): InstantFacts => ({
  written,
  playing: false,
  withOthers: 0,
  diagnostics: [],
  receded: false,
});

// ─── Rendering (one tooltip language — see the theme below) ──────────────

function element(cls: string, text?: string): HTMLElement {
  const el = document.createElement("div");
  el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

function renderCopy(view: EditorView, copy: HoverCopy): HTMLElement {
  const dom = element("cm-tab-hover");
  dom.setAttribute("role", "tooltip");
  if (copy.kind) dom.appendChild(element("cm-tab-hover-kind", copy.kind));
  if (copy.lead) dom.appendChild(element("cm-tab-hover-lead", copy.lead));
  for (const d of copy.problems) {
    const box = element(`cm-tab-hover-problem cm-tab-hover-${d.severity}`);
    box.appendChild(element("cm-tab-hover-message", d.message));
    for (const fix of d.fixes ?? []) {
      // The merge keeps the affordance the lint tooltip owned: clicking a fix
      // dispatches its edits as one undoable transaction.
      const button = document.createElement("button");
      button.className = "cm-tab-hover-fix";
      button.textContent = fix.title;
      button.onclick = () => view.dispatch({ changes: fix.edits.map((e) => ({ ...e })) });
      box.appendChild(button);
    }
    dom.appendChild(box);
  }
  if (copy.detail) dom.appendChild(element("cm-tab-hover-detail", copy.detail));
  return dom;
}

const REFINE_TIMEOUT_MS = 1_500;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      }
    );
  });
}

/** Mount the copy and, if a source is installed, widen it in place once the
 *  frame arrives. Never blocks: Tier 1 is on screen before the ask leaves. */
function tooltipView(view: EditorView, pos: number, copy: HoverCopy): TooltipView {
  const dom = renderCopy(view, copy);
  let live = true;
  const source = view.state.facet(inspectionSource);
  if (source) {
    withTimeout(source(view.state, { pos }), REFINE_TIMEOUT_MS).then((frame) => {
      if (!live || !frame) return;
      const detail = refinedDetail(frame);
      if (!detail) return;
      dom.appendChild(element("cm-tab-hover-detail", detail));
      view.requestMeasure();
    });
  }
  return {
    dom,
    destroy() {
      live = false;
    },
  };
}

/** The Tier-2-only path: nothing to say yet, but a prop might have an
 *  answer. Resolves to a tooltip or to nothing — a box never appears empty
 *  and never appears saying only what the grammar guessed. */
async function refinedOnly(
  view: EditorView,
  pos: number,
  copy: HoverCopy,
  from: number,
  to: number
): Promise<Tooltip | null> {
  const source = view.state.facet(inspectionSource);
  if (!source) return null;
  const frame = await withTimeout(source(view.state, { pos }), REFINE_TIMEOUT_MS);
  if (!frame) return null;
  const detail = refinedDetail(frame);
  if (!detail) return null;
  const full: HoverCopy = { ...copy, detail };
  return {
    pos: from,
    end: to,
    above: false,
    create: (v) => ({ dom: renderCopy(v, full) }),
  };
}

// ─── The extension ───────────────────────────────────────────────────────

/** Scroll dismissal: hover tooltips are dismissed by transactions, and a
 *  scroll is not one. This effect makes it one — dispatched only while a
 *  tooltip is actually up, so idle scrolling costs nothing. */
const dismissHover = StateEffect.define<null>();

function hoverSource(view: EditorView, pos: number, side: -1 | 1): Tooltip | Promise<Tooltip | null> | null {
  if (view.state.field(cursorExplanation, false)) return null; // the keyboard box owns the screen
  const found = factsAt(view.state, pos + (side < 0 ? -1 : 0));
  if (!found) return null;
  const copy = instantCopy(found.facts);
  if (!copy) {
    if (!worthRefining(found.facts.written)) return null;
    const kind = WRITTEN_AS.get(String(found.facts.written)) ?? null;
    return refinedOnly(view, pos, { kind, lead: null, problems: [], detail: null }, found.from, found.to);
  }
  return {
    pos: found.from,
    end: found.to,
    above: false,
    create: (v) => tooltipView(v, pos, copy),
  };
}

const tabHoverTooltip = hoverTooltip(hoverSource, {
  hoverTime: 300,
  hideOnChange: true,
  hideOn: (tr) => tr.effects.some((e) => e.is(dismissHover)),
});

const scrollDismiss = EditorView.domEventHandlers({
  scroll(_event, view) {
    if (view.state.field(tabHoverTooltip.active).length > 0) {
      view.dispatch({ effects: dismissHover.of(null) });
    }
    return false;
  },
});

// ─── Keyboard parity ─────────────────────────────────────────────────────
//
// Hover-only information is inaccessible information. The same copy, at the
// caret, on a key that the editor's own maps leave free (searchKeymap,
// lintKeymap, defaultKeymap and historyKeymap all do). It is a TOGGLE, it
// never takes focus, and any edit or caret move clears it.

const showExplanation = StateEffect.define<Tooltip | null>();

const cursorExplanation = StateField.define<Tooltip | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(showExplanation)) return e.value;
    if (tr.docChanged || tr.selection || tr.effects.some((e) => e.is(dismissHover))) return null;
    return value;
  },
  provide: (f) => showTooltip.from(f),
});

/** `Mod-i` — explain what is under the caret. Always returns true: the
 *  editor's content is contenteditable, and letting `Mod-i` through invites
 *  the browser's own italic command into a document that has no such thing. */
const explainAtCursor: Command = (view) => {
  if (view.state.field(cursorExplanation, false)) {
    view.dispatch({ effects: showExplanation.of(null) });
    return true;
  }
  const pos = view.state.selection.main.head;
  const found = factsAt(view.state, pos);
  if (!found) return true;
  const copy = instantCopy(found.facts);
  const kind = found.facts.written ? (WRITTEN_AS.get(found.facts.written) ?? null) : null;
  if (!copy) {
    if (!worthRefining(found.facts.written)) return true;
    void refinedOnly(view, pos, { kind, lead: null, problems: [], detail: null }, found.from, found.to).then(
      (tip) => {
        if (tip) view.dispatch({ effects: showExplanation.of(announce(tip)) });
      }
    );
    return true;
  }
  view.dispatch({
    effects: showExplanation.of(
      announce({
        pos: found.from,
        end: found.to,
        above: false,
        create: (v) => tooltipView(v, pos, copy),
      })
    ),
  });
  return true;
};

/** A tooltip the caret conjured must announce itself — the pointer path has
 *  the pointer as its own announcement, the keyboard path has nothing. */
function announce(tip: Tooltip): Tooltip {
  return {
    ...tip,
    create: (v) => {
      const inner = tip.create(v);
      inner.dom.setAttribute("aria-live", "polite");
      return inner;
    },
  };
}

const dismissExplanation: Command = (view) => {
  if (!view.state.field(cursorExplanation, false)) return false;
  view.dispatch({ effects: showExplanation.of(null) });
  return true;
};

const hoverTheme = EditorView.baseTheme({
  // ONE tooltip language: the lint tooltip's geometry and type scale, in the
  // theme's gray ramp. Nothing here is brighter than the music it describes.
  ".cm-tab-hover": {
    padding: "5px 9px 6px",
    maxWidth: "36em",
    lineHeight: "1.45",
    fontSize: "12px",
    fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif",
  },
  ".cm-tab-hover-kind": { fontSize: "11px", opacity: "0.55", marginBottom: "1px" },
  ".cm-tab-hover-lead": { opacity: "0.95" },
  ".cm-tab-hover-detail": { opacity: "0.78", marginTop: "1px" },
  // The error hue this product already speaks (the lint underline's), at a
  // quarter of the lint tooltip's bar width — same vocabulary, less shouting.
  ".cm-tab-hover-problem": { borderLeft: "2px solid #999", paddingLeft: "7px", marginTop: "3px" },
  ".cm-tab-hover-error": { borderLeftColor: "#d11" },
  ".cm-tab-hover-warning": { borderLeftColor: "#b8823a" },
  ".cm-tab-hover-fix": {
    font: "inherit",
    fontSize: "11px",
    border: "1px solid #8886",
    borderRadius: "3px",
    padding: "1px 6px",
    marginTop: "4px",
    marginRight: "6px",
    background: "transparent",
    color: "inherit",
    cursor: "pointer",
    display: "inline-block",
  },
});

/** Hover explanations for `tablature()` / `remoteTablature()`. */
export function tabHover(): Extension {
  return [
    cursorExplanation,
    tabHoverTooltip,
    scrollDismiss,
    keymap.of([
      { key: "Mod-i", run: explainAtCursor },
      { key: "Escape", run: dismissExplanation },
    ]),
    hoverTheme,
  ];
}
