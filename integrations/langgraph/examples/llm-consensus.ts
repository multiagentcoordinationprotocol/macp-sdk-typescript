/**
 * The fraud review from consensus-graph.ts with real LLM participants: three
 * Claude-backed reviewers with different briefs vote through MACP. Needs
 * ANTHROPIC_API_KEY and a runtime (see consensus-graph.ts for the docker line):
 *
 *   ANTHROPIC_API_KEY=… npx tsx examples/llm-consensus.ts [clean|borderline|fraudulent]
 */

import { ChatAnthropic } from '@langchain/anthropic';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { Auth, MacpClient } from 'macp-sdk-typescript';
import {
  DEFAULT_EVALUATOR_PROMPT,
  MacpConsensusNode,
  consensusReceipt,
  llmEvaluator,
  type ConsensusResult,
} from '../src';
import { TRANSACTIONS } from './fraud';

const State = Annotation.Root({
  proposal: Annotation<{ option: string; rationale: string; details: Record<string, unknown> }>(),
  macp: Annotation<ConsensusResult>(),
});

const reviewer = (brief: string) =>
  llmEvaluator(new ChatAnthropic({ model: 'claude-opus-5-5', maxTokens: 1024 }), {
    systemPrompt: `${brief}\n\n${DEFAULT_EVALUATOR_PROMPT}`,
  });

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY)
    throw new Error('set ANTHROPIC_API_KEY (or run examples/consensus-graph.ts, which needs no key)');
  const transaction = TRANSACTIONS[process.argv[2] ?? 'borderline'];
  if (!transaction) throw new Error(`unknown transaction; try ${Object.keys(TRANSACTIONS).join(', ')}`);

  const client = new MacpClient({
    address: process.env.MACP_RUNTIME_ADDRESS ?? 'localhost:50051',
    secure: false,
    allowInsecure: true,
    auth: Auth.devAgent('coordinator'),
  });

  const graph = new StateGraph(State)
    .addNode(
      'consensus',
      MacpConsensusNode({
        client,
        participants: [
          {
            id: 'fraud-agent',
            evaluator: reviewer('You are a fraud analyst. Device trust under 0.2 or any chargeback is a warning sign.'),
          },
          {
            id: 'risk-agent',
            evaluator: reviewer(
              'You are a credit-risk analyst focused on exposure: weigh the amount against the signals.',
            ),
          },
          {
            id: 'compliance-agent',
            evaluator: reviewer('You are a payments compliance officer. Repeat chargebacks require a hold.'),
          },
        ],
      }),
    )
    .addEdge(START, 'consensus')
    .addEdge('consensus', END)
    .compile();

  try {
    const { macp } = await graph.invoke({
      proposal: {
        option: `approve ${transaction.id}`,
        rationale: `card payment of ${transaction.amount}`,
        details: { ...transaction },
      },
    });
    console.log(`${transaction.id}: ${macp.outcome} (${macp.commitment.reason})`);
    for (const b of macp.ballots) console.log(`  ${b.participant.padEnd(17)} ${b.vote.padEnd(8)} ${b.reason}`);
    console.log(JSON.stringify(consensusReceipt(macp, { issuer: 'example:llm-consensus' }), null, 2));
  } finally {
    client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
