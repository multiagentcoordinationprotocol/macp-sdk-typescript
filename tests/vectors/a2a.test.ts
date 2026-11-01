/**
 * Replays RFC-MACP-0014's A2A binding vectors (tests/vectors/a2a/, vendored
 * from the spec repo, see SOURCE.md) through src/a2a.ts. Envelopes and Acks
 * in `input`/`expected` are canonical JSON (RFC-MACP-0001 §10): inputs are
 * parsed with the canonical-json codec, results re-encoded with it, and
 * compared as parsed JSON.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ackFromA2aMessage,
  ackToA2aMessage,
  envelopeFromA2aArtifact,
  envelopeFromA2aMessage,
  envelopeFromA2aPart,
  envelopeToA2aArtifact,
  envelopeToA2aMessage,
  envelopeToA2aPart,
  errorInfoFromA2a,
  macpAgentExtension,
  MacpA2aError,
  sessionStateFromA2a,
  sessionStateToA2a,
  type A2aArtifact,
  type A2aMessage,
  type A2aPart,
} from '../../src/a2a';
import {
  ackFromCanonicalJson,
  ackToCanonicalJson,
  envelopeFromCanonicalJson,
  envelopeToCanonicalJson,
} from '../../src/canonical-json';
import type { SessionState } from '../../src/types';

interface Vector {
  id: string;
  op: string;
  description: string;
  input: Record<string, unknown>;
  params?: Record<string, unknown>;
  expected?: unknown;
  expected_error?: { layer: string; code: string };
}

const DIR = join(__dirname, 'a2a');
const VECTORS: Vector[] = readdirSync(DIR)
  .filter((name) => name.startsWith('a2a_') && name.endsWith('.json'))
  .sort()
  .map((name) => JSON.parse(readFileSync(join(DIR, name), 'utf8')) as Vector);

const decodeOptions = (params: Record<string, unknown>) =>
  params.max_payload_bytes === undefined ? {} : { maxPayloadBytes: params.max_payload_bytes as number };

const OPS: Record<string, (input: Record<string, unknown>, params: Record<string, unknown>) => unknown> = {
  envelope_to_a2a_part: (input, params) =>
    envelopeToA2aPart(envelopeFromCanonicalJson(input.envelope), {
      encoding: params.encoding as 'json' | 'proto' | undefined,
    }),
  envelope_from_a2a_part: (input, params) =>
    envelopeToCanonicalJson(envelopeFromA2aPart(input.part as A2aPart, decodeOptions(params))),
  envelope_to_a2a_message: (input, params) =>
    envelopeToA2aMessage(envelopeFromCanonicalJson(input.envelope), {
      encoding: params.encoding as 'json' | 'proto' | undefined,
      messageId: params.message_id as string | undefined,
      contextId: params.context_id as string | undefined,
    }),
  envelope_from_a2a_message: (input, params) =>
    envelopeToCanonicalJson(envelopeFromA2aMessage(input.message as A2aMessage, decodeOptions(params))),
  ack_to_a2a_message: (input, params) =>
    ackToA2aMessage(ackFromCanonicalJson(input.ack), {
      messageId: params.message_id as string,
      taskId: params.task_id as string | undefined,
      contextId: params.context_id as string | undefined,
    }),
  ack_from_a2a_message: (input) => ackToCanonicalJson(ackFromA2aMessage(input.message as A2aMessage)),
  envelope_to_a2a_artifact: (input) =>
    envelopeToA2aArtifact(envelopeFromCanonicalJson(input.envelope), input.sequence as number),
  envelope_from_a2a_artifact: (input, params) => {
    const { envelope, sequence } = envelopeFromA2aArtifact(input.artifact as A2aArtifact, decodeOptions(params));
    return { envelope: envelopeToCanonicalJson(envelope), sequence };
  },
  session_state_to_a2a: (input) => {
    const { taskState, metadata } = sessionStateToA2a(input.session_state as SessionState);
    return { task_state: taskState, metadata };
  },
  session_state_from_a2a: (input) => sessionStateFromA2a(input.task_or_event as { metadata?: Record<string, unknown> }),
  macp_agent_extension: (_input, params) =>
    macpAgentExtension({
      macpVersions: params.macp_versions as string[],
      modes: params.modes as string[],
      required: params.required as boolean | undefined,
      manifestUrl: params.manifest_url as string | undefined,
    }),
  error_info_from_a2a: (input) => errorInfoFromA2a(input.error_or_details),
};

/** Parsed-JSON form: drops undefined members, so "absent" and "omitted" compare equal. */
const asJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value) ?? 'null');

describe('RFC-MACP-0014 A2A binding vectors', () => {
  it('vendors all 107 vectors: 69 positive, 38 reject, every op covered', () => {
    expect(VECTORS).toHaveLength(107);
    expect(VECTORS.filter((v) => v.expected_error).length).toBe(38);
    expect(new Set(VECTORS.map((v) => v.op))).toEqual(new Set(Object.keys(OPS)));
  });

  it.each(VECTORS.filter((v) => !v.expected_error).map((v) => [v.id, v] as const))('%s', (_id, v) => {
    expect(asJson(OPS[v.op]!(v.input, v.params ?? {}))).toStrictEqual(v.expected);
  });

  it.each(VECTORS.filter((v) => v.expected_error).map((v) => [v.id, v] as const))('%s', (_id, v) => {
    let caught: unknown;
    try {
      OPS[v.op]!(v.input, v.params ?? {});
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MacpA2aError);
    const error = caught as MacpA2aError;
    expect({ layer: error.layer, code: error.code }).toStrictEqual(v.expected_error);
  });
});
