/**
 * A LangGraph fraud-review graph that ends in a binding MACP decision.
 *
 *   signals → consensus (MACP Decision, 3 agents) → act
 *
 * Every participant is deterministic, so this runs with no API key:
 *
 *   docker run -d -p 50051:50051 -e MACP_BIND_ADDR=0.0.0.0:50051 \
 *     -e MACP_ALLOW_INSECURE=1 -e MACP_MEMORY_ONLY=1 \
 *     ghcr.io/multiagentcoordinationprotocol/macp-runtime:0.9.0
 *   npx tsx examples/consensus-graph.ts [clean|borderline|fraudulent]
 */

import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { Auth, MacpClient } from 'macp-sdk-typescript';
import { MacpConsensusNode, consensusReceipt, type ConsensusResult, type EvaluationResult } from '../src';
import { TRANSACTIONS, scoreFraud, type Transaction } from './fraud';

const State = Annotation.Root({
  transaction: Annotation<Transaction>(),
  proposal: Annotation<{ option: string; rationale: string; details: Record<string, unknown> }>(),
  macp: Annotation<ConsensusResult>(),
  action: Annotation<string>(),
});

// Each agent reads the same proposal details from its own angle.
const details = (proposal: Record<string, unknown>) => proposal.details as unknown as Transaction;

const fraudAgent = (proposal: Record<string, unknown>): EvaluationResult => {
  const t = details(proposal);
  return scoreFraud(t.deviceTrust, t.chargebacks);
};

const riskAgent = (proposal: Record<string, unknown>): EvaluationResult => {
  const t = details(proposal);
  if (t.amount > 2500)
    return { recommendation: 'REJECT', confidence: 0.8, reason: `amount ${t.amount} exceeds the auto-approve limit` };
  return { recommendation: 'APPROVE', confidence: 0.7, reason: `amount ${t.amount} is within limits` };
};

const complianceAgent = (proposal: Record<string, unknown>): EvaluationResult => {
  const t = details(proposal);
  if (t.chargebacks >= 2)
    return { recommendation: 'BLOCK', confidence: 0.9, reason: 'repeat chargebacks trigger a compliance hold' };
  return { recommendation: 'APPROVE', confidence: 0.75, reason: 'no compliance flags' };
};

async function main(): Promise<void> {
  const which = process.argv[2] ?? 'borderline';
  const transaction = TRANSACTIONS[which];
  if (!transaction) throw new Error(`unknown transaction '${which}'; try ${Object.keys(TRANSACTIONS).join(', ')}`);

  const client = new MacpClient({
    address: process.env.MACP_RUNTIME_ADDRESS ?? 'localhost:50051',
    secure: false,
    allowInsecure: true,
    auth: Auth.devAgent('coordinator'),
  });

  const graph = new StateGraph(State)
    .addNode('signals', (s: typeof State.State) => ({
      proposal: {
        option: `approve ${s.transaction.id}`,
        rationale: `card payment of ${s.transaction.amount}`,
        details: { ...s.transaction },
      },
    }))
    .addNode(
      'consensus',
      MacpConsensusNode({
        client,
        participants: [
          { id: 'fraud-agent', evaluator: fraudAgent },
          { id: 'risk-agent', evaluator: riskAgent },
          { id: 'compliance-agent', evaluator: complianceAgent },
        ],
      }),
    )
    .addNode('act', (s: typeof State.State) => ({
      action: s.macp.outcome === 'approve' ? 'captured' : 'held for review',
    }))
    .addEdge(START, 'signals')
    .addEdge('signals', 'consensus')
    .addEdge('consensus', 'act')
    .addEdge('act', END)
    .compile();

  try {
    const final = await graph.invoke({ transaction });
    const { macp } = final;
    console.log(`${transaction.id}: ${macp.outcome} (${macp.commitment.reason}) → ${final.action}`);
    for (const b of macp.ballots) console.log(`  ${b.participant.padEnd(17)} ${b.vote.padEnd(8)} ${b.reason}`);
    console.log(`  session ${macp.sessionId}`);
    console.log(`  ${macp.commitmentHash}`);
    const receipt = consensusReceipt(macp, { issuer: 'example:fraud-graph' });
    console.log(JSON.stringify(receipt, null, 2));
  } finally {
    client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
