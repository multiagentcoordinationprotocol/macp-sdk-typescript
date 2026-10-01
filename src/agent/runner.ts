import * as fs from 'node:fs';
import * as path from 'node:path';
import { Auth } from '../auth';
import { MacpClient } from '../client';
import { DEFAULT_POLICY_VERSION } from '../constants';
import { logger } from '../logging';
import { Participant, type ParticipantConfig, type InitiatorConfig } from './participant';

export interface BootstrapPayload {
  session_id: string;
  participant_id: string;
  mode: string;
  mode_version?: string;
  configuration_version?: string;
  policy_version?: string;
  runtime_address?: string;
  runtime_url?: string;
  auth_token?: string;
  agent_id?: string;
  secure?: boolean;
  allow_insecure?: boolean;
  participants?: string[];
  initiator?: {
    session_start: {
      intent: string;
      participants: string[];
      ttl_ms: number;
      // Per-session max-suspend cap (ms, proto ≥ 0.1.5). 0/absent = runtime default.
      max_suspend_ms?: number;
      mode_version?: string;
      configuration_version?: string;
      policy_version?: string;
      context?: Record<string, unknown>;
      // RFC-MACP-0007 context propagation: identifier linking this session
      // to an upstream context (e.g. parent run / scenario). Empty / omitted
      // means "no upstream context".
      context_id?: string;
      // Extension metadata map (RFC-MACP-0008). Wire-level `extensions` is a
      // protobuf `map<string, bytes>`; RFC-MACP-0001 §10.3 requires `bytes`
      // fields to serialize as base64 strings in JSON, so a value here is
      // normally a base64 string (decoded strictly, with a raw-UTF-8
      // fallback for a non-base64 string — see `encodeExtensions`). A
      // `Buffer`/`Uint8Array` value is also accepted and passed through
      // unchanged, for in-process TS callers that already hold raw bytes —
      // this can never occur via a JSON bootstrap *file* (JSON has no byte
      // type), only via a hand-constructed `InitiatorConfig`.
      extensions?: Record<string, string | Buffer | Uint8Array>;
      roots?: Array<{ uri: string; name?: string }>;
    };
    kickoff?: {
      message_type: string;
      payload_type?: string;
      payload: Record<string, unknown>;
    };
  };
  metadata?: Record<string, unknown>;
  /**
   * Bind a cancel-callback HTTP endpoint (RFC-0001 §7.2 Option A). The
   * orchestrator POSTs `{runId, reason}` to `http://host:port{path}` to
   * request a clean shutdown. The runner starts the endpoint before
   * entering the event loop and closes it when the participant stops.
   */
  cancel_callback?: { host: string; port: number; path: string };
}

export function fromBootstrap(bootstrapPath?: string): Participant {
  const resolvedPath = bootstrapPath ?? process.env.MACP_BOOTSTRAP_FILE;
  if (!resolvedPath) {
    throw new Error(
      'No bootstrap path provided. Either pass a path argument or set the MACP_BOOTSTRAP_FILE environment variable.',
    );
  }

  const absolutePath = path.isAbsolute(resolvedPath) ? resolvedPath : path.resolve(process.cwd(), resolvedPath);

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Bootstrap file not found: ${absolutePath}`);
  }

  const raw = fs.readFileSync(absolutePath, 'utf8');
  const payload: BootstrapPayload = JSON.parse(raw);

  if (!payload.session_id) throw new Error('Bootstrap payload missing session_id');
  if (!payload.participant_id) throw new Error('Bootstrap payload missing participant_id');
  if (!payload.mode) throw new Error('Bootstrap payload missing mode');

  const runtimeAddress = payload.runtime_address ?? payload.runtime_url ?? '';
  if (!runtimeAddress) throw new Error('Bootstrap payload missing runtime_address / runtime_url');

  const auth = payload.auth_token
    ? Auth.bearer(payload.auth_token, { expectedSender: payload.participant_id })
    : Auth.devAgent(payload.agent_id ?? payload.participant_id);

  const client = new MacpClient({
    address: runtimeAddress,
    secure: payload.secure,
    allowInsecure: payload.allow_insecure,
    auth,
  });

  let initiator: InitiatorConfig | undefined;
  if (payload.initiator) {
    const ss = payload.initiator.session_start;
    initiator = {
      sessionStart: {
        intent: ss.intent,
        participants: ss.participants,
        ttlMs: ss.ttl_ms,
        maxSuspendMs: ss.max_suspend_ms,
        contextId: ss.context_id,
        extensions: encodeExtensions(ss.extensions),
        roots: ss.roots,
      },
      kickoff: payload.initiator.kickoff
        ? {
            messageType: payload.initiator.kickoff.message_type,
            payload: payload.initiator.kickoff.payload,
          }
        : undefined,
    };
  }

  const config: ParticipantConfig = {
    participantId: payload.participant_id,
    sessionId: payload.session_id,
    mode: payload.mode,
    client,
    auth,
    participants: payload.participants ?? [],
    modeVersion: payload.mode_version,
    configurationVersion: payload.configuration_version,
    policyVersion: payload.policy_version ?? DEFAULT_POLICY_VERSION,
    initiator,
    cancelCallback: payload.cancel_callback
      ? {
          host: payload.cancel_callback.host,
          port: payload.cancel_callback.port,
          path: payload.cancel_callback.path,
        }
      : undefined,
  };

  return new Participant(config);
}

// Matches a syntactically valid base64 string (correct alphabet, correct
// padding) — a cheap stand-in for Python's `base64.b64decode(value,
// validate=True)` so a plainly non-base64 string (e.g. "pack:example-001")
// is rejected up front rather than silently mis-decoded by Node's lenient
// `Buffer.from(str, 'base64')`, which ignores invalid characters instead of
// raising. Matches the empty string too (decodes to an empty buffer either
// way, so which branch handles it is immaterial).
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function tryDecodeBase64(value: string): Buffer | undefined {
  if (!BASE64_PATTERN.test(value)) return undefined;
  return Buffer.from(value, 'base64');
}

function describeExtensionsValueType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Coerce a bootstrap `session_start.extensions` map into the
 * `Record<string, Buffer>` form the SessionStart envelope expects
 * (`map<string, bytes>` on the wire).
 *
 * Per RFC-MACP-0001 §10.3, a protobuf `bytes` field's canonical JSON
 * representation is a base64 string, so a `string` value is base64-decoded
 * first (strict shape check via `BASE64_PATTERN`, not Node's lenient
 * decoder); a string that isn't valid base64 falls back to raw UTF-8 bytes.
 * This base64-first heuristic — and the resulting ambiguity for a plain
 * string that happens to also be valid base64 — mirrors
 * `macp-sdk-python`'s `_decode_extensions` on purpose, to stay
 * byte-for-byte interoperable; it is a known, tracked wart, not fixed here.
 * `Buffer`/`Uint8Array` values pass through unchanged, for TS-only
 * in-process callers that already hold raw bytes (never reachable via a
 * JSON bootstrap file). Anything else — including the `extensions`
 * container itself being a non-object (string/number/boolean/array) —
 * throws, naming the offending key and/or type, so a malformed bootstrap
 * fails loudly at construction instead of silently corrupting wire bytes a
 * peer can't decode (issue #139).
 */
export function encodeExtensions(
  extensions: Record<string, string | Buffer | Uint8Array> | undefined,
): Record<string, Buffer> | undefined {
  if (extensions === undefined || extensions === null) return undefined;
  if (typeof extensions !== 'object' || Array.isArray(extensions)) {
    throw new Error(
      `bootstrap session_start.extensions must be an object, got ${describeExtensionsValueType(extensions)}`,
    );
  }
  const out: Record<string, Buffer> = {};
  for (const [key, value] of Object.entries(extensions)) {
    if (Buffer.isBuffer(value)) {
      out[key] = value;
    } else if (value instanceof Uint8Array) {
      out[key] = Buffer.from(value);
    } else if (typeof value === 'string') {
      const decoded = tryDecodeBase64(value);
      if (decoded !== undefined) {
        logger.debug(`[fromBootstrap] extensions["${key}"] decoded as base64`);
        out[key] = decoded;
      } else {
        logger.debug(`[fromBootstrap] extensions["${key}"] is not valid base64; falling back to raw UTF-8`);
        out[key] = Buffer.from(value, 'utf8');
      }
    } else {
      throw new Error(
        `bootstrap extensions["${key}"] must be a base64-encoded string (or Buffer/Uint8Array), got ${describeExtensionsValueType(value)}`,
      );
    }
  }
  return out;
}
