/**
 * Phase 3 of plans/rfc-0007-first-vote-stands.md (issue #55): the `anomalies`
 * surface — types, fields, `BaseProjection.anomalies`/`recordAnomaly`, and
 * the same `anomalies` field on all five mode projections. Purely additive:
 * nothing populates a `ProjectionAnomaly` yet outside this test file's own
 * synthetic subclass. Phases 4-5 add real detection (Decision `Vote`,
 * Quorum ballots).
 *
 * `BaseProjection.recordAnomaly` has NO caller anywhere else in `src/` for
 * the entire plan: `DecisionProjection` (Phase 4) and `QuorumProjection`
 * (Phase 5) do not extend `BaseProjection` (verified — see `src/projections/
 * base.ts`'s class docblock) and inline their own two lines instead, per the
 * plan's "do not extract a shared helper" call. `recordAnomaly` exists only
 * for ext-mode `BaseProjection` subclasses outside this repo — this file's
 * `SmokeAnomalyProjection` is exactly that kind of consumer.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildEnvelope } from '../../../src/envelope';
import { _resetLoggingForTests, configureLogging, type LogSink } from '../../../src/logging';
import { ProtoRegistry } from '../../../src/proto-registry';
import { BaseProjection, type ProjectionAnomaly } from '../../../src/projections/base';
import { DecisionProjection } from '../../../src/projections/decision';
import { HandoffProjection } from '../../../src/projections/handoff';
import { ProposalProjection } from '../../../src/projections/proposal';
import { QuorumProjection } from '../../../src/projections/quorum';
import { TaskProjection } from '../../../src/projections/task';
import type { ProjectionLike } from '../../../src/agent/types';
import type { Envelope } from '../../../src/types';

const registry = new ProtoRegistry();

afterEach(() => {
  _resetLoggingForTests();
});

// ── BaseProjection.recordAnomaly, via a third-party ext-mode subclass ──────
//
// The five built-in mode projections do NOT extend BaseProjection (they
// inline their own two lines in Phases 4-5), so `recordAnomaly` can only be
// exercised through a subclass like this one — the same shape as an
// out-of-tree ext mode.
const EXT_MODE = 'ext.anomaly-smoke.v1';
const EXPECTED_KIND: ProjectionAnomaly['kind'] = 'duplicate_vote';

class SmokeAnomalyProjection extends BaseProjection {
  protected readonly mode = EXT_MODE;

  protected applyMode(envelope: Envelope): void {
    if (envelope.messageType !== 'DuplicateThing') return;
    this.recordAnomaly({
      kind: EXPECTED_KIND,
      mode: envelope.mode,
      messageType: envelope.messageType,
      messageId: envelope.messageId,
      sender: envelope.sender,
      subjectId: 'subject-1',
      detail: `sender ${envelope.sender} duplicated subject-1`,
    });
  }
}

function makeExtEnvelope(overrides: { sender?: string; messageId?: string } = {}): Envelope {
  return buildEnvelope({
    mode: EXT_MODE,
    messageType: 'DuplicateThing',
    sessionId: 'test-session',
    sender: overrides.sender ?? 'agent-a',
    messageId: overrides.messageId,
    payload: Buffer.alloc(0),
  });
}

describe('BaseProjection.recordAnomaly', () => {
  // Array half and sink half are deliberately separate `it()`s (rather than
  // one test asserting both) so the two non-vacuity mutations (delete the
  // `push` vs. delete the `logger.warn` line) each fail exactly one
  // FULLY-EXECUTED test instead of one mutation short-circuiting past an
  // assertion vitest never got to run — and thus never actually proved —
  // inside a shared test body.
  it('pushes one entry with every field intact (array half only)', () => {
    const sink: LogSink = vi.fn();
    configureLogging({ sink }); // suppress the real console sink; not asserted here
    const projection = new SmokeAnomalyProjection();
    const envelope = makeExtEnvelope({ sender: 'alice', messageId: 'm-1' });

    projection.applyEnvelope(envelope, registry);

    expect(projection.anomalies).toHaveLength(1);
    const anomaly = projection.anomalies[0];
    expect(anomaly).toEqual<ProjectionAnomaly>({
      kind: 'duplicate_vote',
      mode: EXT_MODE,
      messageType: 'DuplicateThing',
      messageId: 'm-1',
      sender: 'alice',
      subjectId: 'subject-1',
      detail: 'sender alice duplicated subject-1',
    });
  });

  it('warns via the injected sink exactly once with the recorded anomaly (sink half only)', () => {
    const sink: LogSink = vi.fn();
    configureLogging({ sink });
    const projection = new SmokeAnomalyProjection();
    const envelope = makeExtEnvelope({ sender: 'alice', messageId: 'm-1' });

    projection.applyEnvelope(envelope, registry);

    expect(sink).toHaveBeenCalledTimes(1);
    const expectedAnomaly: ProjectionAnomaly = {
      kind: 'duplicate_vote',
      mode: EXT_MODE,
      messageType: 'DuplicateThing',
      messageId: 'm-1',
      sender: 'alice',
      subjectId: 'subject-1',
      detail: 'sender alice duplicated subject-1',
    };
    expect(sink).toHaveBeenCalledWith('warn', ['projection anomaly', expectedAnomaly]);
  });

  it('a second call appends rather than replaces; order is preserved (array half only)', () => {
    const projection = new SmokeAnomalyProjection();

    projection.applyEnvelope(makeExtEnvelope({ sender: 'alice', messageId: 'm-1' }), registry);
    projection.applyEnvelope(makeExtEnvelope({ sender: 'bob', messageId: 'm-2' }), registry);

    expect(projection.anomalies).toHaveLength(2);
    expect(projection.anomalies[0].sender).toBe('alice');
    expect(projection.anomalies[0].messageId).toBe('m-1');
    expect(projection.anomalies[1].sender).toBe('bob');
    expect(projection.anomalies[1].messageId).toBe('m-2');
  });

  it('a second call warns via the sink a second time (sink half only)', () => {
    const sink: LogSink = vi.fn();
    configureLogging({ sink });
    const projection = new SmokeAnomalyProjection();

    projection.applyEnvelope(makeExtEnvelope({ sender: 'alice', messageId: 'm-1' }), registry);
    projection.applyEnvelope(makeExtEnvelope({ sender: 'bob', messageId: 'm-2' }), registry);

    expect(sink).toHaveBeenCalledTimes(2);
  });

  it('two instances do not share the anomalies array (guards prototype-shared-array mistakes)', () => {
    configureLogging({ sink: vi.fn() }); // suppress the real console sink
    const a = new SmokeAnomalyProjection();
    const b = new SmokeAnomalyProjection();

    a.applyEnvelope(makeExtEnvelope({ messageId: 'm-1' }), registry);

    expect(a.anomalies).toHaveLength(1);
    expect(b.anomalies).toHaveLength(0);
    expect(a.anomalies).not.toBe(b.anomalies);
  });

  it('hasAnomalies is false on a fresh instance and true after one recordAnomaly call', () => {
    configureLogging({ sink: vi.fn() }); // suppress the real console sink
    const projection = new SmokeAnomalyProjection();
    expect(projection.hasAnomalies).toBe(false);

    projection.applyEnvelope(makeExtEnvelope({ messageId: 'm-1' }), registry);

    expect(projection.hasAnomalies).toBe(true);
  });
});

// ── The five mode projections: additive surface only, nothing populates it ─
//
// Phase 3 is deliberately non-detecting: a fresh instance of every one of
// the six classes must have an empty `anomalies` array and `hasAnomalies ===
// false`. Detection (Decision Vote, Quorum ballots) lands in Phases 4-5.
const MODE_PROJECTION_CASES = [
  { name: 'DecisionProjection', factory: () => new DecisionProjection() },
  { name: 'ProposalProjection', factory: () => new ProposalProjection() },
  { name: 'TaskProjection', factory: () => new TaskProjection() },
  { name: 'HandoffProjection', factory: () => new HandoffProjection() },
  { name: 'QuorumProjection', factory: () => new QuorumProjection() },
] as const;

function syntheticAnomaly(overrides: Partial<ProjectionAnomaly> = {}): ProjectionAnomaly {
  return {
    kind: 'duplicate_vote',
    mode: 'test.mode.v1',
    messageType: 'Vote',
    messageId: 'm-1',
    sender: 'alice',
    subjectId: 'subject-1',
    detail: 'synthetic anomaly pushed directly by the test',
    ...overrides,
  };
}

describe.each(MODE_PROJECTION_CASES)('$name — anomalies surface (additive only)', ({ factory }) => {
  it('a fresh instance has anomalies.length === 0 and hasAnomalies === false', () => {
    const projection = factory();
    expect(projection.anomalies).toHaveLength(0);
    expect(projection.hasAnomalies).toBe(false);
  });

  // `anomalies` is public and mutable (no production change needed to test
  // this): pushing directly onto it is how a caller — or this test — would
  // observe an anomaly recorded by a future detector. This proves each
  // mode's own `hasAnomalies` getter is a real `anomalies.length > 0` check
  // and not, e.g., a hand-copy hardcoded to `false` or reading the wrong
  // field — see the mutation note in docs/guides/testing.md.
  it('hasAnomalies becomes true once a ProjectionAnomaly is pushed onto the public, mutable array', () => {
    const projection = factory();

    projection.anomalies.push(syntheticAnomaly());

    expect(projection.hasAnomalies).toBe(true);
  });

  it('two instances do not share the anomalies array (guards prototype-shared-array mistakes)', () => {
    const a = factory();
    const b = factory();

    a.anomalies.push(syntheticAnomaly());

    expect(a.anomalies).toHaveLength(1);
    expect(b.anomalies).toHaveLength(0);
    expect(a.anomalies).not.toBe(b.anomalies);
  });
});

// ── ProjectionLike: the optional member must not become a breaking change ──
describe('ProjectionLike.anomalies stays optional', () => {
  it('{ phase: "", transcript: [] } satisfies ProjectionLike; `anomalies` reads as undefined at runtime', () => {
    // Runtime sanity check only — this does NOT type-check anything (`tests/`
    // is outside `tsconfig.json`'s `include`, so `tsc -p tsconfig.json` never
    // sees this file). The actual non-vacuous compile-time proof that
    // `anomalies` stays optional is `_ProjectionLikeAnomaliesStaysOptional`
    // in `src/agent/types.ts`, which fails `npm run check` if `anomalies` is
    // ever tightened to required.
    const minimal: ProjectionLike = { phase: '', transcript: [] };
    expect(minimal.anomalies).toBeUndefined();
  });
});
