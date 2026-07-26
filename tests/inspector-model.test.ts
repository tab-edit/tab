// The inspector's VIEW MODEL (src/inspector-model.ts): the derivations the
// panes render. Constructed frames on purpose — this is where the cases
// real data cannot produce yet get proven (an `internal` prop, a producer
// with no clock, a claim whose outcome is missing), and where the honest
// fallbacks are pinned so no pane can quietly start lying.

import {
  buildRows,
  causeOf,
  claimPairs,
  costRows,
  filterRows,
  indexActivity,
  orderRows,
  outcomeNameFor,
  packChips,
  rangesInValue,
  savingsLine,
  splitPropId,
  stateChips,
  summarizeValue,
} from "../src/inspector-model.js";
import type { ActivityFrame, InspectionFrame } from "@tab-edit/protocol";

/** A prop as the wire carries it, plus the two exposure axes a newer host
 *  adds (typed loosely on purpose: the model must consume them when present
 *  and degrade when absent). */
function prop(
  id: string,
  extra: Record<string, unknown> = {}
): InspectionFrame["chain"][number]["props"][number] {
  return {
    id,
    chain: [`${splitPropId(id).pack} (base)`],
    deps: [],
    evaluated: true,
    computed: false,
    trace: [],
    value: 1,
    stability: "experimental",
    internal: false,
    ...extra,
  } as InspectionFrame["chain"][number]["props"][number];
}

function frame(nodes: { name: string; from: number; to: number; props: unknown[] }[]): InspectionFrame {
  return {
    version: 3,
    pos: 5,
    chain: nodes.map((n) => ({
      nodeName: n.name,
      ranges: [{ from: n.from, to: n.to }],
      props: n.props as InspectionFrame["chain"][number]["props"],
    })),
    installWarnings: [],
  };
}

const FRAME = frame([
  {
    name: "FretNote",
    from: 5,
    to: 6,
    props: [
      prop("core-pitch/noteSound", { deps: ["core-taxonomy/lineRoles"], stability: "stable" }),
      prop("core-time/noteDuration", { computed: true, stability: "experimental" }),
      prop("core-taxonomy/lineRoles", { value: { 1: "voice" } }),
    ],
  },
  {
    name: "Section",
    from: 0,
    to: 40,
    props: [
      prop("core-taxonomy/segmentKindClaim", {
        value: { value: "music", source: "core-taxonomy", confidence: 0.9 },
      }),
      prop("core-taxonomy/segmentKind", { value: "music" }),
      prop("core-taxonomy/lineRoleClaims", { value: [{ line: 1, value: "voice" }] }),
      prop("core-taxonomy/lineRoles", { value: { 1: "voice" } }),
    ],
  },
  {
    name: "TabDocument",
    from: 0,
    to: 40,
    props: [prop("export-musicxml/documentXml", { evaluated: false, value: undefined })],
  },
]);

const ACTIVITY: ActivityFrame = {
  version: 3,
  passId: 7,
  sincePass: 6,
  segments: [
    {
      from: 0,
      to: 20,
      reuse: "changed",
      recomputes: [
        { propId: "core-time/noteDuration", runs: 4, reason: "text-changed" },
        { propId: "core-pitch/noteSound", runs: 2, reason: "text-changed" },
      ],
    },
    { from: 20, to: 40, reuse: "carried", recomputes: [] },
    {
      from: 40,
      to: 60,
      reuse: "carried",
      recomputes: [{ propId: "core-pitch/noteSound", runs: 1, reason: "dependency-recomputed" }],
    },
  ],
  docRecomputes: [{ propId: "core-aggregates/documentInstruments", runs: 1, reason: "structure-changed" }],
  totalRecomputes: 8,
  unattributed: 0,
  savings: {
    recomputedProps: 8,
    carriedProps: 71,
    elapsedMs: 0.26,
    baselineProps: 79,
    baselineMs: 12.5,
  },
  timings: [
    { propId: "core-time/noteDuration", runs: 4, selfMs: 0.2, totalMs: 0.3, maxSelfMs: 0.09 },
    { propId: "core-pitch/noteSound", runs: 3, selfMs: 0.05, totalMs: 0.05, maxSelfMs: 0.02 },
  ],
};

test("rows carry pack, node, cache state, cost and BOTH directions of the dep graph", () => {
  const rows = buildRows(FRAME, indexActivity(ACTIVITY));
  const noteSound = rows.find((r) => r.id === "core-pitch/noteSound")!;
  expect(noteSound.pack).toBe("core-pitch");
  expect(noteSound.name).toBe("noteSound");
  expect(noteSound.nodeIndex).toBe(0);
  expect(noteSound.nodeName).toBe("FretNote");
  expect(noteSound.runs).toBe(3); // 2 + 1, summed across segments
  expect(noteSound.selfMs).toBeCloseTo(0.05);
  expect(noteSound.reason).toBe("text-changed");
  expect(noteSound.deps).toEqual(["core-taxonomy/lineRoles"]);
  // …and the reverse edge, which is what makes "who reads me?" walkable.
  expect(rows.find((r) => r.id === "core-taxonomy/lineRoles")!.dependents).toEqual([
    "core-pitch/noteSound",
  ]);

  // Cache state, in the vocabulary a plugin author debugs in.
  expect(noteSound.state).toBe("carried");
  expect(rows.find((r) => r.id === "core-time/noteDuration")!.state).toBe("recomputed");
  expect(rows.find((r) => r.id === "export-musicxml/documentXml")!.state).toBe("deferred");
  expect(rows.every((r) => r.stability !== undefined)).toBe(true);
  expect(noteSound.stability).toBe("stable");
  // Absence (an older host) reads as the under-promising default, which is
  // exactly what the projector resolves it to — the two cannot disagree.
  expect(
    buildRows(frame([{ name: "X", from: 0, to: 1, props: [{ ...prop("p/q"), stability: undefined }] }]))[0]
      .stability
  ).toBe("experimental");
});

test("a cold reason outranks the per-read label: `cold` is its own state", () => {
  const cold = indexActivity({
    ...ACTIVITY,
    segments: [
      {
        from: 0,
        to: 20,
        reuse: "changed",
        recomputes: [{ propId: "core-pitch/noteSound", runs: 1, reason: "cold" }],
      },
    ],
    docRecomputes: [],
  });
  expect(buildRows(FRAME, cold).find((r) => r.id === "core-pitch/noteSound")!.state).toBe("cold");
});

test("an INTERNAL prop is an opaque node: position, cost and cache status, no value", () => {
  // Zero props are internal today, so this case cannot come from real data —
  // it is exactly the case a constructed frame is for.
  const opaque = frame([
    {
      name: "Measure",
      from: 0,
      to: 9,
      props: [
        prop("some-pack/secretIndex", {
          internal: true,
          value: { rows: [1, 2, 3] },
          valueChars: 99,
          valueTruncated: true,
          deps: ["core-taxonomy/lineRoles"],
        }),
      ],
    },
  ]);
  const row = buildRows(opaque)[0];
  expect(row.internal).toBe(true);
  expect(row.value).toBeUndefined();
  expect(row.valueTruncated).toBe(false);
  expect(row.valueChars).toBeUndefined();
  // It keeps its place in the graph — that is the point of showing it.
  expect(row.deps).toEqual(["core-taxonomy/lineRoles"]);
  expect(summarizeValue(row)).toBe("internal — value withheld");
});

test("chips: packs in first-appearance order, outcomes with counts", () => {
  const rows = buildRows(FRAME, indexActivity(ACTIVITY));
  expect(packChips(rows).map((c) => c.pack)).toEqual([
    "core-pitch",
    "core-time",
    "core-taxonomy",
    "export-musicxml",
  ]);
  expect(packChips(rows).find((c) => c.pack === "core-taxonomy")!.count).toBe(5);
  const states = Object.fromEntries(stateChips(rows).map((c) => [c.state, c.count]));
  expect(states).toMatchObject({ recomputed: 1, carried: 6, deferred: 1 });
});

test("filters compose: pack, text, outcome, stability, changed-only", () => {
  const rows = buildRows(FRAME, indexActivity(ACTIVITY));
  expect(filterRows(rows, { pack: "core-taxonomy" })).toHaveLength(5);
  expect(filterRows(rows, { text: "note" }).map((r) => r.name).sort()).toEqual([
    "noteDuration",
    "noteSound",
  ]);
  expect(filterRows(rows, { states: ["recomputed"] }).map((r) => r.name)).toEqual(["noteDuration"]);
  expect(filterRows(rows, { stability: ["stable"] }).map((r) => r.name)).toEqual(["noteSound"]);
  expect(filterRows(rows, { changedOnly: true }).map((r) => r.id).sort()).toEqual([
    "core-pitch/noteSound",
    "core-time/noteDuration",
  ]);
  expect(filterRows(rows, { pack: "core-pitch", text: "duration" })).toHaveLength(0);
});

test("COST-FIRST by default — and it SAYS SO when there is no cost data yet", () => {
  const withCost = orderRows(buildRows(FRAME, indexActivity(ACTIVITY)), "cost");
  expect(withCost.costFellBack).toBe(false);
  expect(withCost.rows[0].id).toBe("core-time/noteDuration"); // 0.2ms beats 0.05ms
  expect(withCost.rows[1].id).toBe("core-pitch/noteSound");

  // First open: no window fetched yet. The pane must not pretend.
  const cold = orderRows(buildRows(FRAME), "cost");
  expect(cold.costFellBack).toBe(true);
  expect(cold.rows.map((r) => r.pack)[0]).toBe("core-pitch"); // pack order instead

  // A producer with no clock (a naive reference engine legitimately omits
  // timings) still orders by RUNS rather than falling back.
  const noClock = orderRows(buildRows(FRAME, indexActivity({ ...ACTIVITY, timings: undefined })), "cost");
  expect(noClock.costFellBack).toBe(false);
  expect(noClock.rows[0].id).toBe("core-time/noteDuration"); // 4 runs, ordered by RUNS
});

test("claims pair with their outcome: who bid, who won", () => {
  expect(outcomeNameFor("blockKindClaim")).toBe("blockKind");
  expect(outcomeNameFor("lineRoleClaims")).toBe("lineRoles");
  expect(outcomeNameFor("noteSound")).toBeNull();

  const pairs = claimPairs(buildRows(FRAME));
  expect(pairs.map((p) => [p.claim.name, p.outcome?.name])).toEqual([
    ["segmentKindClaim", "segmentKind"],
    ["lineRoleClaims", "lineRoles"],
  ]);
  // The outcome is matched WITHIN the node: the FretNote's own lineRoles is
  // a different negotiation from the Section's.
  expect(pairs[1].outcome!.nodeIndex).toBe(1);
  // A claim whose outcome is not in the frame still shows as a bid.
  const orphan = claimPairs(buildRows(frame([{ name: "Section", from: 0, to: 9, props: [prop("p/xClaim")] }])));
  expect(orphan).toHaveLength(1);
  expect(orphan[0].outcome).toBeUndefined();
});

test("the savings line is the demonstration — and it refuses to overclaim", () => {
  expect(savingsLine(ACTIVITY)).toEqual({
    headline: "8 of 79 recomputed · 71 carried · 0.26 ms",
    attributed: true,
  });
  // No window yet.
  expect(savingsLine(null).attributed).toBe(false);
  // A local build before its cold boot was measured.
  const noBaseline = savingsLine({
    ...ACTIVITY,
    savings: { ...ACTIVITY.savings, baselineProps: 0, baselineMs: 0 },
  });
  expect(noBaseline.attributed).toBe(false);
  expect(noBaseline.note).toMatch(/baseline/);
  // A window that spans more work than one cold boot (many edits, or the
  // inspector's own reads) floors `carried` at 0 — reporting it as a saving
  // would be a lie.
  const overshoot = savingsLine({
    ...ACTIVITY,
    savings: { ...ACTIVITY.savings, recomputedProps: 120, carriedProps: 0 },
  });
  expect(overshoot.attributed).toBe(false);
  expect(overshoot.headline).toContain("120 recomputed");
});

test("the cost table is PER PROP — the model exposes no segment geometry", () => {
  const cost = costRows(ACTIVITY);
  expect(cost.map((c) => c.propId)).toEqual([
    "core-time/noteDuration",
    "core-pitch/noteSound",
    "core-aggregates/documentInstruments",
  ]);
  expect(cost[0].runs).toBe(4);
  // Runs are summed ACROSS segments: the geometry is used and discarded.
  expect(cost[1].runs).toBe(3);
  // A prop that ran but has no timing still appears, at zero cost.
  expect(cost[2].selfMs).toBe(0);
  expect(cost[2].reason).toBe("structure-changed");
  // Nothing a pane could draw a segment boundary from leaves this module —
  // segment ranges map to no lever a plugin author owns, and they are the
  // most mechanism-revealing thing in the frame.
  expect(JSON.stringify(cost)).not.toContain('"from"');
});

test("WHY it ran: the declared reads that also ran, both directions, hedged", () => {
  const rows = buildRows(FRAME, indexActivity(ACTIVITY));
  const index = indexActivity(ACTIVITY);
  const noteSound = causeOf(rows.find((r) => r.id === "core-pitch/noteSound")!, index);
  // The upstream set is an INTERSECTION of outcome data, and the `kind`
  // says so — the UI must not word it as a recorded cause.
  expect(noteSound.kind).toBe("correlated");
  expect(noteSound.reason).toBe("text-changed");
  expect(noteSound.upstream).toEqual([]); // lineRoles did not run this window

  const withUpstream = causeOf(
    { ...rows[0], deps: ["core-time/noteDuration"], reason: "dependency-recomputed" },
    index
  );
  expect(withUpstream.upstream.map((e) => e.propId)).toEqual(["core-time/noteDuration"]);
  expect(withUpstream.upstream[0].runs).toBe(4);
  expect(withUpstream.upstream[0].selfMs).toBeCloseTo(0.2);

  // The other direction: what ran BECAUSE of me (as far as the frame sees).
  const lineRoles = causeOf(rows.find((r) => r.id === "core-taxonomy/lineRoles")!, index);
  expect(lineRoles.downstream.map((e) => e.propId)).toEqual(["core-pitch/noteSound"]);
});

test("values: ranges inside them are findable, and long ones truncate honestly", () => {
  expect(rangesInValue({ ranges: [{ from: 1, to: 2 }], nested: { deep: { from: 8, to: 9 } } })).toEqual([
    { from: 1, to: 2 },
    { from: 8, to: 9 },
  ]);
  expect(rangesInValue([{ from: 0, to: 1 }, "x", null, 3])).toEqual([{ from: 0, to: 1 }]);
  expect(rangesInValue({ from: "a", to: 2 })).toEqual([]);

  const rows = buildRows(
    frame([
      {
        name: "TabDocument",
        from: 0,
        to: 9,
        props: [
          prop("p/big", { value: "x".repeat(120), valueTruncated: true, valueChars: 40_000 }),
          prop("p/broken", { error: "boom", value: undefined }),
          prop("p/undef", { value: undefined }),
        ],
      },
    ])
  );
  expect(summarizeValue(rows[0])).toMatch(/…\s?\(40,000 chars\)$/);
  expect(summarizeValue(rows[1])).toBe("⚠ boom");
  expect(summarizeValue(rows[2])).toBe("undefined");
});
