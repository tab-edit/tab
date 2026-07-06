// TabLanguage — ADR-001 Appendix A WIRING 2, the literal drop-in Language:
// one Parser whose PartialParse drives base+semantic in a single pipeline
// and returns the BASE Lezer tree to CodeMirror (Language.state stores it,
// so native services — styleTags highlighting, folding, indentation — all
// work untouched), while the finished TabTree rides a WeakMap keyed by
// that base tree. TabFragments are reconstructed from CM's TreeFragments
// through the same WeakMap (TabFragment.pairAll was built for this).
// One scheduler (CM's), zero CM patches, exactly ONE base parse.

import { Input, Parser, PartialParse, Tree, TreeFragment } from "@lezer/common";
import { Language, defineLanguageFacet, syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import {
  ArtifactCache,
  TabFragment,
  TabParser,
  TabTree,
} from "@tab-edit/ast";
import type { PartialTabParse } from "@tab-edit/ast";
import { parser as baseParser } from "@tab-edit/parse";

/** baseTree → TabTree: how the semantic tree rides CM's syntax tree. */
const tabTrees = new WeakMap<Tree, TabTree>();
/** TabTree → the fragments that PRODUCED it (threaded to the state layer
 *  so its carry gates see the same old→new mapping the parse used). */
const parseFragments = new WeakMap<TabTree, readonly TabFragment[]>();

class CmPartialParse implements PartialParse {
  constructor(
    private readonly inner: PartialTabParse,
    private readonly fragments: readonly TabFragment[]
  ) {}

  advance(): Tree | null {
    const tabTree = this.inner.advance();
    if (!tabTree) return null;
    tabTrees.set(tabTree.baseTree, tabTree);
    parseFragments.set(tabTree, this.fragments);
    return tabTree.baseTree;
  }

  get parsedPos(): number {
    return this.inner.parsedPos;
  }

  stopAt(pos: number): void {
    this.inner.stopAt(pos);
  }

  get stoppedAt(): number | null {
    return this.inner.stoppedAt;
  }
}

class CmTabParser extends Parser {
  // bufferLength 32 — MEASURED, not the old "CM ~256" guidance: at 256,
  // ~400-char segments come back as Trees yet lezer still refuses identity
  // reuse across edits (bracketed 2026-07-06; equality carry held, identity
  // didn't; threshold behavior queued for the lezer-expertise pass). 32 is
  // the configuration the 1.25ms@100KB perf baseline and the 99.7%-hit
  // corpus numbers were actually measured at. Own cache: adapter instances
  // don't cross-talk.
  private readonly inner = new TabParser({
    baseParser: baseParser.configure({ bufferLength: 32 }),
    cache: new ArtifactCache(),
  });

  createParse(
    input: Input,
    fragments: readonly TreeFragment[],
    ranges: readonly { from: number; to: number }[]
  ): PartialParse {
    // Reconstruct TabFragments from CM's TreeFragments: every tree CM
    // hands back came out of advance() above, so the WeakMap has it.
    // Unknown trees (e.g. Tree.empty on a fresh state) just drop out —
    // losing reuse for them, never correctness.
    const known = fragments.filter((f) => tabTrees.has(f.tree));
    const map = new Map<Tree, TabTree>();
    for (const f of known) map.set(f.tree, tabTrees.get(f.tree)!);
    const tabFragments = TabFragment.pairAll(known, map);
    return new CmPartialParse(this.inner.startParse(input, tabFragments, ranges), tabFragments);
  }
}

const tabLanguageFacet = defineLanguageFacet({
  commentTokens: { line: "#" },
});

/** The Language. Register through `tablature()` (index.ts) to get the
 *  semantic layer, lint and decorations too. */
export const tabLanguage = new Language(tabLanguageFacet, new CmTabParser(), [], "tablature");

/** The semantic tree for the state's CURRENT syntax tree — null while the
 *  parse hasn't produced one yet (drive it with ensureSyntaxTree /
 *  forceParsing, or read again after CM's scheduler catches up). */
export function tabTree(state: EditorState): TabTree | null {
  return tabTrees.get(syntaxTree(state)) ?? null;
}

/** @internal state-layer.ts uses this to update with true carry mapping. */
export function fragmentsOf(tree: TabTree): readonly TabFragment[] {
  return parseFragments.get(tree) ?? [];
}
