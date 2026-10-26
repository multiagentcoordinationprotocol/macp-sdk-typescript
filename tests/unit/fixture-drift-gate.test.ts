/**
 * Drive the real `make sync-fixtures` / `make verify-fixtures` recipes
 * against synthetic trees, proving the zero-drift gate (`Makefile`) still
 * covers both `tests/conformance/` (pre-existing) and
 * `tests/vectors/cmt-hash/` (added for issue #50 — see
 * `plans/gate-cmt-hash-vectors.md`) without needing the real spec repo
 * checked out.
 *
 * A second, later `describe` block below drives `make sync-parity` /
 * `make verify-parity` the same way, against the single vendored
 * `tests/parity/contract.json` file (`plans/sdk-parity-typescript.md`
 * Phase 5) — a separate, simpler target pair (one file, not a directory of
 * fixtures), so it gets its own small `makeParityCanon`/`makeParityRepo`/
 * `runMakeParity` helpers rather than reusing the fixture-shaped ones above.
 *
 * Every case builds a throwaway "repo" (just the two fixture directories
 * the Makefile cares about) and a throwaway "canonical" tree, then invokes
 * `make -f <this repo's Makefile> <target> SPEC_CONFORMANCE_DIR=<canonical>`
 * with `cwd` set to the throwaway repo. This exercises the actual shell
 * recipe — not a reimplementation of its logic — so a regression in the
 * Makefile itself (a stray `exit`, a mis-escaped `$$`, a pipeline that
 * introduces a subshell and drops the `drift` accumulator) is caught here
 * rather than only in CI against the real spec repo. This is exactly the
 * failure class issue #50 was filed about: a future Makefile edit could
 * silently stop gating and CI — which only ever runs the green path against
 * a clean spec repo — would never notice.
 *
 * Invocation contract, and why each piece matters:
 *
 * - `cwd` is used, never `make -C`: `-C` implies `-w`, which prints
 *   `Entering/Leaving directory` to stdout on GNU Make 4.x (ubuntu-latest)
 *   but not 3.81 (macOS) — that would make any stdout assertion here
 *   non-portable across CI and local runs.
 * - The `-f` path is absolute (this repo's `Makefile`), because with `cwd`
 *   pointed at the synthetic tree a relative `-f` would resolve against the
 *   wrong directory.
 * - `MAKEFLAGS`/`MAKELEVEL`/`MFLAGS` are stripped from the subprocess env.
 *   `npm test` (and `make test`) can itself run under a parent `make`, which
 *   exports those three vars — left in place they change Make's own
 *   error-line prefix to `make[1]:` and can leak outer flags (e.g. a
 *   jobserver from `make -j4`) into the child, adding stderr noise unrelated
 *   to what a case is asserting.
 * - Assertions on failure are always `status !== 0`, never `=== 1`: GNU Make
 *   exits with status **2** when a recipe fails (via `exit 1` or an
 *   unguarded nonzero command), regardless of the recipe's own exit code.
 * - The `DRIFT:`/`EXTRA:`/`Error:` lines the recipes print go to stdout;
 *   Make's own `*** [target] Error N` line goes to stderr. The two streams
 *   are captured separately (never merged) and every assertion here reads
 *   only `result.stdout`.
 *
 * This module imports nothing from `src/`, needs no running MACP runtime,
 * and builds its own throwaway trees under `os.tmpdir()`, so it is hermetic
 * — it never touches the real sibling spec repo or the real fixture
 * directories.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it, expect, afterEach } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../..');
const MAKEFILE = path.join(REPO_ROOT, 'Makefile');

// Both ubuntu-latest and macOS ship GNU make; this doesn't distinguish GNU
// from BSD make, but the recipes rely on GNU-only shell-in-recipe semantics
// (`$$` escaping applied consistently across a `\`-continued recipe line),
// so "make is on PATH" is enough to skip only on a genuinely make-less box.
// Probed at module scope, not in `beforeAll`: `describe.skipIf` is evaluated
// during collection, which happens before any hook runs -- a probe assigned
// in `beforeAll` would always read its initializer and never actually skip.
const makeAvailable = spawnSync('make', ['--version']).status === 0;

const tmpDirs: string[] = [];

function mkTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeFiles(dir: string, files: Record<string, string> | undefined): void {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files ?? {})) {
    fs.writeFileSync(path.join(dir, name), content, 'utf8');
  }
}

/** The Makefile's `VENDORED_FILES`: spec path (under `SPEC_ROOT`) → local
 * path. Every synthetic spec root/repo pair carries all of them by default,
 * with matching stand-in content, so cases about other fixture sets don't trip
 * this check. */
const VENDORED: Record<string, string> = {
  'examples/discovery/receipt_keys.json': 'tests/fixtures/receipt_keys.json',
  'schemas/otel/macp-semconv.json': 'tests/otel/macp-semconv.json',
};
const standIn = (specPath: string): string => `CANON ${specPath}`;
const DEFAULT_SPEC_FILES = Object.fromEntries(Object.keys(VENDORED).map((s) => [s, standIn(s)]));
const DEFAULT_LOCAL_FILES = Object.fromEntries(Object.entries(VENDORED).map(([s, l]) => [l, standIn(s)]));

/** Writes `files` (paths relative to `base`, which may contain `/`). */
function writeTree(base: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true });
    fs.writeFileSync(path.join(base, rel), content, 'utf8');
  }
}

/** Build a throwaway canonical tree mirroring `$(SPEC_CONFORMANCE_DIR)`: a
 * flat top level plus an optional `cmt-hash/` subdirectory and a `receipt/`
 * one (the Makefile's `VECTOR_DIRS`). A sibling `specroot/` stands in for
 * `$(SPEC_ROOT)`, which {@link runMake} passes explicitly, holding `specFiles`
 * (default: every `VENDORED_FILES` source). */
function makeCanon(
  root: string,
  opts: {
    flat?: Record<string, string>;
    cmtHash?: Record<string, string>;
    receipt?: Record<string, string>;
    includeCmtHashDir?: boolean;
    specFiles?: Record<string, string>;
  } = {},
): string {
  const canon = path.join(root, 'canon');
  writeFiles(canon, opts.flat);
  if (opts.includeCmtHashDir ?? true) {
    writeFiles(path.join(canon, 'cmt-hash'), opts.cmtHash);
  }
  writeFiles(path.join(canon, 'receipt'), opts.receipt);
  fs.mkdirSync(path.join(root, 'specroot'), { recursive: true });
  writeTree(path.join(root, 'specroot'), opts.specFiles ?? DEFAULT_SPEC_FILES);
  return canon;
}

/** Build a throwaway repo tree holding just the directories the Makefile
 * checks: `tests/conformance`, `tests/vectors/{cmt-hash,receipt}`, and the
 * `VENDORED_FILES` copies (`localFiles`, default: all of them, matching). */
function makeRepo(
  root: string,
  opts: {
    conformance?: Record<string, string>;
    cmtHash?: Record<string, string>;
    receipt?: Record<string, string>;
    createCmtHashDir?: boolean;
    localFiles?: Record<string, string>;
  } = {},
): string {
  const repo = path.join(root, 'repo');
  writeFiles(path.join(repo, 'tests', 'conformance'), opts.conformance);
  if (opts.createCmtHashDir ?? true) {
    writeFiles(path.join(repo, 'tests', 'vectors', 'cmt-hash'), opts.cmtHash);
  }
  writeFiles(path.join(repo, 'tests', 'vectors', 'receipt'), opts.receipt);
  writeTree(repo, opts.localFiles ?? DEFAULT_LOCAL_FILES);
  return repo;
}

/** Runs a fixtures target with `SPEC_CONFORMANCE_DIR=specDir` and, unless
 * `specRoot` is `null`, `SPEC_ROOT` pointed at the synthetic `specroot/`
 * sibling {@link makeCanon} writes. `null` leaves it to the Makefile's
 * default derivation. */
function runMake(repo: string, target: string, specDir: string, specRoot?: string | null) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.MAKEFLAGS;
  delete env.MAKELEVEL;
  delete env.MFLAGS;
  const args = ['-f', MAKEFILE, target, `SPEC_CONFORMANCE_DIR=${specDir}`];
  if (specRoot !== null) {
    args.push(`SPEC_ROOT=${specRoot ?? path.join(path.dirname(specDir), 'specroot')}`);
  }
  return spawnSync('make', args, {
    cwd: repo,
    env,
    encoding: 'utf8',
    timeout: 120_000,
  });
}

describe.skipIf(!makeAvailable)('fixture drift gate (Makefile verify-fixtures/sync-fixtures)', () => {
  it('passes when both fixture sets are byte-identical', () => {
    const root = mkTmp('macp-gate-clean-');
    const canon = makeCanon(root, { flat: { 'a.json': 'A' }, cmtHash: { 'b.json': 'B' } });
    const repo = makeRepo(root, { conformance: { 'a.json': 'A' }, cmtHash: { 'b.json': 'B' } });

    const result = runMake(repo, 'verify-fixtures', canon);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      'All conformance fixtures, vectors (cmt-hash receipt) and vendored files (tests/fixtures/receipt_keys.json tests/otel/macp-semconv.json) match the canonical source.',
    );
    expect(result.stdout).not.toContain('DRIFT');
    expect(result.stdout).not.toContain('EXTRA');
  });

  it('flags drift when a flat conformance fixture differs from canonical', () => {
    const root = mkTmp('macp-gate-flat-drift-');
    const canon = makeCanon(root, { flat: { 'a.json': 'canonical' }, cmtHash: { 'b.json': 'B' } });
    const repo = makeRepo(root, { conformance: { 'a.json': 'stale' }, cmtHash: { 'b.json': 'B' } });

    const result = runMake(repo, 'verify-fixtures', canon);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('DRIFT: tests/conformance/a.json');
  });

  it('flags drift when a cmt-hash vector differs from canonical', () => {
    const root = mkTmp('macp-gate-cmt-drift-');
    const canon = makeCanon(root, { flat: { 'a.json': 'A' }, cmtHash: { 'b.json': 'canonical' } });
    const repo = makeRepo(root, { conformance: { 'a.json': 'A' }, cmtHash: { 'b.json': 'stale' } });

    const result = runMake(repo, 'verify-fixtures', canon);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('DRIFT: tests/vectors/cmt-hash/b.json');
  });

  it('flags drift when canonical adds a cmt-hash vector with no vendored counterpart', () => {
    // The exact drift class issue #50 was filed about: an upstream vector
    // addition must not go quiet.
    const root = mkTmp('macp-gate-cmt-added-');
    const canon = makeCanon(root, { flat: { 'a.json': 'A' }, cmtHash: { 'new.json': 'content' } });
    const repo = makeRepo(root, { conformance: { 'a.json': 'A' }, cmtHash: {} });

    const result = runMake(repo, 'verify-fixtures', canon);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('DRIFT: tests/vectors/cmt-hash/new.json');
  });

  it('flags a vendored cmt-hash file with no canonical source as EXTRA', () => {
    const root = mkTmp('macp-gate-cmt-extra-');
    const canon = makeCanon(root, { flat: { 'a.json': 'A' }, cmtHash: { 'b.json': 'B' } });
    const repo = makeRepo(root, {
      conformance: { 'a.json': 'A' },
      cmtHash: { 'b.json': 'B', 'orphan.json': 'X' },
    });

    const result = runMake(repo, 'verify-fixtures', canon);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('EXTRA: tests/vectors/cmt-hash/orphan.json');
  });

  it('reports flat and cmt-hash failures together before a single exit', () => {
    const root = mkTmp('macp-gate-both-fail-');
    const canon = makeCanon(root, {
      flat: { 'a.json': 'canonical-a' },
      cmtHash: { 'b.json': 'canonical-b' },
    });
    const repo = makeRepo(root, {
      conformance: { 'a.json': 'stale-a' },
      cmtHash: { 'b.json': 'stale-b' },
    });

    const result = runMake(repo, 'verify-fixtures', canon);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('DRIFT: tests/conformance/a.json');
    expect(result.stdout).toContain('DRIFT: tests/vectors/cmt-hash/b.json');
    // One exit -- only one "Conformance fixtures drifted" summary line.
    expect(result.stdout.match(/Conformance fixtures drifted from canonical\./g)).toHaveLength(1);
  });

  it('checks the receipt vectors the same way: DRIFT, missing, and EXTRA', () => {
    const root = mkTmp('macp-gate-receipt-');
    const canon = makeCanon(root, {
      flat: { 'a.json': 'A' },
      cmtHash: { 'b.json': 'B' },
      receipt: { 'r1.json': 'R1', 'r2.json': 'R2' },
    });
    const repo = makeRepo(root, {
      conformance: { 'a.json': 'A' },
      cmtHash: { 'b.json': 'B' },
      receipt: { 'r1.json': 'changed', 'orphan.json': 'x' },
    });

    const result = runMake(repo, 'verify-fixtures', canon);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('DRIFT: tests/vectors/receipt/r1.json');
    expect(result.stdout).toContain('DRIFT: tests/vectors/receipt/r2.json');
    expect(result.stdout).toContain('EXTRA: tests/vectors/receipt/orphan.json');
  });

  it('fails with a named error when canonical receipt/ is missing', () => {
    const root = mkTmp('macp-gate-receipt-missing-');
    const canon = makeCanon(root, { flat: { 'a.json': 'A' }, cmtHash: { 'b.json': 'B' } });
    fs.rmSync(path.join(canon, 'receipt'), { recursive: true });
    const repo = makeRepo(root, { conformance: { 'a.json': 'A' }, cmtHash: { 'b.json': 'B' } });

    const result = runMake(repo, 'verify-fixtures', canon);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain(`Error: Canonical receipt vector directory not found at ${canon}/receipt`);
  });

  it('fails with a named error, not a garbled glob, when canonical cmt-hash/ is missing', () => {
    const root = mkTmp('macp-gate-cmt-dir-missing-');
    const canon = makeCanon(root, { flat: { 'a.json': 'A' }, includeCmtHashDir: false });
    const repo = makeRepo(root, { conformance: { 'a.json': 'A' }, cmtHash: { 'b.json': 'B' } });

    const result = runMake(repo, 'verify-fixtures', canon);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain(`Error: Canonical cmt-hash vector directory not found at ${canon}/cmt-hash`);
    expect(result.stdout).not.toContain('*.json');
  });

  it('goes red (not a silent pass) when canonical cmt-hash/ exists but is empty', () => {
    // Guards G4's fix: an unmatched `*.json` glob over a present-but-empty
    // directory must not be treated as a literal filename. With real
    // vendored vectors on disk and nothing canonical to match them against,
    // every vendored file must be reported EXTRA -- and no literal
    // "*.json" artifact may appear anywhere in the output.
    const root = mkTmp('macp-gate-cmt-dir-empty-');
    const canon = makeCanon(root, { flat: { 'a.json': 'A' }, cmtHash: {} });
    const repo = makeRepo(root, {
      conformance: { 'a.json': 'A' },
      cmtHash: { 'v1.json': 'v1', 'v2.json': 'v2' },
    });

    const result = runMake(repo, 'verify-fixtures', canon);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('EXTRA: tests/vectors/cmt-hash/v1.json');
    expect(result.stdout).toContain('EXTRA: tests/vectors/cmt-hash/v2.json');
    expect(result.stdout).not.toMatch(/\*\.json/);
  });

  it('does not trigger EXTRA for a non-JSON file (SOURCE.md) in the vendored dir', () => {
    const root = mkTmp('macp-gate-source-md-');
    const canon = makeCanon(root, { flat: { 'a.json': 'A' }, cmtHash: { 'b.json': 'B' } });
    const repo = makeRepo(root, { conformance: { 'a.json': 'A' }, cmtHash: { 'b.json': 'B' } });
    fs.writeFileSync(path.join(repo, 'tests', 'vectors', 'cmt-hash', 'SOURCE.md'), 'provenance', 'utf8');

    const result = runMake(repo, 'verify-fixtures', canon);

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('EXTRA');
    expect(result.stdout).not.toContain('SOURCE.md');
  });

  it('tells the user that an EXTRA: orphan must be deleted by hand', () => {
    // `sync-fixtures` copies but never deletes, so following the "Run 'make
    // sync-fixtures' and commit" line alone leaves an orphaned vendored file
    // in place and the gate red on the next run. The remediation text must
    // say so, or an upstream rename/removal sends a maintainer in a loop.
    const root = mkTmp('macp-gate-delete-hint-');
    const canon = makeCanon(root, { flat: { 'a.json': 'A' }, cmtHash: { 'b.json': 'B' } });
    const repo = makeRepo(root, {
      conformance: { 'a.json': 'A' },
      cmtHash: { 'b.json': 'B', 'orphan.json': 'gone upstream' },
    });

    const result = runMake(repo, 'verify-fixtures', canon);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('EXTRA: tests/vectors/cmt-hash/orphan.json');
    expect(result.stdout).toContain('copies but never deletes');
  });

  it('sync-fixtures also fails with a named error when canonical cmt-hash/ is missing', () => {
    // The guard exists in both targets. Without this case, deleting it from
    // `sync-fixtures` alone leaves the suite green (verified by mutation),
    // and the copy loop would silently no-op against an absent canonical
    // directory instead of saying why.
    const root = mkTmp('macp-gate-sync-dir-missing-');
    const canon = makeCanon(root, { flat: { 'a.json': 'A' }, includeCmtHashDir: false });
    const repo = makeRepo(root, { conformance: {}, cmtHash: {} });

    const result = runMake(repo, 'sync-fixtures', canon);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain(`Error: Canonical cmt-hash vector directory not found at ${canon}/cmt-hash`);
    expect(fs.existsSync(path.join(repo, 'tests', 'conformance', 'a.json'))).toBe(false);
  });

  it('sync-fixtures copies both fixture sets into a synthetic tree correctly', () => {
    const root = mkTmp('macp-gate-sync-');
    const canon = makeCanon(root, { flat: { 'a.json': 'A' }, cmtHash: { 'b.json': 'B' } });
    const repo = makeRepo(root, { conformance: {}, cmtHash: {} });

    const syncResult = runMake(repo, 'sync-fixtures', canon);
    const verifyResult = runMake(repo, 'verify-fixtures', canon);

    expect(syncResult.status).toBe(0);
    expect(fs.readFileSync(path.join(repo, 'tests', 'conformance', 'a.json'), 'utf8')).toBe('A');
    expect(fs.readFileSync(path.join(repo, 'tests', 'vectors', 'cmt-hash', 'b.json'), 'utf8')).toBe('B');
    expect(verifyResult.status).toBe(0);
  });

  // VENDORED_FILES: single spec documents (examples/discovery/receipt_keys.json,
  // schemas/otel/macp-semconv.json) vendored under tests/, gated byte for byte
  // like the vector directories.
  it.each(Object.entries(VENDORED))("flags drift when %s's vendored copy %s differs", (specPath, local) => {
    const root = mkTmp('macp-gate-vendored-drift-');
    const canon = makeCanon(root, { flat: { 'a.json': 'A' } });
    const repo = makeRepo(root, {
      conformance: { 'a.json': 'A' },
      localFiles: { ...DEFAULT_LOCAL_FILES, [local]: 'EDITED' },
    });

    const result = runMake(repo, 'verify-fixtures', canon);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain(`DRIFT: ${local} differs from (or is missing vs) canonical`);
    expect(result.stdout).toContain(`/specroot/${specPath}`);
    // Only the edited file drifts.
    expect(result.stdout.match(/DRIFT:/g)).toHaveLength(1);
  });

  it.each(Object.entries(VENDORED))(
    'flags drift, not a pass, when %s or its vendored copy %s is missing',
    (specPath, local) => {
      const root = mkTmp('macp-gate-vendored-missing-');
      const specFiles = { ...DEFAULT_SPEC_FILES };
      delete specFiles[specPath];
      const canon = makeCanon(root, { flat: { 'a.json': 'A' }, specFiles });
      const repo = makeRepo(root, { conformance: { 'a.json': 'A' } });
      const missingCanon = runMake(repo, 'verify-fixtures', canon);

      const root2 = mkTmp('macp-gate-vendored-unvendored-');
      const localFiles = { ...DEFAULT_LOCAL_FILES };
      delete localFiles[local];
      const canon2 = makeCanon(root2, { flat: { 'a.json': 'A' } });
      const repo2 = makeRepo(root2, { conformance: { 'a.json': 'A' }, localFiles });
      const missingLocal = runMake(repo2, 'verify-fixtures', canon2);

      for (const result of [missingCanon, missingLocal]) {
        expect(result.status).not.toBe(0);
        expect(result.stdout).toContain(`DRIFT: ${local}`);
      }
    },
  );

  it('flags a JSON file in any VENDORED_DIRS directory not named in VENDORED_FILES as EXTRA, but not SOURCE.md', () => {
    const root = mkTmp('macp-gate-vendored-extra-');
    const canon = makeCanon(root, { flat: { 'a.json': 'A' } });
    const repo = makeRepo(root, {
      conformance: { 'a.json': 'A' },
      localFiles: {
        ...DEFAULT_LOCAL_FILES,
        'tests/fixtures/stray.json': '{}',
        'tests/otel/stray.json': '{}',
        'tests/fixtures/SOURCE.md': 'provenance',
        'tests/otel/SOURCE.md': 'provenance',
      },
    });

    const result = runMake(repo, 'verify-fixtures', canon);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('EXTRA: tests/fixtures/stray.json');
    expect(result.stdout).toContain('EXTRA: tests/otel/stray.json');
    expect(result.stdout).not.toContain('SOURCE.md');
    expect(result.stdout).not.toContain('EXTRA: tests/fixtures/receipt_keys.json');
    expect(result.stdout).not.toContain('EXTRA: tests/otel/macp-semconv.json');
    expect(result.stdout).toContain('copies but never deletes');
  });

  it('derives SPEC_ROOT from SPEC_CONFORMANCE_DIR when only the latter is overridden (as CI does)', () => {
    // CI passes SPEC_CONFORMANCE_DIR=$GITHUB_WORKSPACE/_spec/schemas/conformance
    // and nothing else; the vendored files must resolve under _spec/.
    const root = mkTmp('macp-gate-vendored-derive-');
    const canon = path.join(root, 'spec', 'schemas', 'conformance');
    writeFiles(canon, { 'a.json': 'A' });
    writeFiles(path.join(canon, 'cmt-hash'), {});
    writeFiles(path.join(canon, 'receipt'), {});
    writeTree(path.join(root, 'spec'), DEFAULT_SPEC_FILES);
    const repo = makeRepo(root, { conformance: { 'a.json': 'A' } });

    const clean = runMake(repo, 'verify-fixtures', canon, null);
    fs.writeFileSync(path.join(root, 'spec', 'schemas', 'otel', 'macp-semconv.json'), 'UPSTREAM CHANGE');
    const drifted = runMake(repo, 'verify-fixtures', canon, null);

    expect(clean.status).toBe(0);
    expect(drifted.status).not.toBe(0);
    expect(drifted.stdout).toContain(`${canon}/../../schemas/otel/macp-semconv.json`);
  });

  it('sync-fixtures copies every VENDORED_FILES entry, creating its directory', () => {
    const root = mkTmp('macp-gate-vendored-sync-');
    const specFiles = Object.fromEntries(Object.keys(VENDORED).map((s) => [s, `NEW ${s}`]));
    const canon = makeCanon(root, { flat: { 'a.json': 'A' }, specFiles });
    const repo = makeRepo(root, { conformance: {}, localFiles: {} });

    const synced = runMake(repo, 'sync-fixtures', canon);
    const verified = runMake(repo, 'verify-fixtures', canon);

    expect(synced.status).toBe(0);
    for (const [specPath, local] of Object.entries(VENDORED)) {
      expect(fs.readFileSync(path.join(repo, local), 'utf8')).toBe(`NEW ${specPath}`);
    }
    expect(verified.status).toBe(0);
  });

  it.each(['verify-fixtures', 'sync-fixtures'])('%s rejects a VENDORED_FILES entry with no colon', (target) => {
    // Without the guard a colon-less entry splits to src === dst, so sync would
    // copy the spec file into the repo at its spec-relative path.
    const root = mkTmp('macp-gate-vendored-malformed-');
    const canon = makeCanon(root, { flat: { 'a.json': 'A' } });
    const repo = makeRepo(root, { conformance: { 'a.json': 'A' } });
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.MAKEFLAGS;
    delete env.MAKELEVEL;
    delete env.MFLAGS;

    const result = spawnSync(
      'make',
      [
        '-f',
        MAKEFILE,
        target,
        `SPEC_CONFORMANCE_DIR=${canon}`,
        `SPEC_ROOT=${path.join(root, 'specroot')}`,
        'VENDORED_FILES=schemas/otel/macp-semconv.json',
      ],
      { cwd: repo, env, encoding: 'utf8', timeout: 120_000 },
    );

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('Error: VENDORED_FILES entry schemas/otel/macp-semconv.json is not');
    expect(fs.existsSync(path.join(repo, 'schemas'))).toBe(false);
  });

  it.each(Object.keys(VENDORED))('sync-fixtures fails with a named error when %s is missing upstream', (specPath) => {
    const root = mkTmp('macp-gate-vendored-sync-missing-');
    const specFiles = { ...DEFAULT_SPEC_FILES };
    delete specFiles[specPath];
    const canon = makeCanon(root, { flat: { 'a.json': 'A' }, specFiles });
    const repo = makeRepo(root, { conformance: {}, localFiles: {} });

    const result = runMake(repo, 'sync-fixtures', canon);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain(`Error: canonical file ${specPath} not found at`);
  });
});

/** Build a throwaway canonical tree mirroring `$(SPEC_PARITY_DIR)`: an
 * optional single `contract.json` file directly inside it. */
function makeParityCanon(root: string, opts: { contract?: string } = {}): string {
  const canon = path.join(root, 'canon-parity');
  fs.mkdirSync(canon, { recursive: true });
  if (opts.contract !== undefined) {
    fs.writeFileSync(path.join(canon, 'contract.json'), opts.contract, 'utf8');
  }
  return canon;
}

/** Build a throwaway repo tree holding just `tests/parity/`, the directory
 * `verify-parity`/`sync-parity` check. */
function makeParityRepo(root: string, opts: { contract?: string } = {}): string {
  const repo = path.join(root, 'repo-parity');
  fs.mkdirSync(path.join(repo, 'tests', 'parity'), { recursive: true });
  if (opts.contract !== undefined) {
    fs.writeFileSync(path.join(repo, 'tests', 'parity', 'contract.json'), opts.contract, 'utf8');
  }
  return repo;
}

function runMakeParity(repo: string, target: string, specDir: string) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.MAKEFLAGS;
  delete env.MAKELEVEL;
  delete env.MFLAGS;
  return spawnSync('make', ['-f', MAKEFILE, target, `SPEC_PARITY_DIR=${specDir}`], {
    cwd: repo,
    env,
    encoding: 'utf8',
    timeout: 120_000,
  });
}

describe.skipIf(!makeAvailable)('parity contract drift gate (Makefile verify-parity/sync-parity)', () => {
  it('passes when the vendored contract.json is byte-identical to canonical', () => {
    const root = mkTmp('macp-parity-clean-');
    const canon = makeParityCanon(root, { contract: '{"a":1}' });
    const repo = makeParityRepo(root, { contract: '{"a":1}' });

    const result = runMakeParity(repo, 'verify-parity', canon);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('tests/parity/contract.json matches the canonical source.');
    expect(result.stdout).not.toContain('DRIFT');
  });

  it('flags drift when the vendored contract.json differs from canonical', () => {
    const root = mkTmp('macp-parity-drift-');
    const canon = makeParityCanon(root, { contract: '{"a":"canonical"}' });
    const repo = makeParityRepo(root, { contract: '{"a":"stale"}' });

    const result = runMakeParity(repo, 'verify-parity', canon);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('DRIFT: tests/parity/contract.json differs from canonical');
    expect(result.stdout).toContain("Parity contract drifted from canonical. Run 'make sync-parity' and commit.");
  });

  it('verify-parity fails with a named error when the spec repo directory is missing', () => {
    const root = mkTmp('macp-parity-dir-missing-');
    const missingCanon = path.join(root, 'does-not-exist');
    const repo = makeParityRepo(root, { contract: '{"a":1}' });

    const result = runMakeParity(repo, 'verify-parity', missingCanon);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain(`Error: Spec repo not found at ${missingCanon}`);
  });

  it('verify-parity fails with a distinct named error when contract.json itself is missing (not a bare diff/cp error)', () => {
    // The two-guard shape this phase added: a present-but-empty SPEC_PARITY_DIR
    // (directory exists, file renamed/moved upstream) must not fall through to
    // a cryptic `diff: No such file or directory` -- it gets its own message.
    const root = mkTmp('macp-parity-file-missing-');
    const canon = makeParityCanon(root); // directory exists, no contract.json inside
    const repo = makeParityRepo(root, { contract: '{"a":1}' });

    const result = runMakeParity(repo, 'verify-parity', canon);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain(`Error: canonical parity contract not found at ${canon}/contract.json`);
    expect(result.stdout).not.toContain('No such file or directory');
  });

  it('sync-parity fails with a named error when the spec repo directory is missing', () => {
    const root = mkTmp('macp-parity-sync-dir-missing-');
    const missingCanon = path.join(root, 'does-not-exist');
    const repo = makeParityRepo(root);

    const result = runMakeParity(repo, 'sync-parity', missingCanon);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain(`Error: Spec repo not found at ${missingCanon}`);
    expect(fs.existsSync(path.join(repo, 'tests', 'parity', 'contract.json'))).toBe(false);
  });

  it('sync-parity fails with a named error when contract.json itself is missing', () => {
    const root = mkTmp('macp-parity-sync-file-missing-');
    const canon = makeParityCanon(root); // directory exists, no contract.json inside
    const repo = makeParityRepo(root);

    const result = runMakeParity(repo, 'sync-parity', canon);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain(`Error: canonical parity contract not found at ${canon}/contract.json`);
    expect(fs.existsSync(path.join(repo, 'tests', 'parity', 'contract.json'))).toBe(false);
  });

  it('sync-parity copies contract.json into a synthetic tree correctly', () => {
    const root = mkTmp('macp-parity-sync-');
    const canon = makeParityCanon(root, { contract: '{"a":1,"b":2}' });
    const repo = makeParityRepo(root);

    const syncResult = runMakeParity(repo, 'sync-parity', canon);
    const verifyResult = runMakeParity(repo, 'verify-parity', canon);

    expect(syncResult.status).toBe(0);
    expect(fs.readFileSync(path.join(repo, 'tests', 'parity', 'contract.json'), 'utf8')).toBe('{"a":1,"b":2}');
    expect(verifyResult.status).toBe(0);
  });
});
