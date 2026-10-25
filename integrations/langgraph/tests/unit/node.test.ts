import { afterEach, describe, expect, it, vi } from 'vitest';
import { Annotation, END, MemorySaver, START, StateGraph } from '@langchain/langgraph';
import { verifyReceipt } from 'macp-sdk-typescript/receipt';
import { MacpConsensusNode, consensusReceipt, nowIssuedAt, type ConsensusResult } from '../../src';
import { fakeClient, fixed } from './helpers';

afterEach(() => vi.restoreAllMocks());

describe('MacpConsensusNode', () => {
  it('validates at construction', () => {
    const { client } = fakeClient();
    expect(() => MacpConsensusNode({ client, participants: [] })).toThrow(TypeError);
  });

  it('reads state.proposal (string or object) and writes under outputKey', async () => {
    const { client, sent } = fakeClient();
    const node = MacpConsensusNode({
      client,
      participants: [{ id: 'a', evaluator: fixed('APPROVE') }],
      outputKey: 'verdict',
    });
    const out = await node({ proposal: 'ship' });
    expect(Object.keys(out)).toEqual(['verdict']);
    expect(out.verdict!.outcome).toBe('approve');
    expect(sent[0]!.payload.intent).toBe('ship');
    await node({ proposal: { option: 'ship2', rationale: 'r' } });
    expect(sent.filter((s) => s.messageType === 'Proposal').at(-1)!.payload).toMatchObject({
      option: 'ship2',
      rationale: 'r',
    });
  });

  it('takes a custom proposal reader and complains when state has no proposal', async () => {
    const { client } = fakeClient();
    const custom = MacpConsensusNode<{ ask: string }>({
      client,
      participants: [{ id: 'a', evaluator: fixed('APPROVE') }],
      proposal: (s) => ({ option: s.ask }),
    });
    expect((await custom({ ask: 'q' })).macp!.outcome).toBe('approve');
    const plain = MacpConsensusNode({ client, participants: [{ id: 'a', evaluator: fixed('APPROVE') }] });
    await expect(plain({})).rejects.toThrow(/no 'proposal'/);
  });

  it('runs inside a compiled, checkpointed StateGraph and yields a verifiable receipt', async () => {
    const { client } = fakeClient();
    const State = Annotation.Root({
      proposal: Annotation<string>(),
      macp: Annotation<ConsensusResult>(),
      action: Annotation<string>(),
    });
    const graph = new StateGraph(State)
      .addNode(
        'consensus',
        MacpConsensusNode({
          client,
          participants: [
            { id: 'alice', evaluator: fixed('APPROVE') },
            { id: 'bob', evaluator: fixed('REJECT') },
            { id: 'carol', evaluator: fixed('APPROVE') },
          ],
        }),
      )
      .addNode('act', (s: typeof State.State) => ({ action: s.macp.outcome === 'approve' ? 'executed' : 'skipped' }))
      .addEdge(START, 'consensus')
      .addEdge('consensus', 'act')
      .addEdge('act', END)
      .compile({ checkpointer: new MemorySaver() });

    const config = { configurable: { thread_id: 't1' } };
    const final = await graph.invoke({ proposal: 'refund order 9' }, config);
    expect(final.action).toBe('executed');
    expect(final.macp.approvals).toBe(2);

    // State survives the checkpointer and still makes a receipt.
    const restored = (await graph.getState(config)).values.macp as ConsensusResult;
    const receipt = consensusReceipt(restored, { issuer: 'graph:test', issuedAt: '2026-10-25T00:00:00Z' });
    expect(receipt).toMatchObject({
      session_id: restored.sessionId,
      mode: 'macp.mode.decision.v1',
      commitment_hash: restored.commitmentHash,
    });
    expect(verifyReceipt(receipt, {}).verdict).toBe('integrity_only');
  });
});

describe('consensusReceipt', () => {
  it('defaults issued_at to now at second precision', () => {
    expect(nowIssuedAt()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });
});
