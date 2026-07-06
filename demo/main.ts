// Demo page for the tab-edit CodeMirror 6 adapter: an editor pane plus two
// live panes — the semantic AST and diagnostics-with-fixes — driven purely
// through the public @tab-edit/cm surface (../src/index.ts). No src/ edits.
import { basicSetup } from "codemirror";
import { EditorView } from "@codemirror/view";
import { lintGutter } from "@codemirror/lint";
import { EditorSelection, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet } from "@codemirror/view";
import {
  computeActivity,
  inspectNode,
  midiFile,
  musicXml,
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

const view = new EditorView({
  doc: INITIAL_DOC,
  extensions: [
    basicSetup,
    tablature(),
    lintGutter(),
    flashField,
    EditorView.updateListener.of((update) => {
      if (update.docChanged || update.selectionSet) scheduleRefresh();
    }),
  ],
  parent: editorHost,
});

// Exposed for console poking and the Playwright verify loop.
Object.assign(globalThis, { view });

// Side panes: header click collapses; the bottom edge drags to resize
// (native CSS resize).
for (const pane of document.querySelectorAll(".side-panes .pane")) {
  pane.querySelector("h2")?.addEventListener("click", () => pane.classList.toggle("collapsed"));
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
}

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
    const json = JSON.stringify(v, (_k, val) =>
      val instanceof Map ? Object.fromEntries(val) : val
    );
    return json.length > 180 ? `${json.slice(0, 180)}…` : json;
  }
  return JSON.stringify(v);
}

function propRow(node: ReturnType<typeof deepestNodeAt>, p: PropInspection): HTMLElement {
  const row = document.createElement("div");
  row.className = "inspector-row";

  const name = document.createElement("span");
  name.className = "inspector-prop";
  name.textContent = p.id.split("/").pop()!;
  name.title = `chain (outermost first):\n  ${p.chain.join("\n  ")}`;
  row.appendChild(name);

  if (!p.evaluated) {
    const btn = document.createElement("button");
    btn.className = "inspector-compute";
    btn.textContent = "compute";
    btn.title = "May be expensive (whole-document) — computes on demand.";
    btn.addEventListener("click", () => {
      const fresh = inspectNode(view.state, node, [p.id]);
      computeActivity(view.state); // drain — clicked work stays out of edit reports
      const updated = fresh?.props.find((q) => q.id === p.id);
      if (updated) row.replaceWith(propRow(node, updated));
    });
    row.appendChild(btn);
    return row;
  }

  const value = document.createElement("span");
  value.className = p.error ? "inspector-value inspector-error" : "inspector-value";
  value.textContent = p.error ? `⚠ ${p.error}` : ` = ${formatValue(p.value)}`;
  row.appendChild(value);

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

function renderInspector(tree: NonNullable<ReturnType<typeof tabTree>>): void {
  inspectorEl.innerHTML = "";
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
  let warnings: readonly string[] = [];
  for (let node: ReturnType<typeof deepestNodeAt> | null = start; node; node = node.parent) {
    const inspection = inspectNode(view.state, node, node.parent !== null);
    if (!inspection) continue;
    warnings = inspection.installWarnings;
    if (inspection.props.length === 0) continue;

    const header = document.createElement("div");
    header.className = "inspector-node";
    const ranges: string[] = [];
    for (let i = 0; i < node.rangeCount; i++) {
      ranges.push(`[${node.rangeFrom(i)},${node.rangeTo(i)})`);
    }
    header.textContent = `${inspection.nodeName} ${ranges.join("+")}`;
    inspectorEl.appendChild(header);
    for (const p of inspection.props) inspectorEl.appendChild(propRow(node, p));
    shownAny = true;
  }

  if (!shownAny) {
    const none = document.createElement("div");
    none.className = "diag-empty";
    none.textContent = "no props here — move the cursor into a note, measure, or block";
    inspectorEl.appendChild(none);
  }
  for (const w of warnings) {
    const warn = document.createElement("div");
    warn.className = "inspector-warning";
    warn.textContent = `install warning: ${w}`;
    inspectorEl.appendChild(warn);
  }
}

function renderActivity(report: ComputeReport): void {
  activityEl.innerHTML = "";
  const summary = document.createElement("div");
  summary.className = "activity-summary";
  summary.title = ACTIVITY_EXPLAIN.summary;
  const carried = report.segments.filter(
    (s) => s.artifact === "identity" && s.recomputes.size === 0
  ).length;
  summary.textContent =
    `${report.totalRecomputes} compute runs · ` +
    `${carried}/${report.segments.length} segments fully carried` +
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

document.getElementById("export-xml")!.addEventListener("click", () => {
  downloadBlob(musicXml(view.state), "tab.musicxml", "application/vnd.recordare.musicxml+xml");
});

document.getElementById("export-midi")!.addEventListener("click", () => {
  downloadBlob(midiFile(view.state), "tab.mid", "audio/midi");
});
