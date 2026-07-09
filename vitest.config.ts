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
      // Calibrated against the 2026-07 suite (lines 96.05, branches 90.77,
      // functions 92.44, statements 96.05). Floors are current - 2pp; raise
      // them when new tests land. CI gates on these via `npm run test:coverage`.
      thresholds: {
        lines: 94,
        branches: 88,
        functions: 90,
        statements: 94,
      },
    },
  },
});
