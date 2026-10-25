/**
 * No lead agent: code puts the decision to Claude agents directly with
 * `macpConsensus`, here as a quorum where two of three must approve.
 *
 *   ANTHROPIC_API_KEY=… MACP_RUNTIME_ADDRESS=localhost:50051 npx tsx examples/direct-consensus.ts
 */

import { Auth, MacpClient } from 'macp-sdk-typescript';
import { macpConsensus } from '../src/index.js';

const client = new MacpClient({
  address: process.env.MACP_RUNTIME_ADDRESS ?? 'localhost:50051',
  secure: false,
  allowInsecure: true, // dev runtime only
  auth: Auth.devAgent('release-bot'),
});

try {
  const result = await macpConsensus(
    {
      client,
      mode: 'quorum',
      threshold: 2,
      agents: {
        'security-reviewer': { description: 'Security', prompt: 'You are a security reviewer.' },
        'sre-reviewer': { description: 'SRE', prompt: 'You are an SRE responsible for uptime.' },
        'product-reviewer': {
          description: 'Product',
          prompt: 'You own the product roadmap.',
          model: 'claude-sonnet-5-5',
        },
      },
    },
    {
      option: 'deploy v2.4.0 to production on Friday 17:00',
      rationale: 'fixes a checkout bug affecting 2% of orders',
      details: { tests: 'green', rollback: 'one command', on_call: 'staffed until 22:00' },
    },
  );

  console.log(`${result.outcome}: ${result.commitment.reason} ${result.commitmentHash}`);
  for (const b of result.ballots) console.log(`  ${b.participant}: ${b.vote} (${b.reason})`);
} catch (err) {
  // The session was cancelled; e.g. no ANTHROPIC_API_KEY.
  console.error(`consensus failed: ${(err as Error).message}`);
  process.exitCode = 1;
}
client.close();
