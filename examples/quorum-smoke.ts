import { Auth, MacpClient, QuorumSession } from '../src';

async function main(): Promise<void> {
  const client = new MacpClient({
    address: process.env.MACP_RUNTIME_ADDRESS ?? '127.0.0.1:50051',
    secure: false,
    allowInsecure: true, // local dev only; production must use TLS (RFC-MACP-0006 §3)
    auth: Auth.devAgent('coordinator'),
  });

  const init = await client.initialize();
  console.log('initialize', init.selectedProtocolVersion, init.runtimeInfo?.name);

  const session = new QuorumSession(client);
  await session.start({
    intent: 'approve production deploy',
    participants: ['alice', 'bob', 'carol'],
    ttlMs: 60_000,
  });

  await session.requestApproval({
    requestId: 'r1',
    action: 'deploy-v3.0',
    summary: 'Production deployment of v3.0',
    requiredApprovals: 2,
  });

  await session.approve({
    requestId: 'r1',
    reason: 'tests pass',
    sender: 'alice',
    auth: Auth.devAgent('alice'),
  });

  console.log('quorum?', session.projection.hasQuorum('r1')); // false, need 2

  await session.approve({
    requestId: 'r1',
    reason: 'staging looks good',
    sender: 'bob',
    auth: Auth.devAgent('bob'),
  });

  console.log('quorum?', session.projection.hasQuorum('r1')); // true
  console.log('remaining', session.projection.remainingVotesNeeded('r1')); // 0

  await session.commit({
    action: 'quorum.approved',
    authorityScope: 'release-management',
    reason: 'quorum reached with 2/2 approvals',
  });

  const metadata = await session.metadata();
  console.log('state', metadata.metadata.state);
  client.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
