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

    // ——— HOVER EXPLANATIONS ———
    // The claim is a PAIR, and the second half is the one that keeps the
    // feature credible: a technique glyph explains itself, and a dash — 70% of
    // the characters on screen — says nothing at all. A tooltip on every
    // character would be worse than none.
    const hoverText = async (needle, offset, wait = 1_600) => {
      // Scroll FIRST and let CM's measure phase land — reading coordsAtPos in
      // the same tick returns pre-scroll geometry and the pointer lands on a
      // different glyph entirely.
      const pos = await page.evaluate(
        ([n, o]) => {
          const p = window.view.state.doc.toString().indexOf(n) + o;
          window.view.focus();
          window.view.dispatch({ selection: { anchor: p }, scrollIntoView: true });
          return p;
        },
        [needle, offset]
      );
      await page.waitForTimeout(250);
      const spot = await page.evaluate((p) => {
        // coordsAtPos gives a CARET rect (a boundary, not a cell), so its
        // centre sits on the edge between two glyphs and `side` decides which
        // one you get. Aim at the middle of the cell [p, p+1).
        const a = window.view.coordsAtPos(p);
        const b = window.view.coordsAtPos(p + 1);
        return a && b
          ? {
              x: (a.left + b.left) / 2,
              y: (a.top + a.bottom) / 2,
              ch: window.view.state.doc.sliceString(p, p + 1),
            }
          : null;
      }, pos);
      if (!spot) return { text: "", ch: "" };
      // Park the pointer away first: CM only starts the hover timer on a MOVE.
      await page.mouse.move(spot.x, spot.y + 60);
      await page.mouse.move(spot.x, spot.y);
      await page.waitForTimeout(wait);
      const text = await page.evaluate(
        () => document.querySelector(".cm-tab-hover")?.textContent ?? ""
      );
      return { text, ch: spot.ch, spot };
    };

    const hammer = await hoverText("0h3/5", 1);
    check(
      hammer.ch === "h" && /^written as a hammer-on/.test(hammer.text),
      `hovering a technique glyph explains it (${JSON.stringify(hammer.text.slice(0, 90))})`
    );
    // The Tier-2 half really arrived over the wire — the base tree alone can
    // never produce this sentence, because the grammar does not know whether a
    // hammer BOUND to anything.
    check(
      /the note it lands on sounds without a new pick/.test(hammer.text),
      "…with the semantic outcome, not the grammar's guess"
    );
    // NOT under app/: vite serves that directory and a new file there triggers
    // a full page reload — which wiped __cursorProbe nine seconds later and
    // looked like a playback bug (diagnosed 2026-07-26).
    const shot = path.join(require("node:os").tmpdir(), "tab-edit-hover.png");
    await page.screenshot({ path: shot });
    console.log(`      (hover screenshot: ${shot})`);

    const fret = await hoverText("|---3---", 4);
    check(
      fret.ch === "3" && /this plays/.test(fret.text) && /fret 3 on the/.test(fret.text),
      `hovering a fret validates it and names the string (${JSON.stringify(fret.text.slice(0, 80))})`
    );

    const dash = await hoverText("|---3---", 2);
    check(dash.ch === "-" && dash.text === "", `hovering a dash shows NOTHING (${JSON.stringify(dash.text)})`);

    // ONE tooltip language, one box: with hover installed the linter's own
    // text tooltip is off, so a diagnostic can never draw two boxes over one
    // glyph. (The gutter marker reads a separate config and still works.)
    const lintBoxes = await page.evaluate(
      () => document.querySelectorAll(".cm-tooltip-lint").length
    );
    check(lintBoxes === 0, "the lint text tooltip is merged away — never two boxes over one glyph");

    // Dismissal: typing must clear it, and nothing may be left on screen.
    await hoverText("0h3/5", 1);
    await page.keyboard.type("-");
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(200);
    const afterTyping = await page.evaluate(
      () => document.querySelectorAll(".cm-tab-hover").length
    );
    check(afterTyping === 0, "typing dismisses the explanation");
    await page.mouse.move(10, 10);

    // KEYBOARD PARITY — hover-only information is inaccessible information.
    // The same box at the caret, on a key every installed map leaves free.
    await page.evaluate(() => {
      const p = window.view.state.doc.toString().indexOf("0h3/5") + 1;
      window.view.focus();
      window.view.dispatch({ selection: { anchor: p }, scrollIntoView: true });
    });
    await page.waitForTimeout(200);
    await page.keyboard.press("F1");
    await page.waitForTimeout(1_200);
    const keyboard = await page.evaluate(() => {
      const el = document.querySelector(".cm-tab-hover");
      return {
        text: el?.textContent ?? "",
        live: el?.getAttribute("aria-live") ?? "",
        stillInEditor: !!document.activeElement?.closest?.(".cm-editor"),
      };
    });
    check(
      /hammer-on/.test(keyboard.text) && keyboard.live === "polite",
      `F1 explains the caret, and announces itself (${JSON.stringify(keyboard.text.slice(0, 60))} aria-live=${keyboard.live})`
    );
    check(keyboard.stillInEditor, "…without taking focus off the document");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    const dismissed = await page.evaluate(
      () => document.querySelectorAll(".cm-tab-hover").length
    );
    check(dismissed === 0, "Escape dismisses it — nothing requires dismissal, nothing traps");

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

    // ——— THE DEV SURFACE ———
    // Two claims: OFF costs nothing (no inspection queries leave the page,
    // no dev DOM exists), and ON shows REAL values from the live host.
    // The counters wrap the facade object the app itself holds, so they see
    // every query the surface makes.
    await page.evaluate(() => {
      const s = window.appSemantics;
      window.__devCalls = { inspect: 0, activity: 0 };
      const inspect = s.inspectNode.bind(s);
      const activity = s.computeActivity.bind(s);
      s.inspectNode = (state, params) => {
        window.__devCalls.inspect++;
        return inspect(state, params);
      };
      s.computeActivity = (state, params) => {
        window.__devCalls.activity++;
        return activity(state, params);
      };
    });
    const devHidden = await page.evaluate(() => document.getElementById("dev-drawer").hidden);
    check(devHidden, "dev mode is OFF by default — the product page is two clean panes");
    // Exercise the paths that WOULD fetch: a cursor move and an edit.
    await page.evaluate(() => {
      const at = window.view.state.doc.toString().indexOf("|-") + 3;
      window.view.dispatch({ selection: { anchor: at } });
      window.view.focus();
    });
    await page.keyboard.type("5");
    await page.waitForTimeout(1_200);
    const idle = await page.evaluate(() => ({
      ...window.__devCalls,
      devNodes: document.querySelectorAll(".dev-prop, .dev-tree-row, .dev-claim").length,
    }));
    check(
      idle.inspect === 0 && idle.activity === 0,
      `dev OFF spends NOTHING from the rate-limited bucket (${JSON.stringify(idle)})`
    );
    check(idle.devNodes === 0, "dev OFF renders no dev DOM at all");

    await page.click("#dev-toggle");
    await page.waitForFunction(() => document.querySelectorAll("#values-rows .dev-prop").length > 5, {
      timeout: 15_000,
    });
    const values = await page.evaluate(() => {
      const rows = [...document.querySelectorAll("#values-rows .dev-prop")];
      const withValue = rows.filter(
        (r) => (r.querySelector(".dev-prop-value")?.textContent ?? "").length > 2
      );
      return {
        rows: rows.length,
        withValue: withValue.length,
        packs: document.querySelectorAll("#values-toolbar .dev-chip").length,
        claims: document.querySelectorAll("#values-claims .dev-claim").length,
        stability: document.querySelectorAll("#values-rows .dev-stab").length,
        sample: withValue[0]?.textContent?.slice(0, 60) ?? "",
        cacheLine: document.getElementById("values-footer")?.textContent ?? "",
        crumbs: document.querySelectorAll("#dev-breadcrumb .dev-crumb").length,
      };
    });
    check(values.rows > 10, `VALUES lens renders real props at the cursor (${values.rows})`);
    check(values.withValue > 5, `…with real VALUES (${values.withValue}): ${values.sample.trim()}`);
    check(values.packs >= 4, `pack + outcome chips with counts (${values.packs})`);
    check(values.claims > 0, `claims render as bid → outcome pairs (${values.claims})`);
    check(values.stability > 0, `stability badges render (${values.stability})`);
    check(/\d+\/\d+ props served from cache/.test(values.cacheLine), `cache ratio: ${values.cacheLine.slice(0, 40)}`);
    check(values.crumbs > 1, `the context bar breadcrumb names the node chain (${values.crumbs})`);

    // The prop DETAIL: chain, the causal walk, and the pin that survives lenses.
    await page.locator("#values-rows .dev-prop").first().click();
    await page.waitForSelector(".dev-detail");
    const detail = (
      await page.evaluate(() => document.querySelector(".dev-detail")?.textContent ?? "")
    ).toLowerCase();
    check(
      detail.includes("chain") && detail.includes("why it ran") && detail.includes("reads"),
      "prop detail carries provenance: the chain, why it ran, and its declared reads"
    );
    check(
      /correlation, not a recorded cause|did not run in this window|none of its declared reads/.test(detail),
      "the causal view is HEDGED — it says what also ran, not what caused it"
    );
    await page.locator(".dev-detail .dev-mini").first().click(); // pin
    await page.click('.dev-lens[data-lens="tree"]');
    const watched = await page.evaluate(
      () => !document.getElementById("dev-watch").hidden &&
        document.querySelectorAll("#dev-watch .dev-watch-chip").length
    );
    check(watched >= 1, `the watch strip survives a lens switch (${watched})`);

    // TREE: the whole document, client-side (the free half).
    const tree = await page.evaluate(() => ({
      rows: document.querySelectorAll(".dev-tree-row").length,
      atCursor: document.querySelectorAll(".dev-tree-row.at-cursor").length,
      first: document.querySelector(".dev-tree-row")?.textContent ?? "",
    }));
    check(tree.rows > 20, `TREE lens renders the document tree (${tree.rows} rows visible)`);
    check(tree.atCursor === 1, "the cursor's node is highlighted in the tree");
    const before = await page.evaluate(() => window.view.state.selection.main.from);
    await page.locator(".dev-tree-row").nth(3).click();
    const after = await page.evaluate(() => ({
      from: window.view.state.selection.main.from,
      to: window.view.state.selection.main.to,
    }));
    check(after.to > after.from && after.from !== before, `clicking a tree node selects its range (${after.from}-${after.to})`);

    // COST: after an edit, the savings figure and the per-prop table.
    await page.click('.dev-lens[data-lens="cost"]');
    await page.evaluate(() => {
      const at = window.view.state.doc.toString().indexOf("|-") + 3;
      window.view.dispatch({ selection: { anchor: at } });
      window.view.focus();
    });
    await page.keyboard.type("7");
    // Wait for an EDIT-ATTRIBUTED window. The first window a freshly opened
    // surface sees spans everything since the session began (this driver has
    // typed a 69-keystroke burst by now), which legitimately exceeds one cold
    // boot — the savings counter refuses to call that a saving, so the
    // check waits for the window that follows the keystroke above.
    await page.waitForFunction(
      () =>
        document.querySelectorAll("#cost-body .dev-prop").length > 0 &&
        /\d+ of \d+ recomputed/.test(document.getElementById("cost-headline")?.textContent ?? ""),
      { timeout: 20_000 }
    );
    const cost = await page.evaluate(() => ({
      headline: document.getElementById("cost-headline")?.textContent ?? "",
      rows: document.querySelectorAll("#cost-body .dev-prop").length,
      first: document.querySelector("#cost-body .dev-prop")?.textContent ?? "",
      reasons: document.querySelectorAll("#cost-body .dev-reason").length,
      links: document.querySelectorAll("#cost-body .dev-link").length,
      bar: document.getElementById("dev-savings")?.textContent ?? "",
      segments: document.querySelectorAll("#cost-body .dev-segment").length,
    }));
    check(
      /\d+ of \d+ recomputed · \d+ carried · [\d.]+ ms/.test(cost.headline),
      `the SAVINGS line is real: ${cost.headline.split("window")[0].trim()}`
    );
    check(/\d+ of \d+ recomputed/.test(cost.bar), "the savings figure is in the context bar too");
    check(cost.rows > 3, `COST lens lists per-prop work (${cost.rows} props): ${cost.first.replace(/\s+/g, " ").slice(0, 50)}`);
    check(cost.reasons > 0, `recompute reasons render (${cost.reasons})`);
    check(cost.links > 0, `the causal walk is navigable from the cost table (${cost.links} links)`);
    check(cost.segments === 0, "no per-segment geometry is rendered (engine machinery stays invisible)");

    // PROBLEMS, then OFF again: the page must come back to exactly product.
    await page.click('.dev-lens[data-lens="problems"]');
    const problems = await page.evaluate(
      () => document.getElementById("dev-diagnostics")?.textContent ?? ""
    );
    check(problems.length > 0, `PROBLEMS lens renders (${problems.replace(/\s+/g, " ").slice(0, 46)})`);
    // ——— THE SURFACE WHILE THE MUSIC PLAYS ———
    // Follow-the-playhead rewrites the editor selection on every sounding
    // note. Read as cursor moves, that rebuilt the panel per note: it
    // flickered and ate clicks (mousedown and mouseup landing on two
    // different elements — Stan, on the shipped surface). The claim now is
    // that following is CHEAP and STATIONARY: element identity survives the
    // notes, one click is one click, and the query count is throttled rather
    // than per-note.
    await page.click('.dev-lens[data-lens="values"]');
    await page.waitForFunction(() => document.querySelectorAll("#values-rows .dev-prop").length > 5, {
      timeout: 15_000,
    });
    await page.evaluate(() => {
      window.__before = new Map();
      for (const el of document.querySelectorAll("#values-rows .dev-prop")) {
        window.__before.set(el.dataset.key, el);
      }
      window.__chip = document.querySelector('#values-toolbar .dev-chip[data-key^="pack:"]');
      window.__devCalls.inspect = 0;
      window.__devCalls.activity = 0;
      // Count sounding spans the way a user sees them: distinct selections.
      window.__spans = new Set();
      window.__spanTick = setInterval(() => {
        const s = window.view.state.selection.main;
        window.__spans.add(`${s.from}-${s.to}`);
      }, 80);
    });
    await page.click("#play");
    await page.waitForFunction(() => document.getElementById("play")?.textContent === "⏸", {
      timeout: 15_000,
    });
    await page.waitForTimeout(6_000);
    const playing = await page.evaluate(() => {
      let surviving = 0;
      let recreated = 0;
      for (const [key, el] of window.__before) {
        const now = document.querySelector(
          `#values-rows .dev-prop[data-key="${CSS.escape(key)}"]`
        );
        if (!now) continue;
        if (now === el) surviving++;
        else recreated++;
      }
      return {
        surviving,
        recreated,
        spans: window.__spans.size,
        calls: { ...window.__devCalls },
        note: (document.getElementById("dev-breadcrumb")?.textContent ?? "").slice(-40),
      };
    });
    check(
      playing.spans > 6,
      `playback moves through a dense passage (${playing.spans} distinct sounding spans)`
    );
    check(
      playing.surviving > 5 && playing.recreated === 0,
      `row ELEMENTS survive the notes — ${playing.surviving} same elements, ${playing.recreated} rebuilt`
    );
    check(
      playing.calls.inspect < playing.spans && playing.calls.inspect <= 20,
      `queries are throttled, not per note (${playing.calls.inspect} reads for ${playing.spans} spans)`
    );
    // ONE click, mid-playback, on a chip and on a row.
    const chipBox = await page.evaluate(() => {
      const r = window.__chip.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, label: window.__chip.textContent };
    });
    await page.mouse.click(chipBox.x, chipBox.y);
    await page.waitForTimeout(400);
    const chipTook = await page.evaluate(() => ({
      active: window.__chip.classList.contains("active"),
      connected: window.__chip.isConnected,
      rows: document.querySelectorAll("#values-rows .dev-prop").length,
    }));
    check(
      chipTook.active && chipTook.connected,
      `a pack chip takes ONE click while the music plays (${chipBox.label.trim()} → ${chipTook.rows} rows)`
    );
    const rowBox = await page.evaluate(() => {
      const r = document.querySelector("#values-rows .dev-prop").getBoundingClientRect();
      return { x: r.left + 120, y: r.top + r.height / 2 };
    });
    await page.mouse.click(rowBox.x, rowBox.y);
    await page.waitForTimeout(400);
    check(
      await page.evaluate(() => !!document.querySelector(".dev-detail")),
      "a prop row takes ONE click while the music plays"
    );
    // …and with a row open, the playhead HOLDS: what you are reading does
    // not move under you, and no further queries are spent.
    const heldBefore = await page.evaluate(() => ({ ...window.__devCalls }));
    await page.waitForTimeout(2_500);
    const held = await page.evaluate(() => ({
      calls: { ...window.__devCalls },
      open: !!document.querySelector(".dev-detail"),
      note: document.getElementById("dev-breadcrumb")?.textContent ?? "",
    }));
    check(
      held.open && held.calls.inspect === heldBefore.inspect,
      `an open prop row HOLDS the view while playing (${held.calls.inspect - heldBefore.inspect} extra reads)`
    );
    check(/held/.test(held.note), `…and the bar says so (${held.note.slice(-38)})`);
    await page.evaluate(() => clearInterval(window.__spanTick));
    await page.click("#play"); // pause; leave the transport quiet again
    await page.waitForFunction(() => document.getElementById("play")?.textContent === "▶", {
      timeout: 5_000,
    });

    const callsBefore = await page.evaluate(() => ({ ...window.__devCalls }));
    await page.click("#dev-toggle");
    await page.evaluate(() => {
      const at = window.view.state.doc.toString().indexOf("|-") + 3;
      window.view.dispatch({ selection: { anchor: at } });
      window.view.focus();
    });
    await page.keyboard.type("9");
    await page.waitForTimeout(1_200);
    const off = await page.evaluate(() => ({
      hidden: document.getElementById("dev-drawer").hidden,
      devNodes: document.querySelectorAll(".dev-prop, .dev-tree-row").length,
      calls: { ...window.__devCalls },
    }));
    check(off.hidden && off.devNodes === 0, "turning dev OFF returns the page to the product exactly");
    check(
      off.calls.inspect === callsBefore.inspect && off.calls.activity === callsBefore.activity,
      `…and stops every query (${off.calls.inspect}/${off.calls.activity} unchanged)`
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
