// Playwright + bundle-audit driver for the PRODUCT app. Two halves:
//
//   1. THE ARTIFACT AUDIT (the trade-secret posture on the real deployable):
//      an unminified `vite build` of app/ must contain the client machinery
//      and ZERO engine identifiers. This is the check that keeps the public
//      site honest after the flip — CI-fatal, not advisory.
//   2. LIVE CHECKS: the built app (vite preview) against a real session
//      host — live badge, wire overlays, sheet SVG from a wire musicXml,
//      exports through the facade.
//
// Run with `npm run verify:app`; spawns the sibling dev server unless
// REMOTE_WS points elsewhere (e.g. a wrangler dev endpoint).
const { spawnSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const PORT = 5198;
const WS_PORT = 8787;
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
  const hostDir = path.resolve(ROOT, "..", "remote", "host");
  if (!fs.existsSync(hostDir)) {
    throw new Error(`no session host on ${wsUrl} and no sibling checkout — set REMOTE_WS`);
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

function auditBundle() {
  const outDir = path.join(ROOT, "app", "dist-audit");
  fs.rmSync(outDir, { recursive: true, force: true });
  const build = spawnSync(
    path.join(ROOT, "node_modules", ".bin", "vite"),
    ["build", "app", "--minify", "false", "--outDir", "dist-audit"],
    { cwd: ROOT, encoding: "utf8" }
  );
  check(build.status === 0, `unminified audit build succeeds${build.status === 0 ? "" : `\n${build.stderr}`}`);
  const assets = path.join(outDir, "assets");
  const code = fs
    .readdirSync(assets)
    .filter((f) => f.endsWith(".js"))
    .map((f) => fs.readFileSync(path.join(assets, f), "utf8"))
    .join("\n");
  check(code.includes("RemoteClient"), "artifact contains the wire client");
  for (const marker of [
    "PropRegistry",
    "TabParser",
    "StateLayer",
    "documentXml",
    "semparse",
    "ArtifactCache",
  ]) {
    check(!code.includes(marker), `artifact is engine-free: no "${marker}"`);
  }
  fs.rmSync(outDir, { recursive: true, force: true });
}

async function startVite() {
  const vite = spawn(
    path.join(ROOT, "node_modules", ".bin", "vite"),
    ["app", "--port", String(PORT), "--strictPort"],
    { cwd: ROOT, stdio: "ignore" }
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
  auditBundle();
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
    await page.waitForFunction(() => !!window.view && !!window.appSemantics);
    await page.waitForFunction(
      () => document.getElementById("remote-status")?.textContent?.includes("synced"),
      { timeout: 15_000 }
    );
    check(true, `app is live · synced against ${wsUrl}`);

    const directiveMarks = await page.locator(".cm-tabDirective").count();
    check(directiveMarks >= 2, `wire directive underlines render (${directiveMarks})`);
    await page.waitForFunction(
      () => document.querySelectorAll("#sheet-score svg").length > 0,
      { timeout: 20_000 }
    );
    check(true, "sheet renders SVG from the wire musicXml");

    const xml = await page.evaluate(() => window.appSemantics.musicXml(window.view.state));
    check(
      typeof xml === "string" && xml.includes("<score-partwise"),
      "facade musicXml answers over the wire"
    );
    const midiHead = await page.evaluate(async () => {
      const bytes = await window.appSemantics.midiFile(window.view.state);
      return String.fromCharCode(...bytes.slice(0, 4));
    });
    check(midiHead === "MThd", `facade midiFile is an SMF (${JSON.stringify(midiHead)})`);

    check(errors.length === 0, `no console/page errors (got: ${errors.join(" | ") || "none"})`);
  } finally {
    await browser.close();
    server.stop();
    host.stop();
  }
  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
