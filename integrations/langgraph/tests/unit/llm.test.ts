import { describe, expect, it } from 'vitest';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { UNPARSEABLE, llmEvaluator, parseEvaluation } from '../../src';

const info = { sessionId: 's', mode: 'macp.mode.decision.v1', participants: [] };

describe('parseEvaluation', () => {
  it('reads plain and fenced JSON', () => {
    expect(parseEvaluation('{"recommendation":"approve","confidence":0.8,"reason":"fine"}')).toEqual({
      recommendation: 'APPROVE',
      confidence: 0.8,
      reason: 'fine',
    });
    expect(parseEvaluation('```json\n{"recommendation":"BLOCK","confidence":1,"reason":"fraud"}\n```')).toEqual({
      recommendation: 'BLOCK',
      confidence: 1,
      reason: 'fraud',
    });
  });

  it('normalizes ABSTAIN to REVIEW and coerces the reason', () => {
    expect(parseEvaluation('{"recommendation":"Abstain","confidence":0,"reason":7}')).toEqual({
      recommendation: 'REVIEW',
      confidence: 0,
      reason: '7',
    });
    expect(parseEvaluation('{"recommendation":"REJECT","confidence":0.5}').reason).toBe('');
  });

  it.each([
    ['not json', 'I approve!'],
    ['an array', '[1]'],
    ['null', 'null'],
    ['unknown recommendation', '{"recommendation":"ACCEPT","confidence":0.5}'],
    ['missing recommendation', '{"confidence":0.5}'],
    ['confidence > 1', '{"recommendation":"APPROVE","confidence":1.2}'],
    ['confidence < 0', '{"recommendation":"APPROVE","confidence":-0.1}'],
    ['string confidence', '{"recommendation":"APPROVE","confidence":"high"}'],
  ])('falls back to REVIEW/0 on %s', (_name, text) => {
    expect(parseEvaluation(text)).toEqual(UNPARSEABLE);
  });
});

describe('llmEvaluator', () => {
  it('asks the model and parses its answer', async () => {
    const model = new FakeListChatModel({
      responses: ['```json\n{"recommendation":"REVIEW","confidence":0.6,"reason":"needs a human"}\n```', 'garbage'],
    });
    const evaluator = llmEvaluator(model, { systemPrompt: 'be careful' });
    expect(await evaluator.evaluate({ option: 'x' }, info)).toEqual({
      recommendation: 'REVIEW',
      confidence: 0.6,
      reason: 'needs a human',
    });
    expect(await evaluator.evaluate({ option: 'x' }, info)).toEqual(UNPARSEABLE);
  });

  it('sends the system prompt and the proposal as JSON; reads content blocks', async () => {
    const calls: unknown[] = [];
    const model = {
      invoke: async (input: unknown) => {
        calls.push(input);
        return {
          content: [
            { type: 'text', text: '{"recommendation":"APPROVE",' },
            { type: 'text', text: '"confidence":1}' },
          ],
        };
      },
    };
    expect((await llmEvaluator(model).evaluate({ option: 'x' }, info)).recommendation).toBe('APPROVE');
    expect(calls[0]).toEqual([
      ['system', expect.stringContaining('JSON object')],
      ['human', '{"option":"x"}'],
    ]);
  });

  it('treats non-text content as unparseable and lets model errors propagate', async () => {
    expect(await llmEvaluator({ invoke: async () => ({ content: 42 }) }).evaluate({}, info)).toEqual(UNPARSEABLE);
    await expect(
      llmEvaluator({
        invoke: async () => {
          throw new Error('401');
        },
      }).evaluate({}, info),
    ).rejects.toThrow('401');
  });
});
