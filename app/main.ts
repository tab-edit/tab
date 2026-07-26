// The PRODUCT app (ADR-003 M-R2): an editor whose semantics come through
// the TabSemantics facade — by default the wire (engine server-side; this
// bundle is audited engine-free by verify-app.cjs), flippable to
// local-everything by swapping one re-export in ./semantics-mode.ts.
// Compare with demo/ — the demo is the DEV vehicle (engine panes,
// inspector, activity); this is what users get.
/// <reference types="vite/client" />
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import { lintGutter, lintKeymap } from "@codemirror/lint";
import { searchKeymap } from "@codemirror/search";
import { Compartment, EditorSelection, EditorState } from "@codemirror/state";
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { minimalSetup } from "codemirror";
import { OpenSheetMusicDisplay } from "opensheetmusicdisplay";
import { SAMPLES } from "../demo/samples.js";
import blackbird from "../demo/samples/blackbird.txt?raw";
// Engine-free helpers (the /client surface both modes share — the FACTORY
// is the only thing semantics-mode swaps).
import {
  buildRows,
  causeOf,
  claimPairs,
  costRows,
  createPlayer,
  filterRows,
  indexActivity,
  orderRows,
  packChips,
  rangesInValue,
  sanitizeForOsmd,
  savingsLine,
  snapshotOf,
  soundRangesAt,
  splitPropId,
  stateChips,
  summarizeValue,
  tabDiagnostics,
  type ActivityFrame,
  type InspectionFrame,
  type Player,
  type PropRow,
  type PropState,
  type RowOrder,
  type SheetMode,
  type Span,
  type Timbre,
} from "@tab-edit/cm/client";
import { createSemantics } from "./semantics-mode.js";

const INITIAL_DOC = `Title: Blackbird — The Beatles\nTempo: 95\n\n${blackbird}`;

/** Resolve the session endpoint: ?remote= override → build-time env →
 *  localhost dev-server fallback. For a worker endpoint (…/session) mint
 *  an anonymous token (Q17) and a fresh doc id first. */
async function sessionUrl(): Promise<string | null> {
  const override = new URLSearchParams(location.search).get("remote");
  const configured =
    override ??
    (import.meta.env.VITE_REMOTE_URL as string | undefined) ??
    (location.hostname === "localhost" ? "ws://localhost:8787" : null);
  if (!configured) return null;
  try {
    const url = new URL(configured);
    if (url.pathname.endsWith("/session")) {
      url.searchParams.set("doc", crypto.randomUUID());
      const tokenBase = `${url.protocol === "wss:" ? "https:" : "http:"}//${url.host}`;
      const response = await fetch(`${tokenBase}/token`);
      const token = await response.text();
      if (response.ok && token && token !== "token auth is off") {
        url.searchParams.set("token", token);
      }
    }
    return url.toString();
  } catch {
    return configured;
  }
}

const editorEl = document.getElementById("editor") as HTMLElement;
const sheetScoreEl = document.getElementById("sheet-score") as HTMLElement;
const sheetStatusEl = document.getElementById("sheet-status") as HTMLElement;
const statusEl = document.getElementById("remote-status") as HTMLElement;
const playButton = document.getElementById("play") as HTMLButtonElement;
const slider = document.getElementById("transport-slider") as HTMLInputElement;
const timeEl = document.getElementById("transport-time") as HTMLElement;
const followButton = document.getElementById("follow") as HTMLButtonElement;
const timbrePicker = document.getElementById("timbre-picker") as HTMLSelectElement;
const sheetModeButton = document.getElementById("sheet-mode") as HTMLButtonElement;
const sheetToggle = document.getElementById("sheet-toggle") as HTMLButtonElement;
const sheetPane = document.querySelector(".sheet-pane") as HTMLElement;
// ——— the dev surface (one master switch; see setDev) ———
const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const devToggle = el<HTMLButtonElement>("dev-toggle");
const devDrawer = el("dev-drawer");
const devResize = el("dev-resize");
const devBreadcrumbEl = el("dev-breadcrumb");
const devSavingsEl = el("dev-savings");
const devRefreshButton = el<HTMLButtonElement>("dev-refresh");
const devWatchEl = el("dev-watch");
const devDiagnosticsEl = el("dev-diagnostics");
const devDiagCountEl = el("dev-diag-count");
const lensButtons = [...document.querySelectorAll<HTMLButtonElement>(".dev-lens")];
type Lens = "values" | "cost" | "tree" | "problems";
const lensBodies: Record<Lens, HTMLElement> = {
  values: el("lens-values"),
  cost: el("lens-cost"),
  tree: el("lens-tree"),
  problems: el("lens-problems"),
};
const valuesToolbar = el("values-toolbar");
const valuesClaimsEl = el("values-claims");
const valuesRowsEl = el("values-rows");
const valuesFooterEl = el("values-footer");
const costToolbar = el("cost-toolbar");
const costHeadlineEl = el("cost-headline");
const costBodyEl = el("cost-body");
const treeToolbar = el("tree-toolbar");
const treeBodyEl = el("tree-body");

/** Preferences survive a reload; private mode simply doesn't remember. */
const readStore = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const writeStore = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode — preferences just aren't remembered */
  }
};

// Read-only while the music plays (the playhead owns the selection then).
const editableCompartment = new Compartment();
const rangeSignature = (ranges: readonly { from: number; to: number }[]): string =>
  ranges.map((r) => `${r.from}-${r.to}`).join(",");
const fmt = (sec: number): string =>
  `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;

async function main(): Promise<void> {
  const url = await sessionUrl();
  if (url === null) {
    statusEl.textContent = "no session host configured";
    // The editor still works: typing + syntax highlighting are local by
    // construction (I3); semantic overlays wait for a host.
  }
  const semantics = createSemantics(url ?? "ws://localhost:8787");
  let player: Player | null = null;
  // Assigned once the transport exists. A HOOK, not a direct call: the update
  // listener below is installed with the view, long before the transport's
  // `let`s initialize, and selection updates fire during startup — calling
  // into them directly would hit the TDZ (the hoisting trap verify:app caught
  // once already).
  let onSelectionChanged: ((state: EditorState) => void) | null = null;
  /** Same hoisting discipline for the dev surface: the update listener is
   *  installed with the view, long before the surface's `let`s exist. */
  let onDocChanged: (() => void) | null = null;
  // Sheet-convergence bookkeeping, declared ABOVE the view because the update
  // listener below touches it (same hoisting trap as the cursor state: the
  // functions hoist, their `let`s do not). `docEdits` counts document changes;
  // `sheetAt` is the count the RENDERED score reflects. "Live" is the
  // invariant sheetAt === docEdits at rest, and renderSheet re-arms itself
  // until that holds — never relying on a later edit to save it.
  let docEdits = 0;
  let sheetAt = -1;
  let sheetRetries = 0;

  const view = new EditorView({
    doc: INITIAL_DOC,
    parent: editorEl,
    extensions: [
      minimalSetup,
      lineNumbers(),
      dropCursor(),
      crosshairCursor(),
      drawSelection(),
      keymap.of([...searchKeymap, ...lintKeymap]),
      lintGutter(),
      EditorView.theme(
        {
          ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#e8e8e8" },
          ".cm-cursor-secondary": { display: "none" },
          "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
            background: "rgba(91, 157, 250, 0.28)",
          },
        },
        { dark: true }
      ),
      semantics.extension,
      editableCompartment.of(EditorView.editable.of(true)),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          docEdits++;
          sheetRetries = 0; // a new document deserves a fresh retry budget
          scheduleSheet();
          // The cost lens's whole point is "what did that keystroke do?" —
          // measured once the typing settles, never per keystroke.
          onDocChanged?.();
          // An edit invalidates the timeline's spans — stop cleanly rather
          // than play stale positions (same rule as the demo).
          if (player) stopPlayback();
        }
        if (update.selectionSet || update.docChanged) onSelectionChanged?.(update.state);
      }),
    ],
  });
  Object.assign(globalThis, { view, appSemantics: semantics });

  // ——— status badge (remote configurations expose the client) ———
  const client = (semantics as { client?: { status: string; staleBy: number } }).client;
  if (client) {
    setInterval(() => {
      statusEl.textContent =
        client.status === "live"
          ? `live${client.staleBy > 0 ? ` · syncing ${client.staleBy}` : " · synced"}`
          : "connecting";
    }, 250);
  } else {
    statusEl.textContent = "local semantics";
  }

  // ——— live sheet: the musicXml surface rendered by OSMD, debounced ———
  const osmd = new OpenSheetMusicDisplay(sheetScoreEl, {
    autoResize: true,
    backend: "svg",
    drawTitle: true,
    // WE scroll the score pane (scrollSheetCursorIntoView below), not OSMD.
    // Its own follow calls scrollIntoView({behavior:"smooth"}) on every
    // cursor step: that walks every scrollable ANCESTOR (the page included)
    // and restarts its animation on each call, so in a real browser the pane
    // trails the music and the cursor leaves the viewport within seconds —
    // present in the DOM, invisible to the user. Instant scrollTop math is
    // deterministic, stays inside this pane, and the harness can assert it.
    followCursor: false,
  });
  let sheetTimer: ReturnType<typeof setTimeout> | null = null;
  let sheetBusy = false;
  let sheetLoaded = false;
  let sheetMode: SheetMode = "tab";
  // Cursor state lives HERE, above the first renderSheet() call: the
  // function declarations below hoist, their `let`s do not — the initial
  // render calling hideSheetCursor() hit the TDZ (found by verify:app).
  // followPlayhead sits up here for the same reason: the sheet-cursor
  // functions below read it, and they run from the very first render.
  let sheetCursorShown = false;
  let sheetCursorNextTs = -1;
  let followPlayhead = true;
  /** A query that never answers must never wedge the pane. A lost message —
   *  the socket torn down with a request in flight — leaves a promise that
   *  settles NEVER, and `sheetBusy` would stay latched: every later edit
   *  reschedules, every reschedule sees "busy" and reschedules again, and the
   *  sheet stops updating live for the rest of the session with no error
   *  anywhere (reproduced: one swallowed query is enough). A deadline turns
   *  that permanent wedge into an ordinary retry. */
  const SHEET_QUERY_TIMEOUT_MS = 10_000;
  const SHEET_MAX_RETRIES = 4;
  function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error as Error);
        }
      );
    });
  }
  async function renderSheet(): Promise<void> {
    if (sheetBusy) {
      scheduleSheet();
      return;
    }
    sheetBusy = true;
    const at = docEdits; // the document THIS render answers for
    hideSheetCursor();
    let failed = false;
    try {
      const xml = await withDeadline(
        semantics.musicXml(view.state),
        SHEET_QUERY_TIMEOUT_MS,
        "sheet query"
      );
      // VexFlow is the strict oracle — the shared pre-flight (src/osmd.ts)
      // drops what it throws on and reports the count honestly.
      const { xml: renderable, removed } = sanitizeForOsmd(xml, sheetMode);
      await osmd.load(renderable);
      osmd.render();
      sheetLoaded = true;
      sheetAt = at;
      sheetRetries = 0;
      sheetStatus(removed > 0 ? `${removed} unrenderable measure(s)/note(s) skipped` : null);
      showSheetCursorAtStart();
    } catch (e) {
      failed = true;
      sheetLoaded = false;
      sheetStatus(`sheet: ${(e as Error).message}`);
    } finally {
      sheetBusy = false;
      // CONVERGENCE IS THE INVARIANT: while the rendered score is behind the
      // document, re-arm. A render that finished for an older document (the
      // burst case) retries at once; a FAILED one backs off and is bounded,
      // so a genuinely unrenderable document settles on its message instead
      // of spinning — and any edit restores the budget.
      if (sheetAt !== docEdits) {
        if (!failed) scheduleSheet();
        else if (sheetRetries < SHEET_MAX_RETRIES) scheduleSheet(700 * ++sheetRetries);
      }
    }
  }
  function sheetStatus(message: string | null): void {
    sheetStatusEl.hidden = message === null;
    sheetStatusEl.textContent = message ?? "";
  }
  function scheduleSheet(delayMs = 400): void {
    if (sheetTimer !== null) clearTimeout(sheetTimer);
    sheetTimer = setTimeout(() => void renderSheet(), delayMs);
  }
  sheetModeButton.addEventListener("click", () => {
    sheetMode = sheetMode === "tab" ? "standard" : "tab";
    sheetModeButton.textContent = sheetMode === "tab" ? "standard notation" : "tab notation";
    void renderSheet();
  });
  // ═══ THE DEV SURFACE ═════════════════════════════════════════════════
  //
  // ONE MASTER SWITCH (#dev-toggle, or ?dev=1), remembered. Off is the
  // product: no queries, no timers, no dev work of any kind, no layout
  // shift. On, it is organised by QUESTION rather than by data structure —
  // nobody thinks "I want the activity pane", they think "why is this value
  // wrong?" — so it is four LENSES over one permanent context bar:
  //
  //   VALUES    what the engine decided here (claims first: who bid, who won)
  //   COST      what the work cost, and what moved with it
  //   TREE      the whole-document base tree (free: CM stores it — no wire)
  //   PROBLEMS  diagnostics, click to jump
  //
  // The context bar (breadcrumb + savings) and the WATCH strip persist
  // across lenses: watching a prop is orthogonal to which question you are
  // asking. Everything wire-fed is fetched ON DEMAND and debounced — the
  // inspection queries are rate-limited server-side, so nothing polls them.
  const fmtRange = (r: { from: number; to: number }): string => `${r.from}-${r.to}`;
  const ms = (n: number): string => `${n.toFixed(2)} ms`;

  let devOn = false;
  let lens: Lens = ((readStore("tab-edit:dev-lens") as Lens | null) ?? "values") as Lens;
  /** The newest inspection frame, and the document edit count it answered
   *  for. A frame whose document has moved is still worth SHOWING (the
   *  values are the values), but its ranges no longer address the text, so
   *  navigation from it is suppressed until a fresh one lands. */
  let frame: InspectionFrame | null = null;
  let frameAtEdits = -1;
  let framePos = -1;
  let frameError: string | null = null;
  let activity: ActivityFrame | null = null;
  let lastPassId: number | null = null;
  let diffBaseline: number | null = null;
  let diffFrame: ActivityFrame | null = null;
  let inspectBusy = false;
  let activityBusy = false;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let snapshotTimer: ReturnType<typeof setInterval> | null = null;

  // Values-lens view state.
  let packFilter: string | null = null;
  let textFilter = "";
  let stateFilter: PropState[] = [];
  let order: RowOrder = "cost";
  let selectedKey: string | null = null;
  let watch: string[] = (readStore("tab-edit:dev-watch") ?? "").split(",").filter(Boolean);
  const watchSeen = new Map<string, string>();
  const dismissedTeach = new Set(
    (readStore("tab-edit:dev-teach") ?? "").split(",").filter(Boolean)
  );
  const treeExpanded = new Set<string>(["0"]);
  const treeShowAll = new Set<string>();

  // ——— fetching: on demand, debounced, single-flight, never polled ———
  /** The activity window. The FIRST fetch is deliberately UNADDRESSED: an
   *  addressed `sincePass: 0` clamps forward to the oldest retained pass —
   *  the very pass the cold work happened in — so the cold window would come
   *  back empty. Every window after it names the previous frame's pass,
   *  which is non-destructive and leaves the shared cursor alone. */
  async function fetchActivity(): Promise<void> {
    if (!devOn || activityBusy) return;
    activityBusy = true;
    try {
      const next = await semantics.computeActivity(
        view.state,
        lastPassId === null ? {} : { sincePass: lastPassId }
      );
      activity = next;
      lastPassId = next.passId;
      if (diffBaseline !== null) {
        diffFrame = await semantics.computeActivity(view.state, { sincePass: diffBaseline });
      }
    } catch {
      // A debug read that fails must never break the page — the pane keeps
      // showing the last window it had.
    } finally {
      activityBusy = false;
    }
  }

  async function fetchInspection(): Promise<void> {
    if (!devOn || inspectBusy) return;
    inspectBusy = true;
    const pos = view.state.selection.main.from;
    const at = docEdits;
    try {
      frame = await semantics.inspectNode(view.state, { pos, maxValueChars: 4000 });
      framePos = pos;
      frameAtEdits = at;
      frameError = null;
    } catch (e) {
      frameError = (e as Error).message;
    } finally {
      inspectBusy = false;
    }
  }

  /** ONE refresh cycle for the whole surface — a single debounce, in the
   *  order the pull model requires: READ first (inspection), then ask what
   *  the window cost, so the inspector's own reads land in the report it
   *  shows rather than polluting the next edit's. */
  function scheduleDevRefresh(delayMs = 200): void {
    if (!devOn) return;
    if (refreshTimer !== null) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void (async () => {
        if (lens === "values" || lens === "cost" || watch.length > 0) await fetchInspection();
        await fetchActivity();
        paintDev();
      })();
    }, delayMs);
  }

  // ——— tiny DOM helpers ———
  const button = (
    className: string,
    text: string,
    onClick: () => void,
    title?: string
  ): HTMLButtonElement => {
    const b = document.createElement("button");
    b.className = className;
    b.textContent = text;
    if (title) b.title = title;
    b.addEventListener("click", (event) => {
      event.stopPropagation();
      onClick();
    });
    return b;
  };
  const div = (className: string, text?: string): HTMLDivElement => {
    const d = document.createElement("div");
    d.className = className;
    if (text !== undefined) d.textContent = text;
    return d;
  };
  const span = (className: string, text: string, title?: string): HTMLSpanElement => {
    const s = document.createElement("span");
    s.className = className;
    s.textContent = text;
    if (title) s.title = title;
    return s;
  };
  const chip = (text: string, active: boolean, onClick: () => void, title?: string): HTMLElement =>
    button(`dev-chip${active ? " active" : ""}`, text, onClick, title);
  const selectRange = (from: number, to: number): void => {
    const len = view.state.doc.length;
    view.dispatch({
      selection: EditorSelection.range(Math.min(from, len), Math.min(to, len)),
      scrollIntoView: true,
    });
    view.focus();
  };
  /** Frame-derived ranges address the document the frame answered for. */
  const frameIsLive = (): boolean => frameAtEdits === docEdits;

  function teach(host: HTMLElement, key: string, text: string): void {
    if (dismissedTeach.has(key)) {
      host.hidden = true;
      return;
    }
    host.hidden = false;
    host.replaceChildren(
      span("dev-teach-text", text),
      button(
        "dev-teach-x",
        "×",
        () => {
          dismissedTeach.add(key);
          writeStore("tab-edit:dev-teach", [...dismissedTeach].join(","));
          host.hidden = true;
        },
        "dismiss"
      )
    );
  }

  function paintDev(): void {
    if (!devOn) return;
    paintContextBar();
    paintWatch();
    if (lens === "values") paintValues();
    else if (lens === "cost") paintCost();
    else if (lens === "tree") paintTree();
    else paintProblems();
  }

  // ——— the context bar: breadcrumb + the savings figure, always in view ———
  function paintContextBar(): void {
    const state = view.state;
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head);
    const crumbs: HTMLElement[] = [];
    // The semantic chain when a frame has arrived; otherwise CM's own base
    // tree, which costs nothing (wiring 2 stores it) and is never stale.
    const semanticChain = frame && frameIsLive() && frame.chain.length > 0 ? frame.chain : null;
    if (semanticChain) {
      semanticChain.forEach((node, i) => {
        const b = button(
          "dev-crumb",
          node.nodeName,
          () => {
            const r = node.ranges[0];
            if (r && frameIsLive()) selectRange(r.from, r.to);
          },
          `${node.ranges.map(fmtRange).join(" + ")} — semantic node`
        );
        if (i === 0) b.classList.add("dev-crumb-deep");
        crumbs.push(b);
      });
    } else {
      const chain: SyntaxNode[] = [];
      for (
        let n = syntaxTree(state).resolveInner(head, 1) as SyntaxNode | null;
        n && chain.length < 10;
        n = n.parent
      ) {
        chain.push(n);
      }
      chain.forEach((n, i) => {
        const b = button(
          "dev-crumb",
          n.name,
          () => selectRange(n.from, n.to),
          `${n.from}-${n.to} — syntax node`
        );
        if (i === 0) b.classList.add("dev-crumb-deep");
        crumbs.push(b);
      });
    }
    devBreadcrumbEl.replaceChildren(...crumbs);
    devBreadcrumbEl.appendChild(span("dev-pos", `${head} · ${line.number}:${head - line.from + 1}`));
    if (inspectBusy) devBreadcrumbEl.appendChild(span("dev-dim", "reading…"));
    else if (frameError) devBreadcrumbEl.appendChild(span("dev-error", frameError));
    else if (frame && !frameIsLive()) {
      devBreadcrumbEl.appendChild(span("dev-dim", "document moved — ↻"));
    }

    const savings = savingsLine(activity);
    devSavingsEl.replaceChildren(
      span(
        savings.attributed ? "dev-savings-figure" : "dev-savings-figure dev-dim",
        savings.headline
      )
    );
    if (savings.note) devSavingsEl.appendChild(span("dev-dim", savings.note));
  }

  // ——— the watch strip: pinned props, across lenses and across edits ———
  const rowKey = (row: PropRow): string => `${row.nodeIndex} ${row.id}`;
  const currentRows = (): PropRow[] => buildRows(frame, indexActivity(activity));

  function paintWatch(): void {
    devWatchEl.hidden = watch.length === 0;
    if (watch.length === 0) return;
    const rows = currentRows();
    devWatchEl.replaceChildren(span("dev-watch-label", "watching"));
    for (const id of watch) {
      const row = rows.find((r) => r.id === id);
      const item = div("dev-watch-chip");
      item.appendChild(span("dev-watch-name", splitPropId(id).name, id));
      const text = row ? summarizeValue(row, 44) : "not at this node";
      // A marked chip is one whose value MOVED since this strip last saw it —
      // watching a prop across edits is the whole point of pinning one.
      const seen = watchSeen.get(id);
      if (row && seen !== undefined && seen !== text) item.classList.add("changed");
      if (row) watchSeen.set(id, text);
      item.appendChild(span(row ? "dev-watch-value" : "dev-watch-value dev-dim", text));
      if (row) item.appendChild(span(`dev-state dev-state-${row.state}`, "", row.state));
      item.appendChild(
        button(
          "dev-watch-x",
          "×",
          () => {
            watch = watch.filter((w) => w !== id);
            writeStore("tab-edit:dev-watch", watch.join(","));
            paintDev();
          },
          "unpin"
        )
      );
      if (row) {
        item.addEventListener("click", () => {
          selectedKey = rowKey(row);
          setLens("values");
        });
      }
      devWatchEl.appendChild(item);
    }
  }

  // ——— VALUES ———
  function paintValues(): void {
    teach(
      el("values-teach"),
      "values",
      "Every prop the installed packs attach to the nodes at the cursor. Claims come first: packs BID for a decision, the most confident bid wins, and the outcome is what everything downstream reads. Click a row for its override chain, its declared reads and what it cost."
    );
    const rows = currentRows();
    const index = indexActivity(activity);

    valuesToolbar.replaceChildren(
      chip(`all (${rows.length})`, packFilter === null, () => {
        packFilter = null;
        paintDev();
      })
    );
    for (const c of packChips(rows)) {
      valuesToolbar.appendChild(
        chip(`${c.pack} (${c.count})`, packFilter === c.pack, () => {
          packFilter = packFilter === c.pack ? null : c.pack;
          paintDev();
        })
      );
    }
    const states = stateChips(rows);
    if (states.length > 0) valuesToolbar.appendChild(span("dev-sep", "·"));
    for (const s of states) {
      valuesToolbar.appendChild(
        chip(
          `${s.state} (${s.count})`,
          stateFilter.includes(s.state),
          () => {
            stateFilter = stateFilter.includes(s.state)
              ? stateFilter.filter((x) => x !== s.state)
              : [...stateFilter, s.state];
            paintDev();
          },
          s.state === "carried"
            ? "reading it did no work at all"
            : s.state === "recomputed"
              ? "this read ran compute"
              : s.state === "cold"
                ? "ran on a pass with nothing to carry from"
                : "listed but not evaluated — ask for it by name"
        )
      );
    }
    const filterInput = document.createElement("input");
    filterInput.type = "text";
    filterInput.className = "dev-filter";
    filterInput.placeholder = "filter props…";
    filterInput.value = textFilter;
    filterInput.addEventListener("input", () => {
      const caret = filterInput.selectionStart;
      textFilter = filterInput.value;
      paintDev();
      const fresh = valuesToolbar.querySelector<HTMLInputElement>(".dev-filter");
      fresh?.focus();
      if (caret !== null) fresh?.setSelectionRange(caret, caret);
    });
    valuesToolbar.appendChild(filterInput);
    const orderSelect = document.createElement("select");
    orderSelect.className = "dev-select";
    orderSelect.title = "cost-first answers “what is slow” without hunting";
    for (const [value, label] of [
      ["cost", "cost first"],
      ["pack", "by pack"],
      ["name", "by name"],
    ] as const) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      option.selected = order === value;
      orderSelect.appendChild(option);
    }
    orderSelect.addEventListener("change", () => {
      order = orderSelect.value as RowOrder;
      paintDev();
    });
    valuesToolbar.appendChild(orderSelect);

    // CLAIMS: the negotiation, with its winner.
    const pairs = claimPairs(rows).filter((p) => packFilter === null || p.claim.pack === packFilter);
    valuesClaimsEl.replaceChildren();
    if (pairs.length > 0) {
      valuesClaimsEl.appendChild(
        span(
          "dev-section-title",
          "Claims",
          "packs bid for a decision; the winner is what every downstream prop reads"
        )
      );
      for (const pair of pairs) {
        const row = div("dev-claim");
        row.appendChild(span("dev-claim-name", pair.outcome?.name ?? pair.claim.name));
        if (pair.outcome) {
          row.appendChild(span("dev-claim-outcome", summarizeValue(pair.outcome, 30)));
        }
        row.appendChild(span("dev-claim-arrow", "←"));
        const bids = div("dev-claim-bids");
        const bidList = readBids(pair.claim.value);
        for (const bid of bidList) {
          const won =
            pair.outcome !== undefined &&
            JSON.stringify(bid.value) === JSON.stringify(pair.outcome.value);
          bids.appendChild(span(`dev-bid${won ? " won" : ""}`, bidLabel(bid)));
        }
        if (bidList.length === 0) {
          bids.appendChild(span("dev-dim", summarizeValue(pair.claim, 60)));
        }
        row.appendChild(bids);
        row.addEventListener("click", () => {
          selectedKey = rowKey(pair.claim);
          paintDev();
        });
        valuesClaimsEl.appendChild(row);
      }
    }

    // ROWS.
    const visible = orderRows(
      filterRows(rows, { pack: packFilter, text: textFilter, states: stateFilter }),
      order
    );
    valuesRowsEl.replaceChildren();
    if (rows.length === 0) {
      valuesRowsEl.appendChild(
        div(
          "dev-empty",
          frameError
            ? `inspection failed: ${frameError}`
            : inspectBusy
              ? "reading…"
              : "click a note, a measure or a tab line to see what the engine decided for it"
        )
      );
    } else if (visible.rows.length === 0) {
      valuesRowsEl.appendChild(div("dev-empty", "nothing matches these filters"));
    }
    let lastNode = -1;
    for (const row of visible.rows) {
      if (order === "pack" && row.nodeIndex !== lastNode) {
        lastNode = row.nodeIndex;
        valuesRowsEl.appendChild(
          div("dev-node-header", `${row.nodeName}  ${row.ranges.map(fmtRange).join(" + ")}`)
        );
      }
      valuesRowsEl.appendChild(propRow(row));
      if (selectedKey === rowKey(row)) valuesRowsEl.appendChild(propDetail(row, index));
    }

    const evaluated = rows.filter((r) => r.evaluated).length;
    const cached = rows.filter((r) => r.state === "carried").length;
    valuesFooterEl.replaceChildren(
      span("dev-dim", `${cached}/${evaluated} props served from cache`)
    );
    if (visible.costFellBack) {
      valuesFooterEl.appendChild(
        span("dev-dim", "· no cost window yet — ordered by pack; type a character to measure one")
      );
    }
    const snap = snapshotOf(view.state);
    if (snap) {
      const head = view.state.selection.main.head;
      const sounds = soundRangesAt(snap, head);
      valuesFooterEl.appendChild(
        span(
          "dev-dim",
          `· at cursor: ${sounds.length > 0 ? `sound ${sounds.map(fmtRange).join(" ")}` : "no sound"}` +
            ` · document: ${snap.sounds.length} sounds, ${snap.measures.length} measures, ${snap.directives.length} directives`
        )
      );
    }
    for (const w of frame?.installWarnings ?? []) {
      valuesFooterEl.appendChild(span("dev-warning", `install warning: ${w}`));
    }
  }

  interface Bid {
    readonly value: unknown;
    readonly source?: string;
    readonly confidence?: number;
    readonly at?: string;
  }
  /** Claim values come in a few shapes (one bid, a list of them, a per-line
   *  map). Read them tolerantly — the pane teaches the NEGOTIATION, and a
   *  shape it does not recognise falls back to the raw value. */
  function readBids(value: unknown): Bid[] {
    const one = (v: unknown, at?: string): Bid | null => {
      if (v === null || typeof v !== "object") return null;
      const record = v as Record<string, unknown>;
      if (!("value" in record)) return null;
      return {
        value: record.value,
        ...(typeof record.source === "string" ? { source: record.source } : {}),
        ...(typeof record.confidence === "number" ? { confidence: record.confidence } : {}),
        ...(at !== undefined ? { at } : {}),
      };
    };
    const single = one(value);
    if (single) return [single];
    if (Array.isArray(value)) {
      return value.map((v, i) => one(v, String(i))).filter((b): b is Bid => b !== null);
    }
    if (value !== null && typeof value === "object") {
      return Object.entries(value as Record<string, unknown>)
        .map(([k, v]) => one(v, k))
        .filter((b): b is Bid => b !== null);
    }
    return [];
  }
  const bidLabel = (bid: Bid): string => {
    const value = typeof bid.value === "string" ? bid.value : JSON.stringify(bid.value);
    const who = bid.source ?? "?";
    const confidence = bid.confidence !== undefined ? `@${bid.confidence}` : "";
    return `${bid.at !== undefined ? `${bid.at}: ` : ""}${who}${confidence} → ${value}`;
  };

  function propRow(row: PropRow): HTMLElement {
    const r = div(`dev-prop${selectedKey === rowKey(row) ? " selected" : ""}`);
    r.appendChild(span(`dev-state dev-state-${row.state}`, "", row.state));
    r.appendChild(span("dev-prop-name", row.name, row.id));
    r.appendChild(span("dev-prop-pack", row.pack));
    r.appendChild(
      span(
        `dev-stab dev-stab-${row.stability}`,
        row.stability === "stable" ? "stable" : "exp",
        row.stability === "stable"
          ? "stable: identity, value shape and meaning are versioned — safe to build on"
          : "experimental: readable and debuggable, but explicitly changeable"
      )
    );
    if (row.internal) {
      r.appendChild(
        span("dev-stab dev-stab-internal", "internal", "not readable by other plugins — no value is carried")
      );
    }
    r.appendChild(span(row.error ? "dev-prop-value dev-error" : "dev-prop-value", summarizeValue(row)));
    if (row.runs > 0) {
      r.appendChild(
        span("dev-cost", `${row.runs}× ${ms(row.selfMs)}`, "runs and self time in the current window")
      );
    }
    r.appendChild(span("dev-prop-node", row.nodeName));
    r.addEventListener("click", () => {
      selectedKey = selectedKey === rowKey(row) ? null : rowKey(row);
      paintDev();
    });
    return r;
  }

  function propDetail(row: PropRow, index: ReturnType<typeof indexActivity>): HTMLElement {
    const d = div("dev-detail");
    const head = div("dev-detail-head");
    head.appendChild(span("dev-detail-id", row.id));
    head.appendChild(
      button(
        "dev-mini",
        watch.includes(row.id) ? "unpin" : "pin",
        () => {
          watch = watch.includes(row.id) ? watch.filter((w) => w !== row.id) : [...watch, row.id];
          writeStore("tab-edit:dev-watch", watch.join(","));
          paintDev();
        },
        "keep this prop visible across edits and lenses"
      )
    );
    if (!row.evaluated && !row.internal) {
      head.appendChild(
        button(
          "dev-mini",
          "compute",
          () => {
            void computeOne(row);
          },
          "whole-document props are deferred — this computes just this one"
        )
      );
    }
    d.appendChild(head);

    const chainBox = div("dev-detail-block");
    chainBox.appendChild(
      span("dev-detail-label", "chain", "who COULD shape the value, outermost first")
    );
    chainBox.appendChild(span("dev-mono", row.chain.join("  →  ")));
    d.appendChild(chainBox);

    const wire = frame?.chain[row.nodeIndex]?.props.find((p) => p.id === row.id);
    if (wire && wire.trace.length > 0) {
      const traceBox = div("dev-detail-block");
      traceBox.appendChild(
        span("dev-detail-label", "ran", "who actually ran; inner() = the link delegated onward")
      );
      traceBox.appendChild(
        span(
          "dev-mono",
          wire.trace
            .map((s) =>
              s.base
                ? `${s.pluginId} (base)`
                : `${s.pluginId}${s.foundation ? " (foundation)" : ""}${s.delegated ? " → inner()" : ""}`
            )
            .join("  →  ")
        )
      );
      d.appendChild(traceBox);
    }

    // WHY it ran. Hedged deliberately: the engine keeps recompute RECORDS,
    // not a per-read causal trace, so this is what ALSO ran, not a proven
    // cause. If the engine learns to record the triggering read, the same
    // block shows a precise cause and only this label changes.
    const cause = causeOf(row, index);
    const causeBox = div("dev-detail-block");
    causeBox.appendChild(
      span(
        "dev-detail-label",
        "why it ran",
        "derived from outcome data: the declared reads that also recomputed in this window"
      )
    );
    const causeText = div("dev-cause");
    if (row.reason) causeText.appendChild(span("dev-reason", row.reason, reasonHelp(row.reason)));
    if (cause.upstream.length > 0) {
      causeText.appendChild(
        span("dev-dim", "declared reads that also recomputed in this window (correlation, not a recorded cause):")
      );
      for (const edge of cause.upstream) {
        causeText.appendChild(depLink(edge.propId, edge.runs, edge.selfMs));
      }
    } else if (row.deps.length > 0 && row.ranInWindow) {
      causeText.appendChild(span("dev-dim", "none of its declared reads ran in this window"));
    } else if (!row.ranInWindow) {
      causeText.appendChild(span("dev-dim", "it did not run in this window"));
    }
    if (cause.downstream.length > 0) {
      causeText.appendChild(span("dev-dim", "props here that read it and also recomputed:"));
      for (const edge of cause.downstream) {
        causeText.appendChild(depLink(edge.propId, edge.runs, edge.selfMs));
      }
    }
    causeBox.appendChild(causeText);
    d.appendChild(causeBox);

    if (row.deps.length > 0 || row.dependents.length > 0) {
      const depsBox = div("dev-detail-block");
      depsBox.appendChild(
        span("dev-detail-label", "reads", "the props this compute declares it may read")
      );
      const list = div("dev-deps");
      for (const dep of row.deps) list.appendChild(depLink(dep));
      if (row.deps.length === 0) list.appendChild(span("dev-dim", "nothing"));
      depsBox.appendChild(list);
      if (row.dependents.length > 0) {
        depsBox.appendChild(span("dev-detail-label", "read by"));
        const back = div("dev-deps");
        for (const dep of row.dependents) back.appendChild(depLink(dep));
        depsBox.appendChild(back);
      }
      d.appendChild(depsBox);
    }

    if (row.internal) {
      const box = div("dev-detail-block");
      box.appendChild(span("dev-detail-label", "value"));
      box.appendChild(
        span(
          "dev-dim",
          "withheld: code outside the owning plugin may not read an internal prop, so the frame carries its place in the graph, its cache outcome and its cost — never its content."
        )
      );
      d.appendChild(box);
    } else if (row.evaluated && row.error === undefined) {
      const valueBox = div("dev-detail-block");
      valueBox.appendChild(
        span(
          "dev-detail-label",
          row.valueTruncated
            ? `value (cut at ${row.valueChars?.toLocaleString()} chars)`
            : "value"
        )
      );
      const pre = document.createElement("pre");
      pre.className = "dev-value";
      pre.textContent =
        typeof row.value === "string"
          ? row.value
          : (JSON.stringify(row.value, null, 2) ?? "undefined");
      valueBox.appendChild(pre);
      const ranges = rangesInValue(row.value);
      if (ranges.length > 0 && frameIsLive()) {
        const jump = div("dev-deps");
        jump.appendChild(span("dev-dim", "ranges:"));
        for (const range of ranges) {
          jump.appendChild(
            button("dev-link", fmtRange(range), () => selectRange(range.from, range.to), "select this range")
          );
        }
        valueBox.appendChild(jump);
      }
      d.appendChild(valueBox);
    }
    return d;
  }

  /** Compute ONE deferred prop on demand. `only.nodeIndex` is a hint, not a
   *  handle, so the answer is re-matched by node name + ranges before it
   *  patches the frame in place. */
  async function computeOne(row: PropRow): Promise<void> {
    try {
      const fresh = await semantics.inspectNode(view.state, {
        pos: framePos,
        only: { nodeIndex: row.nodeIndex, propIds: [row.id] },
        maxValueChars: 20_000,
      });
      const node = fresh.chain.find(
        (n) =>
          n.nodeName === row.nodeName &&
          JSON.stringify(n.ranges) === JSON.stringify(row.ranges)
      );
      const patched = node?.props.find((p) => p.id === row.id);
      if (patched && frame) {
        frame = {
          ...frame,
          chain: frame.chain.map((n) =>
            n.nodeName === row.nodeName && JSON.stringify(n.ranges) === JSON.stringify(row.ranges)
              ? { ...n, props: n.props.map((p) => (p.id === row.id ? patched : p)) }
              : n
          ),
        };
      }
    } catch (e) {
      frameError = (e as Error).message;
    }
    // The click's own work is real work: attribute it to this window rather
    // than leaving it to surprise the next edit's report.
    await fetchActivity();
    paintDev();
  }

  function depLink(propId: string, runs?: number, selfMs?: number): HTMLElement {
    const label = runs !== undefined ? `${propId}  ${runs}× ${ms(selfMs ?? 0)}` : propId;
    return button(
      "dev-link",
      label,
      () => {
        const target = currentRows().find((r) => r.id === propId);
        packFilter = null;
        stateFilter = [];
        if (target) {
          textFilter = "";
          selectedKey = rowKey(target);
          setLens("values");
          valuesRowsEl.querySelector(".dev-prop.selected")?.scrollIntoView({ block: "center" });
        } else {
          // The edge is real; the prop just attaches somewhere else in the
          // document. Leave a filter behind so the walk is still visible.
          textFilter = splitPropId(propId).name;
          setLens("values");
        }
      },
      "walk to this prop"
    );
  }

  const reasonHelp = (reason: string): string =>
    ({
      cold: "first pass over this document — nothing to carry from",
      "no-prior-value": "a new node: there was no previous value to carry",
      "text-changed": "its part of the document changed",
      "structure-changed": "the shape of the document changed",
      "declared-read-changed": "something it reads directly reported changed",
      "dependency-recomputed": "a prop it names in deps ran in the same window",
      unknown: "not attributable from outcome data",
    })[reason] ?? reason;

  // ——— COST ———
  function paintCost(): void {
    teach(
      el("cost-teach"),
      "cost",
      "What the engine actually did, per prop: how often it ran, what it cost, and which of its declared reads moved with it. The levers are yours — how expensive the compute is, how broad the `on:` selector is, how volatile the declared reads are, and how good the equality cutoff is."
    );
    const showing = diffFrame ?? activity;
    const savings = savingsLine(showing);

    costToolbar.replaceChildren(
      chip(
        diffBaseline === null ? "live window" : `since pass ${diffBaseline}`,
        diffBaseline !== null,
        () => {
          // DIFF MODE: name a pass, then watch what has moved since it. The
          // window is addressable, so it never disturbs the live one.
          if (diffBaseline === null) diffBaseline = activity?.passId ?? null;
          else {
            diffBaseline = null;
            diffFrame = null;
          }
          scheduleDevRefresh(0);
        },
        "mark this pass and diff against it"
      ),
      button("dev-mini", "↻ measure now", () => scheduleDevRefresh(0), "re-read and re-measure")
    );
    if (diffBaseline !== null) {
      costToolbar.appendChild(
        span(
          "dev-dim",
          "diff is PROP-ID granular: which props recomputed, not how their values differ — the engine keeps recompute records, not a history of values"
        )
      );
    }

    costHeadlineEl.replaceChildren(
      span(
        savings.attributed ? "dev-headline-figure" : "dev-headline-figure dev-dim",
        savings.headline
      )
    );
    if (savings.note) costHeadlineEl.appendChild(span("dev-dim", savings.note));
    if (showing) {
      costHeadlineEl.appendChild(
        span(
          "dev-dim",
          `window: passes ${showing.sincePass + 1}–${showing.passId} · ${showing.totalRecomputes} runs` +
            (showing.savings.baselineMs > 0
              ? ` · this document cold-booted in ${ms(showing.savings.baselineMs)}`
              : "")
        )
      );
    }

    costBodyEl.replaceChildren();
    const costs = costRows(showing);
    if (costs.length === 0) {
      costBodyEl.appendChild(
        div("dev-empty", "nothing recomputed in this window — type a character and look again")
      );
      return;
    }
    const index = indexActivity(showing);
    const propRows = currentRows();
    for (const cost of costs) {
      const r = div("dev-prop");
      r.appendChild(span("dev-cost-runs", `${cost.runs}×`));
      r.appendChild(span("dev-cost-ms", ms(cost.selfMs), `worst single run ${ms(cost.maxSelfMs)}`));
      r.appendChild(span("dev-prop-name", cost.name, cost.propId));
      r.appendChild(span("dev-prop-pack", cost.pack));
      if (cost.reason) r.appendChild(span("dev-reason", cost.reason, reasonHelp(cost.reason)));
      const row = propRows.find((p) => p.id === cost.propId);
      if (row) {
        const cause = causeOf(row, index);
        if (cause.upstream.length > 0) {
          r.appendChild(span("dev-dim", "with:"));
          for (const edge of cause.upstream.slice(0, 3)) r.appendChild(depLink(edge.propId));
        }
        r.addEventListener("click", () => {
          selectedKey = rowKey(row);
          setLens("values");
        });
      }
      costBodyEl.appendChild(r);
    }
  }

  // ——— TREE: the whole document, client-side and free ———
  /** Expansion is keyed by the CHILD-INDEX PATH from the root ("0.3.2"), not
   *  by node identity: identities do not survive an edit, and paths outside
   *  the edited region do. */
  function pathOfCursor(): string[] {
    const chain: SyntaxNode[] = [];
    for (
      let n = syntaxTree(view.state).resolveInner(view.state.selection.main.head, 1) as SyntaxNode | null;
      n;
      n = n.parent
    ) {
      chain.unshift(n);
    }
    const path = ["0"];
    let key = "0";
    for (let i = 1; i < chain.length; i++) {
      let index = 0;
      for (let s = chain[i].parent?.firstChild ?? null; s; s = s.nextSibling) {
        if (s.from === chain[i].from && s.to === chain[i].to && s.name === chain[i].name) break;
        index++;
      }
      key = `${key}.${index}`;
      path.push(key);
    }
    return path;
  }

  function paintTree(): void {
    teach(
      el("tree-teach"),
      "tree",
      "The document's syntax tree, as the grammar sees it — this is what a plugin's `on:` selectors match. It is CodeMirror's own tree, so it costs no round trip and never goes stale. Click a node to select its text."
    );
    const tree = syntaxTree(view.state);
    const cursorPath = pathOfCursor();
    for (const p of cursorPath) treeExpanded.add(p);
    const deepest = cursorPath[cursorPath.length - 1];

    treeToolbar.replaceChildren(
      button("dev-mini", "reveal cursor", () => {
        for (const p of pathOfCursor()) treeExpanded.add(p);
        paintTree();
        treeBodyEl.querySelector(".dev-tree-row.at-cursor")?.scrollIntoView({ block: "center" });
      }),
      button("dev-mini", "collapse all", () => {
        treeExpanded.clear();
        treeExpanded.add("0");
        paintTree();
      }),
      span(
        "dev-dim",
        `${tree.length.toLocaleString()} of ${view.state.doc.length.toLocaleString()} chars parsed`
      )
    );
    if (tree.length < view.state.doc.length) {
      treeToolbar.appendChild(
        span("dev-warning", "the parse has not reached the end of the document yet")
      );
    }

    treeBodyEl.replaceChildren();
    const render = (node: SyntaxNode, path: string, depth: number): void => {
      const kids: SyntaxNode[] = [];
      for (let c = node.firstChild; c; c = c.nextSibling) kids.push(c);
      const expanded = treeExpanded.has(path);
      const row = div(`dev-tree-row${path === deepest ? " at-cursor" : ""}`);
      row.style.paddingLeft = `${depth * 13 + 6}px`;
      row.appendChild(
        button(
          "dev-caret",
          kids.length === 0 ? "·" : expanded ? "▾" : "▸",
          () => {
            if (kids.length === 0) return;
            if (expanded) treeExpanded.delete(path);
            else treeExpanded.add(path);
            paintTree();
          },
          kids.length === 0 ? "leaf" : `${kids.length} children`
        )
      );
      row.appendChild(span("dev-tree-name", node.name));
      row.appendChild(span("dev-tree-range", `${node.from}-${node.to}`));
      const text = view.state.doc.sliceString(node.from, Math.min(node.to, node.from + 30));
      if (text.trim().length > 0) {
        row.appendChild(span("dev-tree-text", text.replace(/\n/g, "⏎")));
      }
      row.addEventListener("click", () => selectRange(node.from, node.to));
      treeBodyEl.appendChild(row);
      if (!expanded) return;
      // Lazily rendered children ARE the virtualisation: a collapsed subtree
      // has no DOM at all, so a 16k-char document costs a few dozen rows.
      const cap = treeShowAll.has(path) ? kids.length : 200;
      kids.slice(0, cap).forEach((kid, i) => render(kid, `${path}.${i}`, depth + 1));
      if (kids.length > cap) {
        const more = button("dev-mini", `+${kids.length - cap} more`, () => {
          treeShowAll.add(path);
          paintTree();
        });
        more.style.marginLeft = `${(depth + 1) * 13 + 6}px`;
        treeBodyEl.appendChild(more);
      }
    };
    render(tree.topNode as unknown as SyntaxNode, "0", 0);
  }

  // ——— PROBLEMS ———
  function paintProblems(): void {
    teach(
      el("problems-teach"),
      "problems",
      "Diagnostics from the packs' diagnostic props, over the wire like every other value. Click one to jump to it; a fix applies as an ordinary edit you can undo."
    );
    const diags = tabDiagnostics(view.state);
    devDiagCountEl.textContent = diags.length > 0 ? `(${diags.length})` : "";
    devDiagnosticsEl.replaceChildren();
    if (diags.length === 0) {
      devDiagnosticsEl.appendChild(div("dev-empty", "no diagnostics — the document reads cleanly"));
      return;
    }
    for (const d of diags) {
      const row = div("dev-problem");
      row.appendChild(span(`dev-sev dev-sev-${d.severity}`, d.severity));
      row.appendChild(span("dev-problem-msg", d.message));
      row.appendChild(span("dev-dim", fmtRange(d)));
      for (const fix of d.actions ?? []) {
        row.appendChild(
          button("dev-mini", fix.name, () => {
            fix.apply(view, d.from, d.to);
            view.focus();
          })
        );
      }
      row.addEventListener("click", () => selectRange(d.from, d.to));
      devDiagnosticsEl.appendChild(row);
    }
  }

  // ——— the master switch ———
  function setLens(next: Lens): void {
    lens = next;
    for (const b of lensButtons) {
      const active = b.dataset.lens === next;
      b.setAttribute("aria-selected", String(active));
      b.classList.toggle("active", active);
    }
    for (const [name, body] of Object.entries(lensBodies)) body.hidden = name !== next;
    writeStore("tab-edit:dev-lens", next);
    // A lens that needs wire data and has none yet asks for it once.
    if ((next === "values" || next === "cost") && frame === null && devOn) scheduleDevRefresh(0);
    else paintDev();
  }

  function setDev(on: boolean): void {
    if (on === devOn) return;
    devOn = on;
    devDrawer.hidden = !on;
    devToggle.setAttribute("aria-pressed", String(on));
    devToggle.classList.toggle("active", on);
    writeStore("tab-edit:dev", on ? "1" : "0");
    if (on) {
      setLens(lens);
      // Snapshot values are already on screen for the overlays, so THIS may
      // poll — cheaply, and only while the surface is open. It never touches
      // the rate-limited inspection queries.
      snapshotTimer ??= setInterval(() => {
        if (lens === "problems" || lens === "values") paintDev();
      }, 500);
      scheduleDevRefresh(0);
    } else {
      // OFF COSTS NOTHING: stop the timer, cancel pending work, drop the
      // frames. No queries, no repaints, no retained wire data.
      if (snapshotTimer !== null) {
        clearInterval(snapshotTimer);
        snapshotTimer = null;
      }
      if (refreshTimer !== null) {
        clearTimeout(refreshTimer);
        refreshTimer = null;
      }
      frame = null;
      activity = null;
      diffFrame = null;
      frameError = null;
      selectedKey = null;
      // Nothing painted is left behind either: a hidden pane still holding
      // the last frame's values is retained wire data with a UI on it.
      for (const host of [
        devBreadcrumbEl,
        devSavingsEl,
        devWatchEl,
        valuesToolbar,
        valuesClaimsEl,
        valuesRowsEl,
        valuesFooterEl,
        costToolbar,
        costHeadlineEl,
        costBodyEl,
        treeToolbar,
        treeBodyEl,
        devDiagnosticsEl,
      ]) {
        host.replaceChildren();
      }
    }
  }

  onDocChanged = () => {
    if (!devOn) return;
    paintDev();
    scheduleDevRefresh(350);
  };
  devToggle.addEventListener("click", () => setDev(!devOn));
  devRefreshButton.addEventListener("click", () => {
    frame = null;
    scheduleDevRefresh(0);
  });
  for (const b of lensButtons) b.addEventListener("click", () => setLens(b.dataset.lens as Lens));

  // ?dev=1 sets the SAME single flag — a debug session is shareable as a
  // link, and the harness can open straight into it.
  const devParam = new URLSearchParams(location.search).get("dev");
  if (devParam === "1" || (devParam !== "0" && readStore("tab-edit:dev") === "1")) setDev(true);

  // Drag the top edge to resize.
  devResize.addEventListener("pointerdown", (down) => {
    down.preventDefault();
    devResize.setPointerCapture(down.pointerId);
    const startY = down.clientY;
    const startHeight = devDrawer.getBoundingClientRect().height;
    const move = (e: PointerEvent): void => {
      const height = Math.max(120, Math.min(startHeight + startY - e.clientY, window.innerHeight - 160));
      devDrawer.style.height = `${height}px`;
    };
    const stop = (): void => {
      devResize.removeEventListener("pointermove", move);
      devResize.removeEventListener("pointerup", stop);
    };
    devResize.addEventListener("pointermove", move);
    devResize.addEventListener("pointerup", stop);
  });

  // Keyboard: ⌥D toggles the surface, ⌥1–4 pick a lens, ⌥R re-reads. Alt
  // combinations only, never while typing in a field, and the editor keeps
  // every other key (Space belongs to playback).
  window.addEventListener("keydown", (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    const target = e.target as HTMLElement | null;
    if (target && ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName)) return;
    if (e.code === "KeyD") {
      e.preventDefault();
      setDev(!devOn);
      return;
    }
    if (!devOn) return;
    const lensKeys: Record<string, Lens> = {
      Digit1: "values",
      Digit2: "cost",
      Digit3: "tree",
      Digit4: "problems",
    };
    if (lensKeys[e.code]) {
      e.preventDefault();
      setLens(lensKeys[e.code]);
    } else if (e.code === "KeyR") {
      e.preventDefault();
      frame = null;
      scheduleDevRefresh(0);
    }
  });

  // Collapse/expand — OPEN by default (the sheet is half the product). OSMD
  // lays out to the width it sees, so a score rendered while collapsed keeps
  // that geometry: re-render on the way back out.
  sheetToggle.addEventListener("click", () => {
    const collapsed = sheetPane.classList.toggle("collapsed");
    sheetToggle.textContent = collapsed ? "▸" : "▾";
    sheetToggle.setAttribute("aria-expanded", String(!collapsed));
    sheetToggle.title = collapsed ? "expand the sheet pane" : "collapse the sheet pane";
    if (!collapsed && sheetLoaded) void renderSheet();
  });
  void renderSheet();

  // ——— sheet playback cursor: notation follows the playhead through the
  // TIME join (Player.scoreTimeAt and OSMD timestamps are both whole-note
  // fractions over the SAME exported durations — arithmetic, not matching).
  function hideSheetCursor(): void {
    sheetCursorNextTs = -1;
    if (!sheetCursorShown) return;
    sheetCursorShown = false;
    try {
      osmd.cursor.hide();
    } catch {
      // cursor DOM invalidated by a re-render — nothing to hide
    }
  }
  /** Park the cursor on the first entry of a freshly rendered score. The
   *  score used to show WHERE YOU ARE only while sound was coming out (the
   *  cursor was hidden on stop and never shown at rest), so a user looking
   *  for it before pressing ▶ found nothing at all — the first thing anyone
   *  checks. A parked cursor also proves the thing exists and is on screen. */
  function showSheetCursorAtStart(): void {
    try {
      osmd.cursor.reset();
      osmd.cursor.show();
      sheetCursorShown = true;
      sheetCursorNextTs = -1;
      // Deliberately NO scroll: parking the cursor happens after every
      // re-render (i.e. after every edit) and after stop, and yanking the
      // pane back to bar 1 each time would fight the user reading bar 40.
      // Only the moving playhead scrolls.
    } catch {
      // an empty/degenerate score has no first entry — nothing to park on
    }
  }
  /** Keep the cursor inside the visible band of the score pane. The pane is
   *  the scroller (any real song is several times its height), so without
   *  this the cursor walks out of view within seconds of ▶ — rendered
   *  correctly, and invisible. Honours the ⌖ toggle: follow off means the
   *  user is reading somewhere else and we must not yank the page. */
  function scrollSheetCursorIntoView(): void {
    if (!followPlayhead) return;
    const img = sheetScoreEl.querySelector<HTMLElement>('img[id^="cursorImg"]');
    if (!img) return;
    const pane = sheetScoreEl.getBoundingClientRect();
    const box = img.getBoundingClientRect();
    if (box.height === 0) return;
    const margin = Math.min(80, pane.height / 4);
    if (box.top < pane.top + margin) {
      sheetScoreEl.scrollTop -= pane.top + margin - box.top;
    } else if (box.bottom > pane.bottom - margin) {
      sheetScoreEl.scrollTop += box.bottom - (pane.bottom - margin);
    }
  }
  function followSheetCursor(target: number): void {
    if (!sheetLoaded) return;
    try {
      const c = osmd.cursor;
      if (!sheetCursorShown) {
        c.reset();
        c.show();
        sheetCursorShown = true;
        sheetCursorNextTs = -1;
      }
      if (c.iterator.currentTimeStamp.RealValue > target + 1e-6) {
        c.reset(); // backward jump (scrub/restart)
        sheetCursorNextTs = -1;
      }
      // Nothing to advance to yet. Scrolling is done ON ADVANCE only (below):
      // measuring two rects every animation frame forces a layout per frame
      // against a very large SVG, and the next note is never far away.
      if (target < sheetCursorNextTs) return;
      let advanced = false;
      while (!c.iterator.EndReached && c.iterator.currentTimeStamp.RealValue <= target + 1e-9) {
        c.next();
        advanced = true;
      }
      sheetCursorNextTs = c.iterator.EndReached ? Infinity : c.iterator.currentTimeStamp.RealValue;
      if (advanced) c.previous(); // sit on the SOUNDING entry
      scrollSheetCursorIntoView();
    } catch {
      hideSheetCursor(); // cursor drift must never break playback
    }
  }

  // ——— transport: selection-aware playback with follow-the-playhead ———
  // The data is two wire values (midiEvents + the snapshot sound map), so
  // this identical code path runs remote or local (src/playback.ts).
  let raf = 0;
  let lastSpanKey = "";
  // followPlayhead is declared with the sheet-cursor state above — the cursor
  // functions read it, and they exist before this point.
  let playedToEnd = false;
  // The selection that SCOPED the current player, kept so the transport can
  // tell a user's selection from one the playhead wrote. Without it, follow
  // leaves a single sounding span selected, the next ▶ scopes itself to that
  // span, and there is no way back to the whole score.
  let scopeSelection: EditorSelection | null = null;
  let scopeSignature = "";

  const setEditable = (on: boolean): void => {
    view.dispatch({ effects: editableCompartment.reconfigure(EditorView.editable.of(on)) });
  };
  const applySpans = (spans: readonly Span[]): void => {
    view.dispatch({
      selection: EditorSelection.create(
        spans.map((s) => EditorSelection.range(s.from, s.to)),
        0
      ),
      scrollIntoView: true,
    });
  };
  const jumpToPlayhead = (): void => {
    if (!player) return;
    // The PLAYBAR is the source of truth here: both surfaces move to it, not
    // the other way round. Painting explicitly matters while paused, where the
    // tick is stopped and would otherwise never catch the notation cursor up.
    paintTransport();
    const p = player.progress();
    if (!p.spans) return;
    if (rangeSignature(view.state.selection.ranges) !== rangeSignature(p.spans)) {
      applySpans(p.spans);
    }
  };
  /** Paint the transport from the player's CURRENT position, scheduling
   *  nothing — shared by the running tick and the paused seek below. */
  const paintTransport = (): void => {
    if (!player) return;
    const p = player.progress();
    slider.value = String(Math.round((p.sec / p.totalSec) * 1000));
    timeEl.textContent = `${fmt(p.sec)} / ${fmt(p.totalSec)}`;
    followSheetCursor(player.scoreTimeAt(p.sec));
  };
  const tick = (): void => {
    if (!player || player.paused) return; // a paused playhead owns nothing
    paintTransport();
    const p = player.progress();
    if (followPlayhead && p.spans) {
      const key = rangeSignature(p.spans);
      if (key !== lastSpanKey) {
        lastSpanKey = key;
        applySpans(p.spans);
      }
    }
    if (p.ended) {
      playedToEnd = true;
      stopPlayback();
    } else {
      raf = requestAnimationFrame(tick);
    }
  };

  function stopPlayback(): void {
    cancelAnimationFrame(raf);
    player?.stop();
    player = null;
    // Hand the selection back. If what's on screen is the span FOLLOW wrote,
    // it is not a choice the user made — restoring the scoping selection is
    // what makes "play the whole thing again" reachable.
    if (scopeSelection && rangeSignature(view.state.selection.ranges) === lastSpanKey) {
      // An EDIT can stop playback (the doc-changed path), so the scoping
      // positions may now be past the end — clamp rather than throw.
      const len = view.state.doc.length;
      view.dispatch({
        selection: EditorSelection.create(
          scopeSelection.ranges.map((r) =>
            EditorSelection.range(Math.min(r.anchor, len), Math.min(r.head, len))
          ),
          scopeSelection.mainIndex
        ),
      });
    }
    scopeSelection = null;
    scopeSignature = "";
    playButton.textContent = "▶";
    slider.disabled = true;
    slider.value = "0";
    followButton.disabled = true;
    timeEl.textContent = "";
    // Stop parks the cursor at the top of the score rather than hiding it —
    // the sheet keeps showing a position at rest (see showSheetCursorAtStart).
    showSheetCursorAtStart();
    setEditable(true);
  }

  async function togglePlayback(): Promise<void> {
    if (player && !player.paused) {
      player.pause();
      // STOP THE TICK. Without this the follow loop keeps running while
      // paused and rewrites the selection every frame — which silently ate
      // any click the user made, then made ▶ see a "changed" selection and
      // rebuild from the play-start position.
      cancelAnimationFrame(raf);
      playButton.textContent = "▶";
      setEditable(true);
      return;
    }
    if (player) {
      // PAUSED — the selection is live again, and it is the instruction:
      // unchanged means resume where we stopped, changed means the user picked
      // a new range (or cleared it), which is a new player, not a resume.
      //
      // "Unchanged" has TWO forms, and missing the second one is what made
      // play → pause → play jump back to where the caret started (Stan,
      // 2026-07-26): with follow on, the selection left on screen by a pause
      // is the sounding span the PLAYHEAD wrote, not a choice the user made.
      // Comparing it only against the scoping selection read "changed",
      // rebuilt the player, and stopPlayback restored the play-start caret.
      // A user selection is one that matches NEITHER.
      const selectionNow = rangeSignature(view.state.selection.ranges);
      if (selectionNow === scopeSignature || (lastSpanKey !== "" && selectionNow === lastSpanKey)) {
        player.resume();
        playButton.textContent = "⏸";
        setEditable(false);
        raf = requestAnimationFrame(tick);
        return;
      }
      stopPlayback();
      playedToEnd = false;
    }
    // ONE wire round trip per play (a query, never on the typing path);
    // the sound map comes from the snapshot already on screen.
    playButton.disabled = true;
    let midi;
    try {
      midi = await semantics.midiEvents(view.state);
    } catch (e) {
      sheetStatus(`playback: ${(e as Error).message}`);
      return;
    } finally {
      playButton.disabled = false;
    }
    player = createPlayer(
      { midi, snapshot: snapshotOf(view.state), doc: view.state.doc },
      view.state.selection.ranges,
      timbrePicker.value as Timbre
    );
    if (!player) {
      sheetStatus("playback: nothing playable here yet");
      return;
    }
    scopeSelection = view.state.selection;
    scopeSignature = rangeSignature(view.state.selection.ranges);
    // Play from HERE: a caret on/before a sound starts there; a non-empty
    // selection instead scopes the whole timeline to itself.
    if (!view.state.selection.ranges.some((r) => !r.empty) && !playedToEnd) {
      const sec = player.secAt(view.state.selection.main.head);
      if (sec !== undefined && sec > 0) player.seek(sec);
    }
    playedToEnd = false;
    playButton.textContent = "⏸";
    slider.disabled = false;
    followButton.disabled = false;
    lastSpanKey = "";
    setEditable(false);
    view.focus();
    raf = requestAnimationFrame(tick);
  }

  // PAUSED, follow on: clicking in the text is a SEEK — follow's other
  // direction ("play from where I'm pointing"). A caret moves the playhead
  // inside the current timeline and updates the scope signature so ▶ resumes
  // there; a real selection is left alone, because that is a new SCOPE and
  // togglePlayback rebuilds the player around it.
  onSelectionChanged = (state) => {
    // The dev surface follows the cursor — debounced, and only while it is
    // open (setDev/scheduleDevRefresh both no-op when the switch is off, so
    // a user who never asks for it never spends a query).
    if (devOn) {
      paintDev(); // the free half (breadcrumb, tree) moves immediately
      scheduleDevRefresh();
    }
    if (!player || !player.paused || !followPlayhead) return;
    const sel = state.selection;
    if (sel.ranges.some((r) => !r.empty)) return;
    const sec = player.secAt(sel.main.head);
    if (sec === undefined) return;
    player.seek(sec);
    scopeSignature = rangeSignature(sel.ranges);
    paintTransport();
  };

  playButton.addEventListener("click", () => void togglePlayback());
  slider.addEventListener("input", () => {
    if (!player) return;
    player.seek((Number(slider.value) / 1000) * player.totalSec);
    if (followPlayhead) jumpToPlayhead();
  });
  followButton.addEventListener("click", () => {
    followPlayhead = !followPlayhead;
    followButton.classList.toggle("active", followPlayhead);
    followButton.setAttribute("aria-pressed", String(followPlayhead));
    if (followPlayhead) {
      jumpToPlayhead();
      scrollSheetCursorIntoView(); // ⌖ back on: bring the score with it
    }
  });
  timbrePicker.addEventListener("change", () => {
    if (player) stopPlayback(); // next ▶ builds with the new timbre
  });
  window.addEventListener("keydown", (e) => {
    // Space plays/pauses unless the user is typing in the editor.
    if (e.code !== "Space" || view.hasFocus) return;
    const target = e.target as HTMLElement | null;
    if (target && ["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(target.tagName)) return;
    e.preventDefault();
    void togglePlayback();
  });

  // ——— samples ———
  const picker = document.getElementById("sample-picker") as HTMLSelectElement;
  const starter = document.createElement("option");
  starter.value = "__starter";
  starter.textContent = "Blackbird (starter)";
  picker.appendChild(starter);
  for (const group of SAMPLES) {
    const optgroup = document.createElement("optgroup");
    optgroup.label = group.group;
    for (const item of group.items) {
      const option = document.createElement("option");
      option.value = item.label;
      option.textContent = item.label;
      optgroup.appendChild(option);
    }
    picker.appendChild(optgroup);
  }
  picker.addEventListener("change", () => {
    const text =
      picker.value === "__starter"
        ? INITIAL_DOC
        : SAMPLES.flatMap((g) => g.items).find((i) => i.label === picker.value)?.text;
    if (text === undefined) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    view.focus();
  });

  // ——— import / export through the facade ———
  function downloadBlob(data: BlobPart, filename: string, type: string): void {
    const url = URL.createObjectURL(new Blob([data], { type }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }
  const importInput = document.getElementById("import-xml-file") as HTMLInputElement;
  document.getElementById("import-xml")!.addEventListener("click", () => importInput.click());
  importInput.addEventListener("change", async () => {
    const file = importInput.files?.[0];
    importInput.value = "";
    if (!file) return;
    try {
      const edits = await semantics.importMusicXml(view.state, await file.text());
      view.dispatch({ changes: edits.map((e) => ({ ...e })) });
      view.focus();
    } catch (e) {
      alert(`MusicXML import failed: ${(e as Error).message}`);
    }
  });
  document.getElementById("export-xml")!.addEventListener("click", async () => {
    downloadBlob(
      await semantics.musicXml(view.state),
      "tab.musicxml",
      "application/vnd.recordare.musicxml+xml"
    );
  });
  document.getElementById("export-midi")!.addEventListener("click", async () => {
    const bytes = await semantics.midiFile(view.state);
    // Copy into a plain ArrayBuffer-backed view (TS 5.7 Uint8Array<ArrayBufferLike>
    // is not a BlobPart).
    downloadBlob(new Uint8Array(bytes), "tab.mid", "audio/midi");
  });
}

void main();
