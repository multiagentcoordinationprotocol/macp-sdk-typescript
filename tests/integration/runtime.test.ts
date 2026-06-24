/**
 * Integration tests against a live MACP runtime.
 *
 * Prerequisites:
 *   docker run -d --name macp-runtime-test -p 50051:50051 \
 *     -e MACP_BIND_ADDR=0.0.0.0:50051 -e MACP_ALLOW_INSECURE=1 \
 *     -e MACP_ALLOW_DEV_SENDER_HEADER=1 -e MACP_MEMORY_ONLY=1 macp-runtime
 *
 * For the Bearer-token sections, also set `MACP_AUTH_TOKENS_JSON` on the
 * runtime so alice/bob have real identities — see tests/integration/README.md.
 *
 * Run:
 *   npm run test:integration
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  Auth,
  MacpClient,
  DecisionSession,
  MacpIdentityMismatchError,
  ProposalSession,
  TaskSession,
  HandoffSession,
  QuorumSession,
  SessionLifecycleWatcher,
  buildDecisionPolicy,
  newSessionId,
} from '../../src/index';

const RUNTIME_ADDRESS = process.env.MACP_RUNTIME_ADDRESS ?? 'localhost:50051';

const agentAlice = Auth.devAgent('alice');
const agentBob = Auth.devAgent('bob');

/**
 * Build a new MacpClient for local tests. Use for isolated describe blocks that
 * want their own connection; the shared `client` singleton below is fine for
 * the happy-path suites but do not mutate it.
 */
function makeClient(auth = agentAlice): MacpClient {
  return new MacpClient({
    address: RUNTIME_ADDRESS,
    secure: false,
    allowInsecure: true,
    auth,
  });
}

let client: MacpClient;

beforeAll(() => {
  client = makeClient();
});

afterAll(() => {
  client.close();
});

// ── Client basics ────────────────────────────────────────────────────

describe('MacpClient', () => {
  it('initialize handshake', async () => {
    const result = await client.initialize(5000);
    expect(result.selectedProtocolVersion).toBe('1.0');
    expect(result.runtimeInfo).toBeDefined();
  });

  it('listModes returns built-in modes', async () => {
    const { modes } = await client.listModes(5000);
    const names = modes.map((m) => m.mode);
    expect(names).toContain('macp.mode.decision.v1');
    expect(names).toContain('macp.mode.proposal.v1');
    expect(names).toContain('macp.mode.task.v1');
    expect(names).toContain('macp.mode.handoff.v1');
    expect(names).toContain('macp.mode.quorum.v1');
  });

  it('listRoots', async () => {
    const { roots } = await client.listRoots(5000);
    expect(Array.isArray(roots)).toBe(true);
  });
});

// ── Decision mode ────────────────────────────────────────────────────

describe('Decision mode — happy path', () => {
  let session: DecisionSession;

  it('starts a session', async () => {
    session = new DecisionSession(client, { auth: agentAlice });
    const ack = await session.start({
      intent: 'Choose a framework',
      participants: ['alice', 'bob'],
      ttlMs: 30_000,
      sender: 'alice',
    });
    expect(ack.ok).toBe(true);
  });

  it('proposes an option', async () => {
    const ack = await session.propose({
      proposalId: 'p1',
      option: 'React',
      rationale: 'Popular and well-supported',
      sender: 'alice',
    });
    expect(ack.ok).toBe(true);
  });

  it('evaluates the proposal', async () => {
    const ack = await session.evaluate({
      proposalId: 'p1',
      recommendation: 'APPROVE',
      confidence: 0.9,
      reason: 'Solid choice',
      sender: 'bob',
      auth: agentBob,
    });
    expect(ack.ok).toBe(true);
  });

  it('votes on the proposal', async () => {
    const ack = await session.vote({
      proposalId: 'p1',
      vote: 'approve',
      reason: 'I agree',
      sender: 'bob',
      auth: agentBob,
    });
    expect(ack.ok).toBe(true);
  });

  it('commits the decision', async () => {
    const ack = await session.commit({
      action: 'Use React',
      authorityScope: 'team',
      reason: 'Unanimous approval',
      sender: 'alice',
    });
    expect(ack.ok).toBe(true);
  });

  it('retrieves session metadata + projection reflects commitment', async () => {
    const { metadata } = await session.metadata();
    expect(metadata.sessionId).toBe(session.sessionId);
    expect(metadata.mode).toBe('macp.mode.decision.v1');
    expect(session.projection.isCommitted).toBe(true);
    expect(session.projection.voteTotals()).toEqual({ p1: 1 });
  });
});

// ── Proposal mode ────────────────────────────────────────────────────

describe('Proposal mode — happy path', () => {
  let session: ProposalSession;

  it('starts and proposes', async () => {
    session = new ProposalSession(client, { auth: agentAlice });
    const startAck = await session.start({
      intent: 'API design',
      participants: ['alice', 'bob'],
      ttlMs: 30_000,
      sender: 'alice',
    });
    expect(startAck.ok).toBe(true);

    const propAck = await session.propose({
      proposalId: 'pp1',
      title: 'REST endpoints',
      summary: 'Standard REST API',
      sender: 'alice',
    });
    expect(propAck.ok).toBe(true);
  });

  it('both parties accept the proposal', async () => {
    const ackBob = await session.accept({
      proposalId: 'pp1',
      reason: 'Looks good',
      sender: 'bob',
      auth: agentBob,
    });
    expect(ackBob.ok).toBe(true);

    const ackAlice = await session.accept({
      proposalId: 'pp1',
      reason: 'Agreed',
      sender: 'alice',
    });
    expect(ackAlice.ok).toBe(true);
  });

  it('commits', async () => {
    const ack = await session.commit({
      action: 'Implement REST API',
      authorityScope: 'team',
      reason: 'Accepted by all',
      sender: 'alice',
    });
    expect(ack.ok).toBe(true);
    expect(session.projection.isCommitted).toBe(true);
    // ProposalProjection tracks accepts in a dedicated list; status stays 'open'
    // unless a Withdraw / terminal Reject arrives.
    const acceptsForPp1 = session.projection.accepts.filter((a) => a.proposalId === 'pp1');
    expect(acceptsForPp1.map((a) => a.sender).sort()).toEqual(['alice', 'bob']);
  });
});

// ── Proposal mode — reject path ──────────────────────────────────────

describe('Proposal mode — reject path', () => {
  it('rejects and withdraws', async () => {
    const session = new ProposalSession(client, { auth: agentAlice });
    await session.start({
      intent: 'DB choice',
      participants: ['alice', 'bob'],
      ttlMs: 30_000,
      sender: 'alice',
    });

    await session.propose({
      proposalId: 'rp1',
      title: 'Use MongoDB',
      summary: 'NoSQL approach',
      sender: 'alice',
    });

    const rejectAck = await session.reject({
      proposalId: 'rp1',
      reason: 'Need relational',
      sender: 'bob',
      auth: agentBob,
    });
    expect(rejectAck.ok).toBe(true);

    const withdrawAck = await session.withdraw({
      proposalId: 'rp1',
      reason: 'Withdrawing per feedback',
      sender: 'alice',
    });
    expect(withdrawAck.ok).toBe(true);

    // Projection must reflect the terminal state — not just the Ack trail.
    expect(session.projection.rejections.some((r) => r.proposalId === 'rp1')).toBe(true);
    expect(session.projection.proposals.get('rp1')?.status).toBe('withdrawn');
    const { metadata } = await session.metadata();
    expect(metadata.sessionId).toBe(session.sessionId);
  });
});

// ── Task mode ────────────────────────────────────────────────────────

describe('Task mode — happy path', () => {
  let session: TaskSession;

  it('starts and requests a task', async () => {
    session = new TaskSession(client, { auth: agentAlice });
    const startAck = await session.start({
      intent: 'Code review',
      participants: ['alice', 'bob'],
      ttlMs: 30_000,
      sender: 'alice',
    });
    expect(startAck.ok).toBe(true);

    const reqAck = await session.requestTask({
      taskId: 't1',
      title: 'Review PR #42',
      instructions: 'Check for security issues',
      requestedAssignee: 'bob',
      sender: 'alice',
    });
    expect(reqAck.ok).toBe(true);
  });

  it('accepts the task', async () => {
    const ack = await session.acceptTask({
      taskId: 't1',
      assignee: 'bob',
      sender: 'bob',
      auth: agentBob,
    });
    expect(ack.ok).toBe(true);
  });

  it('updates progress', async () => {
    const ack = await session.updateTask({
      taskId: 't1',
      status: 'in_progress',
      progress: 0.5,
      message: 'Reviewing files',
      sender: 'bob',
      auth: agentBob,
    });
    expect(ack.ok).toBe(true);
  });

  it('completes the task', async () => {
    const ack = await session.completeTask({
      taskId: 't1',
      assignee: 'bob',
      output: Buffer.from('No issues found'),
      sender: 'bob',
      auth: agentBob,
    });
    expect(ack.ok).toBe(true);
  });

  it('commits', async () => {
    const ack = await session.commit({
      action: 'Task completed',
      authorityScope: 'team',
      reason: 'Review finished',
      sender: 'alice',
    });
    expect(ack.ok).toBe(true);
    expect(session.projection.isCommitted).toBe(true);
    expect(session.projection.tasks.get('t1')?.status).toBe('completed');
  });
});

// ── Task mode — reject path ─────────────────────────────────────────

describe('Task mode — reject path', () => {
  it('rejects a task', async () => {
    const session = new TaskSession(client, { auth: agentAlice });
    await session.start({
      intent: 'Urgent fix',
      participants: ['alice', 'bob'],
      ttlMs: 30_000,
      sender: 'alice',
    });

    await session.requestTask({
      taskId: 'tr1',
      title: 'Fix prod bug',
      instructions: 'Investigate crash',
      requestedAssignee: 'bob',
      sender: 'alice',
    });

    const ack = await session.rejectTask({
      taskId: 'tr1',
      assignee: 'bob',
      reason: 'Not my area',
      sender: 'bob',
      auth: agentBob,
    });
    expect(ack.ok).toBe(true);
    expect(session.projection.tasks.get('tr1')?.status).toBe('rejected');
  });
});

// ── Task mode — fail path ────────────────────────────────────────────

describe('Task mode — fail path', () => {
  it('fails a task after accepting', async () => {
    const session = new TaskSession(client, { auth: agentAlice });
    await session.start({
      intent: 'Deploy',
      participants: ['alice', 'bob'],
      ttlMs: 30_000,
      sender: 'alice',
    });

    await session.requestTask({
      taskId: 'tf1',
      title: 'Deploy v2',
      instructions: 'Deploy to staging',
      requestedAssignee: 'bob',
      sender: 'alice',
    });

    await session.acceptTask({ taskId: 'tf1', assignee: 'bob', sender: 'bob', auth: agentBob });

    const ack = await session.failTask({
      taskId: 'tf1',
      assignee: 'bob',
      reason: 'Staging down',
      sender: 'bob',
      auth: agentBob,
    });
    expect(ack.ok).toBe(true);
    expect(session.projection.tasks.get('tf1')?.status).toBe('failed');
    expect(session.projection.failures.some((f) => f.taskId === 'tf1')).toBe(true);
    expect(session.projection.phase).toBe('Failed');
  });
});

// ── Handoff mode ─────────────────────────────────────────────────────

describe('Handoff mode — happy path', () => {
  let session: HandoffSession;

  it('starts and offers handoff', async () => {
    session = new HandoffSession(client, { auth: agentAlice });
    const startAck = await session.start({
      intent: 'Transfer ownership',
      participants: ['alice', 'bob'],
      ttlMs: 30_000,
      sender: 'alice',
    });
    expect(startAck.ok).toBe(true);

    const offerAck = await session.offer({
      handoffId: 'h1',
      targetParticipant: 'bob',
      scope: 'frontend module',
      sender: 'alice',
    });
    expect(offerAck.ok).toBe(true);
  });

  it('adds context', async () => {
    const ack = await session.addContext({
      handoffId: 'h1',
      contentType: 'application/json',
      context: Buffer.from(JSON.stringify({ docs: 'wiki/frontend' })),
      sender: 'alice',
    });
    expect(ack.ok).toBe(true);
  });

  it('accepts the handoff', async () => {
    const ack = await session.acceptHandoff({
      handoffId: 'h1',
      acceptedBy: 'bob',
      sender: 'bob',
      auth: agentBob,
    });
    expect(ack.ok).toBe(true);
  });

  it('commits', async () => {
    const ack = await session.commit({
      action: 'Handoff accepted',
      authorityScope: 'team',
      reason: 'Smooth transition',
      sender: 'alice',
    });
    expect(ack.ok).toBe(true);
    expect(session.projection.isCommitted).toBe(true);
    expect(session.projection.isAccepted('h1')).toBe(true);
  });
});

// ── Handoff mode — decline path ──────────────────────────────────────

describe('Handoff mode — decline path', () => {
  it('declines a handoff', async () => {
    const session = new HandoffSession(client, { auth: agentAlice });
    await session.start({
      intent: 'Transfer DB ownership',
      participants: ['alice', 'bob'],
      ttlMs: 30_000,
      sender: 'alice',
    });

    await session.offer({
      handoffId: 'hd1',
      targetParticipant: 'bob',
      scope: 'database module',
      sender: 'alice',
    });

    const ack = await session.decline({
      handoffId: 'hd1',
      declinedBy: 'bob',
      reason: 'Too busy',
      sender: 'bob',
      auth: agentBob,
    });
    expect(ack.ok).toBe(true);
    expect(session.projection.isDeclined('hd1')).toBe(true);
    expect(session.projection.isAccepted('hd1')).toBe(false);
  });
});

// ── Quorum mode ──────────────────────────────────────────────────────

describe('Quorum mode — happy path', () => {
  let session: QuorumSession;

  it('starts and requests approval', async () => {
    session = new QuorumSession(client, { auth: agentAlice });
    const startAck = await session.start({
      intent: 'Approve release',
      participants: ['alice', 'bob'],
      ttlMs: 30_000,
      sender: 'alice',
    });
    expect(startAck.ok).toBe(true);

    const reqAck = await session.requestApproval({
      requestId: 'q1',
      action: 'Release v2.0',
      summary: 'Cut the release',
      requiredApprovals: 1,
      sender: 'alice',
    });
    expect(reqAck.ok).toBe(true);
  });

  it('approves', async () => {
    const ack = await session.approve({
      requestId: 'q1',
      reason: 'Tests pass',
      sender: 'bob',
      auth: agentBob,
    });
    expect(ack.ok).toBe(true);
  });

  it('commits', async () => {
    const ack = await session.commit({
      action: 'Release approved',
      authorityScope: 'team',
      reason: 'Quorum reached',
      sender: 'alice',
    });
    expect(ack.ok).toBe(true);
    expect(session.projection.isCommitted).toBe(true);
    expect(session.projection.hasQuorum('q1')).toBe(true);
    expect(session.projection.approvalCount('q1')).toBeGreaterThanOrEqual(1);
  });
});

// ── Quorum mode — reject/abstain ─────────────────────────────────────

describe('Quorum mode — reject and abstain', () => {
  it('rejects an approval request', async () => {
    const session = new QuorumSession(client, { auth: agentAlice });
    await session.start({
      intent: 'Approve hotfix',
      participants: ['alice', 'bob'],
      ttlMs: 30_000,
      sender: 'alice',
    });

    await session.requestApproval({
      requestId: 'qr1',
      action: 'Hotfix deploy',
      summary: 'Emergency patch',
      requiredApprovals: 1,
      sender: 'alice',
    });

    const ack = await session.reject({
      requestId: 'qr1',
      reason: 'Not ready',
      sender: 'bob',
      auth: agentBob,
    });
    expect(ack.ok).toBe(true);
    expect(session.projection.hasQuorum('qr1')).toBe(false);
    expect(session.projection.votedSenders('qr1')).toContain('bob');
  });

  it('abstains from an approval request', async () => {
    const session = new QuorumSession(client, { auth: agentAlice });
    await session.start({
      intent: 'Approve budget',
      participants: ['alice', 'bob'],
      ttlMs: 30_000,
      sender: 'alice',
    });

    await session.requestApproval({
      requestId: 'qa1',
      action: 'Budget increase',
      summary: 'Need more resources',
      requiredApprovals: 1,
      sender: 'alice',
    });

    const ack = await session.abstain({
      requestId: 'qa1',
      reason: 'Not my call',
      sender: 'bob',
      auth: agentBob,
    });
    expect(ack.ok).toBe(true);
    expect(session.projection.hasQuorum('qa1')).toBe(false);
    expect(session.projection.votedSenders('qa1')).toContain('bob');
  });
});

// ── Session cancellation ─────────────────────────────────────────────

describe('Session cancellation', () => {
  it('cancels an active session and reports CANCELLED', async () => {
    const session = new DecisionSession(client, { auth: agentAlice });
    await session.start({
      intent: 'Temp session',
      participants: ['alice'],
      ttlMs: 30_000,
      sender: 'alice',
    });

    const ack = await session.cancel('No longer needed');
    expect(ack.ok).toBe(true);
    // proto 0.1.3: explicit cancellation surfaces as CANCELLED (was EXPIRED).
    expect(ack.sessionState).toBe('SESSION_STATE_CANCELLED');

    const { metadata } = await session.metadata();
    expect(metadata.state).toBe('SESSION_STATE_CANCELLED');
  });
});

// ── Session suspend / resume (proto 0.1.3) ───────────────────────────
//
// SuspendSession pauses a session non-terminally: TTL is banked, messages are
// rejected while suspended, and ResumeSession restores OPEN. Symmetric with
// CancelSession — a Core control-plane RPC restricted to the initiator.

describe('Session suspend / resume', () => {
  it('suspends then resumes an active session', async () => {
    const session = new DecisionSession(client, { auth: agentAlice });
    await session.start({
      intent: 'Suspendable session',
      participants: ['alice'],
      ttlMs: 60_000,
      sender: 'alice',
    });

    const suspendAck = await session.suspend('Pausing work');
    expect(suspendAck.ok).toBe(true);
    expect(suspendAck.sessionState).toBe('SESSION_STATE_SUSPENDED');

    const suspended = await session.metadata();
    expect(suspended.metadata.state).toBe('SESSION_STATE_SUSPENDED');

    const resumeAck = await session.resume('Back to work');
    expect(resumeAck.ok).toBe(true);
    expect(resumeAck.sessionState).toBe('SESSION_STATE_OPEN');

    const resumed = await session.metadata();
    expect(resumed.metadata.state).toBe('SESSION_STATE_OPEN');

    await session.cancel('cleanup');
  });

  it('rejects messages sent to a suspended session', async () => {
    const session = new DecisionSession(client, { auth: agentAlice });
    await session.start({
      intent: 'Suspended reject test',
      participants: ['alice'],
      ttlMs: 60_000,
      sender: 'alice',
    });

    await session.suspend('Pausing');

    // A mode message to a suspended session must be NACKed by the runtime.
    await expect(
      session.propose({ proposalId: 'p1', option: 'deploy', rationale: 'while paused', sender: 'alice' }),
    ).rejects.toThrow();

    await session.cancel('cleanup');
  });
});

// ── Streaming ────────────────────────────────────────────────────────

describe('Streaming', () => {
  it('opens a stream and receives messages', async () => {
    const session = new DecisionSession(client, { auth: agentAlice });

    // Open stream first
    const stream = session.openStream();
    const received: unknown[] = [];

    // Start consuming in background
    const consumer = (async () => {
      for await (const envelope of stream.responses()) {
        received.push(envelope);
        // We only need to observe the SessionStart echo
        break;
      }
    })();

    // Send SessionStart through the stream
    const startPayload = client.protoRegistry.encodeKnownPayload('macp.mode.decision.v1', 'SessionStart', {
      intent: 'Stream test',
      participants: ['alice'],
      modeVersion: '1.0.0',
      configurationVersion: 'config.default',
      policyVersion: 'policy.default',
      ttlMs: 30_000,
      contextId: '',
      extensions: {},
      roots: [],
    });
    const envelope = {
      macpVersion: '1.0',
      mode: 'macp.mode.decision.v1',
      messageType: 'SessionStart',
      messageId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      sender: 'alice',
      timestampUnixMs: String(Date.now()),
      payload: startPayload,
    };
    await stream.send(envelope);

    // Wait with timeout
    const timeout = new Promise<void>((_, reject) => setTimeout(() => reject(new Error('stream timeout')), 5000));
    await Promise.race([consumer, timeout]);

    stream.close();
    expect(received.length).toBeGreaterThanOrEqual(1);
  });
});

// ── Subscribe + history replay (RFC-MACP-0006-A1) ────────────────────
//
// A late subscriber sends a subscribe-only frame (sessionId + afterSequence)
// and the runtime replays every accepted envelope for that session before
// switching to live broadcast. This is what lets non-initiator agents join a
// session and observe SessionStart + Proposal regardless of spawn order.

describe('Stream subscribe + history replay', () => {
  it('late subscriber receives previously accepted envelopes via replay', async () => {
    // Alice starts a session and proposes before Bob ever opens a stream.
    const aliceSession = new DecisionSession(client, { auth: agentAlice });
    await aliceSession.start({
      intent: 'Replay test',
      participants: ['alice', 'bob'],
      ttlMs: 30_000,
      sender: 'alice',
    });
    await aliceSession.propose({
      proposalId: 'replay-p1',
      option: 'rollout',
      rationale: 'covered by replay',
      sender: 'alice',
    });

    // Bob now opens a stream and subscribes. The runtime must replay the
    // SessionStart and Proposal that landed before his subscribe frame.
    const bobClient = makeClient(agentBob);
    try {
      const stream = bobClient.openStream();
      await stream.sendSubscribe(aliceSession.sessionId);

      const seenMessageTypes: string[] = [];
      const consumer = (async () => {
        for await (const env of stream.responses()) {
          if (env.sessionId !== aliceSession.sessionId) continue;
          seenMessageTypes.push(env.messageType);
          if (seenMessageTypes.includes('SessionStart') && seenMessageTypes.includes('Proposal')) {
            break;
          }
        }
      })();

      const timeout = new Promise<void>((_, reject) => setTimeout(() => reject(new Error('replay timeout')), 5000));
      await Promise.race([consumer, timeout]);

      stream.close();
      expect(seenMessageTypes).toContain('SessionStart');
      expect(seenMessageTypes).toContain('Proposal');
      // Replay must preserve acceptance order: SessionStart was sent first,
      // Proposal second. The runtime guarantees authoritative ordering, so the
      // SessionStart index must be strictly less than the Proposal index.
      expect(seenMessageTypes.indexOf('SessionStart')).toBeLessThan(seenMessageTypes.indexOf('Proposal'));
    } finally {
      bobClient.close();
    }
  });

  it('sendSubscribe with a future afterSequence skips prior envelopes', async () => {
    // afterSequence=N means "replay only envelopes with seq > N". Setting it
    // beyond the last accepted envelope is a valid way for an agent that has
    // already processed history to resume live-only. We don't assert zero
    // messages (the runtime may still push a liveness frame), only that the
    // long-running proposal is not replayed.
    const aliceSession = new DecisionSession(client, { auth: agentAlice });
    await aliceSession.start({
      intent: 'Skip-replay test',
      participants: ['alice', 'bob'],
      ttlMs: 30_000,
      sender: 'alice',
    });
    await aliceSession.propose({
      proposalId: 'skip-p1',
      option: 'skipped',
      sender: 'alice',
    });

    const bobClient = makeClient(agentBob);
    try {
      const stream = bobClient.openStream();
      await stream.sendSubscribe(aliceSession.sessionId, 1_000_000);

      const received: string[] = [];
      const consumer = (async () => {
        for await (const env of stream.responses()) {
          if (env.sessionId !== aliceSession.sessionId) continue;
          received.push(env.messageType);
        }
      })();

      // Give replay a chance to complete, then close; we expect no Proposal
      // from history because afterSequence is beyond the accepted tail.
      await new Promise((r) => setTimeout(r, 500));
      stream.close();
      await consumer.catch(() => undefined);

      expect(received).not.toContain('Proposal');
    } finally {
      bobClient.close();
    }
  });
});

// ── Initiator contextId + extensions round-trip (SDK-TS-1) ───────────
//
// End-to-end proof that the initiator path now forwards `contextId` and
// `extensions` to the runtime, and that the runtime stamps them onto the
// session metadata so `GetSession` sees them back. This is what CP-16/17/18
// (control-plane projection) depends on.
//
// Uses bearer auth because v0.4.0 runtimes retired the dev-agent header path;
// auto-skipped if MACP_TEST_BEARER_ALICE is not set, same as the
// direct-agent-auth block below.

const SDKTS1_ALICE = process.env.MACP_TEST_BEARER_ALICE ?? '';

describe.skipIf(!SDKTS1_ALICE)('Initiator contextId + extensions round-trip (SDK-TS-1)', () => {
  it('SessionStart carries contextId + extensions; GetSession echoes them back', async () => {
    const authAlice = Auth.bearer(SDKTS1_ALICE, { expectedSender: 'alice' });
    const aliceClient = makeClient(authAlice);
    try {
      const session = new DecisionSession(aliceClient, { auth: authAlice });
      const ack = await session.start({
        intent: 'context propagation smoke',
        participants: ['alice', 'bob'],
        ttlMs: 30_000,
        contextId: 'ctx-upstream-run-7',
        extensions: {
          'aitp.tct': Buffer.from(JSON.stringify({ token: 't-int', issuer: 'iss-1' }), 'utf8'),
          'ctxm.ref': Buffer.from(JSON.stringify('pack:example-001'), 'utf8'),
        },
        sender: 'alice',
      });
      expect(ack.ok).toBe(true);

      const { metadata } = await aliceClient.getSession(session.sessionId, { auth: authAlice, deadlineMs: 5000 });
      expect(metadata.contextId).toBe('ctx-upstream-run-7');
      // Runtime surfaces extension *keys*; values stay opaque. That's the
      // contract the control-plane projection reads (see plans SDK-TS-1 /
      // CP-17). Key ordering is not guaranteed — compare as a set.
      expect(new Set(metadata.extensionKeys ?? [])).toEqual(new Set(['aitp.tct', 'ctxm.ref']));
    } finally {
      aliceClient.close();
    }
  });
});

// ── Session enumeration + lifecycle watch (parity with SDK-PY-2/3) ──
//
// Runtime-backed parity check for the three Python-SDK gaps flagged in
// python-sdk plans SDK-PY-2 (ListSessions), SDK-PY-3 (WatchSessions +
// high-level SessionLifecycleWatcher) and SDK-PY-4 (advertise both
// capabilities on Initialize). The TypeScript SDK already implements all
// three; this block exercises them end-to-end against the runtime so any
// regression is caught by CI.

describe.skipIf(!SDKTS1_ALICE)('Session enumeration + lifecycle watch', () => {
  it('listSessions returns a session created in this test run', async () => {
    const authAlice = Auth.bearer(SDKTS1_ALICE, { expectedSender: 'alice' });
    const aliceClient = makeClient(authAlice);
    try {
      const session = new DecisionSession(aliceClient, { auth: authAlice });
      await session.start({
        intent: 'listSessions smoke',
        participants: ['alice', 'bob'],
        ttlMs: 30_000,
        sender: 'alice',
      });

      const sessions = await aliceClient.listSessions({ auth: authAlice, deadlineMs: 5000 });
      // The runtime returns all sessions visible to this identity; the test
      // only cares that ours is among them.
      const ids = sessions.map((s) => s.sessionId);
      expect(ids).toContain(session.sessionId);
    } finally {
      aliceClient.close();
    }
  });

  it('SessionLifecycleWatcher emits a CREATED event for the initial snapshot', async () => {
    // The runtime's WatchSessions stream first emits CREATED events for every
    // currently-active session (initial sync), then streams new lifecycle
    // transitions (see runtime server.rs:961). We exercise the deterministic
    // snapshot path: start the session first, then subscribe and pull the
    // first event. Testing the live-broadcast path would race Alice's Send
    // against the tonic handler's broadcast-channel subscribe, which is
    // flaky in CI.
    const authAlice = Auth.bearer(SDKTS1_ALICE, { expectedSender: 'alice' });
    const authBob = Auth.bearer(process.env.MACP_TEST_BEARER_BOB ?? '', { expectedSender: 'bob' });
    const aliceClient = makeClient(authAlice);
    const bobClient = makeClient(authBob);

    try {
      const session = new DecisionSession(aliceClient, { auth: authAlice });
      await session.start({
        intent: 'lifecycle watcher snapshot smoke',
        participants: ['alice', 'bob'],
        ttlMs: 30_000,
        sender: 'alice',
      });

      const watcher = new SessionLifecycleWatcher(bobClient, { auth: authBob });
      const controller = new AbortController();
      const seenSessionIds = new Set<string>();
      let seenEventType: string | undefined;

      const consumer = (async () => {
        try {
          for await (const event of watcher.changes(controller.signal)) {
            if (event.session?.sessionId === session.sessionId) {
              seenSessionIds.add(event.session.sessionId);
              seenEventType = String(event.eventType);
              controller.abort();
              break;
            }
          }
        } catch {
          // AbortSignal fires as stream.cancel(); swallow the resulting reject.
        }
      })();

      await Promise.race([consumer, new Promise((r) => setTimeout(r, 5000))]);
      controller.abort();

      expect(seenSessionIds.has(session.sessionId)).toBe(true);
      // Runtime enum SessionLifecycleEvent.EventType.CREATED = 1. Protobuf
      // decoders commonly surface enums either as numeric (1) or the string
      // form ("EVENT_TYPE_CREATED"); accept both so the test is decoder-agnostic.
      expect(seenEventType === 'EVENT_TYPE_CREATED' || seenEventType === '1' || seenEventType === 'CREATED').toBe(true);
    } finally {
      aliceClient.close();
      bobClient.close();
    }
  });
});

// ── Policy registration ──────────────────────────────────────────────

describe('Policy lifecycle', () => {
  const policyId = `test-policy-${Date.now()}`;

  it('registers a policy', async () => {
    const descriptor = buildDecisionPolicy(policyId, 'Integration test policy', {
      voting: { algorithm: 'majority', threshold: 0.5 },
    });
    const result = await client.registerPolicy(descriptor, { auth: agentAlice });
    expect(result.ok).toBe(true);
  });

  it('retrieves the policy', async () => {
    const descriptor = await client.getPolicy(policyId, { auth: agentAlice });
    expect(descriptor.policyId).toBe(policyId);
    expect(descriptor.mode).toBe('macp.mode.decision.v1');
  });

  it('lists policies', async () => {
    const policies = await client.listPolicies('macp.mode.decision.v1', { auth: agentAlice });
    const ids = policies.map((p: any) => p.policyId);
    expect(ids).toContain(policyId);
  });

  it('unregisters the policy', async () => {
    const result = await client.unregisterPolicy(policyId, { auth: agentAlice });
    expect(result.ok).toBe(true);
  });
});

// ── Signals ──────────────────────────────────────────────────────────

describe('Signals', () => {
  it('sends a signal', async () => {
    const ack = await client.sendSignal({
      signalType: 'heartbeat',
      sender: 'alice',
      auth: agentAlice,
    });
    expect(ack.ok).toBe(true);
  });

  it('sends a progress notification', async () => {
    const ack = await client.sendProgress({
      progressToken: 'tok-1',
      progress: 50,
      total: 100,
      message: 'Half done',
      sender: 'alice',
      auth: agentAlice,
    });
    expect(ack.ok).toBe(true);
  });
});

// ── Extension mode registration ──────────────────────────────────────

describe('Extension mode registration', () => {
  it('registers and unregisters an ext mode', async () => {
    const reg = await client.registerExtMode(
      {
        mode: 'ext.test_mode.v1',
        modeVersion: '1.0.0',
        description: 'Test extension mode',
        messageTypes: ['SessionStart', 'Contribute', 'Commitment'],
        terminalMessageTypes: ['Commitment'],
      },
      { auth: agentAlice },
    );
    expect(reg.ok).toBe(true);

    const { modes } = await client.listExtModes();
    const names = modes.map((m) => m.mode);
    expect(names).toContain('ext.test_mode.v1');

    const unreg = await client.unregisterExtMode('ext.test_mode.v1', { auth: agentAlice });
    expect(unreg.ok).toBe(true);
  });
});

// ── Direct-agent auth (RFC-MACP-0004 §4) ─────────────────────────────
//
// Mirrors PY-5 from the direct-agent-auth plan. Runs only when the runtime
// has Bearer credentials provisioned for `alice` + `bob` via
// MACP_AUTH_TOKENS_JSON. See tests/integration/README.md.

const ALICE_TOKEN = process.env.MACP_TEST_BEARER_ALICE;
const BOB_TOKEN = process.env.MACP_TEST_BEARER_BOB;

describe.skipIf(!ALICE_TOKEN || !BOB_TOKEN)('Direct-agent auth — pre-allocated sessionId + Bearer', () => {
  it('initiator opens a pre-allocated session and drives the full Decision loop', async () => {
    const sessionId = newSessionId();

    const aliceAuth = Auth.bearer(ALICE_TOKEN!, { expectedSender: 'alice' });
    const bobAuth = Auth.bearer(BOB_TOKEN!, { expectedSender: 'bob' });

    const aliceClient = new MacpClient({
      address: RUNTIME_ADDRESS,
      secure: false,
      allowInsecure: true,
      auth: aliceAuth,
    });
    const bobClient = new MacpClient({
      address: RUNTIME_ADDRESS,
      secure: false,
      allowInsecure: true,
      auth: bobAuth,
    });

    try {
      await aliceClient.initialize(5000);
      await bobClient.initialize(5000);

      const aliceSession = new DecisionSession(aliceClient, { sessionId });
      const bobSession = new DecisionSession(bobClient, { sessionId });
      expect(aliceSession.sessionId).toBe(sessionId);
      expect(bobSession.sessionId).toBe(sessionId);

      // Initiator drives SessionStart → stream → Proposal.
      const startAck = await aliceSession.start({
        intent: 'Direct-agent auth smoke',
        participants: ['alice', 'bob'],
        ttlMs: 30_000,
      });
      expect(startAck.ok).toBe(true);

      const stream = aliceSession.openStream();
      const received: unknown[] = [];
      const consumer = (async () => {
        for await (const envelope of stream.responses()) {
          received.push(envelope);
          if (received.length >= 1) break;
        }
      })();

      const proposeAck = await aliceSession.propose({
        proposalId: 'da-1',
        option: 'use-direct-auth',
        rationale: 'RFC-MACP-0004 §4 compliance',
      });
      expect(proposeAck.ok).toBe(true);

      // Non-initiator evaluates + votes with its own Bearer identity.
      const evalAck = await bobSession.evaluate({
        proposalId: 'da-1',
        recommendation: 'APPROVE',
        confidence: 0.9,
        reason: 'Aligned with invariants',
      });
      expect(evalAck.ok).toBe(true);

      const voteAck = await bobSession.vote({
        proposalId: 'da-1',
        vote: 'approve',
        reason: 'Agreed',
      });
      expect(voteAck.ok).toBe(true);

      const timeout = new Promise<void>((_, reject) => setTimeout(() => reject(new Error('stream timeout')), 5000));
      await Promise.race([consumer, timeout]);
      stream.close();
      expect(received.length).toBeGreaterThanOrEqual(1);

      const { metadata } = await aliceSession.metadata();
      expect(metadata.sessionId).toBe(sessionId);
      expect(metadata.mode).toBe('macp.mode.decision.v1');

      await aliceSession.cancel('test cleanup');
    } finally {
      aliceClient.close();
      bobClient.close();
    }
  });

  it('rejects explicit sender that conflicts with expectedSender', () => {
    const aliceAuth = Auth.bearer(ALICE_TOKEN!, { expectedSender: 'alice' });
    const aliceClient = new MacpClient({
      address: RUNTIME_ADDRESS,
      secure: false,
      allowInsecure: true,
      auth: aliceAuth,
    });
    try {
      const session = new DecisionSession(aliceClient);
      expect(() =>
        session.propose({
          proposalId: 'rogue',
          option: 'x',
          sender: 'mallory',
        }),
      ).toThrow(MacpIdentityMismatchError);
    } finally {
      aliceClient.close();
    }
  });
});
