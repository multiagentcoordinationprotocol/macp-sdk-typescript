/**
 * End-to-end against a live macp-runtime (CI: ghcr.io/…/macp-runtime:0.9.0 as
 * a service; locally see the README). Address from MACP_RUNTIME_ADDRESS.
 *
 * Claude is replaced by a stub `query` that replays a scripted result message,
 * so these run without an API key; everything from the evaluator's result
 * handling to the committed session is real. One live test runs only when
 * ANTHROPIC_API_KEY is set.
 */

import { afterAll, describe, expect, it } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Auth, MacpClient } from 'macp-sdk-typescript';
import { verifyReceipt } from 'macp-sdk-typescript/receipt';
import {
  claudeEvaluator,
  consensusReceipt,
  macpConsensus,
  macpConsensusServer,
  type ConsensusResult,
  type QueryFn,
} from '../../src/index.js';

const RUNTIME_ADDRESS = process.env.MACP_RUNTIME_ADDRESS ?? 'localhost:50051';

const client = new MacpClient({
  address: RUNTIME_ADDRESS,
  secure: false,
  allowInsecure: true,
  auth: Auth.devAgent('lead-agent'),
});

afterAll(() => client.close());

async function state(sessionId: string): Promise<string | undefined> {
  return (await client.getSession(sessionId)).metadata.state;
}

/** A stub `query` answering for each agent by the first line of its system prompt. */
function scripted(answers: Record<string, SDKMessage>): QueryFn {
  return ({ options }) =>
    (async function* () {
      const role = String(options?.systemPrompt).split('\n')[0]!;
      const message = answers[role];
      if (message) yield message;
    })();
}

const says = (recommendation: string, reason: string) =>
  ({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: '',
    structured_output: { recommendation, confidence: 0.9, reason },
  }) as unknown as SDKMessage;

const agents = {
  fraud: { description: 'fraud', prompt: 'fraud' },
  risk: { description: 'risk', prompt: 'risk' },
  compliance: { description: 'compliance', prompt: 'compliance' },
};

describe('Claude agents reach consensus on macp-runtime', () => {
  it('three agents commit approve 2/3 in decision mode', async () => {
    const query = scripted({
      fraud: says('APPROVE', 'no fraud signals'),
      risk: says('BLOCK', 'amount above limit'),
      compliance: says('APPROVE', 'policy allows it'),
    });
    const result = await macpConsensus(
      { client, agents, evaluator: { query } },
      { option: 'refund order 9', details: { amount: 120 } },
    );
    expect(result).toMatchObject({ outcome: 'approve', approvals: 2, threshold: 2, mode: 'macp.mode.decision.v1' });
    expect(result.ballots.map((b) => b.vote)).toEqual(['APPROVE', 'REJECT', 'APPROVE']);
    expect(await state(result.sessionId)).toBe('SESSION_STATE_RESOLVED');
    expect(verifyReceipt(consensusReceipt(result, { issuer: 'lead-agent' }), {})).toMatchObject({
      integrity: 'match',
      verdict: 'integrity_only',
    });
  });

  it('the lead agent calls mcp consensus and gets a committed rejection back', async () => {
    const query = scripted({
      fraud: says('REJECT', 'card testing pattern'),
      risk: says('REVIEW', 'unclear'),
      compliance: says('APPROVE', 'fine'),
    });
    const committed: ConsensusResult[] = [];
    const server = macpConsensusServer({
      client,
      agents,
      mode: 'quorum',
      evaluator: { query },
      onResult: (r) => void committed.push(r),
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: 'lead', version: '0' });
    await Promise.all([server.instance.connect(serverSide), mcp.connect(clientSide)]);
    const out = await mcp.callTool({
      name: 'consensus',
      arguments: { option: 'wire-transfer', rationale: 'invoice 17' },
    });
    await mcp.close();

    expect(out.isError).toBeFalsy();
    const result = out.structuredContent as unknown as ConsensusResult;
    expect(result).toMatchObject({ outcome: 'reject', approvals: 0, mode: 'macp.mode.quorum.v1' });
    expect(result.ballots.map((b) => b.vote)).toEqual(['REJECT', 'ABSTAIN']);
    expect(committed).toEqual([result]);
    expect(await state(result.sessionId)).toBe('SESSION_STATE_RESOLVED');
  });

  it('a failed Claude run cancels the session and surfaces the error', async () => {
    let sessionId = '';
    const failing: QueryFn = () =>
      (async function* () {
        yield {
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          errors: ['API overloaded'],
        } as unknown as SDKMessage;
      })();
    await expect(
      macpConsensus(
        {
          client,
          participants: [
            {
              id: 'alice',
              evaluator: {
                evaluate: async (proposal, session) => {
                  sessionId = session.sessionId;
                  return claudeEvaluator({ description: 'd', prompt: 'p' }, { query: failing }).evaluate(
                    proposal,
                    session,
                  );
                },
              },
            },
          ],
        },
        { option: 'x' },
      ),
    ).rejects.toThrow('claude evaluator error_during_execution: API overloaded');
    expect(await state(sessionId)).toBe('SESSION_STATE_CANCELLED');
  });

  it.skipIf(!process.env.ANTHROPIC_API_KEY)(
    'live: real Claude agents evaluate and the runtime commits',
    async () => {
      const result = await macpConsensus(
        {
          client,
          agents: {
            security: { description: 'security', prompt: 'You are a security reviewer.' },
            ops: { description: 'ops', prompt: 'You are an SRE.' },
          },
          threshold: 1,
        },
        { option: 'rotate the staging database password', details: { downtime: 'none', reversible: true } },
      );
      expect(['approve', 'reject']).toContain(result.outcome);
      expect(await state(result.sessionId)).toBe('SESSION_STATE_RESOLVED');
    },
    180_000,
  );
});
