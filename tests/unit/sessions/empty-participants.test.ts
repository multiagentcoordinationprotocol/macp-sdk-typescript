import { afterEach, describe, expect, it, vi } from 'vitest';
import { Auth } from '../../../src/auth';
import { MacpClient } from '../../../src/client';
import { DecisionSession } from '../../../src/decision';
import { MacpSessionError } from '../../../src/errors';
import { HandoffSession } from '../../../src/handoff';
import { ProposalSession } from '../../../src/proposal';
import { QuorumSession } from '../../../src/quorum';
import { TaskSession } from '../../../src/task';

// The runtime accepts an empty `participants` list on SessionStart for
// Decision mode only (macp-runtime `allows_empty_participants`, spec fixture
// `decision_zero_participants.json`); every other mode rejects it. Mirrors
// macp-sdk-python's TestEmptyParticipantsPerMode.

function makeClient(): MacpClient {
  return new MacpClient({
    address: '127.0.0.1:50051',
    secure: false,
    allowInsecure: true,
    auth: Auth.bearer('alice-token', { expectedSender: 'alice' }),
  });
}

interface Startable {
  start(input: { intent: string; participants: string[]; ttlMs: number }): Promise<unknown>;
}

const ALL_SESSIONS: ReadonlyArray<readonly [string, (c: MacpClient) => Startable]> = [
  ['DecisionSession', (c) => new DecisionSession(c)],
  ['ProposalSession', (c) => new ProposalSession(c)],
  ['TaskSession', (c) => new TaskSession(c)],
  ['HandoffSession', (c) => new HandoffSession(c)],
  ['QuorumSession', (c) => new QuorumSession(c)],
];

const NON_DECISION = ALL_SESSIONS.filter(([name]) => name !== 'DecisionSession');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SessionStart with an empty participants list', () => {
  it('DecisionSession.start() accepts [] and sends the SessionStart', async () => {
    const client = makeClient();
    const send = vi.spyOn(client, 'send').mockResolvedValue({ ok: true });
    const session = new DecisionSession(client);

    await expect(session.start({ intent: 'inert', participants: [], ttlMs: 10_000 })).resolves.toMatchObject({
      ok: true,
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each(NON_DECISION)('%s.start() rejects [] and sends nothing', async (_name, make) => {
    const client = makeClient();
    const send = vi.spyOn(client, 'send').mockResolvedValue({ ok: true });

    await expect(make(client).start({ intent: 'x', participants: [], ttlMs: 10_000 })).rejects.toThrow(
      'participants must be non-empty',
    );
    expect(send).not.toHaveBeenCalled();
  });

  it.each(ALL_SESSIONS)('%s.start() still rejects a duplicate participant', async (_name, make) => {
    const client = makeClient();
    const send = vi.spyOn(client, 'send').mockResolvedValue({ ok: true });

    await expect(make(client).start({ intent: 'x', participants: ['bob', 'bob'], ttlMs: 10_000 })).rejects.toThrow(
      MacpSessionError,
    );
    expect(send).not.toHaveBeenCalled();
  });
});
