// Demo page for the tab-edit CodeMirror 6 adapter: an editor pane plus two
// live panes — the semantic AST and diagnostics-with-fixes — driven purely
// through the public @tab-edit/cm surface (../src/index.ts). No src/ edits.
import { minimalSetup } from "codemirror";
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { searchKeymap } from "@codemirror/search";
import { lintGutter, lintKeymap } from "@codemirror/lint";
import { OpenSheetMusicDisplay } from "opensheetmusicdisplay";
import { SAMPLES } from "./samples.js";
import { createPlayer } from "./playback.js";
import { Compartment, EditorSelection, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet } from "@codemirror/view";
import {
  computeActivity,
  importMusicXml,
  inspectNode,
  midiFile,
  musicXml,
  selectionNodeHighlight,
  tablature,
  tabStateDiagnostics,
  tabTree,
  type ComputeReport,
  type PropInspection,
} from "../src/index.js";

const INITIAL_DOC =
  "Title: Demo Song\nTempo: 100\n\n" +
  "e|--0--2--3--|--2--0-----|\n" +
  "B|3--------0-|-----3--1--|\n" +
  "G|-----------|-----------|\n" +
  "D|-----------|-----------|\n" +
  "A|-----------|-----------|\n" +
  "E|-----------|-----------|\n";

const astEl = document.getElementById("ast") as HTMLElement;
const diagnosticsEl = document.getElementById("diagnostics") as HTMLElement;
const activityEl = document.getElementById("activity") as HTMLElement;
const inspectorEl = document.getElementById("inspector") as HTMLElement;
const sheetEl = document.getElementById("sheet") as HTMLElement;
const editorHost = document.getElementById("editor") as HTMLElement;

// One-line explanations for the Activity pane (legend + row hovers).
const ACTIVITY_EXPLAIN: Record<string, string> = {
  carried: "Reused untouched — zero work. This is the incrementality working.",
  equal:
    "Re-parsed (edit inside or hugging the boundary) but came out identical — real work, same result.",
  new: "Content changed: re-parsed, props recompute as they're read.",
  state: "Parse reused, but the listed prop values recomputed.",
  doc: "Document-wide folds (measure numbers, directive timeline) that recomputed.",
  summary: "One run = one prop computed for one node. Fewer runs after a small edit = better.",
  propsSummary: "Cached = reading it did zero work; the rest computed for this inspection.",
};

// ——— Activity flash: transient background tint on segments that DID work
// this cycle (red = re-parsed with new content, amber = re-parsed equal,
// blue = only state recomputed). Carried segments stay untinted — the
// visible gap IS the incrementality.
const setFlashes = StateEffect.define<{ from: number; to: number; kind: string }[]>();
const flashMarks: Record<string, Decoration> = {
  new: Decoration.mark({ class: "flash-new" }),
  equal: Decoration.mark({ class: "flash-equal" }),
  state: Decoration.mark({ class: "flash-state" }),
};
const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setFlashes)) {
        deco = Decoration.set(
          e.value
            .filter((f) => f.from < f.to)
            .map((f) => flashMarks[f.kind].range(f.from, f.to)),
          true
        );
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// Diagnostics render as background tints, not squiggles — done purely in
// CSS over CM's own .cm-lintRange marks (style.css), so hover tooltips,
// fix actions, and the gutter all keep working.

let flashClearTimer: ReturnType<typeof setTimeout> | undefined;
function flashActivity(report: ComputeReport): void {
  const flashes = report.segments
    .map((s) => {
      const stateRuns = s.recomputes.size > 0;
      const kind =
        s.artifact === "new" ? "new" : s.artifact === "equal" ? "equal" : stateRuns ? "state" : null;
      return kind ? { from: s.from, to: s.to, kind } : null;
    })
    .filter((f): f is NonNullable<typeof f> => f !== null);
  if (flashes.length === 0) return;
  view.dispatch({ effects: setFlashes.of(flashes) });
  if (flashClearTimer !== undefined) clearTimeout(flashClearTimer);
  flashClearTimer = setTimeout(() => view.dispatch({ effects: setFlashes.of([]) }), 900);
}

let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let generation = 0;

// The AST row the user clicked, pinned so the re-render highlights THAT
// node (not its deepest descendant at the same position) and the inspector
// inspects it. Cleared as soon as the selection moves off its ranges.
let pinned: { index: number; signature: string } | null = null;

const rangeSignature = (ranges: readonly { from: number; to: number }[]): string =>
  ranges.map((r) => `${r.from}-${r.to}`).join(",");

// Column selection and selection-highlighting are toggled live from the
// topbar checkboxes; each rides its own Compartment so a checkbox flip is a
// single reconfigure transaction rather than tearing down the whole editor.
// tablature() itself keeps its defaults off (`false`) — these compartments
// are the ONLY source of the two behaviors here.
const columnSelectionCompartment = new Compartment();
const editableCompartment = new Compartment(); // read-only while playing
const highlightSelectionCompartment = new Compartment();
const columnSelectionExtension = rectangularSelection({ eventFilter: (e) => e.detail === 1 });
const highlightSelectionExtension = selectionNodeHighlight();

const view = new EditorView({
  doc: INITIAL_DOC,
  extensions: [
    // minimalSetup + only what a tab editor needs from basicSetup. Deliberately
    // absent: highlightActiveLine/highlightActiveLineGutter (a full-width line
    // bar misleads in a COLUMN-based notation — selectionNodeHighlight owns
    // "where am I") and the prose extras (folding, bracket closing,
    // autocompletion, indent-on-input).
    minimalSetup,
    lineNumbers(),
    dropCursor(),
    crosshairCursor(),
    // NO highlightSelectionMatches: tab text is a tiny alphabet dominated
    // by dash runs, so "similar text" floods the doc on any selection
    // (Stan 2026-07-13). Explicit search (Cmd-F) covers the motif case.
    keymap.of([...searchKeymap, ...lintKeymap]),
    // drawSelection EXPLICITLY (don't trust setup bundles): it renders the
    // caret + selection layer, incl. while unfocused — required for the
    // playback follow-cursor to be VISIBLE. Themes beat CM's injected base
    // theme by specificity; plain CSS in style.css loses to it.
    drawSelection(),
    EditorView.theme(
      {
        ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#e8e8e8" },
        // one visible caret even in column selections (Stan: no multi-cursors)
        ".cm-cursor-secondary": { display: "none" },
        "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
          background: "rgba(91, 157, 250, 0.28)",
        },
      },
      { dark: true }
    ),
    tablature({ columnSelection: false, highlightSelection: false }),
    columnSelectionCompartment.of(columnSelectionExtension),
    highlightSelectionCompartment.of(highlightSelectionExtension),
    lintGutter(),
    flashField,
    editableCompartment.of(EditorView.editable.of(true)),
    EditorView.updateListener.of((update) => {
      // An edit while paused invalidates the playback timeline's spans —
      // stop cleanly instead of playing stale positions.
      if (update.docChanged && player) stopPlayback();
      if (update.docChanged || update.selectionSet) scheduleRefresh();
    }),
  ],
  parent: editorHost,
});

// ——— Sample picker (first demo users): quiet dropdown, grouped by
// instrument; picking one replaces the whole doc (undoable). The built-in
// starter doc stays the default. ———
const samplePicker = document.getElementById("sample-picker") as HTMLSelectElement;
{
  const starter = document.createElement("option");
  starter.value = "__starter";
  starter.textContent = "samples…";
  samplePicker.appendChild(starter);
  SAMPLES.forEach((g, gi) => {
    const group = document.createElement("optgroup");
    group.label = g.group;
    g.items.forEach((item, ii) => {
      const opt = document.createElement("option");
      opt.value = `${gi}:${ii}`;
      opt.textContent = item.label;
      group.appendChild(opt);
    });
    samplePicker.appendChild(group);
  });
}
samplePicker.addEventListener("change", () => {
  const [gi, ii] = samplePicker.value.split(":").map(Number);
  const text = SAMPLES[gi]?.items[ii]?.text;
  if (text === undefined) return;
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
  view.focus();
});

// ——— Transport (bottom bar): selection-aware ▶/⏸, scrubbable progress,
// follow-the-playhead (cursor moves to each sound, selected — Stan), and
// the editor goes READ-ONLY while playing so playhead spans stay truthful.
const playButton = document.getElementById("play") as HTMLButtonElement;
const slider = document.getElementById("transport-slider") as HTMLInputElement;
const timeEl = document.getElementById("transport-time") as HTMLElement;
const followButton = document.getElementById("follow-playhead") as HTMLButtonElement;
const timbrePicker = document.getElementById("timbre-picker") as HTMLSelectElement;
let player: ReturnType<typeof createPlayer> = null;
let followPlayhead = true;
let lastSpanKey = "";
let raf = 0;

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const setEditable = (on: boolean) =>
  view.dispatch({ effects: editableCompartment.reconfigure(EditorView.editable.of(on)) });

const stopPlayback = () => {
  if (!player) return;
  player.stop();
  player = null;
  cancelAnimationFrame(raf);
  playButton.textContent = "▶";
  slider.disabled = true;
  slider.value = "0";
  timeEl.textContent = "";
  setEditable(true);
  view.dispatch({ effects: setFlashes.of([]) });
};

const tick = () => {
  if (!player) return;
  const p = player.progress();
  slider.value = String(Math.round((p.sec / p.totalSec) * 1000));
  timeEl.textContent = `${fmt(p.sec)} / ${fmt(p.totalSec)}`;
  if (followPlayhead && p.span) {
    const key = `${p.span.from}-${p.span.to}`;
    if (key !== lastSpanKey) {
      lastSpanKey = key;
      // Selection AND a decoration flash: decorations render regardless of
      // focus/selection-layer subtleties, so the playhead is unmissable.
      view.dispatch({
        selection: { anchor: p.span.from, head: p.span.to },
        effects: [
          EditorView.scrollIntoView(p.span.from, { y: "center" }),
          setFlashes.of([{ from: p.span.from, to: p.span.to, kind: "state" }]),
        ],
      });
    }
  }
  if (p.ended) stopPlayback();
  else raf = requestAnimationFrame(tick);
};

const togglePlayback = () => {
  if (player) {
    if (player.paused) {
      player.resume();
      playButton.textContent = "⏸";
      setEditable(false);
      raf = requestAnimationFrame(tick);
    } else {
      player.pause();
      playButton.textContent = "▶";
      setEditable(true); // paused = editable again; an edit stops playback
    }
    return;
  }
  player = createPlayer(
    view.state,
    view.state.selection.ranges,
    timbrePicker.value as import("./playback.js").Timbre
  );
  if (!player) return;
  playButton.textContent = "⏸";
  slider.disabled = false;
  lastSpanKey = "";
  setEditable(false);
  view.focus(); // readOnly; focus makes the follow-selection fully visible
  raf = requestAnimationFrame(tick);
};

playButton.addEventListener("click", togglePlayback);
slider.addEventListener("input", () => {
  if (!player) return;
  player.seek((Number(slider.value) / 1000) * player.totalSec);
});
followButton.addEventListener("click", () => {
  followPlayhead = !followPlayhead;
  followButton.classList.toggle("active", followPlayhead);
});
document.addEventListener("keydown", (e) => {
  // While playing the editor is read-only, so Space is safe EVERYWHERE;
  // when idle it only triggers outside the editor/input fields.
  if (
    e.code === "Space" &&
    (player !== null || (!view.hasFocus && document.activeElement?.tagName !== "INPUT"))
  ) {
    e.preventDefault();
    togglePlayback();
  }
  if (e.code === "Escape" && player) stopPlayback();
});

// Menus: close on click-away (native <details> keeps them open otherwise).
document.addEventListener("click", (e) => {
  for (const menu of document.querySelectorAll("details.menu[open]")) {
    if (!menu.contains(e.target as Node)) menu.removeAttribute("open");
  }
});

// ——— Rotating footer tips: genuinely useful, one every 45s (random,
// never the same twice in a row; 20s read as busy — Stan agreed). ———
const TIPS: readonly string[] = [
  "delete the letter at the start of a tab line — the app derives the missing name and Diagnostics offers a one-click fix",
  "drag across the tab to select a column: tabs are column-based, so a selection is a time slice across all strings",
  "click any note and the Inspector shows everything computed for it — pitch, timing, measure, and which plugin decided",
  "the Sheet pane re-renders live as you type; toggle it between TAB and standard notation",
  "Export MIDI plays in any player; Export/Import MusicXML round-trips the music itself — prose and annotations aren't carried over",
  "prose lives alongside music: add a line like “Tuning: D A D G B e” or “Tempo: 140” above a block and watch it take effect",
  "pick a sample from the dropdown up top — real drum, bass, and guitar tabs, plus a 16th-century lute piece",
];
const tipEl = document.getElementById("tip") as HTMLElement;
let tipIndex = Math.floor(Math.random() * TIPS.length);
const showTip = () => {
  tipEl.textContent = `Tip: ${TIPS[tipIndex]}`;
};
showTip();
setInterval(() => {
  const next = Math.floor(Math.random() * (TIPS.length - 1));
  tipIndex = next >= tipIndex ? next + 1 : next;
  showTip();
}, 45_000);

// Exposed for console poking and the Playwright verify loop.
Object.assign(globalThis, { view });

// Topbar toggles: column select (plain-drag rectangular selection) and
// selection-node highlighting (Sounds + Measures the selection touches).
const columnSelectionToggle = document.getElementById("toggle-column-selection") as HTMLInputElement;
const highlightSelectionToggle = document.getElementById(
  "toggle-highlight-selection"
) as HTMLInputElement;
columnSelectionToggle.addEventListener("change", () => {
  view.dispatch({
    effects: columnSelectionCompartment.reconfigure(
      columnSelectionToggle.checked ? columnSelectionExtension : []
    ),
  });
});
highlightSelectionToggle.addEventListener("change", () => {
  view.dispatch({
    effects: highlightSelectionCompartment.reconfigure(
      highlightSelectionToggle.checked ? highlightSelectionExtension : []
    ),
  });
});

// Side panes: header click collapses.
for (const pane of document.querySelectorAll(".side-panes .pane")) {
  pane.querySelector("h2")?.addEventListener("click", () => pane.classList.toggle("collapsed"));
}

// Divider handles between panes — the primary resize affordance (the old
// corner nub was undiscoverable). Dragging sets the pane ABOVE's height
// directly; panes keep plain fixed heights otherwise (predictable beats
// clever — leftover room below the last pane is fine).
const sidePanes = [...document.querySelectorAll<HTMLElement>(".side-panes .pane")];
for (const pane of sidePanes.slice(0, -1)) {
  const divider = document.createElement("div");
  divider.className = "pane-divider";
  pane.after(divider);
  divider.addEventListener("pointerdown", (down) => {
    if (pane.classList.contains("collapsed")) return;
    down.preventDefault();
    divider.setPointerCapture(down.pointerId);
    const startY = down.clientY;
    const startHeight = pane.getBoundingClientRect().height;
    const move = (e: PointerEvent) => {
      pane.style.height = `${Math.max(34, startHeight + e.clientY - startY)}px`;
    };
    const stop = () => {
      divider.removeEventListener("pointermove", move);
      divider.removeEventListener("pointerup", stop);
    };
    divider.addEventListener("pointermove", move);
    divider.addEventListener("pointerup", stop);
  });
}

// Kick off the first render (the initial state hasn't gone through the
// update listener yet).
scheduleRefresh();

function scheduleRefresh(): void {
  if (debounceTimer !== undefined) clearTimeout(debounceTimer);
  const gen = ++generation;
  debounceTimer = setTimeout(() => pollAndRender(gen), 100);
}

/** tabTree() may still be null right after an edit — CM schedules the
 *  parse; poll at 50ms until it settles, bailing after ~2s. */
function pollAndRender(gen: number, attempt = 0): void {
  if (gen !== generation) return; // superseded by a newer edit
  const tree = tabTree(view.state);
  if (!tree) {
    if (attempt < 40) setTimeout(() => pollAndRender(gen, attempt + 1), 50);
    return;
  }
  // Selection moved off the pinned node's ranges → unpin.
  if (pinned && rangeSignature(view.state.selection.ranges) !== pinned.signature) {
    pinned = null;
  }
  renderAst(tree, view.state.selection.main.from);
  renderDiagnostics();
  // AFTER the reads above — pull model: reads are where computes happen,
  // so the report now attributes this cycle's actual work.
  const report = computeActivity(view.state);
  if (report) {
    renderActivity(report);
    flashActivity(report);
  }
  renderInspector(tree);
  // Drain the inspector's own reads so they don't pollute the NEXT edit's
  // report; surface their cost as a footnote instead.
  const inspectorCost = computeActivity(view.state);
  if (inspectorCost && inspectorCost.totalRecomputes > 0) {
    const note = document.createElement("div");
    note.className = "activity-summary";
    note.textContent = `+ ${inspectorCost.totalRecomputes} runs from the Inspector pane`;
    activityEl.appendChild(note);
  }
  void renderSheet(tree);
}

// ——— Live sheet music: the REAL musicXml export rendered by OSMD. The
// per-section XML cache (§7.4) does the incremental work; this pane just
// re-renders when the tree changes.
const sheetStatusEl = document.getElementById("sheet-status") as HTMLElement;
const sheetScoreEl = document.getElementById("sheet-score") as HTMLElement;
const osmd = new OpenSheetMusicDisplay(sheetScoreEl, {
  autoResize: true, // reflow to the pane width — no horizontal clipping
  backend: "svg",
  drawTitle: true,
});
let sheetTree: unknown = null;
let sheetGeneration = 0;
let sheetLoaded = false;

function sheetStatus(message: string | null): void {
  sheetStatusEl.hidden = message === null;
  sheetStatusEl.textContent = message ?? "";
}

type SheetMode = "tab" | "standard";
let sheetMode: SheetMode = "tab";

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
function sanitizeForOsmd(xmlText: string, mode: SheetMode): { xml: string; removed: number } {
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

async function renderSheet(tree: NonNullable<ReturnType<typeof tabTree>>): Promise<void> {
  if (tree === sheetTree) return;
  sheetTree = tree;
  const gen = ++sheetGeneration;
  const xml = musicXml(view.state);
  computeActivity(view.state); // drain export reads out of edit attribution
  if (!xml.includes("<measure")) {
    // Nothing renderable (empty/prose-only doc) — OSMD throws on it.
    sheetStatusEl.hidden = false;
    sheetStatusEl.textContent = "nothing to render yet — add a tab block";
    return;
  }
  try {
    const { xml: renderable, removed } = sanitizeForOsmd(xml, sheetMode);
    await osmd.load(renderable);
    if (gen !== sheetGeneration) return; // superseded while loading
    osmd.render();
    sheetLoaded = true;
    sheetStatus(
      removed > 0
        ? `${removed} measure${removed === 1 ? "" : "s"} skipped: 1-line staves from stray/misgrouped tab lines (grammar backlog)`
        : null
    );
  } catch (e) {
    if (gen !== sheetGeneration) return;
    // Keep the last good score visible; report above it.
    sheetStatus(`sheet rendering failed: ${(e as Error).message}`);
  }
}

// TAB ↔ standard notation toggle: same export, different sanitize pass.
const sheetModeBtn = document.getElementById("sheet-mode") as HTMLButtonElement;
sheetModeBtn.addEventListener("click", () => {
  sheetMode = sheetMode === "tab" ? "standard" : "tab";
  sheetModeBtn.textContent = sheetMode === "tab" ? "standard notation" : "tab notation";
  sheetTree = null; // force a re-render of the same tree
  const tree = tabTree(view.state);
  if (tree) void renderSheet(tree);
});

// The pane resizes by drag (not just window resize, which OSMD watches
// itself) — re-render to the new width, debounced, only when visible.
let sheetResizeTimer: ReturnType<typeof setTimeout> | undefined;
new ResizeObserver(() => {
  if (!sheetLoaded || sheetEl.clientWidth < 60) return;
  if (sheetResizeTimer !== undefined) clearTimeout(sheetResizeTimer);
  sheetResizeTimer = setTimeout(() => {
    try {
      osmd.render();
    } catch {
      /* zero-width mid-drag — the next resize event re-renders */
    }
  }, 200);
}).observe(sheetEl);

/** Deepest node whose ranges contain `pos` (TabDocument if none). */
function deepestNodeAt(tree: NonNullable<ReturnType<typeof tabTree>>, pos: number) {
  let node = tree.topNode;
  for (;;) {
    let next: typeof node | null = null;
    for (let c = node.firstChild; c; c = c.nextSibling) {
      if (containsPos(c, pos)) {
        next = c;
        break;
      }
    }
    if (!next) return node;
    node = next;
  }
}

function formatValue(v: unknown): string {
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    // Claims read best in words.
    if ("confidence" in o && "source" in o && "value" in o) {
      return `${JSON.stringify(o.value)} — claimed by ${o.source} at ${Math.round(
        (o.confidence as number) * 100
      )}% confidence`;
    }
    // Frac prints as an exact fraction.
    if ("num" in o && "den" in o && Object.keys(o).length === 2) return `${o.num}/${o.den}`;
    return JSON.stringify(v, (_k, val) =>
      val instanceof Map ? Object.fromEntries(val) : val
    );
  }
  return JSON.stringify(v);
}

// Uniform display budget for ALL values (strings included — sectionXml used
// to dump untruncated); rows expose click-to-expand + copy-full instead.
const VALUE_BUDGET = 180;
const truncate = (s: string): string =>
  s.length > VALUE_BUDGET ? `${s.slice(0, VALUE_BUDGET)}…` : s;

// ——— Inspector: one row per prop, grouped by the OWNING plugin (prop ids
// are "pluginId/propName"). Filter/collapse state is module-level so it
// survives re-renders within the session (Stan: filter by plugin, stay
// uncrowded). Data is collected once per cursor move (buildInspectorData,
// the only place that reads props) and repainted from that snapshot on
// every chip/text/collapse interaction (paintInspector) — repainting never
// re-reads props, so it can't pollute the next edit's Activity report.
interface InspectorEntry {
  readonly node: ReturnType<typeof deepestNodeAt>;
  readonly scope: string;
  readonly pluginId: string;
  readonly propName: string;
  prop: PropInspection; // reassigned in place when a "compute" button fires
}
interface InspectorData {
  readonly shownAny: boolean;
  /** Is the cursor ON something musical — a props-bearing node BELOW the
   *  block level (note/measure/sound)? Ambient block/section/document
   *  context alone means the pane should still teach the click→values move. */
  readonly onMusicNode: boolean;
  readonly warnings: readonly string[];
  readonly cachedCount: number;
  readonly evaluatedCount: number;
  readonly entries: readonly InspectorEntry[];
  readonly pluginOrder: readonly string[]; // first-appearance order (deepest node first)
}

const INSPECTOR_TEACH =
  "place the cursor on a note, measure, or tab line in the editor to inspect what the plugins computed for it";

let inspectorData: InspectorData | null = null;
let inspectorPluginFilter: string | null = null;
let inspectorTextFilter = ""; // raw, as typed; compared lowercase/trimmed
const inspectorCollapsedGroups = new Set<string>();

/** "pluginId/propName" → the two parts, split on the FIRST slash only —
 *  propName may itself contain "/" (e.g. nested paths), pluginId never does. */
function splitPropId(id: string): { pluginId: string; propName: string } {
  const i = id.indexOf("/");
  return i === -1 ? { pluginId: "?", propName: id } : { pluginId: id.slice(0, i), propName: id.slice(i + 1) };
}

function inspectorRow(entry: InspectorEntry): HTMLElement {
  const row = document.createElement("div");
  row.className = "inspector-row";

  const scope = document.createElement("span");
  scope.className = "inspector-row-scope";
  scope.textContent = entry.scope;
  row.appendChild(scope);

  const name = document.createElement("span");
  name.className = "inspector-prop";
  name.textContent = entry.propName;
  name.title = `chain (outermost first):\n  ${entry.prop.chain.join("\n  ")}`;
  row.appendChild(name);

  const p = entry.prop;
  if (!p.evaluated) {
    const btn = document.createElement("button");
    btn.className = "inspector-compute";
    btn.textContent = "compute";
    btn.title = "May be expensive (whole-document) — computes on demand.";
    btn.addEventListener("click", () => {
      const fresh = inspectNode(view.state, entry.node, [p.id]);
      computeActivity(view.state); // drain — clicked work stays out of edit reports
      const updated = fresh?.props.find((q) => q.id === p.id);
      if (updated) {
        entry.prop = updated; // keep the snapshot in sync for future repaints
        row.replaceWith(inspectorRow(entry));
      }
    });
    row.appendChild(btn);
    return row;
  }

  const value = document.createElement("span");
  const fullText = p.error ? `⚠ ${p.error}` : ` = ${formatValue(p.value)}`;
  const truncatable = fullText.length > VALUE_BUDGET;
  let expanded = false;
  value.className = p.error ? "inspector-value inspector-error" : "inspector-value";
  if (truncatable) value.classList.add("expandable");
  value.textContent = truncate(fullText);
  if (truncatable) {
    value.title = `${fullText.length.toLocaleString()} chars — click to expand`;
    value.addEventListener("click", () => {
      expanded = !expanded;
      value.textContent = expanded ? fullText : truncate(fullText);
    });
  }
  row.appendChild(value);
  if (!p.error) {
    const copy = document.createElement("button");
    copy.className = "inspector-copy";
    copy.textContent = "⧉";
    copy.title = `copy full value (${fullText.length.toLocaleString()} chars)`;
    copy.addEventListener("click", (e) => {
      e.stopPropagation();
      void navigator.clipboard.writeText(fullText.replace(/^ = /, "")).then(() => {
        copy.textContent = "✓";
        setTimeout(() => (copy.textContent = "⧉"), 900);
      });
    });
    row.appendChild(copy);
  }

  const badge = document.createElement("span");
  badge.className = `inspector-badge ${p.computed ? "inspector-computed" : "inspector-cached"}`;
  badge.textContent = p.computed ? "computed" : "cached";
  row.appendChild(badge);

  if (p.trace.length > 0) {
    const trace = document.createElement("div");
    trace.className = "inspector-trace";
    trace.title = "Who actually ran, outermost first; inner() = the link delegated onward.";
    trace.textContent =
      "ran: " +
      p.trace
        .map((s) =>
          s.base
            ? `${s.pluginId} (base)`
            : `${s.pluginId}${s.foundation ? " (foundation)" : ""}${s.delegated ? " → inner()" : ""}`
        )
        .join(" → ");
    row.appendChild(trace);
  } else if (p.chain.length > 1) {
    const chain = document.createElement("div");
    chain.className = "inspector-trace";
    chain.textContent = "chain: " + p.chain.join(" → ");
    row.appendChild(chain);
  }
  return row;
}

function inspectorGroup(pluginId: string, totalCount: number, visible: readonly InspectorEntry[]): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "inspector-group";

  const collapsed = inspectorCollapsedGroups.has(pluginId);
  const header = document.createElement("div");
  header.className = "inspector-group-header";
  const countLabel = visible.length === totalCount ? `${totalCount}` : `${visible.length}/${totalCount}`;
  header.textContent = `${collapsed ? "▸" : "▾"} ${pluginId} (${countLabel})`;
  header.addEventListener("click", () => {
    if (collapsed) inspectorCollapsedGroups.delete(pluginId);
    else inspectorCollapsedGroups.add(pluginId);
    paintInspector();
  });
  wrap.appendChild(header);

  if (!collapsed) {
    for (const entry of visible) wrap.appendChild(inspectorRow(entry));
  }
  return wrap;
}

function inspectorFilterBar(data: InspectorData): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "inspector-filters";

  const chips = document.createElement("div");
  chips.className = "inspector-chips";

  const counts = new Map<string, number>();
  for (const e of data.entries) counts.set(e.pluginId, (counts.get(e.pluginId) ?? 0) + 1);

  const allChip = document.createElement("span");
  allChip.className = `inspector-chip${inspectorPluginFilter === null ? " active" : ""}`;
  allChip.textContent = `all (${data.entries.length})`;
  allChip.addEventListener("click", () => {
    inspectorPluginFilter = null;
    paintInspector();
  });
  chips.appendChild(allChip);

  for (const pluginId of data.pluginOrder) {
    const chip = document.createElement("span");
    chip.className = `inspector-chip${inspectorPluginFilter === pluginId ? " active" : ""}`;
    chip.textContent = `${pluginId} (${counts.get(pluginId)})`;
    chip.addEventListener("click", () => {
      inspectorPluginFilter = inspectorPluginFilter === pluginId ? null : pluginId;
      paintInspector();
    });
    chips.appendChild(chip);
  }
  bar.appendChild(chips);

  const input = document.createElement("input");
  input.type = "text";
  input.className = "inspector-filter-text";
  input.placeholder = "filter props…";
  input.value = inspectorTextFilter;
  input.addEventListener("input", () => {
    const caret = input.selectionStart;
    inspectorTextFilter = input.value;
    paintInspector();
    // paintInspector() rebuilds the DOM (this input included) — restore
    // focus + caret so typing a filter doesn't lose the cursor mid-word.
    const fresh = inspectorEl.querySelector<HTMLInputElement>(".inspector-filter-text");
    fresh?.focus();
    if (caret !== null) fresh?.setSelectionRange(caret, caret);
  });
  bar.appendChild(input);

  return bar;
}

/** Collect every prop across the cursor's ancestor chain (deepest first).
 *  The only function that reads props — chip/text/collapse interactions
 *  repaint from the result without touching inspectNode again. */
function buildInspectorData(tree: NonNullable<ReturnType<typeof tabTree>>): void {
  // main.from is INSIDE the selected node (head is its END — one past it).
  const pos = view.state.selection.main.from;
  let start = deepestNodeAt(tree, pos);
  // An AST click pins its node: start the chain there, not at the deepest
  // descendant sharing the position.
  if (pinned) {
    for (let n: typeof start | null = start; n; n = n.parent) {
      const ranges: { from: number; to: number }[] = [];
      for (let i = 0; i < n.rangeCount; i++) {
        ranges.push({ from: n.rangeFrom(i), to: n.rangeTo(i) });
      }
      if (rangeSignature(ranges) === pinned.signature) {
        start = n;
        break;
      }
    }
  }
  // The WHOLE ancestor chain, deepest first — block/section-level props
  // (claims, lints) are otherwise unreachable, since a deeper node always
  // owns the cursor. Whole-document props (exports!) defer to a click.
  let shownAny = false;
  let onMusicNode = false;
  let belowBlock = true; // walking upward: still under the block level?
  let warnings: readonly string[] = [];
  let cachedCount = 0;
  let evaluatedCount = 0;
  const entries: InspectorEntry[] = [];
  const pluginOrder: string[] = [];
  const seenPlugins = new Set<string>();
  for (let node: ReturnType<typeof deepestNodeAt> | null = start; node; node = node.parent) {
    if (node.name === "TabBlock" || node.name === "Section" || node.name === "TabDocument") {
      belowBlock = false;
    }
    const inspection = inspectNode(view.state, node, node.parent !== null);
    if (!inspection) continue;
    warnings = inspection.installWarnings;
    if (inspection.props.length === 0) continue;
    shownAny = true;
    if (belowBlock) onMusicNode = true;

    const ranges: string[] = [];
    for (let i = 0; i < node.rangeCount; i++) {
      ranges.push(`[${node.rangeFrom(i)},${node.rangeTo(i)})`);
    }
    const scope = `${inspection.nodeName} ${ranges.join("+")}`;
    for (const p of inspection.props) {
      if (p.evaluated) {
        evaluatedCount++;
        if (!p.computed) cachedCount++;
      }
      const { pluginId, propName } = splitPropId(p.id);
      if (!seenPlugins.has(pluginId)) {
        seenPlugins.add(pluginId);
        pluginOrder.push(pluginId);
      }
      entries.push({ node, scope, pluginId, propName, prop: p });
    }
  }
  inspectorData = { shownAny, onMusicNode, warnings, cachedCount, evaluatedCount, entries, pluginOrder };
}

/** Pure repaint from `inspectorData` + the current filter/collapse state —
 *  never reads props, so it's safe to call from chip/text/collapse handlers. */
function paintInspector(): void {
  inspectorEl.innerHTML = "";
  const data = inspectorData;
  if (!data || !data.shownAny) {
    const none = document.createElement("div");
    none.className = "diag-empty inspector-teach";
    none.textContent = INSPECTOR_TEACH;
    inspectorEl.appendChild(none);
    return;
  }

  // First contact: the cursor isn't ON anything musical yet (only ambient
  // block/section/document context below) — teach the click→values move.
  if (!data.onMusicNode) {
    const teach = document.createElement("div");
    teach.className = "diag-empty inspector-teach";
    teach.textContent = INSPECTOR_TEACH;
    inspectorEl.appendChild(teach);
  }

  inspectorEl.appendChild(inspectorFilterBar(data));

  const summary = document.createElement("div");
  summary.className = "activity-summary";
  summary.title = ACTIVITY_EXPLAIN.propsSummary;
  summary.textContent = `${data.cachedCount}/${data.evaluatedCount} props served from cache`;
  inspectorEl.appendChild(summary);

  const byPlugin = new Map<string, InspectorEntry[]>();
  for (const e of data.entries) {
    (byPlugin.get(e.pluginId) ?? byPlugin.set(e.pluginId, []).get(e.pluginId)!).push(e);
  }
  const text = inspectorTextFilter.trim().toLowerCase();

  let renderedAny = false;
  for (const pluginId of data.pluginOrder) {
    if (inspectorPluginFilter && inspectorPluginFilter !== pluginId) continue;
    const all = byPlugin.get(pluginId) ?? [];
    const visible = text ? all.filter((e) => e.propName.toLowerCase().includes(text)) : all;
    if (visible.length === 0) continue;
    renderedAny = true;
    inspectorEl.appendChild(inspectorGroup(pluginId, all.length, visible));
  }

  if (!renderedAny) {
    const empty = document.createElement("div");
    empty.className = "diag-empty";
    empty.textContent = text
      ? `no props match "${inspectorTextFilter.trim()}"`
      : inspectorPluginFilter
        ? `no ${inspectorPluginFilter} props at the cursor`
        : "no props match the current filter";
    inspectorEl.appendChild(empty);
  }

  for (const w of data.warnings) {
    const warn = document.createElement("div");
    warn.className = "inspector-warning";
    warn.textContent = `install warning: ${w}`;
    inspectorEl.appendChild(warn);
  }
}

function renderInspector(tree: NonNullable<ReturnType<typeof tabTree>>): void {
  buildInspectorData(tree);
  paintInspector();
}

function renderActivity(report: ComputeReport): void {
  activityEl.innerHTML = "";
  const summary = document.createElement("div");
  summary.className = "activity-summary";
  summary.title = ACTIVITY_EXPLAIN.summary;
  const n = report.segments.length;
  const parseReused = report.segments.filter((s) => s.artifact === "identity").length;
  const carried = report.segments.filter(
    (s) => s.artifact === "identity" && s.recomputes.size === 0
  ).length;
  summary.textContent =
    `${report.totalRecomputes} compute runs · ${parseReused}/${n} parse-reused · ` +
    `${carried}/${n} fully carried` +
    (report.unattributed > 0 ? ` · ${report.unattributed} on evicted segments` : "");
  activityEl.appendChild(summary);

  const legend = document.createElement("div");
  legend.className = "activity-legend";
  for (const [key, label] of [
    ["carried", "carried = reused, no work"],
    ["new", "new = content changed"],
    ["equal", "equal = re-parsed, same result"],
    ["state", "state = values recomputed"],
  ] as const) {
    const chip = document.createElement("span");
    chip.className = `activity-chip activity-${key}`;
    chip.textContent = label;
    chip.title = ACTIVITY_EXPLAIN[key];
    legend.appendChild(chip);
  }
  activityEl.appendChild(legend);

  report.segments.forEach((s, i) => {
    const row = document.createElement("div");
    const stateOnly = s.artifact === "identity" && s.recomputes.size > 0;
    const status =
      s.artifact !== "identity" ? s.artifact : stateOnly ? "state" : "carried";
    row.className = `activity-row activity-${status}`;

    const runs = [...s.recomputes.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([id, n]) => `${id.split("/").pop()}×${n}`)
      .join(" ");
    row.textContent = `#${i} [${s.from},${s.to}) ${status.toUpperCase()}${runs ? ` — ${runs}` : ""}`;
    row.title = ACTIVITY_EXPLAIN[status];
    row.addEventListener("click", () => {
      view.dispatch({
        selection: { anchor: s.from, head: Math.min(s.to, s.from + 1) },
        scrollIntoView: true,
      });
      view.focus();
    });
    activityEl.appendChild(row);
  });

  if (report.docRecomputes.size > 0) {
    const doc = document.createElement("div");
    doc.className = "activity-row activity-doc";
    doc.title = ACTIVITY_EXPLAIN.doc;
    doc.textContent =
      "doc-level — " +
      [...report.docRecomputes.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([id, n]) => `${id.split("/").pop()}×${n}`)
        .join(" ");
    activityEl.appendChild(doc);
  }
}

/** Structural (duck-typed) node shape — avoids importing the TabNode type,
 *  which isn't re-exported from src/index.ts; tree.iterate()'s own
 *  signature is what actually types `node` at every call site below. */
function containsPos(
  node: { rangeCount: number; rangeFrom(i: number): number; rangeTo(i: number): number },
  pos: number
): boolean {
  for (let i = 0; i < node.rangeCount; i++) {
    const a = node.rangeFrom(i);
    const b = node.rangeTo(i);
    if (a === b ? pos === a : pos >= a && pos < b) return true;
  }
  return false;
}

function renderAst(tree: NonNullable<ReturnType<typeof tabTree>>, cursorPos: number): void {
  astEl.innerHTML = "";
  let depth = 0;
  let rowIndex = -1;
  const candidates: { div: HTMLDivElement; depth: number }[] = [];
  let pinnedDiv: HTMLDivElement | null = null;

  tree.iterate({
    enter(node) {
      rowIndex++;
      const index = rowIndex;
      const div = document.createElement("div");
      div.className = "ast-line";
      div.style.paddingLeft = `${depth * 14}px`;

      const ranges: { from: number; to: number }[] = [];
      for (let i = 0; i < node.rangeCount; i++) {
        ranges.push({ from: node.rangeFrom(i), to: node.rangeTo(i) });
      }
      const signature = rangeSignature(ranges);
      div.textContent = `${node.name} ${ranges.map((r) => `[${r.from},${r.to})`).join("+")}`;

      // Multi-range nodes (a Sound spans one range PER LINE) select ALL
      // their ranges — tablature() enables allowMultipleSelections, and
      // ranges arrive line-ordered and disjoint from the artifact. Pin the
      // row so the re-render highlights THIS node, not the deepest
      // descendant at the same position.
      div.addEventListener("click", () => {
        pinned = { index, signature };
        view.dispatch({
          selection: EditorSelection.create(
            ranges.map((r) => EditorSelection.range(r.from, r.to))
          ),
          scrollIntoView: true,
        });
        view.focus();
      });

      astEl.appendChild(div);
      if (pinned && pinned.index === index && pinned.signature === signature) pinnedDiv = div;
      if (containsPos(node, cursorPos)) candidates.push({ div, depth });
      depth++;
      return true;
    },
    leave() {
      depth--;
    },
  });

  if (pinnedDiv) {
    (pinnedDiv as HTMLDivElement).classList.add("ast-active");
    return;
  }
  pinned = null; // pinned row no longer exists in this tree
  const maxDepth = candidates.reduce((m, c) => Math.max(m, c.depth), -1);
  for (const c of candidates) {
    if (c.depth === maxDepth) c.div.classList.add("ast-active");
  }
}

function renderDiagnostics(): void {
  const diags = tabStateDiagnostics(view.state);
  diagnosticsEl.innerHTML = "";

  if (diags.length === 0) {
    const empty = document.createElement("div");
    empty.className = "diag-empty";
    empty.textContent = "no diagnostics";
    diagnosticsEl.appendChild(empty);
    return;
  }

  for (const d of diags) {
    const row = document.createElement("div");
    row.className = "diag-row";
    row.addEventListener("click", () => {
      view.dispatch({
        selection: { anchor: d.from, head: Math.max(d.to, d.from) },
        scrollIntoView: true,
      });
      view.focus();
    });

    const dot = document.createElement("span");
    dot.className = `diag-dot diag-${d.severity}`;
    row.appendChild(dot);

    const msg = document.createElement("span");
    msg.className = "diag-message";
    msg.textContent = d.message;
    row.appendChild(msg);

    for (const fix of d.fixes ?? []) {
      const btn = document.createElement("button");
      btn.className = "diag-fix";
      btn.textContent = fix.title;
      btn.addEventListener("click", (event) => {
        event.stopPropagation(); // the row's own click jumps the selection
        view.dispatch({ changes: fix.edits.map((e) => ({ ...e })) });
      });
      row.appendChild(btn);
    }

    diagnosticsEl.appendChild(row);
  }
}

function downloadBlob(data: string | Uint8Array, filename: string, mime: string): void {
  // Uint8Array<ArrayBufferLike> (e.g. from a generic buffer) isn't assignable
  // to BlobPart under TS 5.7+'s typed-array generics; copying into a fresh
  // Uint8Array backed by a plain ArrayBuffer satisfies BlobPart exactly.
  const part: BlobPart = typeof data === "string" ? data : new Uint8Array(data);
  const blob = new Blob([part], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Import: pick a .musicxml file → the §9 producer computes TextEdits from
// the CURRENT state → dispatching them is one undoable transaction.
const importFileInput = document.getElementById("import-xml-file") as HTMLInputElement;
document.getElementById("import-xml")!.addEventListener("click", () => importFileInput.click());
importFileInput.addEventListener("change", async () => {
  const file = importFileInput.files?.[0];
  importFileInput.value = ""; // allow re-picking the same file
  if (!file) return;
  try {
    const edits = importMusicXml(view.state, await file.text());
    view.dispatch({ changes: edits.map((e) => ({ ...e })) });
    view.focus();
  } catch (e) {
    alert(`MusicXML import failed: ${(e as Error).message}`);
  }
});

document.getElementById("export-xml")!.addEventListener("click", () => {
  downloadBlob(musicXml(view.state), "tab.musicxml", "application/vnd.recordare.musicxml+xml");
});

document.getElementById("export-midi")!.addEventListener("click", () => {
  downloadBlob(midiFile(view.state), "tab.mid", "audio/midi");
});
