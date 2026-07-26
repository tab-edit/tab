// The headless force-parse helper every suite must use before reading a tree.
//
// THE TRAP (diagnosed 2026-07-26, after CI failed on Linux while macOS stayed
// green): `ensureSyntaxTree` and `syntaxTree` return DIFFERENT TREES.
//
//   - `EditorState.create` runs LanguageState.init, which gives the parse a
//     20 ms budget and, on timeout, calls takeTree() — the StateField keeps a
//     TRUNCATED tree.
//   - `ensureSyntaxTree` advances the mutable ParseContext and returns the
//     complete tree, but it CANNOT write to the field: only a transaction can.
//   - every downstream read — `syntaxTree(state)`, and therefore `tabTree` via
//     the TabTree WeakMap, and therefore snapshots, diagnostics and their
//     FIXES — goes through the field. So they compute over the truncated tree.
//
// On a fast machine the 20 ms budget finishes the parse and nothing is wrong.
// Under CPU starvation (a throttled shared CI runner) it does not: measured
// 11/12 failing runs at --cpus=0.4, 0/10 unloaded, and a cold-parse probe
// showed a complete 798-char forced tree against a 262-char field tree — the
// unnamed-line diagnostic still firing but WITHOUT its fix, which is exactly
// the "remote ≡ local but no fix actions" CI signature.
//
// CM documents the missing step in `forceParsing`: ensureSyntaxTree, then
// dispatch an empty transaction if the trees differ. The guard matters —
// unguarded, LanguageState.apply early-returns when the trees are identical
// and the republish silently does nothing.
//
// NOTE this is NOT the #17 incremental/fragment story: it reproduces on the
// first COLD parse with an empty cache and a single worker, so `maxWorkers: 1`
// does nothing for it.

import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { expect } from "@jest/globals";

/** Advance `state`'s parse to completion AND republish it into the state
 *  field, so tree reads see the whole document. Returns the new state. */
export function forceParsed(state: EditorState, timeout = 10_000): EditorState {
  const forced = ensureSyntaxTree(state, state.doc.length, timeout);
  expect(forced).not.toBeNull();
  const published = forced !== syntaxTree(state) ? state.update({}).state : state;
  // The assertion that converts a silent wrong-value flake into a loud one.
  expect(syntaxTree(published).length).toBe(published.doc.length);
  return published;
}

/** `EditorState.create` + forceParsed, for the common case. */
export function forceParsedState(
  doc: string,
  extensions: Parameters<typeof EditorState.create>[0] extends { extensions?: infer E } ? E : never,
  timeout = 10_000
): EditorState {
  return forceParsed(EditorState.create({ doc, extensions }), timeout);
}
