/** @type {import('ts-jest').JestConfigWithTsJest} **/
export default {
  testEnvironment: "node",
  transform: {
    "^.+.tsx?$": ["ts-jest", { useESM: true }],
  },
  extensionsToTreatAsEsm: [".ts"],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  testMatch: ["<rootDir>/tests/**/*.test.ts"],
  modulePathIgnorePatterns: ["<rootDir>/dist/"],
  // SERIAL on purpose (2026-07-16): the remote-suite differentials assert
  // value-level snapshot equality after work-budgeted parses; under 4-way
  // worker parallelism on a loaded machine they flake (isolated runs are
  // deterministic green — same contention lesson as ast's two-phase perf).
  //
  // CORRECTION (2026-07-26): serialisation does NOT cover the failure this
  // comment was reaching for. The Linux CI flake was the state field keeping
  // a TRUNCATED tree after LanguageState.init's 20 ms budget, while suites
  // asserted on ensureSyntaxTree's return value — reproducible on the first
  // COLD parse with one worker, so maxWorkers did nothing for it. That is
  // fixed at the source in tests/force-parse.ts. Keep serial for the
  // contention reason above; do not expect it to protect tree completeness.
  maxWorkers: 1,
};
