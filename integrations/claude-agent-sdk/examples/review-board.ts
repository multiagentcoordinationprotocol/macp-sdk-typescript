/**
 * A lead Claude agent that puts a refund decision to three reviewer subagents
 * through MACP, then acts on the binding outcome.
 *
 * The lead gets one tool, `mcp__macp__consensus`. Calling it opens a Decision
 * session on the runtime in which the fraud, risk and compliance agents (each
 * its own Claude query and its own MACP identity) evaluate and vote; the
 * runtime commits the outcome, and the lead reads back the commitment hash.
 *
 *   ANTHROPIC_API_KEY=… MACP_RUNTIME_ADDRESS=localhost:50051 npx tsx examples/review-board.ts
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import { Auth, MacpClient } from 'macp-sdk-typescript';
import { verifyReceipt } from 'macp-sdk-typescript/receipt';
import { consensusReceipt, macpConsensusServer, type ConsensusResult } from '../src/index.js';

const client = new MacpClient({
  address: process.env.MACP_RUNTIME_ADDRESS ?? 'localhost:50051',
  secure: false,
  allowInsecure: true, // dev runtime only
  auth: Auth.devAgent('lead-agent'),
});

const committed: ConsensusResult[] = [];
const macp = macpConsensusServer({
  client,
  agents: {
    'fraud-agent': {
      description: 'Fraud analyst',
      prompt: 'You are a fraud analyst. Look for signs the refund request is abusive or part of a fraud pattern.',
    },
    'risk-agent': {
      description: 'Risk analyst',
      prompt: 'You are a risk analyst. Weigh the financial exposure against the customer relationship.',
    },
    'compliance-agent': {
      description: 'Compliance officer',
      prompt: 'You are a compliance officer. Check the refund against a 30-day, $500-per-order refund policy.',
    },
  },
  onResult: (result) => void committed.push(result),
});

const ticket = {
  order: 'order-9',
  amount_usd: 120,
  days_since_purchase: 12,
  customer_refunds_last_year: 1,
  claim: 'Charged twice for the same order.',
};

try {
  for await (const message of query({
    prompt: `A customer asks for a refund. Put it to the review board, then tell the customer the outcome.\n\n${JSON.stringify(ticket)}`,
    options: {
      model: 'claude-opus-5-5',
      systemPrompt:
        'You are a support lead. Refund decisions are made by the review board: call the consensus tool once ' +
        'with option "refund order-9", a short rationale, and the ticket as details. The outcome is binding.',
      mcpServers: { macp },
      tools: [],
      allowedTools: ['mcp__macp__consensus'],
      maxTurns: 6,
      settingSources: [],
      persistSession: false,
    },
  })) {
    if (message.type === 'assistant') {
      for (const block of message.message.content) if (block.type === 'text') console.log(`lead: ${block.text}`);
    }
    if (message.type === 'result' && message.subtype !== 'success') console.error(`lead failed: ${message.subtype}`);
  }
} catch (err) {
  // e.g. no ANTHROPIC_API_KEY: the SDK throws after the lead's error result.
  console.error(`lead failed: ${(err as Error).message}`);
  process.exitCode = 1;
}

for (const result of committed) {
  console.log(`\noutcome ${result.outcome} (${result.commitment.reason}), session ${result.sessionId}`);
  for (const b of result.ballots) console.log(`  ${b.participant}: ${b.vote} (${b.reason})`);
  const receipt = consensusReceipt(result, { issuer: 'support-lead' });
  console.log(`commitment ${result.commitmentHash}, receipt ${verifyReceipt(receipt, {}).verdict}`);
}
client.close();
