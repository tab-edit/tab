// Demo page for the tab-edit CodeMirror 6 adapter: an editor pane plus two
// live panes — the semantic AST and diagnostics-with-fixes — driven purely
// through the public @tab-edit/cm surface (../src/index.ts). No src/ edits.
import { basicSetup } from "codemirror";
import { EditorView } from "@codemirror/view";
import {
  midiFile,
  musicXml,
  tablature,
  tabStateDiagnostics,
  tabTree,
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
const editorHost = document.getElementById("editor") as HTMLElement;

let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let generation = 0;

const view = new EditorView({
  doc: INITIAL_DOC,
  extensions: [
    basicSetup,
    tablature(),
    EditorView.updateListener.of((update) => {
      if (update.docChanged || update.selectionSet) scheduleRefresh();
    }),
  ],
  parent: editorHost,
});

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

      const ranges: string[] = [];
      for (let i = 0; i < node.rangeCount; i++) {
        ranges.push(`[${node.rangeFrom(i)},${node.rangeTo(i)})`);
      }
      div.textContent = `${node.name} ${ranges.join("+")}`;

      div.addEventListener("click", () => {
        view.dispatch({
          selection: { anchor: node.rangeFrom(0), head: node.rangeTo(0) },
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
      btn.addEventListener("click", () => {
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
