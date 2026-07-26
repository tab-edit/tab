// ENGINE INSPECTION, in-repo: the LOCAL frame producers (state-layer.ts)
// and the app-facing facade methods that carry them.
//
// WHAT THIS SUITE CAN AND CANNOT PROVE. The cross-ENGINE differential —
// "the frame a hosted engine answers ≡ the frame a naive local one
// answers, except the perf fields" — lives in remote/host/tests/
// inspection.test.ts, which has both engines in one process. It cannot be
// restated here: every producer this repo can reach goes through the SAME
// module-level state layer, so a local-vs-oracle comparison would be a
// frame compared with itself modulo JSON. Pretending otherwise would be the
// worst kind of green test.
//
// So this suite proves the three things that ARE in cm-adapter's charter:
//
//   1. WARM ≡ COLD — a frame taken from a state that has been edited into
//      shape equals one taken from a freshly created state at the same
//      text, values and all, excluding `computed`/`trace` (cache-HISTORY
//      dependent by nature — that difference IS what incrementality is) and
//      `version` (a local build answers about the state it was handed).
//      This is the strongest honest statement available in-repo, and it is
//      the same exclusion set the host's differential uses.
//   2. The frame is WIRE-SHAPED: JSON-total, deepest-first, parenthood
//      ordered, root props deferred until asked for.
//   3. The FACADE carries it — both implementations, the remote one through
//      a real RemoteClient over a JSON-round-tripping transport, with the
//      flush-then-cite-atVersion discipline client.ts commits to.
//
// NOTE for the remote repo: the local NodeInspection now carries `ranges`
// and PropInspection carries `deps`/`stability`/`internal`, so the host
// differential's `stable()` can stop excluding `deps` (it was excluded only
// because the local twin had none).

import { EditorState } from "@codemirror/state";
import {
  docHash,
  parseClientMessage,
  PROTOCOL_VERSION,
  type InspectionFrame,
  type ServerMessage,
} from "@tab-edit/protocol";
import { ChangeSet } from "@codemirror/state";
import { forceParsed } from "./force-parse.js";
import {
  configureTabHost,
  createLocalSemantics,
  createRemoteSemantics,
  localActivityFrame,
  localInspectionFrame,
  localSnapshotOf,
  remoteSemantics,
  sessionTransport,
  tablature,
} from "../src/index.js";

const WIDE = "-".repeat(24);
const SYSTEM = [
  `e|--0--2--${WIDE}|`,
  `B|--0-----${WIDE}|`,
  `G|--------${WIDE}|`,
  `D|--------${WIDE}|`,
  `A|--------${WIDE}|`,
  `E|3-------${WIDE}|`,
].join("\n");
const SECOND = [
  `e|--5-----${WIDE}|`,
  `B|--------${WIDE}|`,
  `G|--------${WIDE}|`,
  `D|--------${WIDE}|`,
  `A|--------${WIDE}|`,
  `E|--------${WIDE}|`,
].join("\n");
const DOC = [
  "Tempo: 120",
  "",
  SYSTEM,
  "",
  "A lovely little melody for the inspection suite.",
  "",
  SECOND,
  "",
].join("\n");
/** Inside the first system's opening chord — a FretNote, so the chain runs
 *  note → sound → measure → block → section → document. */
const NOTE_POS = DOC.indexOf("e|--0") + 4;

const localState = (doc: string): EditorState =>
  forceParsed(EditorState.create({ doc, extensions: [tablature()] }));

/** The frame minus what two READS of the same document legitimately differ
 *  on: who had already run (`computed`/`trace`) and the version a local
 *  build has no meaning for. */
function stable(frame: InspectionFrame): unknown {
  return {
    ...frame,
    version: 0,
    chain: frame.chain.map((n) => ({
      ...n,
      props: n.props.map(({ computed, trace, ...rest }) => rest),
    })),
  };
}

test("the chain is deepest-first, with kinds, ranges, chains, declared reads and values", () => {
  const state = localState(DOC);
  const frame = localInspectionFrame(state, { pos: NOTE_POS })!;
  expect(frame).not.toBeNull();
  expect(frame.pos).toBe(NOTE_POS);
  expect(frame.chain.map((n) => n.nodeName)).toEqual([
    "FretNote",
    "Sound",
    "Measure",
    "TabBlock",
    "Section",
    "TabDocument",
  ]);
  // Parenthood is the order: each node's ranges sit inside the next one's.
  expect(frame.chain[0].ranges).toEqual([{ from: NOTE_POS, to: NOTE_POS + 1 }]);
  for (let i = 0; i + 1 < frame.chain.length; i++) {
    const child = frame.chain[i].ranges[0];
    const parent = frame.chain[i + 1].ranges;
    expect(parent.some((r) => r.from <= child.from && child.to <= r.to)).toBe(true);
  }

  const noteSound = frame.chain[0].props.find((p) => p.id === "core-pitch/noteSound")!;
  expect(noteSound.evaluated).toBe(true);
  expect(noteSound.value).toMatchObject({ kind: "pitched", midi: 64 });
  expect(noteSound.chain).toEqual(["core-pitch (base)"]);
  // The declared-read graph is API: the local twin fills it from the same
  // effective union the host projects.
  expect(noteSound.deps).toContain("core-taxonomy/lineRoles");

  // Whole-document props are LISTED but deferred — a cursor move must not
  // pay for the exporters.
  const root = frame.chain[frame.chain.length - 1];
  expect(root.props.length).toBeGreaterThan(0);
  expect(root.props.every((p) => !p.evaluated)).toBe(true);
});

test("WARM ≡ COLD: an edited state and a fresh one answer the same frame", () => {
  // Warm: type the second system's `5` into a `7` and back, so the layer has
  // a real pass history and cached values at the inspected position.
  const at = DOC.lastIndexOf("--5") + 2;
  let warm = localState(DOC);
  warm = forceParsed(warm.update({ changes: { from: at, to: at + 1, insert: "7" } }).state);
  localInspectionFrame(warm, { pos: NOTE_POS }); // populate the cache
  warm = forceParsed(warm.update({ changes: { from: at, to: at + 1, insert: "5" } }).state);
  const warmFrame = localInspectionFrame(warm, { pos: NOTE_POS })!;

  const coldFrame = localInspectionFrame(localState(DOC), { pos: NOTE_POS })!;
  expect(stable(warmFrame)).toEqual(stable(coldFrame));
  // …and it is a real frame with real values, not two empty ones agreeing.
  expect(warmFrame.chain[0].props.length).toBeGreaterThan(0);
});

test("values are JSON, and every position in the document answers a frame", () => {
  const state = localState(DOC);
  let props = 0;
  for (let pos = 0; pos <= DOC.length; pos += 11) {
    const frame = localInspectionFrame(state, { pos, evaluateRoot: true, maxValueChars: 1000 })!;
    expect(JSON.parse(JSON.stringify(frame))).toEqual(frame);
    for (const node of frame.chain) {
      for (const p of node.props) {
        props++;
        expect(p.error).toBeUndefined();
        // No engine object reached a value: the projector's escape hatches
        // stayed unused across the whole document.
        expect(JSON.stringify(p.value ?? null)).not.toMatch(
          /\[circular\]|\[function\]|\[symbol\]|\[depth limit\]/
        );
      }
    }
  }
  expect(props).toBeGreaterThan(500);
});

test("deferred props compute on demand, and long values truncate honestly", () => {
  const state = localState(DOC);
  const chain = localInspectionFrame(state, { pos: NOTE_POS })!.chain;
  const rootIndex = chain.length - 1;
  const xmlProp = chain[rootIndex].props.find((p) => p.id.endsWith("/documentXml"))!;

  const one = localInspectionFrame(state, {
    pos: NOTE_POS,
    only: { nodeIndex: rootIndex, propIds: [xmlProp.id] },
  })!;
  expect(one.chain[rootIndex].props.filter((p) => p.evaluated)).toHaveLength(1);
  // `only` scopes to its node: nothing else in the chain evaluates.
  expect(one.chain[0].props.every((p) => !p.evaluated)).toBe(true);

  const all = localInspectionFrame(state, {
    pos: NOTE_POS,
    evaluateRoot: true,
    maxValueChars: 200,
  })!;
  const xml = all.chain[rootIndex].props.find((p) => p.id === xmlProp.id)!;
  expect(xml.valueTruncated).toBe(true);
  expect(xml.valueChars).toBeGreaterThan(1000);
  expect(String(xml.value)).toContain("score-partwise");
});

test("the cache is VISIBLE: a repeat read of the same node is served from it", () => {
  const state = localState(DOC);
  const computedIn = (f: InspectionFrame): number =>
    f.chain.reduce((n, node) => n + node.props.filter((p) => p.computed).length, 0);
  const first = localInspectionFrame(state, { pos: NOTE_POS })!;
  const again = localInspectionFrame(state, { pos: NOTE_POS })!;
  expect(computedIn(first)).toBeGreaterThan(0);
  expect(computedIn(again)).toBe(0);
  expect(stable(again)).toEqual(stable(first));
});

test("activity: addressable windows, an arithmetic that balances, a measured baseline", () => {
  // A FRESH layer: the state layer is module-level (v1), so earlier tests in
  // this file have already run passes through it — and activity is
  // pass-history dependent by nature. Re-installing gives this test the cold
  // boot its assertions are about, which is exactly why the frame
  // differential deliberately excludes ActivityFrame.
  configureTabHost({});
  const state = localState(DOC);
  // Read something first — the engine is pull-based, so a report before any
  // read is legitimately empty.
  localInspectionFrame(state, { pos: NOTE_POS });
  // THE COLD WINDOW IS THE UNADDRESSED ONE. An addressed `sincePass: 0`
  // clamps forward to the oldest RETAINED pass — which is the pass the cold
  // work happened in, so the window since it is empty. A first fetch must
  // therefore omit sincePass (consuming the shared cursor once) and address
  // every window after it; the app's fetcher does exactly that.
  expect(localActivityFrame(state, { sincePass: 0 })!.totalRecomputes).toBe(0);
  const cold = localActivityFrame(state, {})!;
  const runsIn = (f: typeof cold): number =>
    f.segments.reduce((n, s) => n + s.recomputes.reduce((m, r) => m + r.runs, 0), 0) +
    f.docRecomputes.reduce((n, r) => n + r.runs, 0) +
    f.unattributed;
  expect(cold.totalRecomputes).toBeGreaterThan(0);
  expect(runsIn(cold)).toBe(cold.totalRecomputes);
  expect(cold.segments.every((s) => s.reuse === "changed")).toBe(true);
  expect(cold.segments.flatMap((s) => s.recomputes).every((r) => r.reason === "cold")).toBe(true);
  expect(cold.savings.baselineProps).toBeGreaterThan(0);
  expect(cold.timings!.length).toBeGreaterThan(0);

  // Addressing does not consume: the same window answers the same way twice.
  const first = localActivityFrame(state, { sincePass: cold.passId })!;
  const again = localActivityFrame(state, { sincePass: cold.passId })!;
  expect(again.totalRecomputes).toBe(first.totalRecomputes);
  expect(again.sincePass).toBe(cold.passId);

  // After an edit, the untouched systems carry — and the frame says so.
  const at = DOC.lastIndexOf("--5") + 2;
  const edited = forceParsed(state.update({ changes: { from: at, to: at + 1, insert: "7" } }).state);
  localInspectionFrame(edited, { pos: NOTE_POS });
  const after = localActivityFrame(edited, { sincePass: cold.passId })!;
  expect(after.passId).toBeGreaterThan(cold.passId);
  expect(after.sincePass).toBe(cold.passId);
  expect(runsIn(after)).toBe(after.totalRecomputes);
  expect(after.totalRecomputes).toBeLessThan(cold.totalRecomputes);
  expect(after.segments.some((s) => s.reuse === "carried")).toBe(true);
});

// ─── The facade: same frames, both implementations ───────────────────────

/** A protocol-shaped session over the LOCAL producers — enough of the wire
 *  for a real RemoteClient to hello, sync and query. It is NOT a second
 *  engine (see the header); what it proves is that the frame survives the
 *  transport, that the client's flush-then-cite discipline lands, and that
 *  the two facade implementations agree in shape. */
class InspectionOracle {
  state: EditorState | null = null;
  version = 0;
  lastAtVersion: number | undefined = undefined;
  handle = (raw: unknown): ServerMessage[] => {
    const msg = parseClientMessage(raw);
    if (!msg) return [{ type: "resync", reason: "malformed" }];
    switch (msg.type) {
      case "hello": {
        this.state = localState(msg.docText);
        this.version = 0;
        return [
          { type: "helloOk", protocolVersion: PROTOCOL_VERSION, version: 0, epoch: msg.epoch },
          this.snapshot(),
        ];
      }
      case "updates": {
        if (!this.state) return [{ type: "resync", reason: "no document" }];
        let doc = this.state.doc;
        for (const change of msg.changes) {
          doc = ChangeSet.fromJSON(change).apply(doc);
          this.version++;
        }
        this.state = localState(doc.toString());
        return [{ type: "ack", version: this.version }, this.snapshot()];
      }
      case "verify":
        return docHash(this.state!.doc.toString()) === msg.hash
          ? []
          : [{ type: "resync", reason: "hash mismatch" }];
      case "query": {
        if (!this.state) return [{ type: "queryError", id: msg.id, message: "no document" }];
        const params = (msg.params ?? {}) as { pos?: number; atVersion?: number };
        if (msg.kind === "inspectNode") {
          this.lastAtVersion = params.atVersion;
          const frame = localInspectionFrame(this.state, { pos: params.pos ?? 0 })!;
          // The host answers at ITS version; the client cites the one it
          // flushed, so the two agree in the ordinary case.
          return [
            {
              type: "queryResult",
              id: msg.id,
              result: { ...frame, version: this.version },
            },
          ];
        }
        if (msg.kind === "computeActivity") {
          return [
            { type: "queryResult", id: msg.id, result: localActivityFrame(this.state, {})! },
          ];
        }
        return [{ type: "queryError", id: msg.id, message: `unknown kind "${msg.kind}"` }];
      }
      default:
        return [];
    }
  };
  private snapshot(): ServerMessage {
    return { type: "snapshot", version: this.version, payload: localSnapshotOf(this.state!)! };
  }
}

test("the facade answers frames in BOTH modes, and the remote one cites its version", async () => {
  const oracle = new InspectionOracle();
  const remote = createRemoteSemantics({
    transport: sessionTransport(oracle.handle),
    coalesceMs: 0,
  });
  const state = EditorState.create({
    doc: DOC,
    extensions: [tablature(), remoteSemantics()],
  });
  remote.client.start(state, () => {});

  const wireFrame = await remote.inspectNode(state, { pos: NOTE_POS });
  // The client FLUSHED and cited the version it flushed (client.ts's
  // deliberate choice: the frame's ranges are then in the coordinates on
  // screen, and a session that is behind for any other reason says so with
  // `approximate` instead of answering in stale ones).
  expect(oracle.lastAtVersion).toBe(0);
  expect(wireFrame.version).toBe(0);
  expect(wireFrame.chain.map((n) => n.nodeName)).toEqual([
    "FretNote",
    "Sound",
    "Measure",
    "TabBlock",
    "Section",
    "TabDocument",
  ]);

  // The same frame, in the engine-bundled configuration — one shape, two
  // producers, so app code never branches on mode.
  const local = createLocalSemantics();
  const localFrame = await local.inspectNode(localState(DOC), { pos: NOTE_POS });
  expect(stable(localFrame)).toEqual(stable(wireFrame));

  const activity = await remote.computeActivity(state, {});
  expect(activity.passId).toBeGreaterThan(0);
  expect(JSON.parse(JSON.stringify(activity))).toEqual(activity);

  // An edit moves the cited version with the document.
  const typed = state.update({ changes: { from: 0, to: 0, insert: "# note\n" } });
  remote.client.applyTransaction(typed);
  await remote.inspectNode(typed.state, { pos: NOTE_POS + 7 });
  expect(oracle.lastAtVersion).toBe(1);
});
