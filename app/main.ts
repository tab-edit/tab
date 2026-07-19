// The PRODUCT app (ADR-003 M-R2): an editor whose semantics come through
// the TabSemantics facade — by default the wire (engine server-side; this
// bundle is audited engine-free by verify-app.cjs), flippable to
// local-everything by swapping one re-export in ./semantics-mode.ts.
// Compare with demo/ — the demo is the DEV vehicle (engine panes,
// inspector, activity); this is what users get.
/// <reference types="vite/client" />
import { lintGutter, lintKeymap } from "@codemirror/lint";
import { searchKeymap } from "@codemirror/search";
import { EditorState } from "@codemirror/state";
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

async function main(): Promise<void> {
  const url = await sessionUrl();
  if (url === null) {
    statusEl.textContent = "no session host configured";
    // The editor still works: typing + syntax highlighting are local by
    // construction (I3); semantic overlays wait for a host.
  }
  const semantics = createSemantics(url ?? "ws://localhost:8787");

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
      EditorView.updateListener.of((update) => {
        if (update.docChanged) scheduleSheet();
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
  });
  let sheetTimer: ReturnType<typeof setTimeout> | null = null;
  let sheetBusy = false;
  async function renderSheet(): Promise<void> {
    if (sheetBusy) {
      scheduleSheet();
      return;
    }
    sheetBusy = true;
    try {
      const xml = await semantics.musicXml(view.state);
      await osmd.load(xml);
      osmd.render();
      sheetStatusEl.hidden = true;
    } catch (e) {
      sheetStatusEl.hidden = false;
      sheetStatusEl.textContent = `sheet: ${(e as Error).message}`;
    } finally {
      sheetBusy = false;
    }
  }
  function scheduleSheet(): void {
    if (sheetTimer !== null) clearTimeout(sheetTimer);
    sheetTimer = setTimeout(() => void renderSheet(), 400);
  }
  void renderSheet();

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
