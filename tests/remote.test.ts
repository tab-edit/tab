// ADR-003 M-R1 — the RemoteClient contract, headless. The server here is an
// ORACLE: a protocol-shaped session running THIS repo's local engine
// (computeSnapshot over an EditorState). By the three-way lockstep contract
// (host buildSnapshot ≡ local producers ≡ protocol payload) it is
// behaviorally the remote-host Session — so every client property (version
// discipline, R2/R5/R6 mapping, I1 monotonicity, resync recovery, chaos
// convergence) is provable in-repo with a fast dev loop. The REAL-Session
// differential lives in the remote repo (host/tests), enforcing lockstep
// itself.
import { ensureSyntaxTree } from "@codemirror/language";
import { ChangeSet, EditorState, type StateEffect } from "@codemirror/state";
import {
  parseClientMessage,
  PROTOCOL_VERSION,
  type ServerMessage,
} from "@tab-edit/protocol";
import {
  chaosTransport,
  localSnapshotOf,
  mapSnapshot,
  RemoteClient,
  remoteSemantics,
  sessionTransport,
  snapshotOf,
  tabDiagnostics,
  tablature,
  musicXml,
  type RemoteTransport,
  type SemanticSnapshot,
} from "../src/index.js";

const WIDE = "-".repeat(48);
const SYSTEM = [
  `e|--0--2--${WIDE}|`,
  `B|--0-----${WIDE}|`,
  `G|--------${WIDE}|`,
  `D|--------${WIDE}|`,
  `A|--------${WIDE}|`,
  `E|3-------${WIDE}|`,
].join("\n");
// One line UNNAMED → a lineName diagnostic WITH a fix crosses the wire.
const LINTY_SYSTEM = [
  `e|--0--2--${WIDE}|`,
  `B|--0-----${WIDE}|`,
  `G|--------${WIDE}|`,
  `D|--------${WIDE}|`,
  `A|--------${WIDE}|`,
  ` |3-------${WIDE}|`,
].join("\n");
const DOC = [
  "Tempo: 120",
  "",
  SYSTEM,
  "",
  "A lovely little melody for the remote suite.",
  "",
  LINTY_SYSTEM,
  "",
  "# closing comment",
  "",
].join("\n");

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Force-parsed local state — the differential's ground truth. */
function localState(doc: string): EditorState {
  const state = EditorState.create({ doc, extensions: [tablature()] });
  expect(ensureSyntaxTree(state, doc.length, 10_000)).not.toBeNull();
  return state;
}

function localTruth(doc: string): SemanticSnapshot {
  const snap = localSnapshotOf(localState(doc));
  expect(snap).not.toBeNull();
  // Through the same JSON the wire applies (drops undefined-valued keys).
  return JSON.parse(JSON.stringify(snap)) as SemanticSnapshot;
}

/** The oracle: the protocol spoken by the LOCAL engine. Mirrors the
 *  remote-host Session's discipline — version counting, resync on any
 *  doubt — so client recovery paths are exercised for real. */
class OracleSession {
  state: EditorState | null = null;
  version = 0;
  handle = (raw: unknown): ServerMessage[] => {
    const msg = parseClientMessage(raw);
    if (!msg) return [{ type: "resync", reason: "malformed" }];
    switch (msg.type) {
      case "hello": {
        if (msg.protocolVersion !== PROTOCOL_VERSION) {
          return [{ type: "resync", reason: "protocol" }];
        }
        this.state = localState(msg.docText);
        this.version = 0;
        return [
          { type: "helloOk", protocolVersion: PROTOCOL_VERSION, version: 0 },
          this.snapshot(),
        ];
      }
      case "updates": {
        if (!this.state) return [{ type: "resync", reason: "no document" }];
        if (msg.fromVersion !== this.version) {
          return [{ type: "resync", reason: "version gap" }];
        }
        for (const change of msg.changes) {
          let set: ChangeSet;
          try {
            set = ChangeSet.fromJSON(change);
          } catch {
            return [{ type: "resync", reason: "bad changeset" }];
          }
          if (set.length !== this.state.doc.length) {
            return [{ type: "resync", reason: "length mismatch" }];
          }
          this.state = this.state.update({ changes: set }).state;
          this.version++;
        }
        expect(
          ensureSyntaxTree(this.state, this.state.doc.length, 10_000)
        ).not.toBeNull();
        return [{ type: "ack", version: this.version }, this.snapshot()];
      }
      case "query": {
        if (!this.state) return [{ type: "queryError", id: msg.id, message: "no document" }];
        if (msg.kind === "musicXml") {
          return [{ type: "queryResult", id: msg.id, result: musicXml(this.state) }];
        }
        return [{ type: "queryError", id: msg.id, message: `unknown kind "${msg.kind}"` }];
      }
    }
  };

  private snapshot(): ServerMessage {
    const payload = localSnapshotOf(this.state!);
    expect(payload).not.toBeNull();
    return { type: "snapshot", version: this.version, payload: payload! };
  }
}

/** Headless remote editor: real EditorState + remoteSemantics() store, the
 *  client driven by hand exactly the way the view glue drives it. */
function remoteEditor(doc: string, transport: RemoteTransport, coalesceMs = 0) {
  const editor = {
    state: EditorState.create({ doc, extensions: [tablature(), remoteSemantics()] }),
    client: new RemoteClient(transport, { coalesceMs }),
    edit(spec: { from: number; to?: number; insert?: string }) {
      const tr = this.state.update({ changes: spec });
      this.state = tr.state;
      this.client.applyTransaction(tr);
    },
  };
  editor.client.start(editor.state, (effects) => {
    editor.state = editor.state.update({
      effects: effects as readonly StateEffect<unknown>[],
    }).state;
  });
  return editor;
}

test("boot: hello fills the overlay store — remote ≡ local at rest (I2)", () => {
  const oracle = new OracleSession();
  const ed = remoteEditor(DOC, sessionTransport(oracle.handle));
  expect(ed.client.status).toBe("live");
  expect(ed.client.staleBy).toBe(0);
  const remote = snapshotOf(ed.state);
  expect(remote).not.toBeNull();
  expect(remote).toEqual(localTruth(DOC));
  // The rendered surfaces serve wire data: lint sees the unnamed-line
  // diagnostic including its FIX action.
  const lint = tabDiagnostics(ed.state);
  expect(lint.length).toBeGreaterThan(0);
  expect(lint.some((d) => d.actions && d.actions.length > 0)).toBe(true);
});

test("loopback differential: seeded edit storm, remote ≡ local at every step (I2)", () => {
  const seed = 20260716;
  const rand = mulberry32(seed);
  const oracle = new OracleSession();
  const ed = remoteEditor(DOC, sessionTransport(oracle.handle));
  const glyphs = ["7", "-", "|", "h", "3", " ", "\n"];
  for (let step = 0; step < 25; step++) {
    const insertNotDelete = rand() < 0.6 || ed.state.doc.length < 40;
    const from = Math.floor(rand() * ed.state.doc.length);
    ed.edit(
      insertNotDelete
        ? { from, insert: glyphs[Math.floor(rand() * glyphs.length)] }
        : { from, to: Math.min(from + 1 + Math.floor(rand() * 3), ed.state.doc.length) }
    );
    const remote = snapshotOf(ed.state);
    const local = localTruth(ed.state.doc.toString());
    if (JSON.stringify(remote) !== JSON.stringify(local)) {
      throw new Error(`divergence at seed=${seed} step=${step}`);
    }
  }
  expect(ed.client.staleBy).toBe(0);
});

test("coalescing: burst of edits → ONE updates message, still convergent", () => {
  const oracle = new OracleSession();
  const inner = sessionTransport(oracle.handle);
  const sent: string[] = [];
  const spy: RemoteTransport = {
    send: (msg) => {
      sent.push(msg.type);
      inner.send(msg);
    },
    onMessage: (h) => inner.onMessage(h),
  };
  const ed = remoteEditor(DOC, spy, 60_000); // huge window: manual flush only
  ed.edit({ from: 3, insert: "9" });
  ed.edit({ from: 10, insert: "-" });
  ed.edit({ from: 0, insert: "x" });
  expect(sent).toEqual(["hello"]); // nothing sent yet — coalescing
  ed.client.flush();
  expect(sent).toEqual(["hello", "updates"]);
  expect(oracle.version).toBe(3); // batch carried all three changesets
  expect(snapshotOf(ed.state)).toEqual(localTruth(ed.state.doc.toString()));
});

test("R6 boundary law (pure): typing at an overlay's edges never grows it", () => {
  const base: SemanticSnapshot = {
    sounds: [{ ranges: [{ from: 5, to: 8 }] }],
    measures: [],
    directives: [],
    recededLineStarts: [],
    diagnostics: [],
  };
  const insertAt = (pos: number) =>
    mapSnapshot(base, ChangeSet.of({ from: pos, insert: "x" }, 20)).sounds[0].ranges[0];
  // Insertion at the start pushes the range right; at the end leaves it.
  expect(insertAt(5)).toEqual({ from: 6, to: 9 });
  expect(insertAt(8)).toEqual({ from: 5, to: 8 });
  // R5: deleting the whole overlaid region drops the entry.
  const gone = mapSnapshot(base, ChangeSet.of({ from: 4, to: 9 }, 20));
  expect(gone.sounds).toEqual([]);
});

test("stale window (R2): overlays glue through local edits, frame replaces (§5.1)", () => {
  const oracle = new OracleSession();
  const chaos = chaosTransport(oracle.handle, { rand: mulberry32(7) });
  const ed = remoteEditor(DOC, chaos);
  chaos.drain(); // deliver hello + first frame
  expect(ed.client.status).toBe("live");
  const before = snapshotOf(ed.state)!;
  // Type a new line between the directive and the first system — the wire
  // stays SILENT (nothing pumped): every overlay must shift by the insert.
  const insertAt = DOC.indexOf("\n") + 1;
  const inserted = "x\n";
  ed.edit({ from: insertAt, insert: inserted });
  const mapped = snapshotOf(ed.state)!;
  expect(ed.client.staleBy).toBeGreaterThan(0);
  expect(mapped.sounds).toEqual(
    before.sounds.map((s) => ({
      ranges: s.ranges.map((r) => ({
        from: r.from + inserted.length,
        to: r.to + inserted.length,
      })),
    }))
  );
  // The frame for the edit arrives → wholesale replace (R4), ≡ local.
  chaos.drain();
  expect(ed.client.staleBy).toBe(0);
  expect(snapshotOf(ed.state)).toEqual(localTruth(ed.state.doc.toString()));
});

test("resync recovery (I5): a dropped updates message heals via fresh hello", () => {
  const oracle = new OracleSession();
  const inner = sessionTransport(oracle.handle);
  let dropNextUpdates = true;
  let hellos = 0;
  const lossy: RemoteTransport = {
    send: (msg) => {
      if (msg.type === "hello") hellos++;
      if (msg.type === "updates" && dropNextUpdates) {
        dropNextUpdates = false;
        return; // vanished on the wire
      }
      inner.send(msg);
    },
    onMessage: (h) => inner.onMessage(h),
  };
  const ed = remoteEditor(DOC, lossy);
  ed.edit({ from: 3, insert: "9" }); // dropped — server never sees v0→v1
  ed.edit({ from: 10, insert: "-" }); // server sees fromVersion 1, has 0 → resync
  expect(hellos).toBe(2); // the universal recovery move ran
  expect(ed.client.status).toBe("live");
  expect(snapshotOf(ed.state)).toEqual(localTruth(ed.state.doc.toString()));
});

test("chaos storm: delay + reorder + drop — typing never breaks, quiet converges", () => {
  for (const seed of [1, 20260716]) {
    const rand = mulberry32(seed);
    const oracle = new OracleSession();
    const chaos = chaosTransport(oracle.handle, { rand, dropRate: 0.15, reorder: true });
    const ed = remoteEditor(DOC, chaos);
    const glyphs = ["7", "-", "|", "h", "3", " "];
    for (let step = 0; step < 30; step++) {
      const insertNotDelete = rand() < 0.6 || ed.state.doc.length < 40;
      const from = Math.floor(rand() * ed.state.doc.length);
      ed.edit(
        insertNotDelete
          ? { from, insert: glyphs[Math.floor(rand() * glyphs.length)] }
          : { from, to: Math.min(from + 1 + Math.floor(rand() * 3), ed.state.doc.length) }
      );
      const pumps = Math.floor(rand() * 4);
      for (let i = 0; i < pumps; i++) chaos.pump();
      // I3/I1 under EVERY schedule: the rendered store never goes out of
      // bounds and never throws — mapped-stale is geometrically sound.
      const snap = snapshotOf(ed.state);
      if (snap) {
        for (const entry of [...snap.sounds, ...snap.measures]) {
          for (const r of entry.ranges) {
            expect(r.from).toBeGreaterThanOrEqual(0);
            expect(r.to).toBeLessThanOrEqual(ed.state.doc.length);
          }
        }
      }
    }
    // The network goes quiet: everything queued delivers (resync cascades
    // included) → the storm's damage heals completely (I2 + I5).
    chaos.drain();
    expect(chaos.pending).toBe(0);
    expect(ed.client.staleBy).toBe(0);
    const remote = snapshotOf(ed.state);
    const local = localTruth(ed.state.doc.toString());
    if (JSON.stringify(remote) !== JSON.stringify(local)) {
      throw new Error(`chaos divergence at seed=${seed}`);
    }
  }
});

test("queries resolve over the wire (R3: never stale)", async () => {
  const oracle = new OracleSession();
  const ed = remoteEditor(DOC, sessionTransport(oracle.handle));
  const xml = (await ed.client.query("musicXml")) as string;
  expect(xml).toContain("<score-partwise");
  await expect(ed.client.query("nope")).rejects.toThrow('unknown kind "nope"');
});
