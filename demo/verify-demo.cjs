// Playwright verification driver for the demo side panes — the checks ARE
// the spec (repo fixtures-first rule). Run with `npm run verify:demo`
// (starts its own vite server), or point DEMO_URL at one already running.
//
// What it pins:
//   1. pane order: Sheet, Inspector, AST, Diagnostics, Activity
//   2. default states: Sheet + Inspector expanded; AST/Diagnostics/Activity collapsed
//   3. Sheet's default height is generous (>= 45% of the side-pane column)
//   4. Inspector's default height is a real workspace (>= 22% of the column)
//   5. (removed per Stan: fixed predictable heights — leftover space below
//      the last pane is acceptable; no space-sharing cleverness)
//   6. divider handles sit between panes; dragging one resizes the pane above
//   7. no full-line active-line highlight (misleading in a column-based tab
//      system — selectionNodeHighlight owns "where am I")
//   8. selecting music still lights Sound/Measure node highlights
//   9. Inspector plugin chips appear at a music cursor; one chip = one group
//  10. Inspector text filter narrows rows to substring matches
//  11. first contact teaches: pane subtitle says click/cursor → values, and a
//      teaching hint shows while the cursor is NOT on a music node (fresh
//      load / prose), disappearing once it is
//  12. the run produces zero console/page errors
const { spawn } = require("node:child_process");
const path = require("node:path");
const { chromium } = require("playwright");

const PORT = 5199;
const externalUrl = process.env.DEMO_URL;

let failures = 0;
function check(cond, msg) {
  console.log(`${cond ? "OK  " : "FAIL"}: ${msg}`);
  if (!cond) failures++;
}

async function startServer() {
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
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  vite.kill();
  throw new Error(`dev server did not come up on ${url}`);
}

(async () => {
  const server = await startServer();
  const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });

    await page.goto(server.url, { waitUntil: "networkidle" });
    await page.waitForFunction(() => !!window.view);

    // ——— 1. pane order ———
    const order = await page.$$eval(".side-panes > section.pane", (els) =>
      els.map((el) => el.querySelector("h2")?.textContent?.trim().split(" ")[0])
    );
    check(
      JSON.stringify(order) === JSON.stringify(["Sheet", "Inspector", "AST", "Diagnostics", "Activity"]),
      `pane order is Sheet, Inspector, AST, Diagnostics, Activity (got ${JSON.stringify(order)})`
    );

    // ——— 2. default expanded/collapsed states ———
    const collapsed = await page.$$eval(".side-panes > section.pane", (els) =>
      Object.fromEntries(
        els.map((el) => [/pane-(\w+)/.exec(el.className)[1], el.classList.contains("collapsed")])
      )
    );
    check(!collapsed.sheet, "Sheet starts expanded");
    check(!collapsed.inspector, "Inspector starts expanded");
    check(collapsed.ast === true, "AST starts collapsed");
    check(collapsed.diagnostics === true, "Diagnostics starts collapsed");
    // Collapsed panes must not offer a resize divider (Stan UX report).
    const orphanDividers = await page.$$eval(
      ".side-panes > section.pane.collapsed",
      (els) => els.filter((el) => {
        const next = el.nextElementSibling;
        return next && next.classList.contains("pane-divider") &&
          getComputedStyle(next).display !== "none";
      }).length
    );
    check(orphanDividers === 0, "no visible divider under a collapsed pane");

    // ——— topbar: quiet menus instead of button rows ———
    const topButtons = await page.$$eval(".topbar .actions > button", (els) => els.length);
    check(topButtons === 0, `no loose buttons in the topbar (got ${topButtons})`);
    await page.click("#file-menu summary");
    const fileItems = await page.$$eval("#file-menu .menu-items button", (els) => els.length);
    check(fileItems === 3, `File menu holds the 3 import/export actions (${fileItems})`);
    await page.click("body"); // click-away closes
    check(!(await page.$eval("#file-menu", (el) => el.hasAttribute("open"))), "File menu closes on click-away");

    // ——— in-app playback (one selection-aware ▶ button) ———
    const playBtn = await page.$("#play");
    check(!!playBtn, "play button exists in the topbar");
    await page.click("#play");
    await page.waitForFunction(() => window.__lastPlayback && window.__lastPlayback.events > 0, { timeout: 5000 });
    const whole = await page.evaluate(() => window.__lastPlayback.events);
    check(whole > 0, `clicking play schedules events for the whole doc (${whole})`);
    check(await page.$eval("#play", (el) => el.textContent.trim() === "⏸"), "playing shows pause glyph");
    check(await page.$eval("#transport-slider", (el) => !el.disabled), "slider enabled during playback");
    check(await page.$eval("#editor .cm-content", (el) => el.getAttribute("contenteditable") === "false"), "editor is read-only while playing");
    await page.keyboard.press("Escape"); // stop
    check(await page.$eval("#play", (el) => el.textContent.trim() === "▶"), "Escape stops and restores play glyph");
    check(await page.$eval("#editor .cm-content", (el) => el.getAttribute("contenteditable") === "true"), "editor editable again after stop");
    // Select just the first measure region and play again — fewer events.
    await page.evaluate(() => {
      const line = view.state.doc.line(4); // first music line of the starter doc
      view.dispatch({ selection: { anchor: line.from, head: line.from + 8 } });
    });
    await page.click("#play");
    await page.waitForFunction(() => window.__lastPlayback && window.__lastPlayback.events < 999, { timeout: 5000 });
    const partial = await page.evaluate(() => window.__lastPlayback.events);
    check(partial > 0 && partial < whole, `selection playback plays a subset (${partial} < ${whole})`);
    await page.keyboard.press("Escape");
    // Follow-the-playhead: the selection must WALK the text while playing.
    await page.evaluate(() => view.dispatch({ selection: { anchor: 0, head: 0 } }));
    await page.click("#play");
    await page.waitForTimeout(600);
    const selA = await page.evaluate(() => view.state.selection.main.from);
    await page.waitForFunction((a) => view.state.selection.main.from !== a, selA, { timeout: 4000 });
    const selB = await page.evaluate(() => view.state.selection.main.from);
    check(selA !== selB && selB > 0, `follow moves the cursor between sounds (${selA} → ${selB})`);
    await page.keyboard.press("Escape");

    // ——— sample picker + rotating tips (first-demo-users features) ———
    const groups = await page.$$eval("#sample-picker optgroup", (els) =>
      els.map((el) => `${el.label}:${el.querySelectorAll("option").length}`)
    );
    check(groups.length >= 4, `picker has instrument optgroups (${groups.join(", ")})`);
    const startDoc = await page.evaluate(() => view.state.doc.line(1).text);
    check(/Demo Song/.test(startDoc), `starter doc stays the default (line 1: ${JSON.stringify(startDoc)})`);
    await page.selectOption("#sample-picker", "2:1"); // Drums / Tom Sawyer
    const swapped = await page.evaluate(() => view.state.doc.toString());
    check(/Tom Sawyer/.test(swapped), "picking a drums sample swaps the doc");
    const tip = await page.$eval("#tip", (el) => el.textContent || "");
    check(/^Tip: /.test(tip) && tip.length > 30, `rotating tip is populated (${JSON.stringify(tip.slice(0, 40))}…)`);


    // STRICT (a fallback here once masked a real regression): focus the
    // editor; the drawn caret must EXIST and be light.
    await page.evaluate(() => view.focus());
    await page.waitForSelector(".cm-cursor-primary, .cm-cursor", { state: "attached", timeout: 4000 });
    const caretColor = await page.$eval(".cm-cursor-primary, .cm-cursor", (el) => getComputedStyle(el).borderLeftColor);
    check(caretColor === "rgb(232, 232, 232)", `drawn caret exists and is light (${caretColor})`);
    // Column selection: ranges yes, extra carets no (Stan: no multi-cursors).
    await page.evaluate(() => {
      const { EditorSelection } = window.__cmState ?? {};
      const doc = view.state.doc;
      const l1 = doc.line(4), l2 = doc.line(6);
      view.dispatch({ selection: { anchor: l1.from + 3, head: l2.from + 6 } });
    });
    const secondaries = await page.$$eval(".cm-cursor-secondary", (els) => els.filter((e) => getComputedStyle(e).display !== "none").length);
    check(secondaries === 0, `no visible secondary carets (${secondaries})`);
    check(collapsed.activity === true, "Activity starts collapsed");

    // ——— 3–5. default sizes + full use of the column ———
    const sizes = await page.evaluate(() => {
      const column = document.querySelector(".side-panes");
      const rect = (sel) => document.querySelector(sel).getBoundingClientRect();
      return {
        column: column.getBoundingClientRect().height,
        sheet: rect(".pane-sheet").height,
        inspector: rect(".pane-inspector").height,
      };
    });
    const sheetPct = sizes.sheet / sizes.column;
    const inspectorPct = sizes.inspector / sizes.column;
    check(sheetPct >= 0.45, `Sheet default height is ${(sheetPct * 100).toFixed(1)}% of the column (>= 45%)`);
    check(
      inspectorPct >= 0.22,
      `Inspector default height is ${(inspectorPct * 100).toFixed(1)}% of the column (>= 22%)`
    );

    // ——— 11a. first contact: subtitle + teaching hint at fresh load ———
    // The cursor starts at 0 — the Title/Tempo directive lines, nothing
    // musical — so the Inspector must TEACH the click→values relationship.
    const subtitle = await page.$eval(".pane-inspector h2 .pane-sub", (el) => el.textContent);
    check(
      /click .*editor.*computed values/i.test(subtitle),
      `Inspector subtitle states the click→values relationship plainly (got "${subtitle}")`
    );
    // Deterministic trigger: an EMPTY doc has nothing to inspect anywhere,
    // so the teaching hint MUST show (richer prop catalogs mean position 0
    // of the starter doc can legitimately have rows now).
    const savedDoc = await page.evaluate(() => {
      const d = view.state.doc.toString();
      view.dispatch({ changes: { from: 0, to: d.length, insert: "" } });
      return d;
    });
    await page.waitForSelector("#inspector .inspector-teach", { timeout: 5000 });
    const teachAtLoad = await page.$eval("#inspector .inspector-teach", (el) => el.textContent);
    check(
      /place the cursor/i.test(teachAtLoad),
      `teaching hint shows when there is nothing to inspect (got ${JSON.stringify(teachAtLoad)})`
    );
    await page.evaluate((d) => view.dispatch({ changes: { from: 0, to: 0, insert: d } }), savedDoc);
    await page.waitForTimeout(400);

    // ——— 7. no active-line bar with the cursor in a music line ———
    await page.evaluate(() => {
      const doc = window.view.state.doc.toString();
      // First fret digit is the "0" in the first tab line ("e|--0--..." —
      // doc.indexOf("0") alone would hit "Tempo: 100" in the header).
      const idx = doc.indexOf("0", doc.indexOf("e|"));
      window.view.dispatch({ selection: { anchor: idx + 1, head: idx + 1 } });
      window.view.focus();
    });
    const activeLine = await page.evaluate(() => ({
      line: document.querySelectorAll(".cm-activeLine").length,
      gutter: document.querySelectorAll(".cm-activeLineGutter").length,
      lineNumbers: document.querySelectorAll(".cm-lineNumbers").length,
    }));
    check(activeLine.line === 0, `no .cm-activeLine element with the cursor in a music line (got ${activeLine.line})`);
    check(activeLine.gutter === 0, `no .cm-activeLineGutter element either (got ${activeLine.gutter})`);
    check(activeLine.lineNumbers > 0, "gutter line numbers are still present");

    // ——— 9. Inspector plugin chips at a music-line cursor ———
    // Wait for the render to reflect the FRET cursor, not the stale pos-0
    // one: only the fret render has Measure-scoped rows.
    await page.waitForFunction(() =>
      [...document.querySelectorAll("#inspector .inspector-row-scope")].some((el) =>
        el.textContent.startsWith("Measure")
      )
    );

    // ——— 11b. the teaching hint clears once the cursor IS on a music node ———
    const teachAtFret = await page.evaluate(
      () => document.querySelector("#inspector .inspector-teach") !== null
    );
    check(!teachAtFret, "teaching hint disappears with the cursor on a fret (music node)");
    const chipLabels = await page.$$eval("#inspector .inspector-chip", (els) =>
      els.map((el) => el.textContent.trim())
    );
    const pluginChips = chipLabels.filter((l) => !l.startsWith("all ("));
    check(pluginChips.length >= 2, `at least 2 plugin chips at a fret cursor (got ${pluginChips.length}: ${pluginChips.join(", ")})`);

    const groupsBefore = await page.$$eval("#inspector .inspector-group-header", (els) =>
      els.map((el) => el.textContent.trim())
    );
    check(
      groupsBefore.length === pluginChips.length,
      `one group header per plugin chip before filtering (${groupsBefore.length} groups)`
    );

    const targetPluginId = pluginChips[0].replace(/\s*\(\d+\)$/, "");
    await page.evaluate((label) => {
      [...document.querySelectorAll("#inspector .inspector-chip")]
        .find((el) => el.textContent.trim() === label)
        ?.click();
    }, pluginChips[0]);
    const groupsAfter = await page.$$eval("#inspector .inspector-group-header", (els) =>
      els.map((el) => el.textContent.trim())
    );
    check(
      groupsAfter.length === 1 && groupsAfter[0].includes(targetPluginId),
      `clicking the "${targetPluginId}" chip narrows to exactly that group (got ${JSON.stringify(groupsAfter)})`
    );
    await page.click('#inspector .inspector-chip:has-text("all (")'); // reset for the text check

    // ——— 10. Inspector text filter ———
    await page.waitForFunction(
      (n) => document.querySelectorAll("#inspector .inspector-group-header").length === n,
      groupsBefore.length
    );
    const propNamesBefore = await page.$$eval("#inspector .inspector-prop", (els) =>
      els.map((el) => el.textContent.trim())
    );
    check(propNamesBefore.length > 0, `prop rows are visible before filtering (${propNamesBefore.length})`);
    const substring = propNamesBefore[0].slice(0, Math.max(2, Math.ceil(propNamesBefore[0].length / 2)));
    const expectMatches = propNamesBefore.filter((n) =>
      n.toLowerCase().includes(substring.toLowerCase())
    ).length;
    await page.fill("#inspector .inspector-filter-text", substring);
    const propNamesAfter = await page.$$eval("#inspector .inspector-prop", (els) =>
      els.map((el) => el.textContent.trim())
    );
    check(
      propNamesAfter.length === expectMatches &&
        propNamesAfter.every((n) => n.toLowerCase().includes(substring.toLowerCase())),
      `text filter "${substring}" narrows ${propNamesBefore.length} rows to the ${expectMatches} matching`
    );
    await page.fill("#inspector .inspector-filter-text", ""); // leave clean state

    // ——— 8. selection still lights Sound/Measure node highlights ———
    await page.evaluate(() => {
      const doc = window.view.state.doc.toString();
      const idx = doc.indexOf("0", doc.indexOf("e|"));
      window.view.dispatch({ selection: { anchor: idx, head: idx + 4 } });
    });
    await page.waitForFunction(
      () =>
        document.querySelectorAll(".cm-tab-selected-sound").length +
          document.querySelectorAll(".cm-tab-selected-measure").length >
        0
    );
    const highlights = await page.evaluate(() => ({
      sounds: document.querySelectorAll(".cm-tab-selected-sound").length,
      measures: document.querySelectorAll(".cm-tab-selected-measure").length,
    }));
    check(
      highlights.sounds > 0,
      `selecting music lights Sound node highlights (${highlights.sounds} sound, ${highlights.measures} measure marks)`
    );

    // ——— 6. divider handles: present, and dragging resizes the pane above ———
    const dividerCount = await page.$$eval(".side-panes .pane-divider", (els) => els.length);
    check(dividerCount === 4, `4 divider handles between the 5 panes (got ${dividerCount})`);
    if (dividerCount > 0) {
      const before = await page.evaluate(
        () => document.querySelector(".pane-sheet").getBoundingClientRect().height
      );
      const divider = await page.$(".side-panes .pane-divider"); // first = below Sheet
      const box = await divider.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 80, { steps: 8 });
      await page.mouse.up();
      const after = await page.evaluate(
        () => document.querySelector(".pane-sheet").getBoundingClientRect().height
      );
      check(
        before - after > 40,
        `dragging the divider below Sheet up by 80px shrinks it (${before.toFixed(0)}px → ${after.toFixed(0)}px)`
      );
    }

    // ——— 11. clean console ———
    check(errors.length === 0, `no console/page errors (got: ${errors.join(" | ") || "none"})`);
  } finally {
    await browser.close();
    server.stop();
  }

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
