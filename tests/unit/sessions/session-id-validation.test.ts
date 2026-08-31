import { describe, expect, it } from 'vitest';
import { Auth } from '../../../src/auth';
import { BaseSession } from '../../../src/base-session';
import { MacpClient } from '../../../src/client';
import { DecisionSession } from '../../../src/decision';
import { MacpSessionError } from '../../../src/errors';
import { HandoffSession } from '../../../src/handoff';
import { BaseProjection } from '../../../src/projections/base';
import type { ProtoRegistry } from '../../../src/proto-registry';
import { ProposalSession } from '../../../src/proposal';
import { QuorumSession } from '../../../src/quorum';
import { TaskSession } from '../../../src/task';
import type { Envelope } from '../../../src/types';

class ExtProjection extends BaseProjection {
  protected readonly mode = 'ext.sid.v1';
  protected applyMode(_envelope: Envelope, _registry: ProtoRegistry): void {}
}

class ExtSession extends BaseSession<ExtProjection> {
  protected readonly mode = 'ext.sid.v1';
  protected createProjection(): ExtProjection {
    return new ExtProjection();
  }
}

function makeClient(): MacpClient {
  return new MacpClient({
    address: '127.0.0.1:50051',
    secure: false,
    allowInsecure: true,
    auth: Auth.bearer('alice-token', { expectedSender: 'alice' }),
  });
}

/**
 * Every session constructor that accepts an optional `sessionId`. `BaseSession`
 * is included via a minimal ext-mode subclass — it carries the same guard and
 * is the documented extension point for custom modes.
 */
const SESSION_CLASSES = [
  ['BaseSession', (c: MacpClient, sessionId?: string) => new ExtSession(c, { sessionId })],
  ['DecisionSession', (c: MacpClient, sessionId?: string) => new DecisionSession(c, { sessionId })],
  ['ProposalSession', (c: MacpClient, sessionId?: string) => new ProposalSession(c, { sessionId })],
  ['TaskSession', (c: MacpClient, sessionId?: string) => new TaskSession(c, { sessionId })],
  ['HandoffSession', (c: MacpClient, sessionId?: string) => new HandoffSession(c, { sessionId })],
  ['QuorumSession', (c: MacpClient, sessionId?: string) => new QuorumSession(c, { sessionId })],
] as const;

describe('session constructors — sessionId validation', () => {
  // The bug this pins (#48): the guard used to be `if (options.sessionId)`, a
  // truthy check. An explicit `''` is falsy, so it skipped validation — and
  // `'' ?? newSessionId()` is `''`, not a fresh id, because empty string is not
  // nullish. The result was an invalid session id reaching the wire.
  it.each(SESSION_CLASSES)('%s rejects an explicit empty-string sessionId', (_name, construct) => {
    expect(() => construct(makeClient(), '')).toThrow(MacpSessionError);
  });

  it.each(SESSION_CLASSES)('%s rejects a malformed sessionId', (_name, construct) => {
    expect(() => construct(makeClient(), 'not-a-uuid-at-all-xx')).toThrow(MacpSessionError);
  });

  it.each(SESSION_CLASSES)('%s generates a fresh UUID when sessionId is omitted', (_name, construct) => {
    expect(construct(makeClient(), undefined).sessionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it.each(SESSION_CLASSES)('%s keeps a valid explicit sessionId', (_name, construct) => {
    const sid = '550e8400-e29b-41d4-a716-446655440000';
    expect(construct(makeClient(), sid).sessionId).toBe(sid);
  });
});
