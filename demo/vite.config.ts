import { defineConfig } from "vite";

export default defineConfig({
  optimizeDeps: {
    // The @tab-edit/* packages are COPIED installs (install-links) that get
    // refreshed in place without touching the lockfile — Vite's prebundle
    // cache can't see those refreshes and serves STALE parser/plugin code
    // (bit Stan 2026-07-13: fixed bugs kept "reproducing" in a long-running
    // dev server). Never prebundle them.
    exclude: ["@tab-edit/ast", "@tab-edit/plugins", "@tab-edit/parse", "@tab-edit/cm"],
  },
  server: {
    watch: {
      // …and a RUNNING server must also SEE those in-place refreshes: vite
      // ignores node_modules in its watcher, so a refreshed copy kept
      // serving the old module graph until a manual restart (bit Stan
      // 2026-07-14: 'does not provide an export named directiveEntries').
      // Un-ignoring our own packages makes a copy refresh hot-reload.
      ignored: ["!**/node_modules/@tab-edit/**"],
    },
  },
});
