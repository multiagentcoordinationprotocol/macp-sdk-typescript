// Example: register a governance policy, then run a policy-governed decision session.
//
// Requires a running MACP Rust runtime on localhost:50051:
//   docker run -d --name macp-runtime-test -p 50051:50051 \
//     -e MACP_BIND_ADDR=0.0.0.0:50051 -e MACP_ALLOW_INSECURE=1 \
//     -e MACP_MEMORY_ONLY=1 macp-runtime
//
// Run: npx tsx examples/policy-registration.ts

import {
  Auth,
  DecisionSession,
  MacpClient,
  buildDecisionPolicy,
  type CommitmentRules,
  type EvaluationRules,
  type ObjectionHandlingRules,
  type VotingRules,
} from '../src';

async function main(): Promise<void> {
  const client = new MacpClient({
    address: '127.0.0.1:50051',
    secure: false,
    allowInsecure: true, // local dev only; production requires TLS (RFC-MACP-0006 §3)
    auth: Auth.devAgent('coordinator'),
  });

  try {
    const init = await client.initialize();
    console.log('runtime:', init.runtimeInfo?.name);

    // ── Build a governance policy ────────────────────────────
    const voting: VotingRules = {
      algorithm: 'majority',
      threshold: 0.5,
      quorum: { type: 'count', value: 2 },
    };
    const objectionHandling: ObjectionHandlingRules = {
      criticalSeverityVetoes: true,
      vetoThreshold: 1,
    };
    const evaluation: EvaluationRules = {
      minimumConfidence: 0.7,
      requiredBeforeVoting: true,
    };
    const commitment: CommitmentRules = {
      authority: 'initiator_only',
      requireVoteQuorum: true,
    };
    const policy = buildDecisionPolicy(
      'policy.deploy.majority-veto',
      'Majority vote with veto power for blocking objections',
      { voting, objectionHandling, evaluation, commitment },
    );

    // ── Register with the runtime ────────────────────────────
    const resp = await client.registerPolicy(policy);
    console.log('registered:', resp.ok);

    // ── Verify it's listed ───────────────────────────────────
    const listed = await client.listPolicies('macp.mode.decision.v1');
    console.log(
      'policies:',
      listed.map((d) => d.policyId),
    );

    // ── Retrieve by ID ───────────────────────────────────────
    const got = await client.getPolicy('policy.deploy.majority-veto');
    console.log('retrieved:', got.policyId, got.description);

    // ── Run a session with this policy ───────────────────────
    const session = new DecisionSession(client, { policyVersion: 'policy.deploy.majority-veto' });
    await session.start({
      intent: 'approve production deployment v2.1',
      participants: ['coordinator', 'alice', 'bob'],
      ttlMs: 60_000,
    });
    await session.propose({ proposalId: 'p1', option: 'deploy-v2.1', rationale: 'canary checks passed' });

    await session.evaluate({
      proposalId: 'p1',
      recommendation: 'APPROVE',
      confidence: 0.95,
      reason: 'risk low',
      sender: 'alice',
      auth: Auth.devAgent('alice'),
    });
    await session.evaluate({
      proposalId: 'p1',
      recommendation: 'APPROVE',
      confidence: 0.85,
      reason: 'tests green',
      sender: 'bob',
      auth: Auth.devAgent('bob'),
    });

    await session.vote({
      proposalId: 'p1',
      vote: 'APPROVE',
      reason: 'ship it',
      sender: 'alice',
      auth: Auth.devAgent('alice'),
    });
    await session.vote({
      proposalId: 'p1',
      vote: 'APPROVE',
      reason: 'lgtm',
      sender: 'bob',
      auth: Auth.devAgent('bob'),
    });

    const winner = session.projection.majorityWinner();
    console.log('winner:', winner);

    await session.commit({
      action: 'deployment.approved',
      authorityScope: 'release-management',
      reason: `winner=${winner}`,
    });

    const metadata = (await session.metadata()).metadata;
    console.log('state:', metadata.state, 'mode:', metadata.mode);

    // ── Cleanup ──────────────────────────────────────────────
    await client.unregisterPolicy('policy.deploy.majority-veto');
    console.log('unregistered policy');
  } finally {
    client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
