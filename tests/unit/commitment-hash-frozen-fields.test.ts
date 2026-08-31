import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Drives the real compile-time frozen-field-set guard in
 * `src/commitment-hash.ts` (issue #47) against mutated copies of the real
 * `src/types.ts`, by running the real `tsc` over them.
 *
 * The guard is a type alias — erased at runtime, so no unit test can observe
 * it by calling anything. The only way to prove it is not vacuous is to make
 * the compiler run into it, which is what this file does.
 *
 * Only the two-file closure the guard needs is copied (`types.ts` has no
 * imports; `commitment-hash.ts` imports `./types` and `node:crypto`), so the
 * temp project compiles without a `node_modules` beside it — `typeRoots`
 * points back at this repo's `@types` for the `node:crypto` declarations.
 */
const REPO_ROOT = resolve(__dirname, '..', '..');
const TSC = join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

let workDir: string;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'macp-frozen-fields-'));
  copyFileSync(join(REPO_ROOT, 'src', 'commitment-hash.ts'), join(workDir, 'commitment-hash.ts'));
  writeFileSync(
    join(workDir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'Node16',
        moduleResolution: 'Node16',
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        lib: ['ES2022'],
        typeRoots: [join(REPO_ROOT, 'node_modules', '@types')],
        types: ['node'],
      },
      include: ['*.ts'],
    }),
  );
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** Write `types.ts` into the temp project, then type-check it. */
function typeCheckWith(typesSource: string): { code: number; output: string } {
  writeFileSync(join(workDir, 'types.ts'), typesSource);
  const run = spawnSync(process.execPath, [TSC, '-p', join(workDir, 'tsconfig.json')], {
    encoding: 'utf8',
  });
  return { code: run.status ?? -1, output: `${run.stdout ?? ''}${run.stderr ?? ''}` };
}

function realTypes(): string {
  return readFileSync(join(REPO_ROOT, 'src', 'types.ts'), 'utf8');
}

describe('CommitmentPayload frozen-field-set guard', () => {
  // Control. Without this, every assertion below could be passing on an
  // unrelated compile error (a bad tsconfig, a failed copy) rather than on
  // the guard.
  it('type-checks clean against the real CommitmentPayload', () => {
    const { code, output } = typeCheckWith(realTypes());
    expect(output).toBe('');
    expect(code).toBe(0);
  });

  it('fails the build when CommitmentPayload gains an unhashed field', () => {
    const mutated = realTypes().replace(
      '  supersedes?: CommitmentRef;\n}',
      '  supersedes?: CommitmentRef;\n  tenthField: string;\n}',
    );
    expect(mutated).not.toBe(realTypes()); // the mutation actually applied

    const { code, output } = typeCheckWith(mutated);
    expect(code).not.toBe(0);
    expect(output).toContain('commitment-hash.ts');
    expect(output).toContain(`Type '"tenthField"' does not satisfy the constraint 'never'`);
  });

  it('fails the build when CommitmentPayload loses a field the projection still hashes', () => {
    const mutated = realTypes().replace('  reason: string;\n', '');
    expect(mutated).not.toBe(realTypes());

    const { code, output } = typeCheckWith(mutated);
    expect(code).not.toBe(0);
    expect(output).toContain('commitment-hash.ts');
    expect(output).toContain(`Type '"reason"' does not satisfy the constraint 'never'`);
  });
});
