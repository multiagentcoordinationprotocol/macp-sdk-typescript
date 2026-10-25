/**
 * End-to-end against a live macp-runtime (CI: ghcr.io/…/macp-runtime:0.9.0 as
 * a service; locally see the README). Address from MACP_RUNTIME_ADDRESS.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { Auth, MacpClient } from 'macp-sdk-typescript';
import { verifyReceipt } from 'macp-sdk-typescript/receipt';
import { MacpConsensusNode, consensusReceipt, llmEvaluator, runConsensus, type ConsensusResult } from '../../src';

const RUNTIME_ADDRESS = process.env.MACP_RUNTIME_ADDRESS ?? 'localhost:50051';

const client = new MacpClient({
  address: RUNTIME_ADDRESS,
  secure: false,
  allowInsecure: true,
  auth: Auth.devAgent('coordinator'),
});

afterAll(() => client.close());

const answer = (recommendation: string, reason: string) => JSON.stringify({ recommendation, confidence: 0.9, reason });

async function state(sessionId: string): Promise<string | undefined> {
  return (await client.getSession(sessionId)).metadata.state;
}

describe('MacpConsensusNode against macp-runtime', () => {
  it('a 3-participant decision graph commits approve 2/3', async () => {
    const State = Annotation.Root({ proposal: Annotation<string>(), macp: Annotation<ConsensusResult>() });
    const graph = new StateGraph(State)
      .addNode(
        'consensus',
        MacpConsensusNode({
          client,
          participants: [
            { id: 'alice', evaluator: llmEvaluator(new FakeListChatModel({ responses: [answer('APPROVE', 'ok')] })) },
            { id: 'bob', evaluator: llmEvaluator(new FakeListChatModel({ responses: [answer('BLOCK', 'risky')] })) },
            {
              id: 'carol',
              evaluator: llmEvaluator(
                new FakeListChatModel({ responses: ['```json\n' + answer('approve', 'fine') + '\n```'] }),
              ),
            },
          ],
        }),
      )
      .addEdge(START, 'consensus')
      .addEdge('consensus', END)
      .compile();

    const { macp } = await graph.invoke({ proposal: 'refund order 9' });
    expect(macp).toMatchObject({ outcome: 'approve', approvals: 2, threshold: 2, mode: 'macp.mode.decision.v1' });
    expect(macp.ballots.map((b) => b.vote)).toEqual(['APPROVE', 'REJECT', 'APPROVE']);
    expect(macp.commitment.reason).toBe('2/3 approvals (threshold 2)');
    expect(await state(macp.sessionId)).toBe('SESSION_STATE_RESOLVED');
  });

  it('a quorum the participants turn down commits reject', async () => {
    const result = await runConsensus(
      {
        client,
        mode: 'quorum',
        threshold: 2,
        participants: [
          { id: 'alice', evaluator: () => ({ recommendation: 'REVIEW', confidence: 0.5, reason: 'unsure' }) },
          { id: 'bob', evaluator: () => ({ recommendation: 'REJECT', confidence: 0.9, reason: 'no' }) },
          { id: 'carol', evaluator: () => ({ recommendation: 'APPROVE', confidence: 0.9, reason: 'yes' }) },
        ],
      },
      { option: 'wire-transfer', rationale: 'pay invoice 17', details: { amount: 1200 } },
    );
    expect(result).toMatchObject({ outcome: 'reject', approvals: 0, mode: 'macp.mode.quorum.v1' });
    expect(result.ballots.map((b) => b.vote)).toEqual(['ABSTAIN', 'REJECT']);
    expect(result.commitment.action).toBe('macp.consensus.rejected');
    expect(await state(result.sessionId)).toBe('SESSION_STATE_RESOLVED');
  });

  it('the result makes a receipt that verifies integrity_only', async () => {
    const result = await runConsensus(
      {
        client,
        participants: [{ id: 'alice', evaluator: () => ({ recommendation: 'APPROVE', confidence: 1, reason: 'ok' }) }],
      },
      { option: 'rotate-keys' },
    );
    const receipt = consensusReceipt(result, { issuer: 'langgraph:integration' });
    expect(receipt.commitment_hash).toBe(result.commitmentHash);
    expect(verifyReceipt(receipt, {})).toMatchObject({ integrity: 'match', verdict: 'integrity_only' });
  });

  it('a failure mid-session cancels the session and surfaces the error', async () => {
    let sessionId = '';
    await expect(
      runConsensus(
        {
          client,
          participants: [
            {
              id: 'alice',
              evaluator: (_proposal, session) => {
                sessionId = session.sessionId;
                throw new Error('model unavailable');
              },
            },
          ],
        },
        { option: 'x' },
      ),
    ).rejects.toThrow('model unavailable');
    expect(await state(sessionId)).toBe('SESSION_STATE_CANCELLED');
  });

  it('an unknown policy is refused at start and surfaces the error', async () => {
    await expect(
      runConsensus(
        {
          client,
          policy: 'policy.does-not-exist',
          participants: [{ id: 'alice', evaluator: () => ({ recommendation: 'APPROVE', confidence: 1, reason: '' }) }],
        },
        { option: 'x' },
      ),
    ).rejects.toThrow();
  });
});
