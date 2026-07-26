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

/** A DEPLOYED host has token auth ON (`wrangler secret put TOKEN_SECRET`), so a
 *  bare socket to …/session is rejected — the probe has to mint the anonymous
 *  token exactly like app/main.ts does. Local `wrangler dev`/dev-server run
 *  with auth OFF and answer "token auth is off"; both shapes work here. */
async function probeUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  if (!u.pathname.endsWith("/session")) return url;
  u.searchParams.set("doc", `verify-app-${Date.now()}`);
  const base = `${u.protocol === "wss:" ? "https:" : "http:"}//${u.host}`;
  try {
    const response = await fetch(`${base}/token`);
    const token = await response.text();
    if (response.ok && token && token !== "token auth is off") {
      u.searchParams.set("token", token);
    }
  } catch {}
  return u.toString();
}

async function wsReachable(rawUrl) {
  const url = await probeUrl(rawUrl);
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
  if (process.env.REMOTE_WS) {
    // An explicit endpoint is a DEPLOYMENT check — spawning a local host here
    // would poll a URL the child can never serve (the old failure mode).
    throw new Error(`REMOTE_WS=${wsUrl} is unreachable — token mint or socket refused`);
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
  // AUDIT_ONLY is the CI/deploy gate: the trade-secret posture check needs no
  // browser and no session host, so it can guard a deploy on a runner that has
  // neither. The live half stays a developer/smoke concern.
  if (process.env.AUDIT_ONLY) {
    console.log(failures === 0 ? "\nAUDIT PASSED" : `\n${failures} AUDIT CHECK(S) FAILED`);
    process.exit(failures === 0 ? 0 : 1);
  }
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

    // ——— the score cursor, measured the way a USER sees it ———
    // COUNTING elements was the old check, and it is why "the cursor doesn't
    // show" survived a green harness: OSMD's <img> exists whether or not a
    // single pixel of it reaches the screen. These probes assert GEOMETRY —
    // painted size, inside the scroll pane's visible box, and topmost at its
    // own centre.
    await page.evaluate(() => {
      window.__cursorProbe = () => {
        const pane = document.getElementById("sheet-score");
        const img = pane.querySelector('img[id^="cursorImg"]');
        if (!img) return { present: false };
        const p = pane.getBoundingClientRect();
        const r = img.getBoundingClientRect();
        const style = getComputedStyle(img);
        const painted =
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number(style.opacity) > 0.1 &&
          r.width > 0 &&
          r.height > 0;
        const inPane = r.top >= p.top - 1 && r.bottom <= p.bottom + 1;
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return {
          present: true,
          painted,
          inPane,
          topmost: top ? top.id || top.tagName : null,
          rect: [Math.round(r.top), Math.round(r.height)],
          scrollTop: Math.round(pane.scrollTop),
        };
      };
    });
    const visibleCursor = (c) =>
      c.present && c.painted && c.inPane && String(c.topmost).startsWith("cursorImg");
    // AT REST: the score shows a position before anything plays (it used to
    // show one only while sound was coming out).
    const restCursor = await page.evaluate(() => window.__cursorProbe());
    check(visibleCursor(restCursor), `score cursor is visible at rest (${JSON.stringify(restCursor)})`);

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

    // ——— playback over the wire (the last engine-side feature) ———
    const midi = await page.evaluate(() => window.appSemantics.midiEvents(window.view.state));
    check(
      midi.events.length > 0 && midi.bpm > 0 && midi.ppq > 0,
      `midiEvents query feeds playback (${midi.events.length} events @ ${midi.bpm}bpm)`
    );
    await page.click("#play");
    await page.waitForFunction(() => document.getElementById("play")?.textContent === "⏸", {
      timeout: 15_000,
    });
    // The transport must actually ADVANCE (a real timeline, real clock).
    await page.waitForFunction(
      () => Number(document.getElementById("transport-slider")?.value ?? 0) > 0,
      { timeout: 15_000 }
    );
    check(true, "▶ plays: transport advances from wire-fed events");
    // Follow-the-playhead moved the editor selection onto sounding text…
    const followed = await page.evaluate(() => !window.view.state.selection.main.empty);
    check(followed, "playhead follow selects the sounding sound");
    // …and the notation cursor is on the score, VISIBLY.
    await page.waitForTimeout(1_000);
    const earlyCursor = await page.evaluate(() => window.__cursorProbe());
    check(visibleCursor(earlyCursor), `sheet cursor visible 1s in (${JSON.stringify(earlyCursor)})`);
    // …and STILL visible seconds later. The score is several pane-heights
    // tall, so a cursor nobody scrolls to is off-screen within seconds — the
    // exact regression a one-shot check at t≈0 cannot see. The pane must
    // follow it (we scroll it ourselves; see app/main.ts).
    await page.waitForTimeout(9_000);
    const lateCursor = await page.evaluate(() => window.__cursorProbe());
    check(
      visibleCursor(lateCursor),
      `sheet cursor still visible 10s in — the pane follows (${JSON.stringify(lateCursor)})`
    );
    check(
      lateCursor.rect && earlyCursor.rect && lateCursor.rect[0] !== earlyCursor.rect[0],
      "sheet cursor actually moved with the music"
    );
    // The pane must CHASE the cursor, not merely happen to contain it: scroll
    // to the far end of the score and the next notes must bring it back.
    await page.evaluate(() => {
      const pane = document.getElementById("sheet-score");
      pane.scrollTop = pane.scrollHeight;
    });
    let recovered = false;
    try {
      await page.waitForFunction(() => window.__cursorProbe().inPane, { timeout: 5_000 });
      recovered = true;
    } catch {}
    check(recovered, "score pane scrolls the cursor back into view while playing");

    // ——— pause → play is CONTIGUOUS (no jump back to the play-start caret) ———
    const clock = () =>
      page.evaluate(() => {
        const [pos] = (document.getElementById("transport-time")?.textContent ?? "0:00 / 0:00")
          .split(" / ");
        const [m, s] = pos.split(":");
        return Number(m) * 60 + Number(s);
      });
    await page.click("#play"); // pause
    await page.waitForFunction(() => document.getElementById("play")?.textContent === "▶", {
      timeout: 5_000,
    });
    check(true, "⏸ pauses");
    const pausedAt = await clock();
    check(pausedAt > 0, `paused with the clock past the start (${pausedAt}s)`);
    await page.waitForTimeout(1_000);
    await page.click("#play"); // resume — nothing touched in between
    await page.waitForFunction(() => document.getElementById("play")?.textContent === "⏸", {
      timeout: 10_000,
    });
    await page.waitForTimeout(1_500);
    const resumedAt = await clock();
    // Follow writes the sounding span into the selection every frame, so the
    // selection left on screen by a pause is the PLAYHEAD's, not the user's.
    // Reading it as a user selection rebuilt the player and restarted from
    // the play-start caret — play/pause/play must be contiguous.
    check(
      resumedAt >= pausedAt,
      `▶ after ⏸ continues where it stopped (${pausedAt}s → ${resumedAt}s)`
    );
    await page.click("#play"); // pause again, leave the transport quiet
    await page.waitForFunction(() => document.getElementById("play")?.textContent === "▶", {
      timeout: 5_000,
    });
    // Standard-notation toggle re-renders through the shared sanitizer.
    await page.click("#sheet-mode");
    await page.waitForFunction(
      () => document.getElementById("sheet-mode")?.textContent?.includes("tab notation"),
      { timeout: 10_000 }
    );
    await page.waitForFunction(() => document.querySelectorAll("#sheet-score svg").length > 0, {
      timeout: 20_000,
    });
    check(true, "standard-notation toggle re-renders the score");

    // ——— LIVE SHEET CONVERGENCE (the burst bug) ———
    // The observable is the rendered title (drawTitle: true): type a marker
    // into the Title directive and the score must end up carrying it.
    const titleText = () =>
      page.evaluate(
        () =>
          Array.from(document.querySelectorAll("#sheet-score svg text"))
            .map((t) => t.textContent)
            .find((t) => /Blackbird/.test(t)) ?? ""
      );
    const typeIntoTitle = async (text) => {
      await page.evaluate(() => {
        window.view.dispatch({ selection: { anchor: window.view.state.doc.line(1).to } });
        window.view.focus();
      });
      await page.keyboard.type(text, { delay: 0 });
    };
    const awaitTitle = async (marker, timeout) => {
      try {
        await page.waitForFunction(
          (m) =>
            (Array.from(document.querySelectorAll("#sheet-score svg text"))
              .map((t) => t.textContent)
              .find((t) => /Blackbird/.test(t)) ?? "").includes(m),
          marker,
          { timeout }
        );
        return true;
      } catch {
        return false;
      }
    };
    await typeIntoTitle("BURSTMARK" + "q".repeat(60));
    check(
      await awaitTitle("BURSTMARK" + "q".repeat(60), 20_000),
      `sheet converges after a 69-keystroke burst (${(await titleText()).slice(-16)})`
    );

    // A LOST answer must not end live updating. One swallowed reply — what a
    // socket torn down mid-request produces — used to latch the pane's
    // in-flight flag forever: every later edit rescheduled, every reschedule
    // saw "busy", and the sheet never updated again for the rest of the
    // session, silently. The pane must still converge.
    await page.evaluate(() => {
      const s = window.appSemantics;
      const real = s.musicXml.bind(s);
      let swallow = true;
      s.musicXml = (state) => {
        if (swallow) {
          swallow = false;
          return new Promise(() => {});
        }
        return real(state);
      };
    });
    await typeIntoTitle("LOSTMARK");
    await page.waitForTimeout(1_500);
    await typeIntoTitle("HEALEDMARK");
    check(
      await awaitTitle("HEALEDMARK", 30_000),
      "sheet still converges after an answer is LOST in flight"
    );

    check(errors.length === 0, `no console/page errors (got: ${errors.join(" | ") || "none"})`);
  } finally {
    await browser.close();
    server.stop();
    host.stop();
  }
  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
