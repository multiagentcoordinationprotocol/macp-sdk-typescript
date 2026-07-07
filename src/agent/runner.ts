import * as fs from 'node:fs';
import * as path from 'node:path';
import { Auth } from '../auth';
import { MacpClient } from '../client';
import { DEFAULT_POLICY_VERSION } from '../constants';
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
      // Extension metadata map (RFC-MACP-0008). Values arrive as arbitrary
      // JSON-serialisable structures in the bootstrap file — the runner
      // serialises each one to UTF-8 JSON bytes before handing it to the
      // mode `start()`, since the envelope carries `Record<string, Buffer>`.
      extensions?: Record<string, unknown>;
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

/**
 * Serialise a JSON-native extensions map (as delivered in the bootstrap
 * payload) into the `Record<string, Buffer>` form the SessionStart envelope
 * expects. Each value is encoded as UTF-8 JSON so arbitrary structures
 * round-trip through the protobuf `bytes` field. `Buffer` / `Uint8Array`
 * values are passed through untouched so callers that already hold raw bytes
 * don't pay a double-encode.
 */
function encodeExtensions(extensions: Record<string, unknown> | undefined): Record<string, Buffer> | undefined {
  if (!extensions) return undefined;
  const out: Record<string, Buffer> = {};
  for (const [key, value] of Object.entries(extensions)) {
    if (Buffer.isBuffer(value)) {
      out[key] = value;
    } else if (value instanceof Uint8Array) {
      out[key] = Buffer.from(value);
    } else {
      out[key] = Buffer.from(JSON.stringify(value), 'utf8');
    }
  }
  return out;
}
