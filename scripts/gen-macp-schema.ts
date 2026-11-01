/**
 * Generates src/generated/macp-schema.json, the flat, fully resolved schema
 * the canonical JSON codec (src/canonical-json.ts) reads instead of loading
 * .proto files. That keeps the codec free of Node APIs and of protobufjs at
 * runtime, so it can run in a browser.
 *
 * Run after bumping @multiagentcoordinationprotocol/proto:
 *   npm run gen:schema
 * tests/unit/canonical-json-schema.test.ts fails while the committed file
 * differs from what this script builds from the installed package.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import protobuf from 'protobufjs';

/** The proto files whose messages can be an Envelope payload, plus Envelope/Ack. */
const PROTO_FILES = [
  'macp/v1/envelope.proto',
  'macp/v1/core.proto',
  'macp/modes/decision/v1/decision.proto',
  'macp/modes/proposal/v1/proposal.proto',
  'macp/modes/task/v1/task.proto',
  'macp/modes/handoff/v1/handoff.proto',
  'macp/modes/quorum/v1/quorum.proto',
  'macp/modes/multi_round/v1/multi_round.proto',
];

export interface SchemaField {
  name: string;
  id: number;
  /** A scalar type name, or the full name of a message or enum. */
  type: string;
  kind: 'scalar' | 'enum' | 'message';
  repeated?: true;
  /** Present on a map field: the key's scalar type. */
  keyType?: string;
  /** Explicit presence: `proto3 optional` or a oneof member. */
  presence?: true;
}

export interface MacpSchema {
  proto_version: string;
  messages: Record<string, SchemaField[]>;
  enums: Record<string, Record<string, number>>;
}

export function buildMacpSchema(): MacpSchema {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const protoPackage = require('@multiagentcoordinationprotocol/proto') as { protoDir: string };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { version } = require('@multiagentcoordinationprotocol/proto/package.json') as { version: string };
  const protoDir = protoPackage.protoDir;
  const root = new protobuf.Root();
  root.resolvePath = (_origin, target) => (path.isAbsolute(target) ? target : path.join(protoDir, target));
  root.loadSync(
    PROTO_FILES.map((file) => path.join(protoDir, file)),
    { keepCase: true },
  );
  root.resolveAll();

  const messages: Record<string, SchemaField[]> = {};
  const enums: Record<string, Record<string, number>> = {};
  const fullName = (obj: protobuf.ReflectionObject) => obj.fullName.replace(/^\./, '');

  const walk = (ns: protobuf.NamespaceBase) => {
    for (const nested of ns.nestedArray) {
      if (nested instanceof protobuf.Type) {
        messages[fullName(nested)] = [...nested.fieldsArray]
          .sort((a, b) => a.id - b.id)
          .map((field) => {
            const resolved = field.resolvedType;
            const out: SchemaField = {
              name: field.name,
              id: field.id,
              type: resolved ? fullName(resolved) : field.type,
              kind: resolved instanceof protobuf.Enum ? 'enum' : resolved ? 'message' : 'scalar',
            };
            if (field instanceof protobuf.MapField) out.keyType = field.keyType;
            else if (field.repeated) out.repeated = true;
            if (field.partOf || field.options?.proto3_optional) out.presence = true;
            return out;
          });
      } else if (nested instanceof protobuf.Enum) {
        enums[fullName(nested)] = { ...nested.values };
      }
      if (nested instanceof protobuf.Namespace || nested instanceof protobuf.Type) walk(nested);
    }
  };
  walk(root);

  const sorted = <T>(record: Record<string, T>) =>
    Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, record[key]!]),
    );
  return { proto_version: version, messages: sorted(messages), enums: sorted(enums) };
}

if (typeof module !== 'undefined' && require.main === module) {
  const out = path.join(__dirname, '..', 'src', 'generated', 'macp-schema.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(buildMacpSchema(), null, 2) + '\n');
  console.log(`wrote ${path.relative(process.cwd(), out)}`);
}
