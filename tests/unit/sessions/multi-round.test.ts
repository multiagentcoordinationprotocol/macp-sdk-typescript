import { afterEach, describe, expect, it, vi } from 'vitest';
import { Auth } from '../../../src/auth';
import { MacpClient } from '../../../src/client';
import { MULTI_ROUND_CONVERGED_ACTION, MULTI_ROUND_MODE_VERSION, MODE_MULTI_ROUND } from '../../../src/constants';
import { buildContributePayload } from '../../../src/envelope';
import { MacpIdentityMismatchError, MacpSessionError } from '../../../src/errors';
import { MultiRoundSession } from '../../../src/multi-round';
import type { Envelope } from '../../../src/types';

const HASH = `sha256:${'a'.repeat(64)}`;

function makeClient(): MacpClient {
  return new MacpClient({ address: '127.0.0.1:50051', secure: false, allowInsecure: true });
}

/** A session whose SessionStart (from `coordinator`, participants alice and bob) was accepted. */
async function started(participants = ['alice', 'bob']) {
  const client = makeClient();
  const send = vi.spyOn(client, 'send').mockResolvedValue({ ok: true });
  const session = new MultiRoundSession(client, { configurationVersion: 'cfg-1' });
  await session.start({ intent: 'converge', participants, ttlMs: 60_000, sender: 'coordinator' });
  return { client, send, session, sent: () => send.mock.calls.at(-1)![0] as Envelope };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MultiRoundSession', () => {
  it('starts an ext.multi_round.v1 session at mode_version 1.0.0', async () => {
    const { session, sent, client } = await started();
    expect(session.modeVersion).toBe(MULTI_ROUND_MODE_VERSION);
    const envelope = sent();
    expect([envelope.mode, envelope.messageType]).toEqual([MODE_MULTI_ROUND, 'SessionStart']);
    const payload = client.protoRegistry.decodeKnownPayload(envelope.mode, envelope.messageType, envelope.payload);
    expect(payload).toMatchObject({
      modeVersion: '1.0.0',
      configurationVersion: 'cfg-1',
      participants: ['alice', 'bob'],
    });
    expect(session.projection.initiator).toBe('coordinator');
  });

  it('refuses another mode_version before sending', async () => {
    const client = makeClient();
    const send = vi.spyOn(client, 'send');
    const session = new MultiRoundSession(client, { modeVersion: '2.0.0' });
    await expect(session.start({ intent: 'x', participants: ['alice'], ttlMs: 60_000 })).rejects.toThrow(
      MacpSessionError,
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses an empty participants list before sending', async () => {
    const client = makeClient();
    const send = vi.spyOn(client, 'send');
    const session = new MultiRoundSession(client);
    await expect(session.start({ intent: 'x', participants: [], ttlMs: 60_000 })).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it('contributes a canonical protobuf ContributePayload and tracks it', async () => {
    const { session, sent, client } = await started();
    await session.contribute({ value: 'option_a', sender: 'alice' });
    const envelope = sent();
    expect([envelope.messageType, envelope.sender]).toEqual(['Contribute', 'alice']);
    expect(envelope.payload).toEqual(
      client.protoRegistry.encodeMessage('macp.modes.multi_round.v1.ContributePayload', { value: 'option_a' }),
    );
    expect(session.projection.round).toBe(1);
  });

  it('runs the spec example to convergence and commits with the conventional action', async () => {
    const { session, sent, client } = await started();
    await session.contribute({ value: 'option_a', sender: 'alice' });
    await session.contribute({ value: 'option_b', sender: 'bob' });
    await session.contribute({ value: 'option_a', sender: 'bob' });
    expect([session.projection.round, session.projection.converged, session.projection.convergedValue]).toEqual([
      3,
      true,
      'option_a',
    ]);
    await session.commit({ authorityScope: 'rollout', reason: 'converged', sender: 'coordinator' });
    const envelope = sent();
    const payload = client.protoRegistry.decodeKnownPayload(envelope.mode, 'Commitment', envelope.payload);
    expect(payload).toMatchObject({
      action: MULTI_ROUND_CONVERGED_ACTION,
      outcomePositive: true,
      modeVersion: '1.0.0',
      configurationVersion: 'cfg-1',
      policyVersion: 'policy.default',
    });
    expect(session.projection.phase).toBe('Committed');
  });

  it('does not track a NACKed contribution', async () => {
    const { session, send } = await started();
    send.mockResolvedValueOnce({ ok: false, error: { code: 'FORBIDDEN', message: 'no' } } as never);
    await session.contribute({ value: 'v', sender: 'alice' });
    expect(session.projection.round).toBe(0);
  });

  describe('contribute refuses before sending', () => {
    it.each([
      ['an empty value', { value: '', sender: 'alice' }, /non-empty string/],
      ['a non-string value', { value: 5 as never, sender: 'alice' }, /non-empty string/],
      ['a non-participant initiator', { value: 'v', sender: 'coordinator' }, /not a declared participant/],
    ])('%s', async (_name, input, message) => {
      const { session, send } = await started();
      const calls = send.mock.calls.length;
      await expect(session.contribute(input)).rejects.toThrow(MacpSessionError);
      await expect(session.contribute(input)).rejects.toThrow(message);
      expect(send.mock.calls.length).toBe(calls);
    });

    it('after convergence', async () => {
      const { session, send } = await started();
      await session.contribute({ value: 'v', sender: 'alice' });
      await session.contribute({ value: 'v', sender: 'bob' });
      const calls = send.mock.calls.length;
      await expect(session.contribute({ value: 'v', sender: 'alice' })).rejects.toThrow(/converged/);
      expect(send.mock.calls.length).toBe(calls);
    });
  });

  it('lets an initiator that is also a participant contribute', async () => {
    const { session } = await started(['coordinator', 'bob']);
    await expect(session.contribute({ value: 'v', sender: 'coordinator' })).resolves.toEqual({ ok: true });
  });

  it('sends without local checks when it never saw the SessionStart', async () => {
    const client = makeClient();
    const send = vi.spyOn(client, 'send').mockResolvedValue({ ok: true });
    const session = new MultiRoundSession(client, { sessionId: '01JCMRND9Y5P9V4H0A8E0F4Q01' });
    await session.contribute({ value: 'v', sender: 'anyone' });
    await session.commit({ authorityScope: 's', reason: 'r', sender: 'anyone' });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('sends a commit before convergence; the runtime decides', async () => {
    const { session, send } = await started();
    send.mockResolvedValueOnce({ ok: false, error: { code: 'INVALID_ENVELOPE', message: 'not converged' } } as never);
    const ack = await session.commit({ authorityScope: 's', reason: 'r', sender: 'coordinator' });
    expect(ack.ok).toBe(false);
    expect(session.projection.isCommitted).toBe(false);
  });

  describe('commit refuses before sending', () => {
    it.each([
      ['a participant', { authorityScope: 's', reason: 'r', sender: 'alice' }, /only the initiator/],
      ['a blank action', { action: '  ', authorityScope: 's', reason: 'r', sender: 'coordinator' }, /action/],
      ['a blank authorityScope', { authorityScope: ' ', reason: 'r', sender: 'coordinator' }, /authorityScope/],
      ['a blank reason', { authorityScope: 's', reason: '', sender: 'coordinator' }, /reason/],
      [
        'a blank commitmentId',
        { commitmentId: ' ', authorityScope: 's', reason: 'r', sender: 'coordinator' },
        /commitmentId/,
      ],
      [
        'a negative suffix with outcomePositive true',
        { action: 'plan.rejected', outcomePositive: true, authorityScope: 's', reason: 'r', sender: 'coordinator' },
        /negative suffix/,
      ],
      [
        'a positive suffix with outcomePositive false',
        { action: 'plan.approved', outcomePositive: false, authorityScope: 's', reason: 'r', sender: 'coordinator' },
        /positive suffix/,
      ],
      [
        'a supersedes with a blank sessionId',
        {
          supersedes: { sessionId: ' ', commitmentHash: HASH },
          authorityScope: 's',
          reason: 'r',
          sender: 'coordinator',
        },
        /supersedes.sessionId/,
      ],
      [
        'a supersedes with a non-canonical hash',
        {
          supersedes: { sessionId: 'prior', commitmentHash: 'md5:x' },
          authorityScope: 's',
          reason: 'r',
          sender: 'coordinator',
        },
        /commitmentHash/,
      ],
    ])('%s', async (_name, input, message) => {
      const { session, send } = await started();
      const calls = send.mock.calls.length;
      await expect(session.commit(input)).rejects.toThrow(MacpSessionError);
      await expect(session.commit(input)).rejects.toThrow(message);
      expect(send.mock.calls.length).toBe(calls);
    });
  });

  it.each([
    ['multi_round.converged', false],
    ['plan.Rejected', true], // case-sensitive, like the runtime
    ['plan.rejected', false],
  ])('allows action %s with outcomePositive %s', async (action, outcomePositive) => {
    const { session } = await started();
    await expect(
      session.commit({ action, outcomePositive, authorityScope: 's', reason: 'r', sender: 'coordinator' }),
    ).resolves.toEqual({ ok: true });
  });

  it('infers a negative outcome from a negative suffix', async () => {
    const { session, sent, client } = await started();
    await session.commit({ action: 'plan.declined', authorityScope: 's', reason: 'r', sender: 'coordinator' });
    const payload = client.protoRegistry.decodeKnownPayload(MODE_MULTI_ROUND, 'Commitment', sent().payload);
    expect(payload?.outcomePositive ?? false).toBe(false);
  });

  it('sends supersedes and an explicit commitmentId', async () => {
    const { session, sent, client } = await started();
    await session.commit({
      commitmentId: 'cmt-1',
      supersedes: { sessionId: 'prior', commitmentHash: HASH },
      authorityScope: 's',
      reason: 'r',
      sender: 'coordinator',
    });
    const payload = client.protoRegistry.decodeKnownPayload(MODE_MULTI_ROUND, 'Commitment', sent().payload);
    expect(payload).toMatchObject({ commitmentId: 'cmt-1', supersedes: { sessionId: 'prior', commitmentHash: HASH } });
  });

  it('leaves an empty sender to the runtime, which fills it from the credential', async () => {
    const client = new MacpClient({
      address: '127.0.0.1:50051',
      secure: false,
      allowInsecure: true,
      auth: Auth.bearer('t'),
    });
    const send = vi.spyOn(client, 'send').mockResolvedValue({ ok: true });
    const session = new MultiRoundSession(client);
    await session.start({ intent: 'x', participants: ['alice', 'bob'], ttlMs: 60_000, sender: 'coordinator' });
    await session.contribute({ value: 'v' });
    await session.commit({ authorityScope: 's', reason: 'r' });
    expect(send.mock.calls.map(([e]) => (e as Envelope).sender)).toEqual(['coordinator', '', '']);
  });

  it('skips the initiator check when the SessionStart carried an empty sender', async () => {
    const client = new MacpClient({
      address: '127.0.0.1:50051',
      secure: false,
      allowInsecure: true,
      auth: Auth.bearer('t'),
    });
    vi.spyOn(client, 'send').mockResolvedValue({ ok: true });
    const session = new MultiRoundSession(client);
    await session.start({ intent: 'x', participants: ['alice'], ttlMs: 60_000 });
    expect(session.projection.initiator).toBe('');
    await expect(session.commit({ authorityScope: 's', reason: 'r', sender: 'coordinator' })).resolves.toEqual({
      ok: true,
    });
  });

  it('guards the sender identity', async () => {
    const client = new MacpClient({
      address: '127.0.0.1:50051',
      secure: false,
      allowInsecure: true,
      auth: Auth.bearer('t', { expectedSender: 'alice' }),
    });
    const session = new MultiRoundSession(client);
    await expect(session.contribute({ value: 'v', sender: 'bob' })).rejects.toThrow(MacpIdentityMismatchError);
  });
});

describe('buildContributePayload', () => {
  it('builds { value } without validating', () => {
    expect(buildContributePayload('x')).toEqual({ value: 'x' });
    expect(buildContributePayload('')).toEqual({ value: '' });
  });
});
