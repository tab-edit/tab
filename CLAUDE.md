# @tab-edit/cm — CLAUDE.md

Session entry point for the whole effort: `../CLAUDE_START.md` (ALWAYS start there;
current position in `../docs/STATE.md`). This repo is the CODEMIRROR 6 ADAPTER —
ADR-001 Appendix A **wiring 2** implemented literally: one Parser drives base+semantic,
CM stores the BASE tree (native styleTags highlighting works), the TabTree rides a
WeakMap, TabFragments reconstruct from CM's TreeFragments via `TabFragment.pairAll`.

## Commands

```bash
npm run type-check && npm test   # the gate — run before EVERY commit
npm install                      # refresh COPIED @tab-edit/{ast,plugins,parse}
                                 # (rebuild ast AND plugins first: npm run build in each!)
```

## Critical facts

- **bufferLength 32, NOT the old "CM ~256" note**: measured 2026-07-06 — at 256,
  ~400-char segments are Tree-backed yet lezer refuses identity reuse across edits
  (equality carry still held). 32 is the perf-baseline configuration. Threshold
  behavior is queued for the lezer-expertise pass.
- Repos are ISLANDS: consume ast/plugins/parse ONLY via packages (file: +
  install-links COPY). `@lezer/common` must stay single-instance (npm dedupes it;
  verify with `npm ls @lezer/common` after dependency changes).
- The state layer host is module-level v1 (`configureTabHost` before creating
  states); fragments that produced each TabTree are threaded to `layer.update`
  so carry gates see the true old→new mapping.
- Tests are HEADLESS (EditorState + ensureSyntaxTree — no DOM/EditorView);
  ViewPlugin code (decorations) keeps its pure core (`soundRangesAtCursor`)
  separately testable.

## Layout

```
src/language.ts     CmTabParser + tabLanguage + tabTree(state)  [wiring 2 core]
src/state-layer.ts  TabHost: StateLayer sync, readTabProp, diagnostics,
                    computeActivity (per-segment reuse status + compute-RUN
                    counts — the perf-diagnosis surface; call AFTER reads),
                    inspectNode (per-node prop values + explain chain +
                    chain trace + computed-vs-cached + install warnings)
src/semantics.ts    ADR-003 M-R0: SemanticSnapshot (wire-ready value data:
                    sound/measure maps, directives, receded lines,
                    diagnostics) — home of the pure tree-reading CORES
                    (producers) + snapshotOf (WeakMap<TabTree,snap> cache,
                    the local SemanticsClient) + pure data RESOLVERS
                    (soundRangesAt, selectionHighlightsAt) replicating
                    nodesInRanges range algebra — proven ≡ tree queries by
                    exhaustive sweep (tests/semantics.test.ts)
src/lint.ts         tabDiagnostics → CM lint with FIX ACTIONS (apply =
                    dispatch edits); source renders SNAPSHOT diagnostics
src/selection.ts    selectedNodes (column selections!), midiOfSelection
src/export.ts       musicXml(state), midiFile(state), importMusicXml(state, xml)
src/decorations.ts  ViewPlugins ONLY since M-R0 — chord/selection highlights,
                    directive underlines, prose recession all render pure
                    SNAPSHOT data (build() never touches tree or engine);
                    rebuilds also on snapshot-identity change (closes the
                    stale-after-async-reparse gap)
src/index.ts        tablature() — the whole system as one extension
tests/adapter.test.ts  E2E on real CM machinery
```
