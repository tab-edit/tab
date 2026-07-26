// The semantic STATE layer riding the editor: one StateLayer per adapter
// host, synced lazily to whatever TabTree the language has produced. Reads
// are demand-driven (ADR-002 pull model) — nothing computes until asked —
// and carry across edits uses the SAME fragments the parse itself used
// (language.ts threads them through), so "edit section 2, section 1's
// values survive" holds in the editor exactly as in pluginTest.

import type { EditorState } from "@codemirror/state";
import {
  PropRegistry,
  StateLayer,
  TabTree,
  withChainTrace,
} from "@tab-edit/ast";
import type {
  Diagnostic,
  PassHandle,
  PassSummary,
  PropHandle,
  SegmentArtifact,
  TabNode,
  TabPlugin,
  TextEdit,
} from "@tab-edit/ast";
import {
  toActivityFrame,
  toInspectionFrame,
  type ActivityFrame,
  type ComputeActivityParams,
  type InspectionFrame,
  type InspectNodeParams,
  type RawComputeReport,
  type RawNodeInspection,
  type RawPropInspection,
  type RawPropRuns,
  type RawPropTiming,
  type RawSegmentActivity,
  type RawTraceStep,
  type SavingsJSON,
} from "@tab-edit/protocol";
import {
  aggregatesPlugin,
  articulationPlugin,
  geometryPlugin,
  instrumentPlugin,
  midiPlugin,
  musicxmlImportPlugin,
  musicxmlPlugin,
  pitchPlugin,
  taxonomyPlugin,
  timePlugin,
} from "@tab-edit/plugins";
import { fragmentsOf, tabTree } from "./language.js";

/** The default install set: the full core surface + export packs. */
export const corePlugins: readonly TabPlugin[] = [
  taxonomyPlugin,
  instrumentPlugin,
  geometryPlugin,
  pitchPlugin,
  timePlugin,
  articulationPlugin,
  aggregatesPlugin,
  musicxmlPlugin,
  midiPlugin,
  musicxmlImportPlugin,
];

export interface TabHostOptions {
  readonly plugins?: readonly TabPlugin[];
  readonly configs?: Readonly<Record<string, unknown>>;
}

interface ObservedSegment {
  readonly artifact: SegmentArtifact;
  readonly from: number;
  readonly to: number;
}

/** One segment's share of the work since the previous computeActivity. */
export interface SegmentActivity {
  readonly from: number;
  readonly to: number;
  /** How the segment's artifact crossed the window: "identity" = same
   *  object, zero semantic work; "equal" = semparse re-ran and produced
   *  an equal artifact (work happened, result unchanged); "new" =
   *  re-parsed with different content. */
  readonly artifact: "identity" | "equal" | "new";
  /** prop id → compute() RUNS attributed to this segment (includes
   *  recomputed-but-equal runs — real work the cutoff then absorbed). */
  readonly recomputes: ReadonlyMap<string, number>;
}

export interface ComputeReport {
  readonly segments: readonly SegmentActivity[];
  /** Doc/inline-target compute runs (folds like measure numbering). */
  readonly docRecomputes: ReadonlyMap<string, number>;
  readonly totalRecomputes: number;
  /** Runs on artifacts that left the tree before this report. */
  readonly unattributed: number;
}

/** One link of who actually RAN for an evaluation (chain trace). */
export interface TraceStep {
  readonly pluginId: string;
  readonly delegated?: boolean;
  readonly foundation?: boolean;
  readonly base?: boolean;
}

export interface PropInspection {
  readonly id: string;
  /** Declared chain, outermost first — who COULD shape the value. */
  readonly chain: readonly string[];
  /** Props this compute declares it may read — the EFFECTIVE union across
   *  every chain link (registry.byId(id).deps). The declared-read graph
   *  among catalog props is public API: it is what makes the system
   *  teachable, and it is how "why did this recompute?" is answered by
   *  walking to the dep that ran. */
  readonly deps: readonly string[];
  /** What the prop promises consumers: "stable" = identity, shape and
   *  meaning are versioned; "experimental" = readable and debuggable, but
   *  explicitly changeable (the registry default). */
  readonly stability: string;
  /** Not readable by other plugins. Consumers place it in the graph with
   *  its cost and cache status and WITHHOLD the value. */
  readonly internal: boolean;
  readonly evaluated: boolean;
  readonly value?: unknown;
  readonly error?: string;
  /** Did THIS read run compute, or was it served from cache (carried or
   *  already computed this pass)? The cache visibility is the point. */
  readonly computed: boolean;
  /** Who actually ran, for CHAINED props (plain props emit no trace). */
  readonly trace: readonly TraceStep[];
}

export interface NodeInspection {
  readonly nodeName: string;
  /** The node's full range set (multi-range = chord Sound / multi-line
   *  Measure). Additive since 2026-07-26 — the frame producers need it and
   *  callers that predate it are unaffected. */
  readonly ranges: readonly { readonly from: number; readonly to: number }[];
  readonly props: readonly PropInspection[];
  /** Install advisories (PropRegistry.warnings) — host-visible, never errors. */
  readonly installWarnings: readonly string[];
}

// ─── Frame producers: the LOCAL twin of the session host's inspection ────
//
// The engine-bundled build answers the SAME frames the wire does, through
// the SAME projectors (@tab-edit/protocol), so app code never branches on
// mode and `localFrame ≡ remoteFrame` is a statement a test can make (see
// tests/inspection.test.ts for what it excludes and why). Everything below
// mirrors remote/host/src/inspect.ts deliberately — where the two could
// differ, copy rather than improve: lockstep IS the contract.

function rangesOf(node: TabNode): { from: number; to: number }[] {
  const ranges: { from: number; to: number }[] = [];
  for (let i = 0; i < node.rangeCount; i++) {
    ranges.push({ from: node.rangeFrom(i), to: node.rangeTo(i) });
  }
  return ranges;
}

/** Zero-width nodes match only exactly (verbatim host semantics — a
 *  subtly different descent picks a different node, and the failure would
 *  present as a value mismatch rather than a position one). */
function containsPos(node: TabNode, pos: number): boolean {
  for (let i = 0; i < node.rangeCount; i++) {
    const a = node.rangeFrom(i);
    const b = node.rangeTo(i);
    if (a === b ? pos === a : pos >= a && pos < b) return true;
  }
  return false;
}

/** The node the cursor is IN: descend while a child contains the position. */
export function deepestNodeAt(tree: TabTree, pos: number): TabNode {
  let node = tree.topNode;
  for (;;) {
    let next: TabNode | null = null;
    for (let c = node.firstChild; c; c = c.nextSibling) {
      if (containsPos(c, pos)) {
        next = c;
        break;
      }
    }
    if (!next) return node;
    node = next;
  }
}

/** The two exposure axes ride along as EXCESS fields on the raw shape: the
 *  projector names every field it emits, so they reach a frame only once
 *  the protocol package carries them. Feeding them now means the local twin
 *  gains the badges the moment that lands, with no change here. */
interface LocalRawProp extends RawPropInspection {
  readonly stability?: string;
  readonly internal?: boolean;
}

/** How many passes of segment observations to retain — MATCHED to the
 *  layer's own recompute-log window (measured: it keeps passId-16…passId),
 *  so a clamped window can never pair a reuse baseline with run counts from
 *  a pass the log has already dropped. */
const RETAINED_PASSES = 16;

interface Observation {
  readonly passId: number;
  readonly units: readonly ObservedSegment[];
}

/** The addressable perf observer (the host's ActivityObserver, in-process).
 *  Separate from TabHost.computeActivity's single destructive cursor — the
 *  demo's Activity pane owns that one; frame callers name their own window. */
class ActivityObserver {
  private observations: Observation[] = [];
  private cursor = 0;
  /** This document's own cold cost — the counterfactual the savings counter
   *  reports against. Measured, never modelled. 0 = NOT MEASURED (the local
   *  build has no `hello` pass to measure on: it is filled in from the first
   *  window that starts at pass 0, which IS this document's cold boot). */
  private baseline = { props: 0, ms: 0 };

  reset(): void {
    this.observations = [];
    this.cursor = 0;
    this.baseline = { props: 0, ms: 0 };
  }

  observe(handle: PassHandle, tree: TabTree): void {
    if (this.observations.some((o) => o.passId === handle.id)) return;
    const units: ObservedSegment[] = [];
    for (const unit of tree.units) {
      if (unit.kind !== "segment") continue;
      units.push({ artifact: unit.artifact, from: unit.from, to: TabTree.unitEnd(unit) });
    }
    this.observations.push({ passId: handle.id, units });
    if (this.observations.length > RETAINED_PASSES) this.observations.shift();
  }

  report(
    layer: StateLayer,
    handle: PassHandle,
    version: number,
    sincePass?: number
  ): RawComputeReport {
    const oldest = this.observations.length > 0 ? this.observations[0].passId : 0;
    const from =
      sincePass === undefined ? this.cursor : Math.min(Math.max(sincePass, oldest), handle.id);
    const summary = layer.changesSince({ id: from });
    const current = this.observations.find((o) => o.passId === handle.id)?.units ?? [];
    const baselineUnits = this.observations.find((o) => o.passId === from)?.units ?? [];

    const bySegment = new Map<SegmentArtifact, Map<string, number>>();
    const docRuns = new Map<string, number>();
    let total = 0;
    let unattributed = 0;
    for (const [propId, targets] of summary.changed) {
      for (const target of targets) {
        total++;
        if (target.kind === "segment") {
          let counts = bySegment.get(target.artifact);
          if (!counts) bySegment.set(target.artifact, (counts = new Map()));
          counts.set(propId, (counts.get(propId) ?? 0) + 1);
        } else {
          docRuns.set(propId, (docRuns.get(propId) ?? 0) + 1);
        }
      }
    }

    const recomputed = new Set(summary.changed.keys());
    const registry = layer.registry;
    const dependencyRan = (propId: string): boolean => {
      let deps: ReadonlySet<string>;
      try {
        deps = registry.byId(propId).deps;
      } catch {
        return false;
      }
      for (const dep of deps) if (recomputed.has(dep)) return true;
      return false;
    };
    const cold = from === 0;
    const structureChanged = baselineUnits.length !== current.length;

    const previousIdentities = new Set(baselineUnits.map((u) => u.artifact));
    const segments: RawSegmentActivity[] = [];
    current.forEach((unit, ordinal) => {
      const artifact = previousIdentities.has(unit.artifact)
        ? "identity"
        : baselineUnits.some((u) => u.artifact.equals(unit.artifact))
          ? "equal"
          : "new";
      const counts = bySegment.get(unit.artifact) ?? new Map<string, number>();
      bySegment.delete(unit.artifact);
      const hadPrior = ordinal < baselineUnits.length;
      const recomputes: RawPropRuns[] = [...counts].map(([propId, runs]) => ({
        propId,
        runs,
        reason: cold
          ? "cold"
          : artifact === "new"
            ? hadPrior
              ? "text-changed"
              : "no-prior-value"
            : dependencyRan(propId)
              ? "dependency-recomputed"
              : "declared-read-changed",
      }));
      segments.push({ from: unit.from, to: unit.to, artifact, recomputes });
    });
    for (const counts of bySegment.values()) for (const n of counts.values()) unattributed += n;

    const docRecomputes: RawPropRuns[] = [...docRuns].map(([propId, runs]) => ({
      propId,
      runs,
      reason: cold
        ? "cold"
        : structureChanged
          ? "structure-changed"
          : dependencyRan(propId)
            ? "dependency-recomputed"
            : "declared-read-changed",
    }));

    const timings: RawPropTiming[] = [...summary.timings].map(([propId, t]) => ({
      propId,
      runs: t.runs,
      selfMs: t.selfMs,
      totalMs: t.totalMs,
      maxSelfMs: t.maxSelfMs,
    }));
    // THE BASELINE, locally. The host measures it on its `hello` pass; an
    // in-process build has no hello, so the equivalent moment is the first
    // window with NOTHING TO CARRY FROM (no observed baseline pass) — that
    // window is this document's cold boot by definition. Until one happens
    // it stays 0 = NOT MEASURED, and a consumer must render that as "no
    // baseline" rather than computing a ratio against zero.
    if (this.baseline.props === 0 && baselineUnits.length === 0) {
      this.baseline = { props: countRuns(summary), ms: sumSelfMs(summary) };
    }
    const savings: SavingsJSON = {
      recomputedProps: total,
      carriedProps: Math.max(0, this.baseline.props - total),
      elapsedMs: sumSelfMs(summary),
      baselineProps: this.baseline.props,
      baselineMs: this.baseline.ms,
    };

    if (sincePass === undefined) this.cursor = handle.id;
    return {
      version,
      passId: handle.id,
      sincePass: from,
      segments,
      docRecomputes,
      totalRecomputes: total,
      unattributed,
      savings,
      timings,
    };
  }
}

function countRuns(summary: PassSummary): number {
  let n = 0;
  for (const targets of summary.changed.values()) n += targets.length;
  return n;
}

function sumSelfMs(summary: PassSummary): number {
  let ms = 0;
  for (const t of summary.timings.values()) ms += t.selfMs;
  return ms;
}

/** Module-level host (v1: one instance per process, like the language).
 *  configure() BEFORE creating editor states if you need extra plugins. */
class TabHost {
  private layer: StateLayer;
  private lastTree: TabTree | null = null;
  private lastHandle: PassHandle | null = null;
  private plugins: readonly TabPlugin[] = corePlugins;
  private configs?: Readonly<Record<string, unknown>>;
  /** Observer bookkeeping for computeActivity (one observer, v1). */
  private observedUnits: readonly ObservedSegment[] = [];
  private observedHandle: PassHandle | null = null;
  /** The ADDRESSABLE observer behind activityFrame (frame callers name
   *  their own window; the raw computeActivity cursor above stays the
   *  demo's). */
  private readonly observer = new ActivityObserver();

  constructor() {
    this.layer = new StateLayer(PropRegistry.install(corePlugins));
  }

  configure(options: TabHostOptions): void {
    this.plugins = options.plugins ?? corePlugins;
    this.configs = options.configs;
    this.layer = new StateLayer(
      PropRegistry.install(this.plugins, { configs: this.configs })
    );
    this.lastTree = null;
    this.lastHandle = null;
    this.observedUnits = [];
    this.observedHandle = null;
    this.observer.reset();
  }

  /** Sync the layer to the state's current TabTree (no-op when current). */
  sync(state: EditorState): TabTree | null {
    const tree = tabTree(state);
    if (!tree) return null;
    if (tree !== this.lastTree) {
      this.lastHandle = this.layer.update(tree, fragmentsOf(tree), state.doc.toString());
      this.lastTree = tree;
      // Record the pass's segment set so ANY retained pass can serve as a
      // reuse baseline (addressable windows). Cheap: one array of unit
      // bounds per pass, bounded by RETAINED_PASSES.
      this.observer.observe(this.lastHandle, tree);
    }
    return tree;
  }

  /** The wire-shaped inspection frame, produced in-process (see the frame
   *  producers above). `version` is 0: a local build answers about the state
   *  it was handed, so there is no version to cite — which is exactly why
   *  the differential excludes that field. */
  inspectFrame(state: EditorState, params: InspectNodeParams): InspectionFrame | null {
    const tree = this.sync(state);
    if (!tree) return null;
    const registry = this.layer.registry;
    const runsNow = (propId: string): number =>
      this.layer.changesSince({ id: 0 }).changed.get(propId)?.length ?? 0;
    const pos = Math.max(0, Math.min(Math.round(params.pos), state.doc.length));

    const chain: RawNodeInspection[] = [];
    let index = 0;
    for (let node: TabNode | null = deepestNodeAt(tree, pos); node; node = node.parent, index++) {
      const isRoot = node.parent === null;
      const props: LocalRawProp[] = [];
      for (const prop of registry.props) {
        if (prop.internal) continue;
        if (!prop.selectors.some((sel) => node!.type.is(sel))) continue;
        const declared = registry.explain(prop.id);
        const deps = [...prop.deps];
        const exposure = { stability: prop.stability, internal: prop.internal };
        const wanted = params.only
          ? params.only.nodeIndex === index && params.only.propIds.includes(prop.id)
          : !isRoot || params.evaluateRoot === true;
        if (!wanted) {
          props.push({
            id: prop.id,
            chain: declared,
            deps,
            ...exposure,
            evaluated: false,
            computed: false,
            trace: [],
          });
          continue;
        }
        const runsBefore = runsNow(prop.id);
        try {
          const { value, records } = withChainTrace(() => this.layer.read(prop.handle, node!));
          const record = [...records].reverse().find((r) => r.propId === prop.id);
          const trace: RawTraceStep[] = (record?.events ?? []).map((e) =>
            e.kind === "base"
              ? { pluginId: e.pluginId, base: true }
              : {
                  pluginId: e.pluginId,
                  delegated: e.delegated,
                  ...(e.foundation ? { foundation: true as const } : {}),
                }
          );
          props.push({
            id: prop.id,
            chain: declared,
            deps,
            ...exposure,
            evaluated: true,
            value,
            computed: runsNow(prop.id) > runsBefore,
            trace,
          });
        } catch (e) {
          props.push({
            id: prop.id,
            chain: declared,
            deps,
            ...exposure,
            evaluated: true,
            error: (e as Error).message,
            computed: runsNow(prop.id) > runsBefore,
            trace: [],
          });
        }
      }
      chain.push({ nodeName: node.name, ranges: rangesOf(node), props });
    }
    return toInspectionFrame(
      {
        version: 0,
        pos,
        chain,
        installWarnings: registry.warnings.map(
          (w) => `${w.kind}: ${w.pluginId} → ${w.targetPropId}`
        ),
      },
      { maxValueChars: params.maxValueChars }
    );
  }

  /** The wire-shaped activity frame. Call AFTER the reads you want
   *  attributed (pull model), and pass your own `sincePass` — the
   *  unaddressed window is a destructive read shared by every caller. */
  activityFrame(state: EditorState, params: ComputeActivityParams = {}): ActivityFrame | null {
    if (!this.sync(state) || !this.lastHandle) return null;
    const sincePass =
      typeof params.sincePass === "number" && Number.isFinite(params.sincePass)
        ? Math.max(0, Math.round(params.sincePass))
        : undefined;
    return toActivityFrame(this.observer.report(this.layer, this.lastHandle, 0, sincePass));
  }

  /** What computation ACTUALLY happened since the previous call — the
   *  performance-diagnosis surface. Call AFTER the reads whose work you
   *  want attributed (pull model: reads are where computes happen). */
  computeActivity(state: EditorState): ComputeReport | null {
    const tree = this.sync(state);
    if (!tree || !this.lastHandle) return null;

    // Drain compute-run targets since the last report. The layer's log
    // records every compute() RUN — recomputed-but-equal included (the
    // cutoff backdates the value, not the work).
    const summary = this.layer.changesSince(this.observedHandle ?? { id: 0 });
    const bySegment = new Map<SegmentArtifact, Map<string, number>>();
    const docRecomputes = new Map<string, number>();
    let total = 0;
    let unattributed = 0;
    for (const [propId, targets] of summary.changed) {
      for (const target of targets) {
        total++;
        if (target.kind === "segment") {
          let counts = bySegment.get(target.artifact);
          if (!counts) bySegment.set(target.artifact, (counts = new Map()));
          counts.set(propId, (counts.get(propId) ?? 0) + 1);
        } else {
          docRecomputes.set(propId, (docRecomputes.get(propId) ?? 0) + 1);
        }
      }
    }

    // Per-segment artifact status: identity (zero semantic work), equal
    // (semparse re-ran, same result), new (content changed).
    const previousIdentities = new Set(this.observedUnits.map((u) => u.artifact));
    const segments: SegmentActivity[] = [];
    const currentUnits: ObservedSegment[] = [];
    for (const unit of tree.units) {
      if (unit.kind !== "segment") continue;
      const observed = {
        artifact: unit.artifact,
        from: unit.from,
        to: TabTree.unitEnd(unit),
      };
      currentUnits.push(observed);
      const status = previousIdentities.has(unit.artifact)
        ? "identity"
        : this.observedUnits.some((u) => u.artifact.equals(unit.artifact))
          ? "equal"
          : "new";
      const recomputes = bySegment.get(unit.artifact) ?? new Map<string, number>();
      bySegment.delete(unit.artifact);
      segments.push({ from: observed.from, to: observed.to, artifact: status, recomputes });
    }
    // Runs targeting artifacts no longer in the tree (superseded mid-window).
    for (const counts of bySegment.values()) {
      for (const n of counts.values()) unattributed += n;
    }

    this.observedUnits = currentUnits;
    this.observedHandle = this.lastHandle;
    return { segments, docRecomputes, totalRecomputes: total, unattributed };
  }

  /** Debug/inspector surface: every non-internal prop attaching to `node`,
   *  with declared chain (explain), value, and the ACTUAL evaluation trace
   *  (withChainTrace — empty when the read was served from cache).
   *  `evaluate: false` (or an id allowlist) defers heavy props to a click. */
  inspect(
    state: EditorState,
    node: TabNode,
    evaluate: boolean | readonly string[] = true
  ): NodeInspection | null {
    if (!this.sync(state)) return null;
    const registry = this.layer.registry;
    // Compute-run detection for PLAIN props: only the CURRENT pass's log
    // can grow between the two samples, so a count delta over the whole
    // retained window means THIS read actually ran compute (chained props
    // additionally get the richer trace).
    const runsNow = (propId: string): number =>
      this.layer.changesSince({ id: 0 }).changed.get(propId)?.length ?? 0;
    const props: PropInspection[] = [];
    for (const prop of registry.props) {
      if (prop.internal) continue;
      if (!prop.selectors.some((sel) => node.type.is(sel))) continue;
      const chain = registry.explain(prop.id);
      // The EFFECTIVE union across the chain (InstalledProp.deps), the same
      // expression the session host projects — lockstep beats cleverness.
      const deps = [...prop.deps];
      const exposure = { deps, stability: prop.stability, internal: prop.internal };
      const wanted = evaluate === true || (evaluate !== false && evaluate.includes(prop.id));
      if (!wanted) {
        props.push({ id: prop.id, chain, ...exposure, evaluated: false, computed: false, trace: [] });
        continue;
      }
      const runsBefore = runsNow(prop.id);
      try {
        const { value, records } = withChainTrace(() => this.layer.read(prop.handle, node));
        const record = [...records].reverse().find((r) => r.propId === prop.id);
        const trace: TraceStep[] = (record?.events ?? []).map((e) =>
          e.kind === "base"
            ? { pluginId: e.pluginId, base: true }
            : {
                pluginId: e.pluginId,
                delegated: e.delegated,
                ...(e.foundation ? { foundation: true as const } : {}),
              }
        );
        props.push({
          id: prop.id,
          chain,
          ...exposure,
          evaluated: true,
          value,
          computed: runsNow(prop.id) > runsBefore,
          trace,
        });
      } catch (e) {
        props.push({
          id: prop.id,
          chain,
          ...exposure,
          evaluated: true,
          error: (e as Error).message,
          computed: runsNow(prop.id) > runsBefore,
          trace: [],
        });
      }
    }
    return {
      nodeName: node.name,
      ranges: rangesOf(node),
      props,
      installWarnings: this.layer.registry.warnings.map(
        (w) => `${w.kind}: ${w.pluginId} → ${w.targetPropId}`
      ),
    };
  }

  read<T>(state: EditorState, handle: PropHandle<T>, node: TabNode): T {
    if (!this.sync(state)) {
      throw new Error("tab-edit: no TabTree yet — ensure the syntax tree is parsed first");
    }
    return this.layer.read(handle, node);
  }

  diagnostics(state: EditorState): readonly Diagnostic[] {
    if (!this.sync(state)) return [];
    return this.layer.diagnostics();
  }

  runCommand(state: EditorState, id: string, args: unknown): readonly TextEdit[] {
    if (!this.sync(state)) {
      throw new Error("tab-edit: no TabTree yet — ensure the syntax tree is parsed first");
    }
    return this.layer.runCommand(id, args);
  }
}

const host = new TabHost();

/** Swap the plugin install set / configs (call before creating states). */
export function configureTabHost(options: TabHostOptions): void {
  host.configure(options);
}

/** Read a prop value for a node — demand-evaluated, carry-aware. */
export function readTabProp<T>(state: EditorState, handle: PropHandle<T>, node: TabNode): T {
  return host.read(state, handle, node);
}

/** All current diagnostics from diagnostic props (lint feeds on this). */
export function tabStateDiagnostics(state: EditorState): readonly Diagnostic[] {
  return host.diagnostics(state);
}

/** Inspect a node: every prop that attaches to it, with declared chain,
 *  value, and the actual evaluation trace (empty = cache-served). Pass
 *  `evaluate: false` or an id allowlist to defer heavy props. */
export function inspectNode(
  state: EditorState,
  node: TabNode,
  evaluate: boolean | readonly string[] = true
): NodeInspection | null {
  return host.inspect(state, node, evaluate);
}

/** What computation ACTUALLY ran since the previous call: per-segment
 *  artifact reuse status + per-prop compute-run counts (pull model — call
 *  AFTER the reads you want attributed). Perf-diagnosis surface; one
 *  observer per host, v1. */
export function computeActivity(state: EditorState): ComputeReport | null {
  return host.computeActivity(state);
}

/** The LOCAL twin of the `inspectNode` query: the ancestor chain at `pos`
 *  with every non-internal prop, projected through the protocol's own
 *  choke point — the identical frame the wire answers, minus the perf
 *  fields two engines legitimately differ on (`computed`/`trace`) and the
 *  `version` a local build has no meaning for. */
export function localInspectionFrame(
  state: EditorState,
  params: InspectNodeParams
): InspectionFrame | null {
  return host.inspectFrame(state, params);
}

/** The LOCAL twin of the `computeActivity` query. Pass-history dependent by
 *  nature (passId/sincePass/timings/savings/reuse) — this is deliberately
 *  NOT part of the frame differential. */
export function localActivityFrame(
  state: EditorState,
  params: ComputeActivityParams = {}
): ActivityFrame | null {
  return host.activityFrame(state, params);
}

/** Run a producer command (ADR-002 §9); the returned edits are yours to
 *  dispatch: `view.dispatch({ changes: edits.map(e => ({...e})) })`. */
export function runTabCommand(
  state: EditorState,
  id: string,
  args: unknown
): readonly TextEdit[] {
  return host.runCommand(state, id, args);
}
