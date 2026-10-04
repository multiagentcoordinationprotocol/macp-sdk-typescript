// Non-initiator / observer agent — direct-agent-auth flow (RFC-MACP-0004 §4).
//
// Companion to direct-agent-auth-initiator.ts. A non-initiator never calls
// session.start(); it opens a stream on a known sessionId and reacts to
// events as the initiator's envelopes arrive.
//
// Invocation (set MACP_SESSION_ID first, matching the initiator):
//   MACP_SESSION_ID=$SESSION_ID npx tsx examples/direct-agent-auth-observer.ts

import { Auth, DecisionSession, MacpClient } from '../src';

async function main(): Promise<void> {
  const sessionId = process.env.MACP_SESSION_ID;
  if (!sessionId) {
    console.error('MACP_SESSION_ID must be set (match the initiator)');
    process.exit(2);
  }

  const participantId = 'alice';
  const bearerToken = process.env.MACP_ALICE_BEARER;

  const auth = bearerToken
    ? Auth.bearer(bearerToken, { expectedSender: participantId })
    : Auth.devAgent(participantId);

  const client = new MacpClient({
    address: process.env.MACP_RUNTIME_TARGET ?? process.env.MACP_RUNTIME_ADDRESS ?? '127.0.0.1:50051',
    secure: false,
    allowInsecure: true,
    auth,
  });

  try {
    await client.initialize();

    const session = new DecisionSession(client, { sessionId, auth });
    const stream = session.openStream();

    await stream.sendSubscribe(sessionId);
    console.log(`observer ${participantId} attached to ${sessionId}`);

    for await (const envelope of stream.responses()) {
      console.log(`  ← ${envelope.messageType} from ${envelope.sender}`);
      if (envelope.messageType === 'Proposal') {
        const ack = await session.evaluate({
          proposalId: 'p1',
          recommendation: 'APPROVE',
          confidence: 0.9,
          reason: 'looks good',
        });
        console.log(`    → Evaluation ack.ok=${ack.ok}`);
      } else if (envelope.messageType === 'Commitment') {
        console.log('  session committed — exiting observer loop.');
        break;
      }
    }

    stream.close();
  } finally {
    client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
