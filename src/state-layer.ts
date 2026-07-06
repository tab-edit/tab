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
} from "@tab-edit/ast";
import type {
  Diagnostic,
  PassHandle,
  PropHandle,
  SegmentArtifact,
  TabNode,
  TabPlugin,
  TextEdit,
} from "@tab-edit/ast";
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
  }

  /** Sync the layer to the state's current TabTree (no-op when current). */
  sync(state: EditorState): TabTree | null {
    const tree = tabTree(state);
    if (!tree) return null;
    if (tree !== this.lastTree) {
      this.lastHandle = this.layer.update(tree, fragmentsOf(tree), state.doc.toString());
      this.lastTree = tree;
    }
    return tree;
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

/** What computation ACTUALLY ran since the previous call: per-segment
 *  artifact reuse status + per-prop compute-run counts (pull model — call
 *  AFTER the reads you want attributed). Perf-diagnosis surface; one
 *  observer per host, v1. */
export function computeActivity(state: EditorState): ComputeReport | null {
  return host.computeActivity(state);
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
