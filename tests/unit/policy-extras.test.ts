import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  buildDecisionPolicy,
  buildHandoffPolicy,
  buildProposalPolicy,
  buildQuorumPolicy,
  buildTaskPolicy,
  policyRuleExtensions,
  type PolicyRuleExtras,
} from '../../src/policy';
import { MacpSessionError } from '../../src/errors';
import type { PolicyDescriptor } from '../../src/types';
import { GOLDEN_CASES } from './policy-golden-cases';

// RFC-MACP-0012 §4 extension (`x-`) and annotation (`_`/`$`) rules keys. Same
// cases as macp-sdk-python's tests/unit/test_policy_domains.py extras block.

const BUILDERS: Record<string, (extras?: PolicyRuleExtras) => PolicyDescriptor> = {
  decision: (extras) => buildDecisionPolicy('p', 'd', {}, extras),
  quorum: (extras) => buildQuorumPolicy('p', 'd', {}, extras),
  proposal: (extras) => buildProposalPolicy('p', 'd', {}, extras),
  task: (extras) => buildTaskPolicy('p', 'd', {}, extras),
  handoff: (extras) => buildHandoffPolicy('p', 'd', {}, extras),
};

describe('policy rule extensions and annotations', () => {
  it.each(Object.keys(BUILDERS))('%s: emitted at top level, after the standard sections, in order', (mode) => {
    const standard = Object.keys(JSON.parse(BUILDERS[mode]().rules));
    const rules = JSON.parse(
      BUILDERS[mode]({
        extensions: { 'x-com.acme.audit': { level: 2 }, 'x-org.example.v-2': {} },
        annotations: { _owner: 'team-a', $comment: ['free', 'form'] },
      }).rules,
    );
    expect(Object.keys(rules)).toEqual([...standard, 'x-com.acme.audit', 'x-org.example.v-2', '_owner', '$comment']);
    expect(rules['x-com.acme.audit']).toEqual({ level: 2 });
    expect(rules.$comment).toEqual(['free', 'form']);
  });

  it.each<[string, PolicyRuleExtras['extensions'], string]>([
    ['collision', { voting: {} }, 'collides with a standard rule section'],
    ['no x- prefix', { 'com.acme': {} }, 'must match'],
    ['single segment', { 'x-acme': {} }, 'must match'],
    ['uppercase', { 'x-Com.acme': {} }, 'must match'],
    ['prototype name', { toString: {} }, 'must match'],
    ['non-object', { 'x-com.acme': 3 as unknown as Record<string, unknown> }, 'must be an object'],
    ['null', { 'x-com.acme': null as unknown as Record<string, unknown> }, 'must be an object'],
    ['array', { 'x-com.acme': [] as unknown as Record<string, unknown> }, 'must be an object'],
  ])('bad extension (%s)', (_label, extensions, message) => {
    const build = () => buildDecisionPolicy('p', 'd', {}, { extensions });
    expect(build).toThrow(MacpSessionError);
    expect(build).toThrow(message);
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['collision', { commitment: 1 }, 'collides with a standard rule section'],
    ['no prefix', { owner: 'a' }, "must start with '_' or '$'"],
    ['x- key', { 'x-com.acme': {} }, "must start with '_' or '$'"],
  ])('bad annotation (%s)', (_label, annotations, message) => {
    const build = () => buildQuorumPolicy('p', 'd', {}, { annotations });
    expect(build).toThrow(MacpSessionError);
    expect(build).toThrow(message);
  });

  it('a __proto__ annotation becomes an own key, not a prototype swap', () => {
    const annotations = JSON.parse('{"__proto__": {"polluted": true}}') as Record<string, unknown>;
    const rules = JSON.parse(buildTaskPolicy('p', 'd', {}, { annotations }).rules);
    expect(Object.hasOwn(rules, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('copies extension objects (later caller mutation does not leak)', () => {
    const section: Record<string, unknown> = { level: 1 };
    const descriptor = buildHandoffPolicy('p', 'd', {}, { extensions: { 'x-com.acme.audit': section } });
    section.level = 9;
    expect(JSON.parse(descriptor.rules)['x-com.acme.audit']).toEqual({ level: 1 });
  });

  it('empty extensions/annotations change nothing', () => {
    for (const build of Object.values(BUILDERS)) {
      expect(build({ extensions: {}, annotations: {} }).rules).toBe(build().rules);
    }
  });
});

describe('policy builder rules bytes (golden)', () => {
  const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'golden', 'policy-builders.json'), 'utf8')) as Record<
    string,
    string
  >;

  it('every case is snapshotted', () => {
    expect(Object.keys(golden).sort()).toEqual(Object.keys(GOLDEN_CASES).sort());
  });

  it.each(Object.keys(GOLDEN_CASES))('%s', (name) => {
    expect(GOLDEN_CASES[name]().rules).toBe(golden[name]);
  });
});

describe('policyRuleExtensions', () => {
  it('reads InitializeResult.capabilities.policyRegistry.ruleExtensions', () => {
    const capabilities = { policyRegistry: { registerPolicy: true, ruleExtensions: ['x-com.acme.audit'] } };
    expect(policyRuleExtensions({ selectedProtocolVersion: '1.0', capabilities })).toEqual(['x-com.acme.audit']);
    expect(policyRuleExtensions(capabilities)).toEqual(['x-com.acme.audit']);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['no capabilities', { selectedProtocolVersion: '1.0' }],
    ['no policyRegistry', { modeRegistry: {} }],
    ['pre-0.9 registry', { policyRegistry: { registerPolicy: true } }],
    ['non-array', { policyRegistry: { ruleExtensions: 'x-a.b' } }],
  ])('%s: []', (_label, source) => {
    expect(policyRuleExtensions(source as never)).toEqual([]);
  });

  it('drops non-string entries', () => {
    expect(policyRuleExtensions({ policyRegistry: { ruleExtensions: ['x-a.b', 3, null] } })).toEqual(['x-a.b']);
  });
});
