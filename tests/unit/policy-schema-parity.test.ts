import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  ABSTENTION_INTERPRETATIONS,
  COMMITMENT_AUTHORITIES,
  CRITICAL_OBJECTION_ACTIONS,
  PROPOSAL_ACCEPTANCE_CRITERIA,
  buildDecisionPolicy,
  buildHandoffPolicy,
  buildProposalPolicy,
  buildQuorumPolicy,
  buildTaskPolicy,
  type PolicyRuleExtras,
} from '../../src/policy';

// Policy-builder value domains vs the canonical rule schemas: the SDK analogue
// of the runtime's `enum_lists_match_the_canonical_schemas`, and of
// macp-sdk-python's tests/unit/test_policy_schema_parity.py. Needs a spec
// checkout, so it runs only when MACP_POLICY_SCHEMAS_DIR points at the spec's
// schemas/json/policy directory (the conformance-fixtures workflow sets it).

const DIR = process.env.MACP_POLICY_SCHEMAS_DIR;
const MODES = ['decision', 'quorum', 'proposal', 'task', 'handoff'] as const;
type Schema = { properties: Record<string, Schema>; enum?: unknown[]; [k: string]: unknown };

const schema = (mode: string): Schema =>
  JSON.parse(fs.readFileSync(path.join(DIR!, `${mode}-rules.schema.json`), 'utf8')) as Schema;
const prop = (s: Schema, ...names: string[]): Schema => names.reduce((node, name) => node.properties[name], s);
const sorted = (values: Iterable<unknown>) => [...values].map(String).sort();

const BUILD = {
  decision: () => buildDecisionPolicy('p', 'd', {}),
  quorum: () => buildQuorumPolicy('p', 'd', {}),
  proposal: () => buildProposalPolicy('p', 'd', {}),
  task: () => buildTaskPolicy('p', 'd', {}),
  handoff: () => buildHandoffPolicy('p', 'd', {}),
};

const BUILD_WITH_EXTRAS = {
  decision: (extras: PolicyRuleExtras) => buildDecisionPolicy('p', 'd', {}, extras),
  quorum: (extras: PolicyRuleExtras) => buildQuorumPolicy('p', 'd', {}, extras),
  proposal: (extras: PolicyRuleExtras) => buildProposalPolicy('p', 'd', {}, extras),
  task: (extras: PolicyRuleExtras) => buildTaskPolicy('p', 'd', {}, extras),
  handoff: (extras: PolicyRuleExtras) => buildHandoffPolicy('p', 'd', {}, extras),
};

describe.skipIf(!DIR)('policy builder domains match the canonical rule schemas', () => {
  it.each(MODES)('%s commitment.authority', (mode) => {
    expect(sorted(prop(schema(mode), 'commitment', 'authority').enum!)).toEqual(sorted(COMMITMENT_AUTHORITIES));
  });

  it.each(MODES)('%s extension and annotation key patterns', (mode) => {
    // The builders' private EXTENSION_KEY_RE/ANNOTATION_KEY_RE sources.
    const patterns = Object.keys(schema(mode).patternProperties as Record<string, unknown>);
    expect(patterns).toContain('^x-[a-z0-9]+(\\.[a-z0-9-]+)+$');
    expect(patterns).toContain('^[_$]');
    const rules = JSON.parse(
      BUILD_WITH_EXTRAS[mode]({ extensions: { 'x-com.acme.audit': {} }, annotations: { _note: 1 } }).rules,
    );
    for (const key of ['x-com.acme.audit', '_note']) {
      expect(
        patterns.some((p) => new RegExp(p).test(key)),
        key,
      ).toBe(true);
    }
  });

  it('decision enums and bounds', () => {
    const s = schema('decision');
    // Private sets: every schema value must build, and the union lists here
    // must equal the schema.
    const algorithms = prop(s, 'voting', 'algorithm').enum as string[];
    expect(sorted(algorithms)).toEqual(
      sorted(['none', 'majority', 'supermajority', 'unanimous', 'weighted', 'plurality']),
    );
    expect(sorted(prop(s, 'voting', 'quorum', 'type').enum!)).toEqual(['count', 'percentage']);
    for (const type of ['count', 'percentage'] as const) {
      expect(() => buildDecisionPolicy('p', 'd', { voting: { quorum: { type, value: 1 } } })).not.toThrow();
    }
    expect(prop(s, 'voting', 'quorum', 'value').minimum).toBe(0);
    expect(sorted(prop(s, 'objection_handling', 'critical_objection_action').enum!)).toEqual(
      sorted(CRITICAL_OBJECTION_ACTIONS),
    );
    const veto = prop(s, 'objection_handling', 'veto_threshold');
    expect([veto.type, veto.minimum]).toEqual(['integer', 1]);
    const mc = prop(s, 'evaluation', 'minimum_confidence');
    expect([mc.minimum, mc.maximum]).toEqual([0, 1]);
  });

  it('quorum enums and bounds', () => {
    const s = schema('quorum');
    expect(sorted(prop(s, 'threshold', 'type').enum!)).toEqual(['n_of_m', 'percentage']);
    const value = prop(s, 'threshold', 'value');
    expect([value.type, value.exclusiveMinimum]).toEqual(['integer', 0]);
    expect(sorted(prop(s, 'abstention', 'interpretation').enum!)).toEqual(sorted(ABSTENTION_INTERPRETATIONS));
  });

  it('proposal enums and bounds', () => {
    const s = schema('proposal');
    expect(sorted(prop(s, 'acceptance', 'criterion').enum!)).toEqual(sorted(PROPOSAL_ACCEPTANCE_CRITERIA));
    const rounds = prop(s, 'counter_proposal', 'max_rounds');
    expect([rounds.type, rounds.minimum]).toEqual(['integer', 0]);
  });

  it('handoff bounds', () => {
    const timeout = prop(schema('handoff'), 'acceptance', 'implicit_accept_timeout_ms');
    expect([timeout.type, timeout.minimum]).toEqual(['integer', 0]);
  });

  it.each(MODES)('%s: every section the builder emits is declared', (mode) => {
    const emitted = JSON.parse(BUILD[mode]().rules) as Record<string, unknown>;
    const declared = schema(mode).properties;
    for (const [section, body] of Object.entries(emitted)) {
      expect(declared, `${mode}: undeclared section ${section}`).toHaveProperty(section);
      if (body && typeof body === 'object') {
        const inner = Object.keys(declared[section].properties ?? {});
        for (const key of Object.keys(body)) expect(inner, `${mode}.${section}.${key}`).toContain(key);
      }
    }
  });
});
