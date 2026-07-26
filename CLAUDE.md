# @tab-edit/cm — CLAUDE.md

Session entry point for the whole effort: `../CLAUDE_START.md` (ALWAYS start there;
current position in `../docs/STATE.md`). This repo is the CODEMIRROR 6 ADAPTER —
ADR-001 Appendix A **wiring 2** implemented literally: one Parser drives base+semantic,
CM stores the BASE tree (native styleTags highlighting works), the TabTree rides a
WeakMap, TabFragments reconstruct from CM's TreeFragments via `TabFragment.pairAll`.

## Commands

```bash
npm run type-check && npm test   # the gate — run before EVERY commit
                                 # (includes the /client BUNDLE AUDIT)
npm run verify:remote            # LOCAL E2E of ADR-003: real browser → ws →
                                 # remote/host Session (spawns the sibling
                                 # dev server; demo ?remote=ws://… by hand)
npm run verify:app               # PRODUCT app driver: artifact audit on the
                                 # real vite build (engine-free — CI-fatal
                                 # posture) + live wire checks
npm run app                      # the product page (vercel builds THIS now)
npm install                      # refresh COPIED @tab-edit/{ast,plugins,parse}
                                 # (rebuild ast AND plugins first: npm run build in each!)
                                 # @tab-edit/protocol comes from the remote
                                 # repo ROOT (git+ssh)
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
                    localInspectionFrame/localActivityFrame — the LOCAL
                    TWIN of the host's producers, projected through the
                    protocol's own choke point (mirror remote/host/src/
                    inspect.ts VERBATIM where they could differ; internal
                    props list OPAQUE, deps come sorted from
                    registry.catalog(), exposure is checked BEFORE the
                    evaluate policy). Local has no `hello`, so the savings
                    baseline is measured on the first window with nothing
                    to carry from and reads 0 = NOT MEASURED until then.
                    computeActivity (per-segment reuse status + compute-RUN
                    counts — the perf-diagnosis surface; call AFTER reads),
                    inspectNode (per-node prop values + explain chain +
                    chain trace + computed-vs-cached + install warnings)
src/client.ts       THE ENGINE-FREE ENTRY (@tab-edit/cm/client — exports
                    map): baseTabLanguage (compiled LR tables only),
                    remoteTablature() ≡ tablature() via shared
                    tablatureSupport(), createRemoteSemantics(). NOTHING
                    here may reach @tab-edit/{ast,plugins} — pinned by
                    tests/client-bundle.test.ts (esbuild) AND
                    app/verify-app.cjs (real vite artifact). Careful even
                    with COMMENTS: audit markers match comment text.
src/playback.ts     ENGINE-FREE playback: buildTimeline (wire values only —
                    midiEvents + the snapshot SOUND MAP + doc geometry),
                    the Web Audio synth (Stan's ear-tuned guitar body IR /
                    pick knock — do NOT retune without his ears), windowed
                    scheduler (pure cursorAt/schedulableThrough cores).
                    demo/playback.ts is a local-sourcing shim over it.
src/osmd.ts         sanitizeForOsmd — the VexFlow pre-flight shared by the
                    demo and the app (drops what VexFlow throws on, reports
                    the count). Engine-free, DOM-only.
src/facade.ts       TabSemantics — the ONE app-facing interface; local
                    twin createLocalSemantics lives in index.ts. The
                    open-source flip = app/semantics-mode.ts re-export.
                    Since 2026-07-26 it also carries INSPECTION:
                    inspectNode/computeActivity answering @tab-edit/
                    protocol frames. The remote impl FLUSHES then cites
                    atVersion: client.version (RemoteClient.version is
                    public) so frame ranges land in on-screen coordinates.
src/inspector-model.ts  PURE view model over the two frames (rows, pack +
                    OUTCOME chips, filters, cost-first ordering with an
                    honest fallback, claim→outcome pairing, causeOf,
                    savings line, value range extraction). Engine-free
                    (frame TYPES only) → part of /client. It deliberately
                    exposes NO segment geometry: per-segment reuse maps to
                    no lever a plugin author owns and is the most
                    mechanism-revealing thing in the frame, so no pane can
                    draw it. tests/inspector-model.test.ts drives it with
                    CONSTRUCTED frames (internal-opaque prop, a producer
                    with no clock) that real data cannot produce.
src/snapshot-model.ts  PURE half of semantics: value model + 0ms
                    resolvers + snapshotSource facet. Source selection is
                    PRECEDENCE-based: tablature() installs the local
                    engine at default prec, remoteSemantics() the wire
                    store at Prec.highest — flatten ORDER is not a
                    contract (found-by-storm).
src/remote.ts       ADR-003 M-R1: RemoteClient (view-free core — start/
                    applyTransaction/flush/query/receive — + EditorView
                    glue via .extension), mapSnapshot (§5.1 R2/R5/R6 range
                    algebra), remoteSnapshotField (maps through every local
                    edit, replaced atomically per frame), transports:
                    sessionTransport (loopback, JSON-round-trips = I4),
                    chaosTransport (seeded pump-time drop/reorder; never
                    drops hello/helloOk — transport contract), webSocket-
                    Transport. tests/remote.test.ts drives it against a
                    NAIVE-COLD protocol oracle (deterministic; CM
                    incremental slicing makes #17 flake otherwise); the
                    REAL-Session differential lives in remote/host.
src/semantics.ts    ADR-003 M-R0: SemanticSnapshot (wire-ready value data:
                    sound/measure maps, directives, receded lines,
                    diagnostics) — home of the pure tree-reading CORES
                    (producers) + snapshotOf (WeakMap<TabTree,snap> cache,
                    the local SemanticsClient) + pure data RESOLVERS
                    (soundRangesAt, selectionHighlightsAt) replicating
                    nodesInRanges range algebra — proven ≡ tree queries by
                    exhaustive sweep (tests/semantics.test.ts)
src/lint.ts         tabDiagnostics → CM lint with FIX ACTIONS (apply =
                    dispatch edits); source renders SNAPSHOT diagnostics.
                    tabLint({textTooltips:false}) is how the HOVER merge
                    turns lint's own text tooltip off (the gutter marker
                    reads a separate config and is untouched)
src/hover.ts        HOVER EXPLANATIONS — the document explaining itself,
                    in the PRODUCT (never dev-gated). THE RULE: the prop
                    layer is truth, the parse tree is a HYPOTHESIS (`H` on
                    a hi-hat line parses Hammer and the layer refuses it),
                    so node type only ever names what the user WROTE.
                    TIER 1 = snapshot only, synchronous, stands alone:
                    diagnostics verbatim + authoritative, else sound-map
                    membership WITH no overlapping diagnostic (an
                    unresolved glyph IS a child of its Sound — pinned by
                    tests/hover.test.ts). TIER 2 = one inspectNode once the
                    hover commits, through the `inspectionSource` facet the
                    two facade builders populate; APPENDS a line, never
                    revises. Keys: F1 / Ctrl-Alt-i (Mod-i is defaultKeymap's
                    selectParentSyntax; mac Alt-combos can never match).
                    Silent: lattice, barlines, prose, and every construct
                    with no prop behind it.
src/selection.ts    selectedNodes (column selections!), midiOfSelection
src/export.ts       musicXml(state), midiFile(state), importMusicXml(state, xml)
src/decorations.ts  ViewPlugins ONLY since M-R0 — chord/selection highlights,
                    directive underlines, prose recession all render pure
                    SNAPSHOT data (build() never touches tree or engine);
                    rebuilds also on snapshot-identity change (closes the
                    stale-after-async-reparse gap)
src/index.ts        tablature() — the whole system as one extension;
                    snapshotOf routes through the snapshotSource FACET
                    (default = local engine; RemoteClient overrides it —
                    every decoration/lint surface swaps origin at once)
tests/adapter.test.ts  E2E on real CM machinery
app/                THE PRODUCT PAGE — FEATURE-COMPLETE over the wire,
                    plus THE DEV SURFACE (2026-07-26): ONE master switch
                    (#dev-toggle / ?dev=1 / ⌥D), four lenses over a
                    permanent context bar — VALUES (claims as bid→outcome,
                    prop rows, detail panel with the chain, the hedged
                    "why it ran" and navigable deps), COST (savings
                    headline + per-PROP runs/ms/reason; diff mode via
                    sincePass), TREE (whole-document base tree, free —
                    lazily rendered, path-keyed expansion), PROBLEMS.
                    OFF COSTS NOTHING (no queries — they are rate-limited
                    120/20s — no timers, no dev DOM), pinned by verify:app.
                    First activity window is UNADDRESSED (an addressed
                    sincePass:0 clamps past the cold pass); later ones name
                    the previous passId.
                    (editor · sheet + tab/standard toggle · full transport
                    with selection-aware playback, ⌖ follow moving BOTH the
                    editor selection and the OSMD cursor · import/export ·
                    samples): codes ONLY against the TabSemantics facade
                    plus the engine-free /client helpers (createPlayer,
                    snapshotOf, sanitizeForOsmd); semantics-mode.ts is the
                    one-line local↔remote swap (both modes proven live).
                    GOTCHA pinned by verify:app: function declarations
                    hoist, their `let` state does not — the first
                    renderSheet() ran before the cursor state existed.
                    Endpoint: ?remote= → VITE_REMOTE_URL → localhost
                    dev-server; worker endpoints mint anonymous tokens.
demo/               the DEV vehicle (engine panes, inspector, playback) —
                    still fat by design; ?remote= + settings toggle for
                    wire-vs-local comparison
```
