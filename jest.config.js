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
  maxWorkers: 1,
};
