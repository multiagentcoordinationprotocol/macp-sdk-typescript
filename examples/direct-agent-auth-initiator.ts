// Initiator agent — direct-agent-auth flow (RFC-MACP-0004 §4).
//
// Reference template for the agent that *opens* a session under the topology
// described in docs/guides/direct-agent-auth.md:
//   1. reads the pre-allocated sessionId from env/bootstrap,
//   2. authenticates to the runtime with its own Bearer token,
//   3. emits SessionStart,
//   4. emits the first mode envelope (a Proposal here).
//
// Run the runtime first:
//   docker run -d --name macp-runtime-test -p 50051:50051 \
//     -e MACP_BIND_ADDR=0.0.0.0:50051 -e MACP_ALLOW_INSECURE=1 \
//     -e MACP_MEMORY_ONLY=1 macp-runtime
//
// Invocation:
//   SESSION_ID=$(uuidgen)
//   MACP_SESSION_ID=$SESSION_ID npx tsx examples/direct-agent-auth-initiator.ts &
//   MACP_SESSION_ID=$SESSION_ID npx tsx examples/direct-agent-auth-observer.ts

import { Auth, DecisionSession, MacpClient, newSessionId } from '../src';

async function main(): Promise<void> {
  const sessionId = process.env.MACP_SESSION_ID ?? newSessionId();
  const participantId = 'coordinator';
  const bearerToken = process.env.MACP_INITIATOR_BEARER;

  const auth = bearerToken
    ? Auth.bearer(bearerToken, { expectedSender: participantId })
    : Auth.devAgent(participantId);

  const client = new MacpClient({
    address: process.env.MACP_RUNTIME_TARGET ?? '127.0.0.1:50051',
    secure: false,
    allowInsecure: true, // local dev only; production requires TLS
    auth,
  });

  try {
    const init = await client.initialize();
    console.log(`connected: ${init.runtimeInfo?.name}`);

    // 1. SessionStart (unary) — runtime binds the initiator to us.
    const session = new DecisionSession(client, { sessionId, auth });
    const startAck = await session.start({
      intent: 'pick a deployment plan',
      participants: [participantId, 'alice', 'bob'],
      ttlMs: 60_000,
    });
    console.log(`SessionStart ack.ok=${startAck.ok}`);

    // 2. Emit a Proposal so the observer has something to evaluate.
    const propAck = await session.propose({
      proposalId: 'p1',
      option: 'deploy-canary',
      rationale: 'validate with 5% traffic first',
    });
    console.log(`Proposal ack.ok=${propAck.ok}`);

    console.log(`sessionId=${sessionId} — ready for observer to attach`);
  } finally {
    client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
