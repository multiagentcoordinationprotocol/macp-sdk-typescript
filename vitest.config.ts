import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/integration/**'],
    globals: true,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // Exclude pure type/barrel files — they skew the function percentage
      // without adding meaningful runtime paths to cover.
      exclude: ['src/types.ts', 'src/agent/types.ts', 'src/index.ts', 'src/agent/index.ts', 'src/projections.ts'],
      // `json` + `json-summary` feed the PR coverage comment in CI
      // (davelosert/vitest-coverage-report-action).
      reporter: ['text', 'html', 'json-summary', 'json'],
      // Recalibrated 2026-08 for @vitest/coverage-v8 v4 (lines 94.60, branches
      // 83.87, functions 92.28, statements 93.13). Floors are current - 2pp;
      // raise them when new tests land. CI gates on these via
      // `npm run test:coverage`.
      //
      // These numbers are LOWER than the v3-era floors (94/88/90/94) even
      // though not a single test was removed — the v8 provider was rewritten
      // in Vitest 4 to remap coverage through a rolldown AST instead of
      // v8-to-istanbul, and the old `ignoreEmptyLines` escape hatch was
      // deleted along with it. The new mapping sees branches the old one
      // missed (optional chaining, default parameters, logical short-circuits),
      // so the same suite measures stricter. Treat the v3 and v4 series as two
      // different rulers: do NOT read the drop as a coverage regression, and do
      // NOT try to restore the old numbers by loosening `exclude`.
      thresholds: {
        lines: 92,
        branches: 81,
        functions: 90,
        statements: 91,
      },
    },
  },
});
