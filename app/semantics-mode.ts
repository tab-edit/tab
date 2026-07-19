// THE OPEN-SOURCE FLIP — the entire local↔remote decision lives in this
// file (Stan directive 2026-07-18: going open-source/local-everything must
// be a ~three-line change; this is that change). The app codes against the
// TabSemantics facade only; the bundler follows whichever factory is
// re-exported here, so REMOTE builds contain zero engine code (audited by
// verify-app.cjs) and LOCAL builds bundle the engine and need no server.

// ── REMOTE (the product configuration: engine stays server-side) ──
import { createRemoteSemantics } from "@tab-edit/cm/client";
export const createSemantics = (url: string) => createRemoteSemantics({ url });

// ── LOCAL (open-source / offline: swap to these lines instead) ──
// import { createLocalSemantics } from "@tab-edit/cm";
// export const createSemantics = (_url: string) => createLocalSemantics();
