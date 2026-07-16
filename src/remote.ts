// ADR-003 M-R1 — the RemoteClient: the browser half of the wire. It owns
// the versioned overlay store and the §5.1 alignment law: every frame the
// server sends was computed at an explicit version; the client maps it
// through everything typed since (R2), then the StateField keeps it glued
// through further edits until the next frame replaces it wholesale (R4).
//
// Shape notes:
// - The client core is VIEW-FREE (start/applyTransaction/receive), so the
//   differential and chaos suites drive it headless against real
//   EditorStates; `extension` adds the thin EditorView glue.
// - Single writer (ADR-003 §5): version = changesets recorded since hello.
//   The client never rebases; anything suspect server-side answers resync,
//   and the client's answer to resync is a fresh hello with the full text.
// - I3 by construction: nothing here is awaited on the typing path — sends
//   are fire-and-forget, frames arrive as effect-only transactions.

import {
  ChangeSet,
  StateEffect,
  StateField,
  Text,
  type ChangeDesc,
  type EditorState,
  type Extension,
  type Transaction,
} from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type ServerMessage,
  type SnapshotPayload,
} from "@tab-edit/protocol";
import { snapshotSource, type SemanticSnapshot } from "./semantics.js";

// ─── Mapping (the R2/R5/R6 range algebra) ────────────────────────────────

/** Map one overlay range through a change: `from` maps AFTER insertions at
 *  its point and `to` BEFORE insertions at its point (R6 — typing at a
 *  boundary never grows the overlay); a range whose text was entirely
 *  deleted collapses and is dropped (R5). Zero-width ranges stay points. */
function mapRange<T extends { readonly from: number; readonly to: number }>(
  r: T,
  changes: ChangeDesc
): T | null {
  if (r.from === r.to) {
    const pos = changes.mapPos(r.from, 1);
    return { ...r, from: pos, to: pos };
  }
  const from = changes.mapPos(r.from, 1);
  const to = changes.mapPos(r.to, -1);
  if (to <= from) return null;
  return { ...r, from, to };
}

/** Map a whole snapshot through local changes — pure; used both by the
 *  field (keystroke-time gluing) and by the client (bringing an arriving
 *  frame from its computed version up to the present). */
export function mapSnapshot(snap: SemanticSnapshot, changes: ChangeDesc): SemanticSnapshot {
  const mapRanges = (
    entries: readonly { readonly ranges: readonly { from: number; to: number }[] }[]
  ) =>
    entries
      .map((e) => ({
        ranges: e.ranges
          .map((r) => mapRange(r, changes))
          .filter((r): r is { from: number; to: number } => r !== null),
      }))
      .filter((e) => e.ranges.length > 0);
  return {
    sounds: mapRanges(snap.sounds),
    measures: mapRanges(snap.measures),
    directives: snap.directives
      .map((d) => mapRange(d, changes))
      .filter((d): d is (typeof snap.directives)[number] => d !== null),
    recededLineStarts: [...new Set(snap.recededLineStarts.map((p) => changes.mapPos(p, -1)))].sort(
      (a, b) => a - b
    ),
    diagnostics: snap.diagnostics
      .map((d) => {
        const range = mapRange(d, changes);
        if (!range) return null;
        return d.fixes
          ? {
              ...range,
              fixes: d.fixes.map((f) => ({
                ...f,
                edits: f.edits.map((e) => ({
                  ...e,
                  from: changes.mapPos(e.from, 1),
                  to: changes.mapPos(e.to, -1),
                })),
              })),
            }
          : range;
      })
      .filter((d): d is (typeof snap.diagnostics)[number] => d !== null),
  };
}

// ─── The overlay store ───────────────────────────────────────────────────

/** Replaces the remote overlay store wholesale (R4 — all overlay kinds in a
 *  frame land atomically). Payloads arrive PRE-MAPPED to the dispatch-time
 *  document; dispatch frames as effect-only transactions. */
export const applyRemoteSnapshot = StateEffect.define<SemanticSnapshot>();

/** The wire-fed snapshot store: maps itself through every local edit
 *  (mapped-stale is EXACTLY right wherever carry holds — ADR-003 §5.1),
 *  replaced atomically when a frame arrives. */
export const remoteSnapshotField = StateField.define<SemanticSnapshot | null>({
  create: () => null,
  update(value, tr) {
    if (value && tr.docChanged) value = mapSnapshot(value, tr.changes);
    for (const e of tr.effects) if (e.is(applyRemoteSnapshot)) value = e.value;
    return value;
  },
});

/** The store + the snapshotOf override, view-free — headless tests install
 *  THIS and drive a RemoteClient by hand; `client.extension` bundles it
 *  with the EditorView glue for live editors. */
export function remoteSemantics(): Extension {
  return [
    remoteSnapshotField,
    snapshotSource.of((state: EditorState) => state.field(remoteSnapshotField)),
  ];
}

// ─── Transport ───────────────────────────────────────────────────────────

export interface RemoteTransport {
  send(msg: ClientMessage): void;
  onMessage(handler: (msg: ServerMessage) => void): void;
}

/** In-process loopback: wire the client straight at anything protocol-
 *  shaped — the remote-host Session, the test oracle. Every message
 *  JSON-round-trips, so nothing that couldn't cross a real wire can cross
 *  this one (I4 in executable form). */
export function sessionTransport(
  handle: (raw: unknown) => readonly unknown[]
): RemoteTransport {
  let deliver: (msg: ServerMessage) => void = () => {};
  return {
    send(msg) {
      for (const reply of handle(JSON.parse(JSON.stringify(msg)))) {
        deliver(JSON.parse(JSON.stringify(reply)) as ServerMessage);
      }
    },
    onMessage(handler) {
      deliver = handler;
    },
  };
}

export interface ChaosOptions {
  /** Seeded RNG (house style: mulberry32) — the caller owns the seed. */
  readonly rand: () => number;
  /** Probability a pumped message is dropped instead of delivered. */
  readonly dropRate?: number;
  /** Pump a RANDOM queued message instead of the oldest (reordering). */
  readonly reorder?: boolean;
}

export interface ChaosTransport extends RemoteTransport {
  /** Deliver (or drop) ONE queued message; no-op when queues are empty. */
  pump(): void;
  /** Deliver EVERYTHING queued, in order, losslessly — including messages
   *  generated while draining (the clean final exchange convergence needs). */
  drain(): void;
  readonly pending: number;
}

/** Seeded chaos over a loopback session: messages queue in both directions
 *  and move only when pumped — delayed, reordered, or dropped by schedule.
 *  I1/I3 must hold under EVERY schedule; drain() then models the network
 *  going quiet, after which convergence (I2/I5) must hold. */
export function chaosTransport(
  handle: (raw: unknown) => readonly unknown[],
  options: ChaosOptions
): ChaosTransport {
  const { rand, dropRate = 0, reorder = false } = options;
  let deliver: (msg: ServerMessage) => void = () => {};
  const up: ClientMessage[] = [];
  const down: ServerMessage[] = [];
  let lossless = false;
  const move = (drop: boolean): void => {
    const lane = up.length && down.length ? (rand() < 0.5 ? up : down) : up.length ? up : down;
    if (!lane.length) return;
    const index = reorder && !lossless ? Math.floor(rand() * lane.length) : 0;
    const [msg] = lane.splice(index, 1);
    if (drop) return;
    if (lane === up) {
      for (const reply of handle(JSON.parse(JSON.stringify(msg)))) {
        down.push(JSON.parse(JSON.stringify(reply)) as ServerMessage);
      }
    } else {
      deliver(msg as ServerMessage);
    }
  };
  return {
    send(msg) {
      up.push(JSON.parse(JSON.stringify(msg)) as ClientMessage);
    },
    onMessage(handler) {
      deliver = handler;
    },
    pump() {
      move(rand() < dropRate);
    },
    drain() {
      lossless = true;
      while (up.length || down.length) move(false);
      lossless = false;
    },
    get pending() {
      return up.length + down.length;
    },
  };
}

/** A real WebSocket wire (the dev server locally; the Durable Object shell
 *  in production). Messages sent before the socket opens are queued; after
 *  close they are dropped — overlays freeze-but-map (I3), typing and syntax
 *  highlighting never notice. */
export function webSocketTransport(url: string): RemoteTransport & { close(): void } {
  const ws = new WebSocket(url);
  const preOpen: ClientMessage[] = [];
  let deliver: (msg: ServerMessage) => void = () => {};
  ws.addEventListener("open", () => {
    for (const msg of preOpen.splice(0)) ws.send(JSON.stringify(msg));
  });
  ws.addEventListener("message", (event) => {
    deliver(JSON.parse(String(event.data)) as ServerMessage);
  });
  return {
    send(msg) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
      else if (ws.readyState === WebSocket.CONNECTING) preOpen.push(msg);
    },
    onMessage(handler) {
      deliver = handler;
    },
    close() {
      ws.close();
    },
  };
}

// ─── The client ──────────────────────────────────────────────────────────

export interface RemoteClientOptions {
  /** Upstream burst coalescing in ms (ADR-003 §4). 0 = every transaction
   *  sends immediately (tests, loopback). Default 15. */
  readonly coalesceMs?: number;
}

export type RemoteStatus = "connecting" | "live";

export class RemoteClient {
  private readonly transport: RemoteTransport;
  private readonly coalesceMs: number;
  private dispatch: ((effects: readonly StateEffect<SemanticSnapshot>[]) => void) | null = null;
  private doc: Text = Text.empty;
  /** Changesets recorded since hello; log[i] takes version logBase+i to
   *  logBase+i+1. Pruned below the newest applied snapshot version. */
  private log: ChangeSet[] = [];
  private logBase = 0;
  private version = 0;
  private sentVersion = 0;
  private appliedVersion = -1;
  /** Outstanding hellos. While > 0, downstream frames belong to a dead
   *  generation and resyncs answer pre-hello messages — both are ignored
   *  (the channel is ordered; chaos reordering only delays convergence). */
  private awaitingHello = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private queryId = 0;
  private readonly queries = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();

  constructor(transport: RemoteTransport, options: RemoteClientOptions = {}) {
    this.transport = transport;
    this.coalesceMs = options.coalesceMs ?? 15;
    transport.onMessage((msg) => this.receive(msg));
  }

  get status(): RemoteStatus {
    return this.dispatch && this.awaitingHello === 0 ? "live" : "connecting";
  }

  /** Local changesets the newest applied frame has not seen — 0 at
   *  quiescence; the UI's staleness affordance reads this. */
  get staleBy(): number {
    return this.appliedVersion < 0 ? this.version + 1 : this.version - this.appliedVersion;
  }

  /** The full live wiring: overlay store + snapshotOf override + EditorView
   *  glue (hello on create, updates upstream, frames dispatched as
   *  effect-only transactions outside the update cycle). */
  get extension(): Extension {
    const client = this;
    return [
      remoteSemantics(),
      ViewPlugin.define((view: EditorView) => {
        client.start(view.state, (effects) =>
          queueMicrotask(() => {
            try {
              view.dispatch({ effects });
            } catch {
              // view destroyed — the session outlived the editor; drop.
            }
          })
        );
        return {
          update(update) {
            for (const tr of update.transactions) client.applyTransaction(tr);
          },
        };
      }),
    ];
  }

  /** Boot the session on `state`'s document. Headless callers install
   *  remoteSemantics() themselves and pass an effect dispatcher that
   *  applies to THEIR current state. */
  start(
    state: EditorState,
    dispatch: (effects: readonly StateEffect<SemanticSnapshot>[]) => void
  ): void {
    this.dispatch = dispatch;
    this.doc = state.doc;
    this.hello();
  }

  /** Record a dispatched transaction (call for EVERY transaction; non-doc
   *  ones are free). Sending coalesces; the LOG is appended synchronously —
   *  mapping correctness depends on it. */
  applyTransaction(tr: Transaction): void {
    if (!tr.docChanged) return;
    this.doc = tr.newDoc;
    this.log.push(tr.changes);
    this.version++;
    if (this.coalesceMs === 0) this.flush();
    else if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => this.flush(), this.coalesceMs);
    }
  }

  /** Push everything recorded-but-unsent upstream as ONE updates message
   *  (the server composes the batch and evaluates the latest doc only). */
  flush(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.sentVersion === this.version) return;
    this.transport.send({
      type: "updates",
      fromVersion: this.sentVersion,
      changes: this.log.slice(this.sentVersion - this.logBase).map((c) => c.toJSON()),
    });
    this.sentVersion = this.version;
  }

  /** Request/response over the wire (musicXml, midiFile, …). Never used on
   *  the typing path; results are computed at ≥ the version you were
   *  looking at (R3). */
  query(kind: string, params?: unknown): Promise<unknown> {
    const id = ++this.queryId;
    return new Promise((resolve, reject) => {
      this.queries.set(id, { resolve, reject });
      this.transport.send({
        type: "query",
        id,
        kind,
        ...(params !== undefined ? { params } : {}),
      });
    });
  }

  /** The universal recovery move (I5): full text, version numbering
   *  restarts at 0. Everything in flight from the old generation is dead. */
  private hello(): void {
    this.log = [];
    this.logBase = 0;
    this.version = 0;
    this.sentVersion = 0;
    this.appliedVersion = -1;
    this.awaitingHello++;
    this.transport.send({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      docText: this.doc.toString(),
    });
  }

  private receive(msg: ServerMessage): void {
    switch (msg.type) {
      case "helloOk":
        if (this.awaitingHello > 0) this.awaitingHello--;
        return;
      case "ack":
        return; // liveness only in v1 — pruning happens on snapshot apply
      case "snapshot":
        this.applyFrame(msg.version, msg.payload);
        return;
      case "queryResult": {
        const pending = this.queries.get(msg.id);
        this.queries.delete(msg.id);
        pending?.resolve(msg.result);
        return;
      }
      case "queryError": {
        const pending = this.queries.get(msg.id);
        this.queries.delete(msg.id);
        pending?.reject(new Error(msg.message));
        return;
      }
      case "resync":
        // While a hello is outstanding this resync answers a message from
        // before it (ordered channel) — the hello already supersedes it.
        if (this.awaitingHello === 0) this.hello();
        return;
    }
  }

  private applyFrame(version: number, payload: SnapshotPayload): void {
    if (this.awaitingHello > 0) return; // dead generation
    if (version < this.appliedVersion) return; // I1 — never regress
    if (version < this.logBase || version > this.version) return; // unknowable
    const tail = this.log.slice(version - this.logBase);
    // The payload mirrors SemanticSnapshot by the three-way lockstep
    // contract (protocol ≡ host snapshot ≡ local producers).
    let snapshot = payload as unknown as SemanticSnapshot;
    if (tail.length > 0) {
      snapshot = mapSnapshot(
        snapshot,
        tail.reduce((all, c) => all.compose(c))
      );
    }
    this.appliedVersion = version;
    if (version > this.logBase) {
      this.log.splice(0, version - this.logBase);
      this.logBase = version;
    }
    this.dispatch?.([applyRemoteSnapshot.of(snapshot)]);
  }
}
