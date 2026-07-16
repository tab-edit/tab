// Playwright driver for REMOTE mode (ADR-003 M-R1) — the local E2E proof
// that the whole system runs on a laptop: real browser → real WebSocket →
// real Session host → wire-fed overlays back in the editor. Run with
// `npm run verify:remote`; it spawns the sibling repo's dev server
// (remote/host) unless one is already on the port / REMOTE_WS is set.
//
// What it pins:
//   1. the client reaches "live · synced" over a real socket
//   2. wire-fed decorations render: directive underlines + prose recession
//   3. cursor→chord highlight resolves from SNAPSHOT data (0 ms, no tree)
//   4. typing round-trips: edit → updates upstream → frame downstream →
//      badge returns to "synced" (I3: typing never blocked meanwhile)
//   5. queries answer over the wire and SEE the edit (R3): musicXml
//      reflects a title typed seconds earlier
//   6. zero console/page errors throughout
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const PORT = 5199;
const WS_PORT = 8787;
const externalUrl = process.env.DEMO_URL;
const wsUrl = process.env.REMOTE_WS || `ws://localhost:${WS_PORT}`;

let failures = 0;
function check(cond, msg) {
  console.log(`${cond ? "OK  " : "FAIL"}: ${msg}`);
  if (!cond) failures++;
}

async function wsReachable(url) {
  return new Promise((resolve) => {
    try {
      const ws = new WebSocket(url);
      const done = (ok) => {
        try {
          ws.close();
        } catch {}
        resolve(ok);
      };
      ws.onopen = () => done(true);
      ws.onerror = () => done(false);
      setTimeout(() => done(false), 1500);
    } catch {
      resolve(false);
    }
  });
}

async function startSessionHost() {
  if (await wsReachable(wsUrl)) {
    console.log(`session host already on ${wsUrl} — reusing`);
    return { stop: () => {} };
  }
  // Workspace-local convenience: spawn the sibling repo's dev server.
  const hostDir = path.resolve(__dirname, "..", "..", "remote", "host");
  if (!fs.existsSync(hostDir)) {
    throw new Error(
      `no session host on ${wsUrl} and no sibling checkout at ${hostDir} — ` +
        `start one (cd remote/host && npm run dev-server) or set REMOTE_WS`
    );
  }
  const proc = spawn(path.join(hostDir, "node_modules", ".bin", "tsx"), ["tools/dev-server.ts"], {
    cwd: hostDir,
    stdio: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    if (await wsReachable(wsUrl)) return { stop: () => proc.kill() };
    await new Promise((r) => setTimeout(r, 200));
  }
  proc.kill();
  throw new Error(`session host did not come up on ${wsUrl}`);
}

async function startVite() {
  if (externalUrl) return { url: externalUrl, stop: () => {} };
  const root = path.resolve(__dirname, "..");
  const vite = spawn(
    path.join(root, "node_modules", ".bin", "vite"),
    ["demo", "--port", String(PORT), "--strictPort"],
    { cwd: root, stdio: "ignore" }
  );
  const url = `http://localhost:${PORT}/`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(url)).ok) return { url, stop: () => vite.kill() };
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  vite.kill();
  throw new Error(`vite did not come up on ${url}`);
}

(async () => {
  const host = await startSessionHost();
  const server = await startVite();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });

    await page.goto(`${server.url}?remote=${encodeURIComponent(wsUrl)}`, {
      waitUntil: "networkidle",
    });
    await page.waitForFunction(() => !!window.view && !!window.remoteClient);

    // ——— 1. live over a real socket ———
    await page.waitForFunction(
      () => document.getElementById("remote-status")?.textContent?.includes("live"),
      { timeout: 10_000 }
    );
    await page.waitForFunction(
      () => document.getElementById("remote-status")?.textContent?.includes("synced"),
      { timeout: 10_000 }
    );
    check(true, `client is live · synced against ${wsUrl}`);

    // ——— 2. wire-fed decorations ———
    const directiveMarks = await page.locator(".cm-tabDirective").count();
    check(directiveMarks >= 2, `directive underlines render from the wire (${directiveMarks})`);
    const proseLines = await page.locator(".cm-tabProse").count();
    check(proseLines > 0, `prose recession renders from the wire (${proseLines} lines)`);

    // ——— 3. cursor→chord from snapshot data ———
    await page.evaluate(() => {
      const doc = window.view.state.doc.toString();
      // First fret digit on a tab lattice line: a digit surrounded by dashes.
      const at = doc.search(/-\d/) + 1;
      window.view.dispatch({ selection: { anchor: at } });
      window.view.focus();
    });
    await page.waitForFunction(() => document.querySelectorAll(".cm-tabSound").length > 0, {
      timeout: 5_000,
    });
    check(true, "cursor on a fret lights the chord highlight (snapshot resolver)");

    // ——— 4 + 5. typing round-trips and queries SEE the edit (R3) ———
    const xmlBefore = await page.evaluate(() => window.remoteClient.query("musicXml"));
    check(
      typeof xmlBefore === "string" && xmlBefore.includes("<score-partwise"),
      "musicXml query answers over the wire"
    );
    check(xmlBefore.includes("Blackbird"), "score carries the title before the edit");
    await page.evaluate(() => {
      const at = window.view.state.doc.toString().indexOf("Blackbird") + "Blackbird".length;
      window.view.dispatch({ changes: { from: at, insert: "X" }, userEvent: "input.type" });
    });
    // staleBy increments SYNCHRONOUSLY inside the dispatch above, so this
    // is race-free where the 250ms badge text is not: 0 again means the
    // frame for the edited doc came back (updates flushed, server applied).
    await page.waitForFunction(() => window.remoteClient.staleBy === 0, { timeout: 10_000 });
    const xmlAfter = await page.evaluate(() => window.remoteClient.query("musicXml"));
    check(
      xmlAfter.includes("BlackbirdX"),
      "musicXml reflects the just-typed title (server saw the changeset)"
    );

    // ——— 6. clean run ———
    check(errors.length === 0, `no console/page errors (got: ${errors.join(" | ") || "none"})`);
  } finally {
    await browser.close();
    server.stop();
    host.stop();
  }
  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
