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
import { Annotation, Compartment, EditorSelection, EditorState } from "@codemirror/state";
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
/** Marks the selections follow-the-playhead writes (see applySpans). */
const playheadSelection = Annotation.define<boolean>();
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
  let onSelectionChanged: ((state: EditorState, fromPlayhead: boolean) => void) | null = null;
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
        if (update.selectionSet || update.docChanged) {
          onSelectionChanged?.(
            update.state,
            update.transactions.some((tr) => tr.annotation(playheadSelection) === true)
          );
        }
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
  /** SET vs PARTITION — the interaction model mirrors the data model (see
   *  docs/design/UI-PRINCIPLES.md §6, written after these two dimensions
   *  wore the same pill on one line and were immediately confounded). Packs
   *  are a set: many at once. Outcome is a partition: exactly one, or all. */
  const packFilters = new Set<string>();
  let textFilter = "";
  let stateFilter: PropState | null = null;
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
        rememberWatch();
      })();
    }, delayMs);
  }

  // ——— WHILE THE MUSIC PLAYS ————————————————————————————————————————————
  //
  // Follow-the-playhead writes the editor selection on EVERY sounding note.
  // Read as cursor moves, those writes made the surface re-read and repaint
  // per note: the chrome flickered and clicks landed between two different
  // elements (Stan, on the shipped surface). Three rules answer it, and only
  // the third is a timer:
  //
  //   1. PROVENANCE. A playhead selection is not user intent (annotation
  //      above). It never resets the user-intent debounce, never moves the
  //      lens, and never counts as "the user is looking somewhere else".
  //   2. IDENTITY. Rows, chips and crumbs are keyed and PATCHED IN PLACE
  //      (see `sync`), so following costs text updates, never a rebuild —
  //      which is what makes a click land on the element it started on.
  //   3. STICKINESS. Wherever the user is actually working — pointer inside
  //      the surface, a button held down, a prop row open, a field focused —
  //      the playhead does not get to move the view at all.
  //
  // WHY FOLLOW AT ALL, rather than freeze? Watching the values tick over
  // note by note is the best demonstration this surface has: the sound you
  // hear and the engine's reading of it, side by side. Freezing would trade
  // the feature away to fix a rendering bug. With (2) in place the chrome is
  // stationary anyway, so the honest fix is to keep it live and make it
  // solid — and to hold still exactly where holding still matters.
  const PLAYHEAD_MIN_MS = 400;
  /** How long after the pointer last MOVED the surface still counts as being
   *  pointed at. A pointer merely PARKED over the pane is not aiming at
   *  anything — blocking on presence alone froze the pane for as long as the
   *  mouse rested there (found by the harness: it clicks, then never moves
   *  the mouse again). Movement, press and release all fall inside this
   *  window, which is what the click-safety rule actually needs. */
  const POINTER_QUIET_MS = 1200;
  let lastPlayheadRefresh = 0;
  let pointerInSurface = false;
  let lastPointerMove = 0;
  let pointerHeld = false;
  let paintPending = false;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Would a repaint right now move something the user is aiming at? */
  const paintBlocked = (): boolean =>
    pointerHeld || (pointerInSurface && Date.now() - lastPointerMove < POINTER_QUIET_MS);
  /** May the playhead move what the surface is LOOKING at? Stickier than
   *  paint-blocking: an open prop row or a focused field means the user is
   *  working here, and the view must stay put even though repainting it
   *  would be safe. */
  const playheadMayMove = (): boolean =>
    selectedKey === null &&
    !paintBlocked() &&
    !(document.activeElement !== null && devDrawer.contains(document.activeElement));

  devDrawer.addEventListener("pointerenter", () => {
    pointerInSurface = true;
    lastPointerMove = Date.now();
  });
  devDrawer.addEventListener("pointermove", () => {
    lastPointerMove = Date.now();
  });
  devDrawer.addEventListener("pointerleave", () => {
    pointerInSurface = false;
    flushPendingPaint();
  });
  // Unconditionally between mousedown and mouseup: a list that re-orders
  // between the two halves of a click is a click delivered to the wrong row.
  // Registered only while the surface is ON — principle #14 says OFF means
  // no listeners registered, not "registered but early-returning".
  const onPointerDown = (): void => {
    pointerHeld = true;
  };
  const onPointerUp = (): void => {
    pointerHeld = false;
    flushPendingPaint();
  };
  /** The quiet moment after the pointer leaves or the button comes up: the
   *  surface catches up to whatever it deferred — and to the playhead, which
   *  may have moved a long way while you were reading. Unconditional rather
   *  than only-when-pending, so the "held" note can never be left lying. */
  function flushPendingPaint(): void {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!devOn) return;
    if (paintBlocked()) {
      // Still aimed at: try again once the pointer has been still a moment.
      flushTimer = setTimeout(flushPendingPaint, POINTER_QUIET_MS);
      return;
    }
    paintPending = false;
    lastPlayheadFree = playheadMayMove();
    paintDev(true);
  }

  /** The playhead's own refresh path: throttled, suppressed while the user
   *  is working, and it never touches the debounce that user moves use. */
  let lastPlayheadFree = true;
  function playheadMoved(): void {
    if (!devOn) return;
    const mayMove = playheadMayMove();
    if (mayMove !== lastPlayheadFree) {
      // Say which of the two it is doing — following, or deliberately
      // holding still — but only on the TRANSITION: repainting the bar under
      // a pointer that is resting in the surface is the thing we are fixing.
      lastPlayheadFree = mayMove;
      if (mayMove) paintContextBar();
    }
    if (!mayMove) return;
    const now = Date.now();
    if (now - lastPlayheadRefresh < PLAYHEAD_MIN_MS) {
      paintContextBar();
      return;
    }
    lastPlayheadRefresh = now;
    // A dense passage is 8-16 sounding notes a second; at one refresh per
    // 400 ms this is ≤5 queries/s against a 20/s refill, so playback cannot
    // starve the interactive budget however fast the music is.
    scheduleDevRefresh(0);
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
  /** Patch text without touching the node when it has not changed (a write
   *  to textContent replaces the child text node — cheap, but it also kills
   *  a native selection inside it). */
  const setText = (el: HTMLElement, text: string): void => {
    if (el.textContent !== text) el.textContent = text;
  };

  /** KEYED RECONCILIATION — the reason a click lands where it started.
   *
   *  Same key ⇒ the SAME ELEMENT, patched in place; only genuine order
   *  changes move a node. Rebuilding a list wholesale is what makes a UI
   *  eat clicks (mousedown and mouseup on two different elements) and
   *  flicker; with identity held, a repaint during playback is a few text
   *  writes and the chrome never moves at all. `create` runs once per key;
   *  `update` runs on every paint and is where all dynamic content goes. */
  interface RowSpec {
    readonly key: string;
    create(): HTMLElement;
    update?(el: HTMLElement): void;
  }
  function sync(host: HTMLElement, specs: readonly RowSpec[]): void {
    const existing = new Map<string, HTMLElement>();
    for (const child of [...host.children]) {
      const key = (child as HTMLElement).dataset.key;
      if (key !== undefined) existing.set(key, child as HTMLElement);
    }
    let cursor: ChildNode | null = host.firstChild;
    // Duplicate keys are disambiguated rather than collapsed: a list that
    // silently drops its second identical row is a worse bug than a rebuilt
    // one, and callers cannot always prove uniqueness.
    const seen = new Map<string, number>();
    for (const spec of specs) {
      const n = seen.get(spec.key) ?? 0;
      seen.set(spec.key, n + 1);
      const key = n === 0 ? spec.key : `${spec.key}~${n}`;
      let el = existing.get(key);
      if (el) existing.delete(key);
      else {
        el = spec.create();
        el.dataset.key = key;
      }
      spec.update?.(el);
      if (cursor === el) cursor = el.nextSibling;
      else host.insertBefore(el, cursor);
    }
    for (const el of existing.values()) el.remove();
  }
  /** The row's CURRENT data, read by handlers bound once at create time —
   *  a handler that closed over the row it was created with would act on a
   *  stale one after the first patch. */
  const rowData = new WeakMap<HTMLElement, unknown>();
  const selectRange = (from: number, to: number): void => selectRanges([{ from, to }]);
  /** A NODE OWNS MANY RANGES — that is the geometry, not a detail: a Measure
   *  spans every string line of its system, a Sound spans the columns it
   *  occupies across lines. Selecting only the first range would say the node
   *  is a fragment of one line, which is a lie about the data model (and the
   *  one this product least affords: the selection IS a region of the time ×
   *  voice grid). Same idiom playback's follow already uses in applySpans. */
  const selectRanges = (ranges: readonly { from: number; to: number }[]): void => {
    if (ranges.length === 0) return;
    const len = view.state.doc.length;
    const clamped = ranges
      .map((r) => ({ from: Math.min(r.from, len), to: Math.min(r.to, len) }))
      .filter((r) => r.to >= r.from);
    if (clamped.length === 0) return;
    view.dispatch({
      selection: EditorSelection.create(
        clamped.map((r) => EditorSelection.range(r.from, r.to)),
        0
      ),
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

  function paintDev(force = false): void {
    if (!devOn) return;
    // NEVER MOVE ANYTHING UNDER A POINTER: a background repaint (a frame
    // landing, the playhead moving, a timer) waits for the quiet moment
    // after the pointer leaves or the button comes up. Interaction-driven
    // paints pass `force` — a chip you just clicked must answer at once.
    if (!force && paintBlocked()) {
      paintPending = true;
      // Deferred, not dropped: a frame that arrived while the pointer was
      // moving lands as soon as it settles, without needing another event.
      if (flushTimer === null) flushTimer = setTimeout(flushPendingPaint, POINTER_QUIET_MS);
      return;
    }
    paintContextBar();
    paintWatch();
    if (lens === "values") paintValues();
    else if (lens === "cost") paintCost();
    else if (lens === "tree") paintTree();
    else paintProblems();
  }

  // ——— the context bar: breadcrumb + the savings figure, always in view ———
  //
  // THE BREADCRUMB NAMES SEMANTIC NODES, and only those (decision,
  // 2026-07-26). Three reasons, and they generalise:
  //   1. It is the vocabulary a plugin author programs against — a prop
  //      declares `on: "Measure"` / `"Sound"`, which are the engine's node
  //      names. The base tree speaks TabSegmentLine / TabString /
  //      MeasureLine, and locating someone inside a structure they cannot
  //      attach anything to is worse than saying nothing.
  //   2. The parse tree is a HYPOTHESIS: the grammar recovers aggressively
  //      and the semantic layer discards some of what it produces (an
  //      uppercase H on a percussion line parses as a technique and is
  //      refused). A crumb built on the grammar's guess would confidently
  //      place you inside something the engine threw away.
  //   3. It costs nothing: the inspection frame IS the ancestor chain.
  //
  // So there is NO base-tree fallback. Showing grammar crumbs and swapping
  // them for engine ones when the frame lands would be the UI changing its
  // mind in a second vocabulary — principles #7 (never move the user's
  // world), #9 (honest states) and #10 (one vocabulary). With no frame we
  // show the position and nothing else; silence is the default.
  function paintContextBar(): void {
    const state = view.state;
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head);
    const chain = frame && frameIsLive() ? frame.chain : [];
    // The syntactic reading is kept ONLY to answer "and what did the grammar
    // think?" on hover. Where the two disagree is the most informative thing
    // this surface can say, and on a tooltip it costs no chrome to say it.
    const syntactic: SyntaxNode[] = [];
    for (
      let n = syntaxTree(state).resolveInner(head, 1) as SyntaxNode | null;
      n && syntactic.length < 8;
      n = n.parent
    ) {
      syntactic.push(n);
    }
    const syntaxLine = syntactic.map((n) => n.name).join(" ‹ ");
    // NO DIVERGENCE MARKER, and the reason is worth keeping. The case worth
    // flagging is "the grammar recognised something the ENGINE DISCARDED"
    // (an uppercase H on a percussion line parses as a technique and is
    // refused). What the two data sources actually support is only "the
    // grammar's innermost node is narrower than the engine's" — which is the
    // ORDINARY case on dashes, dividers and line names, where the engine's
    // finest granularity is simply coarser. A marker that fires on most of
    // the document would say "the engine built nothing here" about text the
    // engine reads perfectly well: principle #3 (when in doubt show nothing)
    // and #9 (never imply more than the data supports). Telling the two
    // apart needs a signal the wire does not carry — the host would have to
    // report what the semantic layer REFUSED — so the comparison stays where
    // it is honest: the grammar's full reading, on the deepest crumb's
    // tooltip, available whenever anyone wants to check.

    const specs: RowSpec[] = chain.map((node, i) => ({
      // Keyed by DEPTH, not by name+range: walking down a tab line changes
      // the ranges every note, and a key that changes every note is a
      // rebuild wearing a keyed renderer's clothes.
      key: `crumb:${i}`,
      create: () => {
        const b = button("dev-crumb", "", () => {
          const data = rowData.get(b) as readonly { from: number; to: number }[] | undefined;
          // The version guard stands: ranges are expressed at the frame's
          // version, and a MULTI-range selection built from stale
          // coordinates would scatter across unrelated text — worse than a
          // single stale one, not better.
          if (data && frameIsLive()) selectRanges(data);
        });
        return b;
      },
      update: (elt) => {
        rowData.set(elt, node.ranges);
        setText(elt, node.nodeName);
        elt.title =
          `${node.ranges.map(fmtRange).join(" + ")} — what the ENGINE built here` +
          (i === 0 ? `\nthe grammar reads: ${syntaxLine}` : "");
        elt.classList.toggle("dev-crumb-deep", i === 0);
      },
    }));
    specs.push({
      key: "pos",
      create: () => span("dev-pos", ""),
      update: (el) => setText(el, `${head} · ${line.number}:${head - line.from + 1}`),
    });
    const note = inspectBusy
      ? { className: "dev-dim", text: "reading…" }
      : frameError !== null
        ? { className: "dev-error", text: frameError }
        : frame && !frameIsLive()
          ? { className: "dev-dim", text: "document moved — ↻" }
          : chain.length === 0
            ? { className: "dev-dim", text: "no reading here yet" }
            : // While the music plays the surface says which of the two it is
              // doing — following the notes, or deliberately holding still
              // because you are working in it. Neither state is a mystery.
              player !== null && !player.paused
              ? playheadMayMove()
                ? { className: "dev-dim", text: "following the playhead" }
                : { className: "dev-dim", text: "held — following again when you're done" }
              : null;
    if (note) {
      specs.push({
        key: "note",
        create: () => span("dev-dim", ""),
        update: (el) => {
          el.className = note.className;
          setText(el, note.text);
        },
      });
    }
    sync(devBreadcrumbEl, specs);

    const savings = savingsLine(activity);
    sync(devSavingsEl, [
      {
        key: "figure",
        create: () => span("dev-savings-figure", ""),
        update: (el) => {
          el.className = savings.attributed ? "dev-savings-figure" : "dev-savings-figure dev-dim";
          setText(el, savings.headline);
        },
      },
      ...(savings.note
        ? [
            {
              key: "note",
              create: () => span("dev-dim", ""),
              update: (el: HTMLElement) => setText(el, savings.note!),
            },
          ]
        : []),
    ]);
  }

  // ——— the watch strip: pinned props, across lenses and across edits ———
  /** A row's identity across frames: NODE KIND + prop id, never the chain
   *  INDEX. Following the playhead moves the cursor between nodes of
   *  different depth — a Measure-level position gains FretNote and Sound
   *  ancestors — which shifts every index and would re-key (and so rebuild)
   *  every row on a note whose chain is one deeper. Kind + id survives that,
   *  which is what keeps a row clickable while the music moves. */
  const rowKey = (row: PropRow): string => `${row.nodeName}|${row.id}`;
  const currentRows = (): PropRow[] => buildRows(frame, indexActivity(activity));

  function paintWatch(): void {
    devWatchEl.hidden = watch.length === 0;
    if (watch.length === 0) return;
    const rows = currentRows();
    sync(devWatchEl, [
      { key: "label", create: () => span("dev-watch-label", "watching") },
      ...watch.map((id) => ({
        key: `watch:${id}`,
        create: () => {
          const item = div("dev-watch-chip");
          item.appendChild(span("dev-watch-name", splitPropId(id).name, id));
          item.appendChild(span("dev-watch-value", ""));
          item.appendChild(span("dev-state", ""));
          item.appendChild(
            button(
              "dev-watch-x",
              "×",
              () => {
                watch = watch.filter((w) => w !== id);
                writeStore("tab-edit:dev-watch", watch.join(","));
                paintDev(true);
              },
              "unpin"
            )
          );
          item.addEventListener("click", () => {
            const row = currentRows().find((r) => r.id === id);
            if (!row) return;
            selectedKey = rowKey(row);
            setLens("values");
          });
          return item;
        },
        update: (item: HTMLElement) => {
          const row = rows.find((r) => r.id === id);
          const text = row ? summarizeValue(row, 44) : "not at this node";
          // A marked chip is one whose value MOVED since the last FRAME (not
          // the last repaint — advancing it here would erase the marker on
          // the next paint, which is exactly the moment you are looking at
          // it). rememberWatch() advances it, once per frame.
          const seen = watchSeen.get(id);
          item.classList.toggle("changed", row !== undefined && seen !== undefined && seen !== text);
          const value = item.children[1] as HTMLElement;
          value.className = row ? "dev-watch-value" : "dev-watch-value dev-dim";
          setText(value, text);
          const dot = item.children[2] as HTMLElement;
          dot.className = row ? `dev-state dev-state-${row.state}` : "dev-state";
          dot.title = row?.state ?? "";
        },
      })),
    ]);
  }

  /** Advance the watch strip's memory — called once per arriving frame, so a
   *  Δ marker survives until the value actually moves again. */
  function rememberWatch(): void {
    if (watch.length === 0) return;
    const rows = currentRows();
    for (const id of watch) {
      const row = rows.find((r) => r.id === id);
      if (row) watchSeen.set(id, summarizeValue(row, 44));
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

    // TOOLBAR — TWO DIMENSIONS, TWO AFFORDANCES.
    //
    // `core-taxonomy` answers WHO PRODUCED THIS; `carried` answers WHAT
    // HAPPENED TO IT this window. Rendered as identical pills on one line
    // they read as one kind of thing, which is false, so the two got
    // confounded on sight (Stan, on the shipped surface). The fix is not a
    // divider — it is to let each control mirror its own data:
    //
    //   PACKS   a SET      → multi-select pills, styled like the pack name
    //                        they filter (the segment before the `/`)
    //   OUTCOME a PARTITION → ONE segmented control with an explicit `all`,
    //                        each item wearing the SAME DOT the rows wear
    //
    // So you filter by clicking the badge you can already see, and the shape
    // of the control tells you whether picking a second one is even a
    // question. No second row, no new hue, no chrome around chrome: the
    // segmented group's own border is the separation, and it is the same
    // control the lens strip above already uses.
    const toolbar: RowSpec[] = [
      {
        key: "packs",
        create: () => div("dev-packs"),
        update: (host) =>
          sync(host, [
            {
              key: "all",
              create: () =>
                button("dev-chip dev-chip-pack", "", () => {
                  packFilters.clear();
                  paintDev(true);
                }),
              update: (elt) => {
                setText(elt, `all packs (${rows.length})`);
                elt.className = `dev-chip dev-chip-pack${packFilters.size === 0 ? " active" : ""}`;
                elt.title = "every pack that attaches a prop here";
              },
            },
            ...packChips(rows).map((c) => ({
              key: `pack:${c.pack}`,
              create: () =>
                button("dev-chip dev-chip-pack", "", () => {
                  // Multi-select, because a set is a set: two packs at once
                  // is a question a plugin author actually asks.
                  if (packFilters.has(c.pack)) packFilters.delete(c.pack);
                  else packFilters.add(c.pack);
                  paintDev(true);
                }),
              update: (elt: HTMLElement) => {
                setText(elt, `${c.pack} (${c.count})`);
                elt.className = `dev-chip dev-chip-pack${packFilters.has(c.pack) ? " active" : ""}`;
                elt.title = `props produced by ${c.pack} — click to add or remove it`;
              },
            })),
          ]),
      },
      {
        key: "outcome",
        create: () => {
          const group = div("dev-outcome");
          group.title = "what happened to each prop in the current window";
          return group;
        },
        update: (host) => {
          const states = stateChips(rows);
          sync(host, [
            {
              key: "all",
              create: () =>
                button("dev-seg", "", () => {
                  stateFilter = null;
                  paintDev(true);
                }),
              update: (elt) => {
                setText(elt, `all ${rows.length}`);
                elt.className = `dev-seg${stateFilter === null ? " active" : ""}`;
                elt.title = "every outcome";
              },
            },
            ...states.map((s) => ({
              key: `state:${s.state}`,
              create: () => {
                const b = button("dev-seg", "", () => {
                  // Single-select, because a prop is exactly one of these.
                  // Clicking the active one returns to `all` — forgiving,
                  // and it keeps the control's own state reachable.
                  stateFilter = stateFilter === s.state ? null : s.state;
                  paintDev(true);
                });
                // The SAME dot the rows wear: the filter looks like what it
                // filters, so nothing has to be learned twice.
                b.appendChild(span(`dev-state dev-state-${s.state}`, ""));
                b.appendChild(span("dev-seg-label", ""));
                return b;
              },
              update: (elt: HTMLElement) => {
                elt.className = `dev-seg${stateFilter === s.state ? " active" : ""}`;
                setText(elt.children[1] as HTMLElement, `${s.state} ${s.count}`);
                elt.title =
                  s.state === "carried"
                    ? "carried — reading it did no work at all"
                    : s.state === "recomputed"
                      ? "recomputed — this read ran compute"
                      : s.state === "cold"
                        ? "cold — it ran on a pass with nothing to carry from"
                        : "deferred — listed but not evaluated; ask for it by name";
              },
            })),
          ]);
        },
      },
      {
        key: "filter",
        create: () => {
          const input = document.createElement("input");
          input.type = "text";
          input.className = "dev-filter";
          input.placeholder = "filter props…";
          input.value = textFilter;
          input.addEventListener("input", () => {
            textFilter = input.value;
            paintDev(true);
          });
          return input;
        },
        update: (elt) => {
          const input = elt as HTMLInputElement;
          // Never write over what the user is typing.
          if (document.activeElement !== input && input.value !== textFilter) {
            input.value = textFilter;
          }
        },
      },
      {
        key: "order",
        create: () => {
          const select = document.createElement("select");
          select.className = "dev-select";
          select.title = "cost-first answers “what is slow” without hunting";
          for (const [value, label] of [
            ["cost", "cost first"],
            ["pack", "by pack"],
            ["name", "by name"],
          ] as const) {
            const option = document.createElement("option");
            option.value = value;
            option.textContent = label;
            select.appendChild(option);
          }
          select.value = order;
          select.addEventListener("change", () => {
            order = select.value as RowOrder;
            paintDev(true);
          });
          return select;
        },
        update: (elt) => {
          const select = elt as HTMLSelectElement;
          if (document.activeElement !== select && select.value !== order) select.value = order;
        },
      },
    ];
    sync(valuesToolbar, toolbar);

    // CLAIMS: the negotiation, with its winner.
    const pairs = claimPairs(rows).filter(
      (p) => packFilters.size === 0 || packFilters.has(p.claim.pack)
    );
    sync(
      valuesClaimsEl,
      pairs.length === 0
        ? []
        : [
            {
              key: "title",
              create: () =>
                span(
                  "dev-section-title",
                  "Claims",
                  "packs bid for a decision; the winner is what every downstream prop reads"
                ),
            },
            ...pairs.map((pair) => ({
              key: `claim:${rowKey(pair.claim)}`,
              create: () => {
                const row = div("dev-claim");
                row.appendChild(span("dev-claim-name", ""));
                row.appendChild(span("dev-claim-outcome", ""));
                row.appendChild(span("dev-claim-arrow", "←"));
                row.appendChild(div("dev-claim-bids"));
                row.addEventListener("click", () => {
                  const data = rowData.get(row) as typeof pair | undefined;
                  if (!data) return;
                  selectedKey = rowKey(data.claim);
                  paintDev(true);
                });
                return row;
              },
              update: (row: HTMLElement) => {
                rowData.set(row, pair);
                setText(row.children[0] as HTMLElement, pair.outcome?.name ?? pair.claim.name);
                setText(
                  row.children[1] as HTMLElement,
                  pair.outcome ? summarizeValue(pair.outcome, 30) : ""
                );
                const bidList = readBids(pair.claim.value);
                sync(
                  row.children[3] as HTMLElement,
                  bidList.length === 0
                    ? [
                        {
                          key: "raw",
                          create: () => span("dev-dim", ""),
                          update: (b: HTMLElement) => setText(b, summarizeValue(pair.claim, 60)),
                        },
                      ]
                    : bidList.map((bid, i) => ({
                        key: `bid:${i}`,
                        create: () => span("dev-bid", ""),
                        update: (b: HTMLElement) => {
                          const won =
                            pair.outcome !== undefined &&
                            JSON.stringify(bid.value) === JSON.stringify(pair.outcome.value);
                          b.className = `dev-bid${won ? " won" : ""}`;
                          setText(b, bidLabel(bid));
                        },
                      }))
                );
              },
            })),
          ]
    );

    // ROWS. Keyed by node + prop id: the same prop keeps the same element
    // across repaints, so a click that starts on it ends on it — which is
    // the whole fix for "I have to click multiple times" during playback.
    const visible = orderRows(
      filterRows(rows, {
        packs: [...packFilters],
        text: textFilter,
        states: stateFilter ? [stateFilter] : [],
      }),
      order
    );
    const rowSpecs: RowSpec[] = [];
    if (rows.length === 0) {
      const message = frameError
        ? `inspection failed: ${frameError}`
        : inspectBusy
          ? "reading…"
          : "click a note, a measure or a tab line to see what the engine decided for it";
      rowSpecs.push({
        key: "empty",
        create: () => div("dev-empty"),
        update: (elt) => setText(elt, message),
      });
    } else if (visible.rows.length === 0) {
      rowSpecs.push({
        key: "empty",
        create: () => div("dev-empty", "nothing matches these filters"),
      });
    }
    let lastNode = -1;
    for (const row of visible.rows) {
      if (order === "pack" && row.nodeIndex !== lastNode) {
        lastNode = row.nodeIndex;
        const header = `${row.nodeName}  ${row.ranges.map(fmtRange).join(" + ")}`;
        rowSpecs.push({
          key: `node:${row.nodeName}`,
          create: () => div("dev-node-header"),
          update: (elt) => setText(elt, header),
        });
      }
      rowSpecs.push(propRowSpec(row));
      if (selectedKey === rowKey(row)) {
        // The detail panel is rebuilt on purpose: it is one element under
        // the row you just clicked, it holds no scroll state worth keeping,
        // and its content is deeply conditional.
        rowSpecs.push({
          key: `detail:${rowKey(row)}`,
          create: () => propDetail(row, index),
          update: (elt) => {
            const fresh = propDetail(row, index);
            if (elt.innerHTML !== fresh.innerHTML) elt.replaceChildren(...fresh.childNodes);
          },
        });
      }
    }
    sync(valuesRowsEl, rowSpecs);

    const evaluated = rows.filter((r) => r.evaluated).length;
    const cached = rows.filter((r) => r.state === "carried").length;
    const snap = snapshotOf(view.state);
    const head = view.state.selection.main.head;
    const sounds = snap ? soundRangesAt(snap, head) : [];
    sync(valuesFooterEl, [
      {
        key: "cache",
        create: () => span("dev-dim", ""),
        update: (elt) => setText(elt, `${cached}/${evaluated} props served from cache`),
      },
      ...(visible.costFellBack
        ? [
            {
              key: "fallback",
              create: () =>
                span(
                  "dev-dim",
                  "· no cost window yet — ordered by pack; type a character to measure one"
                ),
            },
          ]
        : []),
      ...(snap
        ? [
            {
              key: "snapshot",
              create: () => span("dev-dim", ""),
              update: (elt: HTMLElement) =>
                setText(
                  elt,
                  `· at cursor: ${sounds.length > 0 ? `sound ${sounds.map(fmtRange).join(" ")}` : "no sound"}` +
                    ` · document: ${snap.sounds.length} sounds, ${snap.measures.length} measures, ${snap.directives.length} directives`
                ),
            },
          ]
        : []),
      ...(frame?.installWarnings ?? []).map((w, i) => ({
        key: `warn:${i}`,
        create: () => span("dev-warning", ""),
        update: (elt: HTMLElement) => setText(elt, `install warning: ${w}`),
      })),
    ]);
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

  /** One prop row, as a KEYED spec: the skeleton is built once and every
   *  repaint patches text and classes. Handlers read the row's CURRENT data
   *  from `rowData` rather than the value they closed over. */
  function propRowSpec(row: PropRow): RowSpec {
    return {
      key: `prop:${rowKey(row)}`,
      create: () => {
        const r = div("dev-prop");
        r.appendChild(span("dev-state", ""));
        r.appendChild(span("dev-prop-name", ""));
        r.appendChild(span("dev-prop-pack", ""));
        r.appendChild(span("dev-stab", ""));
        r.appendChild(span("dev-stab dev-stab-internal", "internal"));
        r.appendChild(span("dev-prop-value", ""));
        r.appendChild(span("dev-cost", ""));
        const nodeTag = span("dev-prop-node", "");
        nodeTag.addEventListener("click", (event) => {
          // "Clicking a node selects the node" must hold wherever a node is
          // named — so the node tag is the affordance here, and it selects
          // ALL of that node's ranges.
          event.stopPropagation();
          const data = rowData.get(r) as PropRow | undefined;
          if (data && frameIsLive()) selectRanges(data.ranges);
        });
        r.appendChild(nodeTag);
        r.addEventListener("click", () => {
          const data = rowData.get(r) as PropRow | undefined;
          if (!data) return;
          selectedKey = selectedKey === rowKey(data) ? null : rowKey(data);
          paintDev(true);
        });
        return r;
      },
      update: (r) => {
        rowData.set(r, row);
        r.className = `dev-prop${selectedKey === rowKey(row) ? " selected" : ""}`;
        const [dot, name, pack, stab, internal, value, cost, node] = [
          ...r.children,
        ] as HTMLElement[];
        dot.className = `dev-state dev-state-${row.state}`;
        dot.title = row.state;
        setText(name, row.name);
        name.title = row.id;
        setText(pack, row.pack);
        stab.className = `dev-stab dev-stab-${row.stability}`;
        setText(stab, row.stability === "stable" ? "stable" : "exp");
        stab.title =
          row.stability === "stable"
            ? "stable: identity, value shape and meaning are versioned — safe to build on"
            : "experimental: readable and debuggable, but explicitly changeable";
        internal.hidden = !row.internal;
        internal.title = "not readable by other plugins — no value is carried";
        value.className = row.error ? "dev-prop-value dev-error" : "dev-prop-value";
        setText(value, summarizeValue(row));
        cost.hidden = row.runs === 0;
        if (row.runs > 0) {
          setText(cost, `${row.runs}× ${ms(row.selfMs)}`);
          cost.title = "runs and self time in the current window";
        }
        setText(node, row.nodeName);
        node.title = frameIsLive()
          ? `select this ${row.nodeName} — all ${row.ranges.length} range(s)`
          : "the document moved — refresh before selecting";
        node.classList.toggle("dev-clickable", frameIsLive());
      },
    };
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
          paintDev(true);
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
        // A value's ranges are frequently ONE region across lines (a column
        // span is exactly that), so offer the whole region as well as its
        // parts — one extra control, and only when there is more than one.
        if (ranges.length > 1) {
          jump.appendChild(
            button(
              "dev-link",
              `all ${ranges.length}`,
              () => selectRanges(ranges),
              "select every range in this value as one multi-range selection"
            )
          );
        }
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
    paintDev(true);
  }

  function depLink(propId: string, runs?: number, selfMs?: number): HTMLElement {
    const label = runs !== undefined ? `${propId}  ${runs}× ${ms(selfMs ?? 0)}` : propId;
    return button(
      "dev-link",
      label,
      () => {
        const target = currentRows().find((r) => r.id === propId);
        packFilters.clear();
        stateFilter = null;
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

    sync(costToolbar, [
      {
        key: "diff",
        create: () =>
          chip(
            "",
            false,
            () => {
              // DIFF MODE: name a pass, then watch what has moved since it.
              // The window is addressable, so it never disturbs the live one.
              if (diffBaseline === null) diffBaseline = activity?.passId ?? null;
              else {
                diffBaseline = null;
                diffFrame = null;
              }
              scheduleDevRefresh(0);
            },
            "mark this pass and diff against it"
          ),
        update: (elt) => {
          setText(elt, diffBaseline === null ? "live window" : `since pass ${diffBaseline}`);
          elt.className = `dev-chip${diffBaseline !== null ? " active" : ""}`;
        },
      },
      {
        key: "measure",
        create: () =>
          button("dev-mini", "↻ measure now", () => scheduleDevRefresh(0), "re-read and re-measure"),
      },
      ...(diffBaseline !== null
        ? [
            {
              key: "diff-note",
              create: () =>
                span(
                  "dev-dim",
                  "diff is PROP-ID granular: which props recomputed, not how their values differ — the engine keeps recompute records, not a history of values"
                ),
            },
          ]
        : []),
    ]);

    sync(costHeadlineEl, [
      {
        key: "figure",
        create: () => span("dev-headline-figure", ""),
        update: (elt) => {
          elt.className = savings.attributed
            ? "dev-headline-figure"
            : "dev-headline-figure dev-dim";
          setText(elt, savings.headline);
        },
      },
      ...(savings.note
        ? [
            {
              key: "note",
              create: () => span("dev-dim", ""),
              update: (elt: HTMLElement) => setText(elt, savings.note!),
            },
          ]
        : []),
      ...(showing
        ? [
            {
              key: "window",
              create: () => span("dev-dim", ""),
              update: (elt: HTMLElement) =>
                setText(
                  elt,
                  `window: passes ${showing.sincePass + 1}–${showing.passId} · ${showing.totalRecomputes} runs` +
                    (showing.savings.baselineMs > 0
                      ? ` · this document cold-booted in ${ms(showing.savings.baselineMs)}`
                      : "")
                ),
            },
          ]
        : []),
    ]);

    const costs = costRows(showing);
    if (costs.length === 0) {
      sync(costBodyEl, [
        {
          key: "empty",
          create: () =>
            div("dev-empty", "nothing recomputed in this window — type a character and look again"),
        },
      ]);
      return;
    }
    const index = indexActivity(showing);
    const propRows = currentRows();
    sync(
      costBodyEl,
      costs.map((cost) => ({
        key: `cost:${cost.propId}`,
        create: () => {
          const r = div("dev-prop");
          r.appendChild(span("dev-cost-runs", ""));
          r.appendChild(span("dev-cost-ms", ""));
          r.appendChild(span("dev-prop-name", ""));
          r.appendChild(span("dev-prop-pack", ""));
          r.appendChild(span("dev-reason", ""));
          r.appendChild(span("dev-dim", "with:"));
          r.appendChild(div("dev-cause-inline"));
          r.addEventListener("click", () => {
            const target = currentRows().find((p) => p.id === cost.propId);
            if (!target) return;
            selectedKey = rowKey(target);
            setLens("values");
          });
          return r;
        },
        update: (r: HTMLElement) => {
          const [runs, msEl, name, pack, reason, withLabel, causes] = [
            ...r.children,
          ] as HTMLElement[];
          setText(runs, `${cost.runs}×`);
          setText(msEl, ms(cost.selfMs));
          msEl.title = `worst single run ${ms(cost.maxSelfMs)}`;
          setText(name, cost.name);
          name.title = cost.propId;
          setText(pack, cost.pack);
          reason.hidden = cost.reason === undefined;
          if (cost.reason) {
            setText(reason, cost.reason);
            reason.title = reasonHelp(cost.reason);
          }
          const row = propRows.find((p) => p.id === cost.propId);
          const upstream = row ? causeOf(row, index).upstream.slice(0, 3) : [];
          withLabel.hidden = upstream.length === 0;
          sync(
            causes,
            upstream.map((edge) => ({
              key: `up:${edge.propId}`,
              create: () => depLink(edge.propId),
            }))
          );
        },
      }))
    );
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
      "The document AS PARSED — the grammar's reading, in the grammar's own vocabulary (TabSegmentLine, TabString, MeasureLine). What the engine BUILT from it is the breadcrumb above and the Values lens, in the vocabulary props attach to; where the two disagree, the prop layer is the truth and this is the hypothesis. Free and never stale: it is CodeMirror's own tree. Click a node to select its text."
    );
    const tree = syntaxTree(view.state);
    const cursorPath = pathOfCursor();
    for (const p of cursorPath) treeExpanded.add(p);
    const deepest = cursorPath[cursorPath.length - 1];

    sync(treeToolbar, [
      {
        key: "vocab",
        create: () =>
          span(
            "dev-vocab",
            "as parsed",
            "the grammar's vocabulary — the engine's own nodes are in the breadcrumb and the Values lens"
          ),
      },
      {
        key: "reveal",
        create: () =>
          button("dev-mini", "reveal cursor", () => {
            for (const p of pathOfCursor()) treeExpanded.add(p);
            paintTree();
            treeBodyEl.querySelector(".dev-tree-row.at-cursor")?.scrollIntoView({ block: "center" });
          }),
      },
      {
        key: "collapse",
        create: () =>
          button("dev-mini", "collapse all", () => {
            treeExpanded.clear();
            treeExpanded.add("0");
            paintTree();
          }),
      },
      {
        key: "parsed",
        create: () => span("dev-dim", ""),
        update: (elt) =>
          setText(
            elt,
            `${tree.length.toLocaleString()} of ${view.state.doc.length.toLocaleString()} chars parsed`
          ),
      },
      ...(tree.length < view.state.doc.length
        ? [
            {
              key: "partial",
              create: () =>
                span("dev-warning", "the parse has not reached the end of the document yet"),
            },
          ]
        : []),
    ]);

    // Rows are keyed by PATH, so following the playhead down a tab line
    // moves one `at-cursor` class rather than rebuilding the tree.
    const specs: RowSpec[] = [];
    const walk = (node: SyntaxNode, path: string, depth: number): void => {
      const kids: SyntaxNode[] = [];
      for (let c = node.firstChild; c; c = c.nextSibling) kids.push(c);
      const expanded = treeExpanded.has(path);
      const name = node.name;
      const from = node.from;
      const to = node.to;
      const text = view.state.doc.sliceString(from, Math.min(to, from + 30)).replace(/\n/g, "⏎");
      specs.push({
        key: `row:${path}`,
        create: () => {
          const row = div("dev-tree-row");
          row.appendChild(button("dev-caret", "", () => {
            const data = rowData.get(row) as { path: string; leaf: boolean } | undefined;
            if (!data || data.leaf) return;
            if (treeExpanded.has(data.path)) treeExpanded.delete(data.path);
            else treeExpanded.add(data.path);
            paintTree();
          }));
          row.appendChild(span("dev-tree-name", ""));
          row.appendChild(span("dev-tree-range", ""));
          row.appendChild(span("dev-tree-text", ""));
          row.addEventListener("click", () => {
            const data = rowData.get(row) as { from: number; to: number } | undefined;
            if (data) selectRange(data.from, data.to);
          });
          return row;
        },
        update: (row) => {
          rowData.set(row, { path, from, to, leaf: kids.length === 0 });
          row.className = `dev-tree-row${path === deepest ? " at-cursor" : ""}`;
          row.style.paddingLeft = `${depth * 13 + 6}px`;
          const [caret, nameEl, range, textEl] = [...row.children] as HTMLElement[];
          setText(caret, kids.length === 0 ? "·" : expanded ? "▾" : "▸");
          caret.title = kids.length === 0 ? "leaf" : `${kids.length} children`;
          setText(nameEl, name);
          setText(range, `${from}-${to}`);
          textEl.hidden = text.trim().length === 0;
          setText(textEl, text);
        },
      });
      if (!expanded) return;
      // Lazily rendered children ARE the virtualisation: a collapsed subtree
      // has no DOM at all, so a 16k-char document costs a few dozen rows.
      const cap = treeShowAll.has(path) ? kids.length : 200;
      kids.slice(0, cap).forEach((kid, i) => walk(kid, `${path}.${i}`, depth + 1));
      if (kids.length > cap) {
        const hidden = kids.length - cap;
        specs.push({
          key: `more:${path}`,
          create: () => {
            const more = button("dev-mini", "", () => {
              treeShowAll.add(path);
              paintTree();
            });
            more.style.marginLeft = `${(depth + 1) * 13 + 6}px`;
            return more;
          },
          update: (elt) => setText(elt, `+${hidden} more`),
        });
      }
    };
    walk(tree.topNode as unknown as SyntaxNode, "0", 0);
    sync(treeBodyEl, specs);
  }

  // ——— PROBLEMS ———
  function paintProblems(): void {
    teach(
      el("problems-teach"),
      "problems",
      "Diagnostics from the packs' diagnostic props, over the wire like every other value. Click one to jump to it; a fix applies as an ordinary edit you can undo."
    );
    const diags = tabDiagnostics(view.state);
    setText(devDiagCountEl, diags.length > 0 ? `(${diags.length})` : "");
    sync(
      devDiagnosticsEl,
      diags.length === 0
        ? [
            {
              key: "empty",
              create: () => div("dev-empty", "no diagnostics — the document reads cleanly"),
            },
          ]
        : diags.map((d, i) => ({
            // Keyed by POSITION + code, not by index: a diagnostic that
            // survives an edit keeps its row (and its fix buttons) rather
            // than being replaced by the one that took its place in the list.
            key: `diag:${d.from}:${d.to}:${d.message.slice(0, 40)}:${i}`,
            create: () => {
              const row = div("dev-problem");
              row.appendChild(span("dev-sev", ""));
              row.appendChild(span("dev-problem-msg", ""));
              row.appendChild(span("dev-dim", ""));
              row.appendChild(div("dev-fixes"));
              row.addEventListener("click", () => {
                const data = rowData.get(row) as typeof d | undefined;
                if (data) selectRange(data.from, data.to);
              });
              return row;
            },
            update: (row: HTMLElement) => {
              rowData.set(row, d);
              const [sev, msg, range, fixes] = [...row.children] as HTMLElement[];
              sev.className = `dev-sev dev-sev-${d.severity}`;
              setText(sev, d.severity);
              setText(msg, d.message);
              setText(range, fmtRange(d));
              sync(
                fixes,
                (d.actions ?? []).map((fix, fi) => ({
                  key: `fix:${fi}`,
                  create: () =>
                    button("dev-mini", "", () => {
                      const data = rowData.get(row) as typeof d | undefined;
                      const action = data?.actions?.[fi];
                      if (!action) return;
                      action.apply(view, data.from, data.to);
                      view.focus();
                    }),
                  update: (b: HTMLElement) => setText(b, fix.name),
                }))
              );
            },
          }))
    );
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
    else paintDev(true);
  }

  function setDev(on: boolean): void {
    if (on === devOn) return;
    devOn = on;
    devDrawer.hidden = !on;
    devToggle.setAttribute("aria-pressed", String(on));
    devToggle.classList.toggle("active", on);
    writeStore("tab-edit:dev", on ? "1" : "0");
    if (on) {
      window.addEventListener("pointerdown", onPointerDown);
      window.addEventListener("pointerup", onPointerUp);
      setLens(lens);
      // Snapshot values are already on screen for the overlays, so THIS may
      // poll — cheaply, and only while the surface is open. It never touches
      // the rate-limited inspection queries.
      // ONLY what the snapshot poll actually feeds: the diagnostics count and
      // the Problems list. Repainting the VALUES lens here would rebuild its
      // filter box under the user's fingers — type two characters, pause, and
      // the third lands in a discarded input.
      snapshotTimer ??= setInterval(() => {
        if (!devOn) return;
        if (lens === "problems") paintProblems();
        else {
          const count = tabDiagnostics(view.state).length;
          devDiagCountEl.textContent = count > 0 ? `(${count})` : "";
        }
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
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      pointerHeld = false;
      pointerInSurface = false;
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
      // PROVENANCE, not position: follow writes the selection on every
      // sounding note, and a selection the PLAYHEAD wrote is not a cursor
      // move the user made. Everything downstream that reacts to "the user
      // moved" must be able to tell — an annotation is exact, where a
      // signature comparison is a guess that a repeated span defeats.
      annotations: playheadSelection.of(true),
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
  onSelectionChanged = (state, fromPlayhead) => {
    // The dev surface follows the cursor — debounced, and only while it is
    // open (setDev/scheduleDevRefresh both no-op when the switch is off, so
    // a user who never asks for it never spends a query). A selection the
    // PLAYHEAD wrote takes the throttled, suppressible path instead: it is
    // not user intent, so it must not reset the user debounce, must not
    // move the view while you are working in it, and must not spend a query
    // per sounding note.
    if (devOn) {
      if (fromPlayhead) playheadMoved();
      else {
        paintDev(); // the free half (breadcrumb, tree) moves immediately
        scheduleDevRefresh();
      }
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
