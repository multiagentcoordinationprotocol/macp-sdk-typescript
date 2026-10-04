/**
 * Executes every `examples/*.ts` file as a real subprocess against a live
 * runtime and asserts a clean exit. `npm run check:examples` only type-checks
 * these files (`tsc --noEmit`) and never runs them -- this is the gap that
 * leaves open (see plans/issue-160-docs-examples-parity.md, Phase 6).
 *
 * `RUN`/`BEARER_GATED`/`EXCLUDED` is a deliberately hardcoded classification,
 * not derived as "everything not excluded": deriving it that way would make
 * the coverage-parity test below a tautology, silently reopening the exact
 * gap this file closes the moment a new, unclassified example is added.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { describe, it, expect } from 'vitest';

const EXAMPLES_DIR = path.join(__dirname, '../../examples');
const ALL_EXAMPLES = fs.readdirSync(EXAMPLES_DIR).filter((f) => f.endsWith('.ts'));

const RUN: string[] = [
  'cancel-callback.ts',
  'decision-smoke.ts',
  'direct-agent-auth-initiator.ts',
  'handoff-smoke.ts',
  'policy-registration.ts',
  'proposal-smoke.ts',
  'quorum-smoke.ts',
  'task-smoke.ts',
  'watch-smoke.ts', // self-terminates via its own 10s internal AbortController timeout
];

// Token-gated, not a runtime-reachability auto-skip (see the "no auto-skip"
// case below) -- mirrors the existing precedent at
// tests/integration/runtime.test.ts:1270 (`describe.skipIf(!ALICE_TOKEN || !BOB_TOKEN)`),
// reusing the same env var names.
const BEARER_GATED: Record<string, string[]> = {
  'bearer-smoke.ts': ['MACP_TEST_BEARER_ALICE', 'MACP_TEST_BEARER_BOB'],
};

const EXCLUDED: Record<string, string> = {
  'direct-agent-auth-observer.ts':
    'requires a concurrently running direct-agent-auth-initiator.ts sharing ' +
    'MACP_SESSION_ID; blocks on stream.responses() with no timeout until a ' +
    'Commitment arrives from that paired process.',
  'agent-policy-aware.ts':
    'subscribes a Participant to a PRE-EXISTING, live session and awaits ' +
    'participant.run() until that session reaches a terminal phase -- it ' +
    'does not create its own session. Standing one up deterministically (a ' +
    'second session-owning process plus something that commits/resolves it) ' +
    'is multi-process orchestration out of scope for this phase; same ' +
    'exclusion category as direct-agent-auth-observer.ts, not a CLI-arg ' +
    'problem solvable with a fresh session id.',
};

function runExample(name: string): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [require.resolve('tsx/cli'), path.join(EXAMPLES_DIR, name)], {
    encoding: 'utf8',
    timeout: 25_000,
    // Drop any ambient MACP_SESSION_ID: direct-agent-auth-initiator.ts reads it
    // as an override (process.env.MACP_SESSION_ID ?? newSessionId()), so a
    // leftover value from a manual paired run in this shell (often uppercase,
    // or already registered with the runtime) fails this test for reasons
    // that have nothing to do with the example itself.
    env: { ...process.env, MACP_SESSION_ID: undefined },
  });
}

function describeFailure(name: string, result: SpawnSyncReturns<string>): string {
  // `result.error` is set by spawnSync itself (ETIMEDOUT past the 25s budget,
  // ENOBUFS past the 1MB default maxBuffer, ENOENT, ...) rather than by the
  // child's own exit -- status/signal alone don't say a timeout happened.
  const spawnError = result.error
    ? `\n--- spawn error ---\n${result.error.code}: ${result.error.message} (25s budget)`
    : '';
  return (
    `${name} exited with status=${result.status} signal=${result.signal}\n` +
    `--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}${spawnError}`
  );
}

describe('example execution', () => {
  it('examples directory matches the expected, known file count', () => {
    // Not >= : this repo's example count is fixed and known. A new file
    // showing up here must be deliberately classified below, not just
    // tolerated by a loose inequality.
    expect(
      ALL_EXAMPLES.length,
      'A new examples/*.ts file was added -- classify it in RUN, BEARER_GATED, or EXCLUDED below, then bump this count',
    ).toBe(12);
  });

  it('every example is classified into RUN, BEARER_GATED, or EXCLUDED', () => {
    const classified = new Set([...RUN, ...Object.keys(BEARER_GATED), ...Object.keys(EXCLUDED)]);
    const actual = new Set(ALL_EXAMPLES);
    const unclassified = ALL_EXAMPLES.filter((f) => !classified.has(f));
    const stale = [...classified].filter((f) => !actual.has(f));
    expect(
      { unclassified, stale },
      'unclassified: add the file to RUN, BEARER_GATED, or EXCLUDED above. ' +
        'stale: remove the deleted/renamed file from whichever list still names it.',
    ).toEqual({ unclassified: [], stale: [] });
  });

  it('every exclusion has a non-empty reason', () => {
    for (const [name, reason] of Object.entries(EXCLUDED)) {
      expect(reason.trim().length, `reason for ${name} must not be empty`).toBeGreaterThan(0);
    }
  });

  // No runtime-reachability auto-skip, by design: this matches
  // tests/integration/runtime.test.ts's own convention (it assumes a runtime
  // is present, per CLAUDE.md's documented local workflow and CI's own
  // readiness-wait step in integration.yml) and fails hard with a clear gRPC
  // error if not, rather than silently skipping. Distinct from the
  // token-gated skip on bearer-smoke.ts below, which is about optional
  // credentials, not runtime presence.
  it.each(RUN)(
    '%s exits 0',
    (name) => {
      const result = runExample(name);
      expect(result.status, describeFailure(name, result)).toBe(0);
    },
    30_000,
  );

  it.skipIf(!process.env.MACP_TEST_BEARER_ALICE || !process.env.MACP_TEST_BEARER_BOB)(
    'bearer-smoke.ts exits 0',
    () => {
      const result = runExample('bearer-smoke.ts');
      expect(result.status, describeFailure('bearer-smoke.ts', result)).toBe(0);
    },
    30_000,
  );
});
