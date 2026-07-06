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
} from "@tab-edit/ast";
import type { Diagnostic, PropHandle, TabNode, TabPlugin, TabTree, TextEdit } from "@tab-edit/ast";
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

/** Module-level host (v1: one instance per process, like the language).
 *  configure() BEFORE creating editor states if you need extra plugins. */
class TabHost {
  private layer: StateLayer;
  private lastTree: TabTree | null = null;
  private plugins: readonly TabPlugin[] = corePlugins;
  private configs?: Readonly<Record<string, unknown>>;

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
  }

  /** Sync the layer to the state's current TabTree (no-op when current). */
  sync(state: EditorState): TabTree | null {
    const tree = tabTree(state);
    if (!tree) return null;
    if (tree !== this.lastTree) {
      this.layer.update(tree, fragmentsOf(tree), state.doc.toString());
      this.lastTree = tree;
    }
    return tree;
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

/** Run a producer command (ADR-002 §9); the returned edits are yours to
 *  dispatch: `view.dispatch({ changes: edits.map(e => ({...e})) })`. */
export function runTabCommand(
  state: EditorState,
  id: string,
  args: unknown
): readonly TextEdit[] {
  return host.runCommand(state, id, args);
}
