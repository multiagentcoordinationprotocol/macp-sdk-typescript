/**
 * Guards for the canonical JSON codec's packaging: the committed schema
 * matches what `npm run gen:schema` builds from the installed proto package,
 * and the codec's import graph stays free of Node, gRPC and protobufjs so the
 * `./canonical-json` subpath works in a browser.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildMacpSchema } from '../../scripts/gen-macp-schema';
import committed from '../../src/generated/macp-schema.json';

const SRC = path.join(__dirname, '..', '..', 'src');

/** Every module `entry` reaches through relative imports, type-only ones excluded. */
function runtimeImportGraph(entry: string): Map<string, string> {
  const seen = new Map<string, string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    const source = fs.readFileSync(file, 'utf8');
    seen.set(file, source);
    for (const match of source.matchAll(/^import\s+(?!type\b)[^'"]*?from\s+'(\.[^']+)'/gm)) {
      const target = path.resolve(path.dirname(file), match[1]!);
      if (target.endsWith('.json')) continue;
      visit(`${target}.ts`);
    }
  };
  visit(entry);
  return seen;
}

describe('canonical JSON packaging', () => {
  it('commits the schema generated from the installed proto package', () => {
    expect(committed, 'src/generated/macp-schema.json is stale: run npm run gen:schema').toEqual(buildMacpSchema());
  });

  it('imports nothing Node-only at runtime', () => {
    const graph = runtimeImportGraph(path.join(SRC, 'canonical-json.ts'));
    expect([...graph.keys()].map((f) => path.relative(SRC, f)).sort()).toEqual([
      'canonical-json.ts',
      'constants.ts',
      'errors.ts',
    ]);
    const strip = (source: string) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    for (const [file, source] of graph) {
      // module load must be browser-safe: no Node, gRPC or protobufjs import
      expect(strip(source), file).not.toMatch(/from\s+'(node:|@grpc|protobufjs)|require\(|\bprocess\./);
    }
    // errors.ts only touches Buffer inside parseErrorDetails, which the codec never calls
    expect(strip(graph.get(path.join(SRC, 'canonical-json.ts'))!)).not.toMatch(/\bBuffer\b|parseErrorDetails/);
  });
});
