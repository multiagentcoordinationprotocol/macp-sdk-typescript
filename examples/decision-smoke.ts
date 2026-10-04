import { Auth, DecisionSession, MacpClient } from '../src';

async function main(): Promise<void> {
  const client = new MacpClient({
    address: process.env.MACP_RUNTIME_ADDRESS ?? '127.0.0.1:50051',
    secure: false,
    allowInsecure: true, // local dev only; production must use TLS (RFC-MACP-0006 §3)
    auth: Auth.devAgent('coordinator'),
  });

  const init = await client.initialize();
  console.log('initialize', init.selectedProtocolVersion, init.runtimeInfo?.name);

  const session = new DecisionSession(client);
  await session.start({
    intent: 'pick a deployment',
    participants: ['coordinator', 'alice', 'bob'], // coordinator proposes below, so must be a participant
    ttlMs: 60_000,
  });
  await session.propose({ proposalId: 'p1', option: 'deploy-v2.1', rationale: 'canary checks passed' });
  await session.evaluate({
    proposalId: 'p1',
    recommendation: 'approve',
    confidence: 0.95,
    reason: 'risk low',
    sender: 'alice',
    auth: Auth.devAgent('alice'),
  });
  await session.vote({
    proposalId: 'p1',
    vote: 'approve',
    reason: 'ship it',
    sender: 'bob',
    auth: Auth.devAgent('bob'),
  });
  const winner = session.projection.majorityWinner();
  console.log('winner', winner);
  await session.commit({
    action: 'deployment.approved',
    authorityScope: 'release-management',
    reason: `winner=${winner}`,
  });
  const metadata = await session.metadata();
  console.log('state', metadata.metadata.state, 'mode', metadata.metadata.mode);
  client.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
