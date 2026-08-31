/**
 * Phase 2 of plans/rfc-0007-first-vote-stands.md (issue #55): `message_id`
 * dedup at all six `applyEnvelope` entry points, gating `transcript`.
 *
 * Normative basis: RFC-MACP-0006 §3.2 Redelivery.
 * - `:94` — a runtime MAY echo back accepted client-submitted envelopes as
 *   part of the authoritative accepted sequence (the initiator echo is
 *   sanctioned, not a bug).
 * - `:134` — a redelivery MUST NOT advance the client's sequence position.
 * - `:135` — a redelivery MUST NOT count a second time against any Mode
 *   cardinality rule — "a second" means a distinct `message_id`, never the
 *   same envelope arriving twice.
 * - `:136` — a consumer that accumulates state per envelope (appending to a
 *   list, incrementing a counter) MUST be idempotent w.r.t. `message_id`.
 *
 * This is empirically motivated too: `Participant`'s own happy path applies
 * every initiator envelope twice today (local apply-on-ACK via the mode
 * session's private `sendAndTrack`, then again via replayed history in
 * `Participant.processMessage`, onto the SAME projection instance — see
 * `docs/api/projections.md` "Design intent: shared projection instance").
 * Without this dedup, that double-apply corrupts every accumulate-on-apply
 * site: Decision `evaluations`/`objections`, Proposal `accepts`/`rejections`,
 * Task `updates`/`completions`/`failures`.
 *
 * A redelivery is NOT an anomaly (RFC-MACP-0001 §8's at-least-once delivery
 * makes it architecturally expected) — logged at `debug`, never `warn`, and
 * (once Phase 3 lands) never recorded as a `ProjectionAnomaly`. This phase
 * predates the `anomalies` surface, so the "priority regression" below is
 * authored as a placeholder over `evaluations` only; Phases 4-5 extend the
 * same shape to votes and ballots.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MODE_DECISION, MODE_HANDOFF, MODE_PROPOSAL, MODE_QUORUM, MODE_TASK } from '../../../src/constants';
import { buildEnvelope } from '../../../src/envelope';
import { _resetLoggingForTests, configureLogging, type LogSink } from '../../../src/logging';
import { ProtoRegistry } from '../../../src/proto-registry';
import { BaseProjection } from '../../../src/projections/base';
import { DecisionProjection } from '../../../src/projections/decision';
import { HandoffProjection } from '../../../src/projections/handoff';
import { ProposalProjection } from '../../../src/projections/proposal';
import { QuorumProjection } from '../../../src/projections/quorum';
import { TaskProjection } from '../../../src/projections/task';
import type { Envelope } from '../../../src/types';

const registry = new ProtoRegistry();

function makeEnvelope(
  mode: string,
  messageType: string,
  payload: Record<string, unknown>,
  opts: { sender?: string; messageId?: string } = {},
): Envelope {
  return buildEnvelope({
    mode,
    messageType,
    sessionId: 'test-session',
    sender: opts.sender ?? 'agent-a',
    messageId: opts.messageId,
    payload: registry.encodeKnownPayload(mode, messageType, payload),
  });
}

afterEach(() => {
  _resetLoggingForTests();
});

// ── Basic dedup, across all five built-in mode projections ────────────────
//
// Each of these is a "site" per the plan's Files list: DecisionProjection,
// ProposalProjection, TaskProjection, HandoffProjection, QuorumProjection —
// the sixth site, BaseProjection, is covered separately below via a
// third-party subclass (the five mode projections do NOT extend it).
const MODE_CASES = [
  {
    name: 'DecisionProjection',
    mode: MODE_DECISION,
    factory: () => new DecisionProjection(),
    messageType: 'Proposal',
    payload: { proposalId: 'p1', option: 'a' },
  },
  {
    name: 'ProposalProjection',
    mode: MODE_PROPOSAL,
    factory: () => new ProposalProjection(),
    messageType: 'Proposal',
    payload: { proposalId: 'p1', title: 'Plan A' },
  },
  {
    name: 'TaskProjection',
    mode: MODE_TASK,
    factory: () => new TaskProjection(),
    messageType: 'TaskRequest',
    payload: { taskId: 't1', title: 'Build feature', instructions: 'implement it' },
  },
  {
    name: 'HandoffProjection',
    mode: MODE_HANDOFF,
    factory: () => new HandoffProjection(),
    messageType: 'HandoffOffer',
    payload: { handoffId: 'h1', targetParticipant: 'bob', scope: 'frontend' },
  },
  {
    name: 'QuorumProjection',
    mode: MODE_QUORUM,
    factory: () => new QuorumProjection(),
    messageType: 'ApprovalRequest',
    payload: { requestId: 'r1', action: 'deploy', summary: 'deploy v2', requiredApprovals: 2 },
  },
] as const;

describe.each(MODE_CASES)('$name — applyEnvelope message_id dedup', ({ mode, factory, messageType, payload }) => {
  it('applying the SAME envelope object twice yields transcript.length === 1', () => {
    const projection = factory();
    const envelope = makeEnvelope(mode, messageType, payload, { messageId: 'm-dup' });

    projection.applyEnvelope(envelope, registry);
    projection.applyEnvelope(envelope, registry);

    expect(projection.transcript).toHaveLength(1);
  });

  it('two independently-built envelopes with an explicit, REUSED messageId collapse to transcript.length === 1', () => {
    // Deliberately explicit + reused (never buildEnvelope's auto-minted id):
    // an auto-minted id exercises the cardinality path, not the dedup path,
    // and would pass while testing nothing.
    const projection = factory();
    const first = makeEnvelope(mode, messageType, payload, { messageId: 'm-shared' });
    const second = makeEnvelope(mode, messageType, payload, { messageId: 'm-shared' });

    projection.applyEnvelope(first, registry);
    projection.applyEnvelope(second, registry);

    expect(projection.transcript).toHaveLength(1);
  });

  it('two envelopes with DISTINCT messageIds and identical payloads both apply — transcript.length === 2', () => {
    const projection = factory();
    const first = makeEnvelope(mode, messageType, payload, { messageId: 'm-1' });
    const second = makeEnvelope(mode, messageType, payload, { messageId: 'm-2' });

    projection.applyEnvelope(first, registry);
    projection.applyEnvelope(second, registry);

    expect(projection.transcript).toHaveLength(2);
  });

  it('two envelopes with messageId: "" both apply — empty ids are never deduped', () => {
    const projection = factory();
    const first = makeEnvelope(mode, messageType, payload, { messageId: '' });
    const second = makeEnvelope(mode, messageType, payload, { messageId: '' });

    projection.applyEnvelope(first, registry);
    projection.applyEnvelope(second, registry);

    expect(projection.transcript).toHaveLength(2);
  });
});

// ── The seven accumulate-on-apply sites ────────────────────────────────────
//
// Map-keyed records (votes, ballots) mask a double-apply; these seven do
// not. A redelivery of the same message_id must not duplicate any of them.
describe('redelivery does not duplicate an accumulate-on-apply site', () => {
  it('Decision.evaluations', () => {
    const projection = new DecisionProjection();
    projection.applyEnvelope(
      makeEnvelope(MODE_DECISION, 'Proposal', { proposalId: 'p1', option: 'a' }, { messageId: 'm-proposal' }),
      registry,
    );
    const evaluation = makeEnvelope(
      MODE_DECISION,
      'Evaluation',
      { proposalId: 'p1', recommendation: 'approve', confidence: 0.9 },
      { sender: 'bob', messageId: 'm-eval' },
    );

    projection.applyEnvelope(evaluation, registry);
    projection.applyEnvelope(evaluation, registry); // redelivery

    expect(projection.evaluations).toHaveLength(1);
  });

  it('Decision.objections', () => {
    const projection = new DecisionProjection();
    projection.applyEnvelope(
      makeEnvelope(MODE_DECISION, 'Proposal', { proposalId: 'p1', option: 'a' }, { messageId: 'm-proposal' }),
      registry,
    );
    const objection = makeEnvelope(
      MODE_DECISION,
      'Objection',
      { proposalId: 'p1', reason: 'risky', severity: 'critical' },
      { sender: 'bob', messageId: 'm-obj' },
    );

    projection.applyEnvelope(objection, registry);
    projection.applyEnvelope(objection, registry); // redelivery

    expect(projection.objections).toHaveLength(1);
  });

  it('Proposal.accepts', () => {
    const projection = new ProposalProjection();
    projection.applyEnvelope(
      makeEnvelope(MODE_PROPOSAL, 'Proposal', { proposalId: 'p1', title: 'X' }, { messageId: 'm-proposal' }),
      registry,
    );
    const accept = makeEnvelope(
      MODE_PROPOSAL,
      'Accept',
      { proposalId: 'p1', reason: 'looks good' },
      { sender: 'bob', messageId: 'm-accept' },
    );

    projection.applyEnvelope(accept, registry);
    projection.applyEnvelope(accept, registry); // redelivery

    expect(projection.accepts).toHaveLength(1);
  });

  it('Proposal.rejections', () => {
    const projection = new ProposalProjection();
    projection.applyEnvelope(
      makeEnvelope(MODE_PROPOSAL, 'Proposal', { proposalId: 'p1', title: 'X' }, { messageId: 'm-proposal' }),
      registry,
    );
    const reject = makeEnvelope(
      MODE_PROPOSAL,
      'Reject',
      { proposalId: 'p1', terminal: false, reason: 'not yet' },
      { sender: 'bob', messageId: 'm-reject' },
    );

    projection.applyEnvelope(reject, registry);
    projection.applyEnvelope(reject, registry); // redelivery

    expect(projection.rejections).toHaveLength(1);
  });

  it('Task.updates', () => {
    const projection = new TaskProjection();
    projection.applyEnvelope(
      makeEnvelope(
        MODE_TASK,
        'TaskRequest',
        { taskId: 't1', title: 'X', instructions: 'do' },
        { messageId: 'm-request' },
      ),
      registry,
    );
    projection.applyEnvelope(
      makeEnvelope(MODE_TASK, 'TaskAccept', { taskId: 't1', assignee: 'w' }, { sender: 'w', messageId: 'm-accept' }),
      registry,
    );
    const update = makeEnvelope(
      MODE_TASK,
      'TaskUpdate',
      { taskId: 't1', status: 'working', progress: 0.5, message: 'halfway' },
      { sender: 'w', messageId: 'm-update' },
    );

    projection.applyEnvelope(update, registry);
    projection.applyEnvelope(update, registry); // redelivery

    expect(projection.updates).toHaveLength(1);
  });

  it('Task.completions', () => {
    const projection = new TaskProjection();
    projection.applyEnvelope(
      makeEnvelope(
        MODE_TASK,
        'TaskRequest',
        { taskId: 't1', title: 'X', instructions: 'do' },
        { messageId: 'm-request' },
      ),
      registry,
    );
    projection.applyEnvelope(
      makeEnvelope(MODE_TASK, 'TaskAccept', { taskId: 't1', assignee: 'w' }, { sender: 'w', messageId: 'm-accept' }),
      registry,
    );
    const complete = makeEnvelope(
      MODE_TASK,
      'TaskComplete',
      { taskId: 't1', assignee: 'w', summary: 'done' },
      { sender: 'w', messageId: 'm-complete' },
    );

    projection.applyEnvelope(complete, registry);
    projection.applyEnvelope(complete, registry); // redelivery

    expect(projection.completions).toHaveLength(1);
  });

  it('Task.failures', () => {
    const projection = new TaskProjection();
    projection.applyEnvelope(
      makeEnvelope(
        MODE_TASK,
        'TaskRequest',
        { taskId: 't1', title: 'X', instructions: 'do' },
        { messageId: 'm-request' },
      ),
      registry,
    );
    projection.applyEnvelope(
      makeEnvelope(MODE_TASK, 'TaskAccept', { taskId: 't1', assignee: 'w' }, { sender: 'w', messageId: 'm-accept' }),
      registry,
    );
    const fail = makeEnvelope(
      MODE_TASK,
      'TaskFail',
      { taskId: 't1', assignee: 'w', errorCode: 'E1', reason: 'crash', retryable: true },
      { sender: 'w', messageId: 'm-fail' },
    );

    projection.applyEnvelope(fail, registry);
    projection.applyEnvelope(fail, registry); // redelivery

    expect(projection.failures).toHaveLength(1);
  });
});

// ── THE PRIORITY REGRESSION ────────────────────────────────────────────────
//
// A redelivery must NOT be treated as a duplicate/anomaly. `ProjectionAnomaly`
// doesn't exist yet (Phase 3), so this is written now over `evaluations` as a
// placeholder and is EXTENDED in Phases 4-5 to cover votes and ballots. This
// is the assertion that would fail loudly if a later "simplification" turned
// dedup into anomaly detection.
describe('THE PRIORITY REGRESSION: a redelivery is not a duplicate/anomaly (placeholder, extended in Phases 4-5)', () => {
  it('a redelivered Evaluation emits no warn and leaves evaluations.length === 1', () => {
    const sink: LogSink = vi.fn();
    configureLogging({ sink }); // default level 'warn' — a warn call would still reach this sink
    const projection = new DecisionProjection();
    projection.applyEnvelope(
      makeEnvelope(MODE_DECISION, 'Proposal', { proposalId: 'p1', option: 'a' }, { messageId: 'm-proposal' }),
      registry,
    );
    const evaluation = makeEnvelope(
      MODE_DECISION,
      'Evaluation',
      { proposalId: 'p1', recommendation: 'approve', confidence: 0.9 },
      { sender: 'bob', messageId: 'm-eval' },
    );

    projection.applyEnvelope(evaluation, registry);
    projection.applyEnvelope(evaluation, registry); // redelivery, NOT a genuine duplicate

    expect(projection.evaluations).toHaveLength(1);
    expect(sink).not.toHaveBeenCalledWith('warn', expect.anything());
  });
});

// ── debug, never warn ───────────────────────────────────────────────────────
describe('redelivery logging', () => {
  it('logs at debug level, never warn (default level "warn" suppresses debug — must configure level: "debug")', () => {
    const sink: LogSink = vi.fn();
    configureLogging({ level: 'debug', sink });
    const projection = new DecisionProjection();
    const envelope = makeEnvelope(MODE_DECISION, 'Proposal', { proposalId: 'p1', option: 'a' }, { messageId: 'm-dup' });

    projection.applyEnvelope(envelope, registry);
    projection.applyEnvelope(envelope, registry); // redelivery

    const calls = (sink as unknown as { mock: { calls: [string, unknown[]][] } }).mock.calls;
    const warnCalls = calls.filter(([level]) => level === 'warn');
    const debugCalls = calls.filter(([level]) => level === 'debug');

    expect(warnCalls).toHaveLength(0);
    expect(debugCalls).toHaveLength(1);
    expect(debugCalls[0]![1][0]).toBe('projection redelivery ignored');
  });

  it('at the SDK default level (warn), a redelivery produces zero sink calls (debug is suppressed)', () => {
    // This is deliberately NOT how the "logs at debug" test above is written —
    // it exists to document the suppression, not to (mis)prove debug fired.
    const sink: LogSink = vi.fn();
    configureLogging({ sink }); // level left at default ('warn')
    const projection = new DecisionProjection();
    const envelope = makeEnvelope(MODE_DECISION, 'Proposal', { proposalId: 'p1', option: 'a' }, { messageId: 'm-dup' });

    projection.applyEnvelope(envelope, registry);
    projection.applyEnvelope(envelope, registry); // redelivery

    expect(sink).not.toHaveBeenCalled();
  });
});

// ── Third-party extensibility guard ────────────────────────────────────────
//
// The dedup guard sits in BaseProjection.applyEnvelope BEFORE the call to
// applyMode (src/projections/base.ts), so a redelivered envelope is shielded
// without the subclass doing anything. This is the only reason the change is
// safe for out-of-tree/ext modes that never see this PR.
const EXT_MODE = 'ext.smoke.v1';

class SmokeProjection extends BaseProjection {
  protected readonly mode = EXT_MODE;
  readonly events: string[] = [];

  protected applyMode(envelope: Envelope): void {
    this.events.push(envelope.messageType);
  }
}

describe('BaseProjection: third-party subclass is shielded from redelivery', () => {
  it('a redelivered envelope is absorbed without the subclass implementing any dedup itself', () => {
    const projection = new SmokeProjection();
    const envelope = buildEnvelope({
      mode: EXT_MODE,
      messageType: 'SomeExtEvent',
      sessionId: 'test-session',
      sender: 'agent-a',
      messageId: 'm-ext',
      payload: Buffer.alloc(0),
    });

    projection.applyEnvelope(envelope, registry);
    projection.applyEnvelope(envelope, registry); // redelivery

    expect(projection.events).toHaveLength(1);
    expect(projection.transcript).toHaveLength(1);
  });

  it('two envelopes with messageId: "" both apply — empty ids are never deduped', () => {
    const projection = new SmokeProjection();
    const makeExt = () =>
      buildEnvelope({
        mode: EXT_MODE,
        messageType: 'SomeExtEvent',
        sessionId: 'test-session',
        sender: 'agent-a',
        messageId: '',
        payload: Buffer.alloc(0),
      });

    projection.applyEnvelope(makeExt(), registry);
    projection.applyEnvelope(makeExt(), registry);

    expect(projection.transcript).toHaveLength(2);
    expect(projection.events).toHaveLength(2);
  });
});

// ── End-to-end echo test ────────────────────────────────────────────────────
//
// Simulates the live shape from the DECISIVE FINDING: a mode session's own
// private sendAndTrack applies an envelope locally on ACK, then the SAME
// envelope (same message_id) arrives again via replayed transport history
// and is applied a second time to the SAME projection instance.
describe('end-to-end echo (sendAndTrack apply-on-ACK, then replay)', () => {
  it('transcript and the evaluations accumulate site both stay at 1 across the echo', () => {
    const projection = new DecisionProjection();
    projection.applyEnvelope(
      makeEnvelope(MODE_DECISION, 'Proposal', { proposalId: 'p1', option: 'a' }, { messageId: 'm-proposal' }),
      registry,
    );
    const evaluation = makeEnvelope(
      MODE_DECISION,
      'Evaluation',
      { proposalId: 'p1', recommendation: 'approve', confidence: 0.9 },
      { sender: 'bob', messageId: 'm-eval' },
    );

    // Local apply-on-ACK (sendAndTrack).
    projection.applyEnvelope(evaluation, registry);
    // Later replay of the same accepted history onto the same instance.
    projection.applyEnvelope(evaluation, registry);

    expect(projection.transcript).toHaveLength(2); // Proposal + Evaluation, once each
    expect(projection.evaluations).toHaveLength(1);
  });
});
