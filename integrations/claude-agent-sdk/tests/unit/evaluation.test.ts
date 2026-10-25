import { describe, expect, it } from 'vitest';
import { UNPARSEABLE, parseEvaluation, toEvaluation } from '../../src/index.js';

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

describe('toEvaluation', () => {
  it('validates a structured output like parsed text', () => {
    expect(toEvaluation({ recommendation: 'block', confidence: 0.7, reason: 'r' })).toEqual({
      recommendation: 'BLOCK',
      confidence: 0.7,
      reason: 'r',
    });
    expect(toEvaluation('{"recommendation":"APPROVE","confidence":1}').recommendation).toBe('APPROVE');
  });

  it.each([[null], [undefined], [[1]], [3], [{ recommendation: 'YES', confidence: 1 }]])(
    'falls back to REVIEW/0 on %j',
    (answer) => expect(toEvaluation(answer)).toEqual(UNPARSEABLE),
  );
});
