// Child process for otel_absent_no_import (tests/unit/otel.test.ts). Run with
// tsx; with `block-otel.cjs` preloaded, @opentelemetry/api is unresolvable.
// Prints one JSON line describing what the SDK loaded and sent.
import * as sdk from '../../../src/index';

const loaded = (): string[] => Object.keys(require.cache).filter((k) => k.includes('@opentelemetry'));
const afterImport = loaded();

const client = new sdk.MacpClient({ address: '127.0.0.1:1', secure: false, allowInsecure: true });
const afterConstruct = loaded();

const grpcClient = (client as unknown as { client: Record<string, unknown> }).client;
const calls: unknown[][] = [];
for (const name of ['GetManifest', 'Send']) {
  grpcClient[name] = (...args: unknown[]) => {
    calls.push(
      args
        .slice(1, -1)
        .map((a) => (a && typeof a === 'object' && 'getMap' in a ? (a as { getMap(): unknown }).getMap() : a)),
    );
    (args[args.length - 1] as (e: unknown, r: unknown) => void)(null, name === 'Send' ? { ack: { ok: true } } : {});
  };
}

async function main(): Promise<void> {
  await client.getManifest();
  await client.getManifest();
  const ack = await client.send(
    sdk.buildEnvelope({ mode: 'macp.mode.decision.v1', messageType: 'Vote', sessionId: 's', payload: Buffer.from('') }),
    { auth: sdk.Auth.bearer('t') },
  );
  process.stdout.write(
    JSON.stringify({
      afterImport,
      afterConstruct,
      afterCalls: loaded().length,
      requireCalls: (globalThis as { __otelRequireCalls?: number }).__otelRequireCalls ?? null,
      calls,
      ack,
    }) + '\n',
  );
}

main().catch((error: unknown) => {
  process.stderr.write(String(error));
  process.exit(1);
});
