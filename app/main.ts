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
  createPlayer,
  sanitizeForOsmd,
  snapshotOf,
  soundRangesAt,
  tabDiagnostics,
  type Player,
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
const devToggle = document.getElementById("dev-toggle") as HTMLButtonElement;
const devDrawer = document.getElementById("dev-drawer") as HTMLElement;
const devCursorEl = document.getElementById("dev-cursor") as HTMLElement;
const devDiagnosticsEl = document.getElementById("dev-diagnostics") as HTMLElement;
const devDiagCountEl = document.getElementById("dev-diag-count") as HTMLElement;
const devSnapshotEl = document.getElementById("dev-snapshot") as HTMLElement;
const devTreeEl = document.getElementById("dev-tree") as HTMLElement;

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
  // ——— dev drawer: what the engine decided, read off the SNAPSHOT ———
  // Every value here already crossed the wire for the overlays, so the drawer
  // adds no engine code to the audited bundle. What it cannot show is
  // per-node prop provenance (inspectNode's explain chain) — that lives in
  // the engine and would need its own protocol query.
  const fmtRange = (r: { from: number; to: number }): string => `${r.from}–${r.to}`;
  function renderDev(state: EditorState): void {
    if (devDrawer.hidden) return;
    const snap = snapshotOf(state);
    if (!snap) {
      devCursorEl.textContent = "no snapshot yet — waiting on the host";
      devDiagnosticsEl.replaceChildren();
      devSnapshotEl.textContent = "";
      devDiagCountEl.textContent = "";
      return;
    }
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head);
    const sounds = soundRangesAt(snap, head);
    const measure = snap.measures.findIndex((m) =>
      m.ranges.some((r) => r.from <= head && head < r.to)
    );
    const directives = snap.directives.filter((d) => d.from <= head && head <= d.to);
    devCursorEl.textContent = [
      `pos        ${head}   line ${line.number}, col ${head - line.from + 1}`,
      `sound      ${sounds.length ? sounds.map(fmtRange).join("   ") : "—"}`,
      `measure    ${measure >= 0 ? `#${measure}` : "—"}`,
      `directive  ${directives.length ? directives.map((d) => `${d.key}=${d.value}`).join("   ") : "—"}`,
      `prose      ${snap.recededLineStarts.includes(line.from) ? "yes (receded)" : "no"}`,
    ].join("\n");

    const diags = tabDiagnostics(state);
    devDiagCountEl.textContent = `(${diags.length})`;
    devDiagnosticsEl.replaceChildren(
      ...(diags.length
        ? diags.map((d) => {
            const row = document.createElement("button");
            row.className = `dev-row dev-${d.severity}`;
            row.textContent = `${d.severity}  ${fmtRange(d)}  ${d.message}${
              d.actions && d.actions.length > 0 ? `   [${d.actions.length} fix]` : ""
            }`;
            // Clicking a diagnostic is how you get to it — the drawer is a
            // navigation surface, not just a readout.
            row.addEventListener("click", () => {
              view.dispatch({
                selection: EditorSelection.range(d.from, d.to),
                scrollIntoView: true,
              });
              view.focus();
            });
            return row;
          })
        : [Object.assign(document.createElement("div"), { textContent: "none" })])
    );

    // The BASE tree is CM's own (wiring 2 stores it), so the node chain at the
    // cursor is free — no engine, no wire round trip. It is the syntax half of
    // the demo's AST pane; the SEMANTIC tree stays server-side.
    const chain: string[] = [];
    for (
      let n = syntaxTree(state).resolveInner(head, 1) as SyntaxNode | null;
      n && chain.length < 12;
      n = n.parent
    ) {
      chain.push(`${n.name}  ${n.from}\u2013${n.to}`);
    }
    devTreeEl.textContent = chain.length ? chain.join("\n") : "no tree yet";

    devSnapshotEl.textContent = [
      `sounds         ${snap.sounds.length}`,
      `measures       ${snap.measures.length}`,
      `directives     ${snap.directives.length}`,
      `receded lines  ${snap.recededLineStarts.length}`,
      `diagnostics    ${snap.diagnostics.length}`,
    ].join("\n");
  }
  const setDev = (on: boolean): void => {
    devDrawer.hidden = !on;
    devToggle.setAttribute("aria-pressed", String(on));
    try {
      localStorage.setItem("tab-edit:dev", on ? "1" : "0");
    } catch {
      /* private mode — the drawer just won't be remembered */
    }
    if (on) renderDev(view.state);
  };
  devToggle.addEventListener("click", () => setDev(devDrawer.hidden));
  try {
    if (localStorage.getItem("tab-edit:dev") === "1") setDev(true);
  } catch {
    /* ignore */
  }
  // The wire delivers snapshots asynchronously, so poll while the drawer is
  // open — cheap, and it keeps the readout honest after a reparse.
  setInterval(() => renderDev(view.state), 500);

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
    renderDev(state);
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
