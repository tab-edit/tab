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
  midiFile,
  musicXml,
  tablature,
  tabStateDiagnostics,
  tabTree,
  type ComputeReport,
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
const editorHost = document.getElementById("editor") as HTMLElement;

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
  renderAst(tree, view.state.selection.main.head);
  renderDiagnostics();
  // AFTER the reads above — pull model: reads are where computes happen,
  // so the report now attributes this cycle's actual work.
  const report = computeActivity(view.state);
  if (report) {
    renderActivity(report);
    flashActivity(report);
  }
}

function renderActivity(report: ComputeReport): void {
  activityEl.innerHTML = "";
  const summary = document.createElement("div");
  summary.className = "activity-summary";
  const carried = report.segments.filter(
    (s) => s.artifact === "identity" && s.recomputes.size === 0
  ).length;
  summary.textContent =
    `${report.totalRecomputes} compute runs · ` +
    `${carried}/${report.segments.length} segments fully carried` +
    (report.unattributed > 0 ? ` · ${report.unattributed} on evicted segments` : "");
  activityEl.appendChild(summary);

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
  const candidates: { div: HTMLDivElement; depth: number }[] = [];

  tree.iterate({
    enter(node) {
      const div = document.createElement("div");
      div.className = "ast-line";
      div.style.paddingLeft = `${depth * 14}px`;

      const ranges: { from: number; to: number }[] = [];
      for (let i = 0; i < node.rangeCount; i++) {
        ranges.push({ from: node.rangeFrom(i), to: node.rangeTo(i) });
      }
      div.textContent = `${node.name} ${ranges.map((r) => `[${r.from},${r.to})`).join("+")}`;

      // Multi-range nodes (a Sound spans one range PER LINE) select ALL
      // their ranges — tablature() enables allowMultipleSelections, and
      // ranges arrive line-ordered and disjoint from the artifact.
      div.addEventListener("click", () => {
        view.dispatch({
          selection: EditorSelection.create(
            ranges.map((r) => EditorSelection.range(r.from, r.to))
          ),
          scrollIntoView: true,
        });
        view.focus();
      });

      astEl.appendChild(div);
      if (containsPos(node, cursorPos)) candidates.push({ div, depth });
      depth++;
      return true;
    },
    leave() {
      depth--;
    },
  });

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
