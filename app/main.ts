// The PRODUCT app (ADR-003 M-R2): an editor whose semantics come through
// the TabSemantics facade — by default the wire (engine server-side; this
// bundle is audited engine-free by verify-app.cjs), flippable to
// local-everything by swapping one re-export in ./semantics-mode.ts.
// Compare with demo/ — the demo is the DEV vehicle (engine panes,
// inspector, activity); this is what users get.
/// <reference types="vite/client" />
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
          scheduleSheet();
          // An edit invalidates the timeline's spans — stop cleanly rather
          // than play stale positions (same rule as the demo).
          if (player) stopPlayback();
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
    followCursor: true,
  });
  let sheetTimer: ReturnType<typeof setTimeout> | null = null;
  let sheetBusy = false;
  let sheetLoaded = false;
  let sheetMode: SheetMode = "tab";
  // Cursor state lives HERE, above the first renderSheet() call: the
  // function declarations below hoist, their `let`s do not — the initial
  // render calling hideSheetCursor() hit the TDZ (found by verify:app).
  let sheetCursorShown = false;
  let sheetCursorNextTs = -1;
  async function renderSheet(): Promise<void> {
    if (sheetBusy) {
      scheduleSheet();
      return;
    }
    sheetBusy = true;
    hideSheetCursor();
    try {
      const xml = await semantics.musicXml(view.state);
      // VexFlow is the strict oracle — the shared pre-flight (src/osmd.ts)
      // drops what it throws on and reports the count honestly.
      const { xml: renderable, removed } = sanitizeForOsmd(xml, sheetMode);
      await osmd.load(renderable);
      osmd.render();
      sheetLoaded = true;
      sheetStatus(removed > 0 ? `${removed} unrenderable measure(s)/note(s) skipped` : null);
    } catch (e) {
      sheetLoaded = false;
      sheetStatus(`sheet: ${(e as Error).message}`);
    } finally {
      sheetBusy = false;
    }
  }
  function sheetStatus(message: string | null): void {
    sheetStatusEl.hidden = message === null;
    sheetStatusEl.textContent = message ?? "";
  }
  function scheduleSheet(): void {
    if (sheetTimer !== null) clearTimeout(sheetTimer);
    sheetTimer = setTimeout(() => void renderSheet(), 400);
  }
  sheetModeButton.addEventListener("click", () => {
    sheetMode = sheetMode === "tab" ? "standard" : "tab";
    sheetModeButton.textContent = sheetMode === "tab" ? "standard notation" : "tab notation";
    void renderSheet();
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
      if (target < sheetCursorNextTs) return;
      let advanced = false;
      while (!c.iterator.EndReached && c.iterator.currentTimeStamp.RealValue <= target + 1e-9) {
        c.next();
        advanced = true;
      }
      sheetCursorNextTs = c.iterator.EndReached ? Infinity : c.iterator.currentTimeStamp.RealValue;
      if (advanced) c.previous(); // sit on the SOUNDING entry
    } catch {
      hideSheetCursor(); // cursor drift must never break playback
    }
  }

  // ——— transport: selection-aware playback with follow-the-playhead ———
  // The data is two wire values (midiEvents + the snapshot sound map), so
  // this identical code path runs remote or local (src/playback.ts).
  let raf = 0;
  let lastSpanKey = "";
  let followPlayhead = true;
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
    const p = player.progress();
    if (!p.spans) return;
    if (rangeSignature(view.state.selection.ranges) !== rangeSignature(p.spans)) {
      applySpans(p.spans);
    }
  };
  const tick = (): void => {
    if (!player) return;
    const p = player.progress();
    slider.value = String(Math.round((p.sec / p.totalSec) * 1000));
    timeEl.textContent = `${fmt(p.sec)} / ${fmt(p.totalSec)}`;
    followSheetCursor(player.scoreTimeAt(p.sec));
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
      view.dispatch({ selection: scopeSelection });
    }
    scopeSelection = null;
    scopeSignature = "";
    playButton.textContent = "▶";
    slider.disabled = true;
    slider.value = "0";
    followButton.disabled = true;
    timeEl.textContent = "";
    hideSheetCursor();
    setEditable(true);
  }

  async function togglePlayback(): Promise<void> {
    if (player && !player.paused) {
      player.pause();
      playButton.textContent = "▶";
      setEditable(true);
      return;
    }
    if (player) {
      // PAUSED — the selection is live again, and it is the instruction:
      // unchanged means resume where we stopped, changed means the user picked
      // a new range (or cleared it), which is a new player, not a resume.
      if (rangeSignature(view.state.selection.ranges) === scopeSignature) {
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
    osmd.FollowCursor = followPlayhead;
    if (followPlayhead) jumpToPlayhead();
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
