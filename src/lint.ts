// Lint integration: layer.diagnostics → CM lint, with FIXES surfaced as
// lint ACTIONS — clicking one dispatches the fix's edits as a single
// undoable transaction; the reparse + re-lint flow is CM's normal
// incremental pipeline (Stan's inject-and-reparse requirement).

import { linter, type Diagnostic as CmDiagnostic } from "@codemirror/lint";
import type { EditorState, Extension } from "@codemirror/state";
import { snapshotOf } from "./semantics.js";

/** Pure mapping (headless-testable): SNAPSHOT diagnostics → CM shape
 *  (ADR-003 M-R0: the lint source renders snapshot data; the linter's own
 *  delay re-pulls, so it always sees the current tree's snapshot). */
export function tabDiagnostics(state: EditorState): CmDiagnostic[] {
  return (snapshotOf(state)?.diagnostics ?? []).map((d) => ({
    from: d.from,
    to: d.to,
    severity: d.severity,
    message: d.message,
    ...(d.code ? { source: d.code } : {}),
    ...(d.fixes && d.fixes.length > 0
      ? {
          actions: d.fixes.map((fix) => ({
            name: fix.title,
            apply(view: { dispatch(spec: object): void }) {
              view.dispatch({ changes: fix.edits.map((e) => ({ ...e })) });
            },
          })),
        }
      : {}),
  }));
}

/** The lint extension for `tablature()`. */
export function tabLint(): Extension {
  return linter((view) => tabDiagnostics(view.state));
}
