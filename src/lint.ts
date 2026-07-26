// Lint integration: layer.diagnostics → CM lint, with FIXES surfaced as
// lint ACTIONS — clicking one dispatches the fix's edits as a single
// undoable transaction; the reparse + re-lint flow is CM's normal
// incremental pipeline (Stan's inject-and-reparse requirement).

import { linter, type Diagnostic as CmDiagnostic } from "@codemirror/lint";
import type { EditorState, Extension } from "@codemirror/state";
import { snapshotOf } from "./snapshot-model.js";

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

export interface TabLintOptions {
  /** Let the lint extension put its OWN tooltip over the text on hover
   *  (default true). `tablatureSupport()` turns it off when hover
   *  explanations are installed: those render the same diagnostics — with
   *  the same fix buttons — inside ONE box that also carries what the glyph
   *  was written as, and two boxes over one glyph is exactly the small
   *  incoherence this product refuses. The GUTTER marker's tooltip reads a
   *  separate config and is untouched. */
  readonly textTooltips?: boolean;
}

/** The lint extension for `tablature()`. */
export function tabLint(options: TabLintOptions = {}): Extension {
  return linter(
    (view) => tabDiagnostics(view.state),
    options.textTooltips === false ? { tooltipFilter: () => [] } : {}
  );
}
