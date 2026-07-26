// THE INSPECTOR'S VIEW MODEL — pure functions from the two wire frames
// (InspectionFrame / ActivityFrame) to the rows, chips, pairs and headline
// figures a pane renders. No DOM, no engine, no transport: the app renders
// what this produces, and tests/inspector-model.test.ts drives it with
// constructed frames — including the cases real data cannot produce yet
// (an `internal` prop, a frame whose producer has no clock).
//
// It lives in src/ rather than app/ for two reasons: the panes must behave
// identically in engine-bundled and wire-fed builds (one model, two frame
// producers), and derivations this load-bearing — "what recomputed", "which
// claim won", "what may I depend on" — deserve unit tests rather than
// Playwright archaeology.
//
// ENGINE-FREE by construction: it imports frame TYPES only, so it belongs
// to the audited /client surface.

import type {
  ActivityFrame,
  InspectionFrame,
  PropInspectionJSON,
  PropTimingJSON,
  RecomputeReason,
} from "@tab-edit/protocol";

/** "pluginId/propName" → the two parts, split on the FIRST slash only:
 *  pluginId never contains one, a prop name might. */
export function splitPropId(id: string): { pack: string; name: string } {
  const i = id.indexOf("/");
  return i === -1 ? { pack: "?", name: id } : { pack: id.slice(0, i), name: id.slice(i + 1) };
}

/** What happened to this prop, in the vocabulary a plugin author debugs in.
 *  - `deferred` — listed but not evaluated (whole-document props cost more
 *    than a cursor move is worth; ask for them by name);
 *  - `cold` — it ran, on a pass with nothing to carry from;
 *  - `recomputed` — this read ran compute;
 *  - `carried` — served from cache: reading it did no work at all. */
export type PropState = "deferred" | "cold" | "recomputed" | "carried";

/** The wire's own closed vocabulary. ABSENT reads as `experimental`, which
 *  is what the projector resolves it to as well — so an old host and a new
 *  client cannot disagree, and the disagreement they cannot have would have
 *  been in the over-promising direction. */
export type PropStability = "stable" | "experimental";

export interface PropRow {
  readonly id: string;
  readonly pack: string;
  readonly name: string;
  /** Index in the frame's chain (0 = deepest node at the position). */
  readonly nodeIndex: number;
  readonly nodeName: string;
  readonly ranges: readonly { readonly from: number; readonly to: number }[];
  /** Declared chain, outermost first — who COULD shape the value. */
  readonly chain: readonly string[];
  /** Declared reads: the outgoing edges of the dependency graph. */
  readonly deps: readonly string[];
  /** Props IN THIS FRAME that name this one in their deps — the incoming
   *  edges, so the graph can be walked in both directions. */
  readonly dependents: readonly string[];
  readonly evaluated: boolean;
  readonly computed: boolean;
  /** Not readable by other plugins: the row shows position, cost and cache
   *  status, and WITHHOLDS the value (`value` is undefined here even if the
   *  frame carried one). */
  readonly internal: boolean;
  readonly stability: PropStability;
  readonly value?: unknown;
  readonly valueTruncated: boolean;
  readonly valueChars?: number;
  readonly error?: string;
  readonly state: PropState;
  /** From the activity window, when one has been fetched: runs and cost. */
  readonly runs: number;
  readonly selfMs: number;
  readonly maxSelfMs: number;
  readonly reason?: RecomputeReason;
  /** Did this prop run at all in the activity window? (The COST lens's
   *  "what moved" filter, and the honest answer to "why did this rerun?"
   *  when walked through `deps`.) */
  readonly ranInWindow: boolean;
}

export interface ActivityIndex {
  readonly runsByProp: ReadonlyMap<string, { readonly runs: number; readonly reason: RecomputeReason }>;
  readonly timingByProp: ReadonlyMap<string, PropTimingJSON>;
  /** Every prop id that ran in the window (segment- and doc-attributed). */
  readonly changed: ReadonlySet<string>;
  readonly hasTimings: boolean;
}

const EMPTY_ACTIVITY: ActivityIndex = {
  runsByProp: new Map(),
  timingByProp: new Map(),
  changed: new Set(),
  hasTimings: false,
};

/** Fold an activity frame into per-prop lookups (runs are attributed per
 *  segment; a prop that ran in three segments ran three times). */
export function indexActivity(frame?: ActivityFrame | null): ActivityIndex {
  if (!frame) return EMPTY_ACTIVITY;
  const runsByProp = new Map<string, { runs: number; reason: RecomputeReason }>();
  const add = (propId: string, runs: number, reason: RecomputeReason): void => {
    const prev = runsByProp.get(propId);
    // First reason wins per prop — reasons are taxonomy-level, and a prop
    // that ran for two causes is not more informative for being relabelled.
    runsByProp.set(propId, { runs: (prev?.runs ?? 0) + runs, reason: prev?.reason ?? reason });
  };
  for (const segment of frame.segments) {
    for (const r of segment.recomputes) add(r.propId, r.runs, r.reason);
  }
  for (const r of frame.docRecomputes) add(r.propId, r.runs, r.reason);
  const timingByProp = new Map<string, PropTimingJSON>();
  for (const t of frame.timings ?? []) timingByProp.set(t.propId, t);
  return {
    runsByProp,
    timingByProp,
    changed: new Set(runsByProp.keys()),
    hasTimings: (frame.timings?.length ?? 0) > 0,
  };
}

/** The axes as an OLDER host might omit them: absence is not an error, it
 *  is the under-promising default (see PropStability). */
interface ExposureFields {
  readonly stability?: string;
  readonly internal?: boolean;
}

function stabilityOf(prop: PropInspectionJSON): PropStability {
  return (prop as PropInspectionJSON & ExposureFields).stability === "stable"
    ? "stable"
    : "experimental";
}

function stateOf(prop: PropInspectionJSON, reason?: RecomputeReason): PropState {
  if (!prop.evaluated) return "deferred";
  if (reason === "cold") return "cold";
  return prop.computed ? "recomputed" : "carried";
}

/** One row per prop per chain node, deepest node first (frame order). */
export function buildRows(
  frame: InspectionFrame | null,
  activity: ActivityIndex = EMPTY_ACTIVITY
): PropRow[] {
  if (!frame) return [];
  // Incoming dependency edges, within what this frame can see.
  const dependents = new Map<string, Set<string>>();
  for (const node of frame.chain) {
    for (const prop of node.props) {
      for (const dep of prop.deps) {
        let set = dependents.get(dep);
        if (!set) dependents.set(dep, (set = new Set()));
        set.add(prop.id);
      }
    }
  }
  const rows: PropRow[] = [];
  frame.chain.forEach((node, nodeIndex) => {
    for (const prop of node.props) {
      const internal = (prop as PropInspectionJSON & ExposureFields).internal === true;
      const runs = activity.runsByProp.get(prop.id);
      const timing = activity.timingByProp.get(prop.id);
      rows.push({
        id: prop.id,
        ...splitPropId(prop.id),
        nodeIndex,
        nodeName: node.nodeName,
        ranges: node.ranges,
        chain: prop.chain,
        deps: prop.deps,
        dependents: [...(dependents.get(prop.id) ?? [])].sort(),
        evaluated: prop.evaluated,
        computed: prop.computed,
        internal,
        stability: stabilityOf(prop),
        // Internal props are placed in the graph with their cost and cache
        // status; the VALUE is withheld (cross-plugin reads are refused, so
        // showing it would teach a dependency nobody may take).
        ...(internal ? {} : { value: prop.value }),
        valueTruncated: !internal && prop.valueTruncated === true,
        ...(internal ? {} : prop.valueChars !== undefined ? { valueChars: prop.valueChars } : {}),
        ...(prop.error !== undefined ? { error: prop.error } : {}),
        state: stateOf(prop, runs?.reason),
        runs: runs?.runs ?? 0,
        selfMs: timing?.selfMs ?? 0,
        maxSelfMs: timing?.maxSelfMs ?? 0,
        ...(runs ? { reason: runs.reason } : {}),
        ranInWindow: runs !== undefined,
      });
    }
  });
  return rows;
}

export interface PackChip {
  readonly pack: string;
  readonly count: number;
}

/** Pack chips with counts, in FIRST-APPEARANCE order (deepest node first) —
 *  the order teaches the tree: the packs that spoke about the note come
 *  before the ones that spoke about the document. */
export function packChips(rows: readonly PropRow[]): PackChip[] {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.pack, (counts.get(row.pack) ?? 0) + 1);
  return [...counts].map(([pack, count]) => ({ pack, count }));
}

export interface StateChip {
  readonly state: PropState;
  readonly count: number;
}

/** Outcome chips — "show me only what recomputed on this keystroke" is one
 *  click, which is the actual debugging question. */
export function stateChips(rows: readonly PropRow[]): StateChip[] {
  const order: PropState[] = ["recomputed", "cold", "carried", "deferred"];
  const counts = new Map<PropState, number>();
  for (const row of rows) counts.set(row.state, (counts.get(row.state) ?? 0) + 1);
  return order.filter((s) => counts.has(s)).map((state) => ({ state, count: counts.get(state)! }));
}

export interface RowFilters {
  /** Packs are a SET: wanting two at once is meaningful, so the filter is a
   *  list and the UI that drives it is multi-select. Empty = every pack. */
  readonly packs?: readonly string[];
  readonly text?: string;
  /** Outcome is a PARTITION — a prop is exactly one of carried / recomputed
   *  / cold / deferred — so the filter is at most one value and the UI that
   *  drives it is single-select. Empty = every outcome. */
  readonly states?: readonly PropState[];
  readonly stability?: readonly PropStability[];
  /** Only props that ran in the current activity window. */
  readonly changedOnly?: boolean;
}

export function filterRows(rows: readonly PropRow[], filters: RowFilters): PropRow[] {
  const text = (filters.text ?? "").trim().toLowerCase();
  const states = filters.states && filters.states.length > 0 ? new Set(filters.states) : null;
  const stability =
    filters.stability && filters.stability.length > 0 ? new Set(filters.stability) : null;
  const packs = filters.packs && filters.packs.length > 0 ? new Set(filters.packs) : null;
  return rows.filter((row) => {
    if (packs && !packs.has(row.pack)) return false;
    if (states && !states.has(row.state)) return false;
    if (stability && !stability.has(row.stability)) return false;
    if (filters.changedOnly && !row.ranInWindow) return false;
    // Prop ID only — matching the node kind too would make "note" select
    // every prop on a FretNote, which reads as a bug the first time you use
    // it. The chain node is a chip, not a search term.
    if (text && !row.id.toLowerCase().includes(text)) return false;
    return true;
  });
}

export type RowOrder = "cost" | "pack" | "name";

export interface OrderedRows {
  readonly rows: readonly PropRow[];
  /** The requested order was `cost` but nothing has cost data yet (no
   *  activity window fetched, or a producer with no clock) — the pane must
   *  say so rather than pretend the list is cost-sorted. */
  readonly costFellBack: boolean;
}

/** COST-FIRST by default: `selfMs` is already summed over the window's runs,
 *  so ordering by it combines frequency and cost in one number; runs break
 *  ties so a hot-but-cheap prop still outranks a cold one. */
export function orderRows(rows: readonly PropRow[], order: RowOrder): OrderedRows {
  const sorted = [...rows];
  if (order === "cost") {
    const hasCost = sorted.some((r) => r.selfMs > 0 || r.runs > 0);
    if (!hasCost) return { rows: byPack(sorted), costFellBack: true };
    sorted.sort(
      (a, b) => b.selfMs - a.selfMs || b.runs - a.runs || a.id.localeCompare(b.id)
    );
    return { rows: sorted, costFellBack: false };
  }
  if (order === "name") {
    sorted.sort((a, b) => a.name.localeCompare(b.name) || a.nodeIndex - b.nodeIndex);
    return { rows: sorted, costFellBack: false };
  }
  return { rows: byPack(sorted), costFellBack: false };
}

/** Pack order = first appearance; within a pack, chain order (deepest node
 *  first, install order after that) is already what the frame gives. */
function byPack(rows: readonly PropRow[]): PropRow[] {
  const packs = new Map<string, number>();
  for (const row of rows) if (!packs.has(row.pack)) packs.set(row.pack, packs.size);
  return [...rows].sort(
    (a, b) => (packs.get(a.pack)! - packs.get(b.pack)!) || a.nodeIndex - b.nodeIndex
  );
}

// ─── Claims: the negotiation, with its winner ────────────────────────────

export interface ClaimPair {
  /** The bid(s): who claimed what, at what confidence. */
  readonly claim: PropRow;
  /** The resolved value the engine kept — absent when the outcome prop is
   *  not evaluated at this node (or belongs to another pack). */
  readonly outcome?: PropRow;
}

/** `blockKindClaim → blockKind`, `lineRoleClaims → lineRoles`: strip the
 *  suffix, and a PLURAL claim resolves to a plural outcome (the claims are
 *  per line, the outcome is the map of them). Same pack, same node — a
 *  claim resolved somewhere else is a different negotiation. */
export function outcomeNameFor(claimName: string): string | null {
  if (claimName.endsWith("Claims")) return `${claimName.slice(0, -"Claims".length)}s`;
  if (claimName.endsWith("Claim")) return claimName.slice(0, -"Claim".length);
  return null;
}

/** Every claim prop in the frame, paired with the value that won. This is
 *  the one place the architecture is visible as a NEGOTIATION rather than a
 *  list of values — a pack author cannot coexist with the base packs
 *  without seeing it. */
export function claimPairs(rows: readonly PropRow[]): ClaimPair[] {
  const byKey = new Map<string, PropRow>();
  for (const row of rows) byKey.set(`${row.nodeIndex} ${row.id}`, row);
  const pairs: ClaimPair[] = [];
  for (const row of rows) {
    const outcomeName = outcomeNameFor(row.name);
    if (outcomeName === null) continue;
    const outcome = byKey.get(`${row.nodeIndex} ${row.pack}/${outcomeName}`);
    pairs.push(outcome ? { claim: row, outcome } : { claim: row });
  }
  return pairs;
}

// ─── The savings counter: the demonstration, honestly bounded ────────────

export interface SavingsLine {
  /** "16 of 79 recomputed · 63 carried · 0.26 ms" */
  readonly headline: string;
  /** Is the carry figure attributable to this window? */
  readonly attributed: boolean;
  /** Why not, when it isn't — rendered next to the headline, never instead
   *  of it. */
  readonly note?: string;
}

const ms = (n: number): string => `${n.toFixed(2)} ms`;

export function savingsLine(frame?: ActivityFrame | null): SavingsLine {
  if (!frame) return { headline: "—", attributed: false, note: "no window yet" };
  const s = frame.savings;
  if (s.baselineProps === 0) {
    return {
      headline: `${s.recomputedProps} recomputed · ${ms(s.elapsedMs)}`,
      attributed: false,
      note: "cold baseline not measured",
    };
  }
  if (s.recomputedProps > s.baselineProps) {
    // A window can span many edits, or include the inspector's own reads —
    // more work than one cold boot, so "carried" would be a lie (the frame
    // floors it at 0). Report what happened and say why it isn't a saving.
    return {
      headline: `${s.recomputedProps} recomputed · ${ms(s.elapsedMs)}`,
      attributed: false,
      note: `window exceeds the ${s.baselineProps}-run cold baseline`,
    };
  }
  return {
    headline: `${s.recomputedProps} of ${s.baselineProps} recomputed · ${s.carriedProps} carried · ${ms(s.elapsedMs)}`,
    attributed: true,
  };
}

// ─── WHY a prop ran: the causal view, honestly labelled ──────────────────

export interface CauseEdge {
  readonly propId: string;
  readonly runs: number;
  readonly selfMs: number;
  readonly reason?: RecomputeReason;
}

export interface CauseView {
  /** How the upstream set was obtained.
   *
   *  `correlated` — the declared reads that ALSO ran in this window. It is
   *  an intersection of outcome data, not a recorded cause: the engine keeps
   *  recompute records, not a per-read causal trace, and `RecomputeReason`
   *  itself is derived the same way. Say so in the UI: a false causal claim
   *  in a debugger is worse than a hedged true one.
   *
   *  Reserved: `recorded`, for when the engine can name the read that
   *  actually triggered the run. The shape is deliberately identical so the
   *  same display upgrades in place — only the label changes. */
  readonly kind: "correlated";
  readonly reason?: RecomputeReason;
  /** Declared reads of this prop that also ran in the window. */
  readonly upstream: readonly CauseEdge[];
  /** Props (visible in this frame) that read this one and also ran — the
   *  other direction of the same walk: what MY recompute cost downstream. */
  readonly downstream: readonly CauseEdge[];
}

/** The chain a plugin author walks to answer "why did my prop rerun?" —
 *  upstream to the declared read that moved, downstream to what moved
 *  because of it. Both directions are navigable because both are edges of
 *  the public declared-read graph. */
export function causeOf(row: PropRow, activity: ActivityIndex): CauseView {
  const edge = (propId: string): CauseEdge | null => {
    const runs = activity.runsByProp.get(propId);
    if (!runs) return null;
    return {
      propId,
      runs: runs.runs,
      selfMs: activity.timingByProp.get(propId)?.selfMs ?? 0,
      reason: runs.reason,
    };
  };
  const collect = (ids: readonly string[]): CauseEdge[] =>
    ids
      .map(edge)
      .filter((e): e is CauseEdge => e !== null)
      .sort((a, b) => b.selfMs - a.selfMs || b.runs - a.runs || a.propId.localeCompare(b.propId));
  return {
    kind: "correlated",
    ...(row.reason ? { reason: row.reason } : {}),
    upstream: collect(row.deps),
    downstream: collect(row.dependents),
  };
}

// ─── The COST lens's window table ────────────────────────────────────────
//
// PROP GRANULARITY ONLY, deliberately. A plugin author's performance levers
// are compute cost, `on:` selector breadth, declared-read volatility and
// `stableWhenEqual` quality — all per prop. Per-SEGMENT reuse maps to none
// of them (segment boundaries are engine machinery ADR-002 keeps invisible
// to plugin code, and no plugin can influence them), so it is at once the
// least actionable and the most mechanism-revealing thing in the frame.
// `ActivityFrame.segments` is therefore read for its per-prop RUNS and
// never for its geometry — this module exposes no segment ranges at all, so
// no pane can accidentally draw where the engine cuts the document.

export interface CostRow {
  readonly propId: string;
  readonly pack: string;
  readonly name: string;
  readonly runs: number;
  readonly selfMs: number;
  readonly maxSelfMs: number;
  readonly reason?: RecomputeReason;
}

/** Per-prop cost over the window, cost-first. Props with runs but no timing
 *  (a producer without a clock) still appear — at zero cost, which is the
 *  honest rendering of "we know it ran, we do not know what it cost". */
export function costRows(frame?: ActivityFrame | null): CostRow[] {
  if (!frame) return [];
  const index = indexActivity(frame);
  const ids = new Set<string>([...index.changed, ...index.timingByProp.keys()]);
  return [...ids]
    .map((propId) => {
      const t = index.timingByProp.get(propId);
      const r = index.runsByProp.get(propId);
      return {
        propId,
        ...splitPropId(propId),
        runs: r?.runs ?? t?.runs ?? 0,
        selfMs: t?.selfMs ?? 0,
        maxSelfMs: t?.maxSelfMs ?? 0,
        ...(r ? { reason: r.reason } : {}),
      };
    })
    .sort((a, b) => b.selfMs - a.selfMs || b.runs - a.runs || a.propId.localeCompare(b.propId));
}

// ─── Values are structured data, not strings ─────────────────────────────

/** Every {from,to} pair inside a projected prop value — a value that IS a
 *  document range should be clickable, whatever depth it sits at. Bounded:
 *  a pane needs a handful, not a crawl of a 10k-entry fold. */
export function rangesInValue(value: unknown, limit = 24): { from: number; to: number }[] {
  const found: { from: number; to: number }[] = [];
  const walk = (v: unknown, depth: number): void => {
    if (found.length >= limit || depth > 6 || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const item of v) walk(item, depth + 1);
      return;
    }
    const record = v as Record<string, unknown>;
    if (typeof record.from === "number" && typeof record.to === "number") {
      found.push({ from: record.from, to: record.to });
    }
    for (const key of Object.keys(record)) walk(record[key], depth + 1);
  };
  walk(value, 0);
  return found;
}

/** A one-line rendering for a row: enough to recognise the value, never so
 *  much that the list stops being scannable. The full structure is the
 *  detail panel's job. */
export function summarizeValue(row: PropRow, budget = 90): string {
  if (row.internal) return "internal — value withheld";
  if (row.error !== undefined) return `⚠ ${row.error}`;
  if (!row.evaluated) return "not evaluated";
  if (row.value === undefined) return "undefined";
  const text = typeof row.value === "string" ? row.value : JSON.stringify(row.value);
  if (text === undefined) return String(row.value);
  const suffix = row.valueTruncated ? ` … (${row.valueChars?.toLocaleString() ?? "?"} chars)` : "";
  return text.length > budget ? `${text.slice(0, budget)}…${suffix}` : `${text}${suffix}`;
}
