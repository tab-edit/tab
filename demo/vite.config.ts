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
});
