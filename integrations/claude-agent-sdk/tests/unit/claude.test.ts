import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { Auth, MacpSdkError } from 'macp-sdk-typescript';
import { verifyReceipt } from 'macp-sdk-typescript/receipt';
import {
  DEFAULT_MODEL,
  EVALUATION_SCHEMA,
  EVALUATOR_INSTRUCTIONS,
  UNPARSEABLE,
  claudeEvaluator,
  consensusReceipt,
  consensusTool,
  macpConsensus,
  macpConsensusServer,
  toConsensusOptions,
  type ConsensusResult,
  type QueryFn,
} from '../../src/index.js';
import { fakeClient, fixed } from './helpers.js';

afterEach(() => vi.restoreAllMocks());

const info = { sessionId: 's', mode: 'macp.mode.decision.v1', participants: [] };

const success = (structured_output: unknown, result = '') =>
  ({ type: 'result', subtype: 'success', is_error: false, result, structured_output }) as unknown as SDKMessage;

/** A fake `query` that records each call and replays `messages` (or one per call from `perCall`). */
function stubQuery(...perCall: SDKMessage[][]) {
  const calls: { prompt: string; options?: Options }[] = [];
  const query: QueryFn = (params) => {
    calls.push(params);
    const messages = perCall[Math.min(calls.length - 1, perCall.length - 1)] ?? [];
    return (async function* () {
      yield* messages;
    })();
  };
  return { query, calls };
}

const answer = (recommendation: string, reason = `says ${recommendation}`) => [
  { type: 'system', subtype: 'init' } as unknown as SDKMessage,
  success({ recommendation, confidence: 0.9, reason }),
];

describe('claudeEvaluator', () => {
  it('runs one isolated query per evaluation and reads the structured output', async () => {
    const { query, calls } = stubQuery(answer('APPROVE', 'fine'));
    const evaluator = claudeEvaluator({ description: 'risk', prompt: 'You are a risk analyst.' }, { query });
    expect(await evaluator.evaluate({ option: 'refund' }, info)).toEqual({
      recommendation: 'APPROVE',
      confidence: 0.9,
      reason: 'fine',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.prompt).toBe('{"option":"refund"}');
    expect(calls[0]!.options).toEqual({
      systemPrompt: `You are a risk analyst.\n\n${EVALUATOR_INSTRUCTIONS}`,
      model: DEFAULT_MODEL,
      tools: [],
      maxTurns: 4,
      outputFormat: { type: 'json_schema', schema: EVALUATION_SCHEMA },
      settingSources: [],
      persistSession: false,
    });
  });

  it('prefers the definition over the argument over the default; queryOptions apply last', async () => {
    const { query, calls } = stubQuery(answer('APPROVE'));
    const def = {
      description: 'd',
      prompt: 'p',
      tools: ['WebSearch'],
      disallowedTools: ['Bash'],
      effort: 'high' as const,
    };
    await claudeEvaluator(
      { ...def, model: 'claude-haiku-5-5', maxTurns: 2 },
      { query, model: 'x', maxTurns: 9 },
    ).evaluate({}, info);
    await claudeEvaluator({ ...def, model: 'inherit' }, { query, model: 'claude-sonnet-5-5', maxTurns: 9 }).evaluate(
      {},
      info,
    );
    await claudeEvaluator(def, { query, queryOptions: { model: 'forced', maxTurns: 1 } }).evaluate({}, info);
    expect(calls.map((c) => [c.options?.model, c.options?.maxTurns])).toEqual([
      ['claude-haiku-5-5', 2],
      ['claude-sonnet-5-5', 9],
      ['forced', 1],
    ]);
    expect(calls[0]!.options).toMatchObject({ tools: ['WebSearch'], disallowedTools: ['Bash'], effort: 'high' });
  });

  it('falls back to the result text, then to REVIEW/0 on an answer that does not validate', async () => {
    const { query } = stubQuery(
      [success(undefined, '```json\n{"recommendation":"block","confidence":0.4,"reason":"r"}\n```')],
      [success({ recommendation: 'MAYBE', confidence: 2 })],
    );
    const evaluator = claudeEvaluator({ description: 'd', prompt: 'p' }, { query });
    expect((await evaluator.evaluate({}, info)).recommendation).toBe('BLOCK');
    expect(await evaluator.evaluate({}, info)).toEqual(UNPARSEABLE);
  });

  it.each([
    [
      'an error subtype',
      { type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['too many turns'] },
      'claude evaluator error_max_turns: too many turns',
    ],
    [
      'an error with no detail',
      { type: 'result', subtype: 'error_during_execution', is_error: true, errors: [] },
      'no detail',
    ],
    [
      'a success flagged is_error',
      { type: 'result', subtype: 'success', is_error: true, result: 'Invalid API key' },
      'Invalid API key',
    ],
  ])('throws MacpSdkError on %s', async (_name, message, text) => {
    const { query } = stubQuery([message as unknown as SDKMessage]);
    await expect(claudeEvaluator({ description: 'd', prompt: 'p' }, { query }).evaluate({}, info)).rejects.toThrow(
      text,
    );
  });

  it('reports the error result the SDK yielded before throwing, else wraps the throw', async () => {
    const def = { description: 'd', prompt: 'p' };
    const throwing =
      (...before: SDKMessage[]): QueryFn =>
      () =>
        (async function* () {
          yield* before;
          throw new Error('Claude Code returned an error result');
        })();
    const errorResult = {
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: 'Not logged in',
    } as unknown as SDKMessage;
    await expect(claudeEvaluator(def, { query: throwing(errorResult) }).evaluate({}, info)).rejects.toThrow(
      'claude evaluator error: Not logged in',
    );
    const wrapped = claudeEvaluator(def, { query: throwing() }).evaluate({}, info);
    await expect(wrapped).rejects.toBeInstanceOf(MacpSdkError);
    await expect(wrapped).rejects.toThrow('claude evaluator: Claude Code returned an error result');
  });

  it('throws when the stream ends without a result', async () => {
    const { query } = stubQuery([]);
    await expect(claudeEvaluator({ description: 'd', prompt: 'p' }, { query }).evaluate({}, info)).rejects.toThrow(
      /without a result/,
    );
  });
});

describe('macpConsensus', () => {
  it('turns agents into participants in key order, each evaluating with its own query', async () => {
    const { client, sent } = fakeClient();
    const { query, calls } = stubQuery(answer('APPROVE'), answer('BLOCK', 'risky'), answer('APPROVE'));
    const result = await macpConsensus(
      {
        client,
        agents: {
          fraud: { description: 'fraud', prompt: 'You are a fraud analyst.' },
          risk: { description: 'risk', prompt: 'You are a risk analyst.', auth: Auth.devAgent('risk') },
          compliance: { description: 'compliance', prompt: 'You are a compliance officer.' },
        },
        evaluator: { query },
      },
      { option: 'refund order 9', details: { amount: 120 } },
    );
    expect(result).toMatchObject({ outcome: 'approve', approvals: 2, threshold: 2 });
    expect(result.ballots.map((b) => [b.participant, b.vote])).toEqual([
      ['fraud', 'APPROVE'],
      ['risk', 'REJECT'],
      ['compliance', 'APPROVE'],
    ]);
    expect(calls.map((c) => (c.options?.systemPrompt as string).split('\n')[0])).toEqual([
      'You are a fraud analyst.',
      'You are a risk analyst.',
      'You are a compliance officer.',
    ]);
    expect(JSON.parse(calls[0]!.prompt)).toEqual({
      proposalId: 'p1',
      option: 'refund order 9',
      rationale: '',
      details: { amount: 120 },
      mode: 'macp.mode.decision.v1',
    });
    expect(sent.filter((s) => s.messageType === 'Evaluation').map((s) => s.sender)).toEqual([
      'fraud',
      'risk',
      'compliance',
    ]);
  });

  it('accepts plain participants', async () => {
    const { client } = fakeClient();
    const result = await macpConsensus(
      { client, mode: 'quorum', threshold: 1, participants: [{ id: 'a', evaluator: fixed('APPROVE') }] },
      { option: 'x' },
    );
    expect(result).toMatchObject({ outcome: 'approve', mode: 'macp.mode.quorum.v1' });
  });

  it.each([
    ['both', { agents: {}, participants: [] }],
    ['neither', {}],
  ])('needs exactly one of agents / participants (%s)', (_name, extra) => {
    const { client } = fakeClient();
    expect(() => toConsensusOptions({ client, ...extra } as never)).toThrow(TypeError);
    expect(() => toConsensusOptions({ client, ...extra } as never)).toThrow(/exactly one/);
  });

  it('passes a per-agent voter through', () => {
    const { client } = fakeClient();
    const voter = { shouldVote: () => false, decideVote: async () => ({ vote: 'APPROVE', reason: '' }) };
    const [p] = toConsensusOptions({ client, agents: { a: { description: 'd', prompt: 'p', voter } } }).participants;
    expect(p!.voter).toBe(voter);
    expect(p!.auth).toBeUndefined();
  });
});

type ToolResult = {
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/** Calls the tool as the MCP server would, with only the arguments the model sent. */
const call = (t: ReturnType<typeof consensusTool>, args: Record<string, unknown>) =>
  t.handler(args as Parameters<typeof t.handler>[0], {}) as Promise<ToolResult>;

describe('consensus tool', () => {
  const participants = [
    { id: 'a', evaluator: fixed('APPROVE') },
    { id: 'b', evaluator: fixed('APPROVE') },
  ];

  it('builds an in-process MCP server named macp, validating options up front', () => {
    const { client } = fakeClient();
    const server = macpConsensusServer({ client, participants });
    expect(server).toMatchObject({ type: 'sdk', name: 'macp' });
    expect(macpConsensusServer({ client, participants, name: 'board' }).name).toBe('board');
    expect(() => macpConsensusServer({ client, participants: [] })).toThrow(TypeError);
    expect(() => macpConsensusServer({ client, participants, threshold: 3 })).toThrow(/threshold/);
  });

  it('runs a session per call, returns the result as text and structuredContent, and calls onResult', async () => {
    const { client } = fakeClient();
    const seen: ConsensusResult[] = [];
    const t = consensusTool({ client, participants, onResult: (r) => void seen.push(r) });
    expect(t.name).toBe('consensus');
    expect(t.description).toMatch(/\(a, b\)/);
    const out = await call(t, { option: 'ship it', details: { pr: 1 } });
    expect(out.isError).toBeUndefined();
    const result = JSON.parse(out.content[0]!.text) as ConsensusResult;
    expect(result).toMatchObject({ outcome: 'approve', approvals: 2 });
    expect(out.structuredContent).toEqual(result);
    expect(seen).toEqual([result]);
    expect(verifyReceipt(consensusReceipt(result, { issuer: 'lead' }), {}).verdict).toBe('integrity_only');
  });

  it('returns a failed session as a tool error, after cancelling it', async () => {
    const { client, cancel } = fakeClient({ failOn: 'Commitment' });
    const out = await call(consensusTool({ client, participants }), { option: 'x' });
    expect(out).toMatchObject({ isError: true });
    expect(out.content[0]!.text).toBe('consensus failed: boom on Commitment');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('reports an onResult failure without hiding that the session committed', async () => {
    const { client } = fakeClient();
    const t = consensusTool({
      client,
      participants,
      onResult: () => {
        throw new Error('disk full');
      },
    });
    const out = await call(t, { option: 'x' });
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toMatch(/^consensus committed approve \(session .+\) but onResult failed: disk full$/);
  });
});
