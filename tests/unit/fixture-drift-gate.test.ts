/**
 * Drive the real `make sync-fixtures` / `make verify-fixtures` recipes
 * against synthetic trees, proving the zero-drift gate (`Makefile`) still
 * covers both `tests/conformance/` (pre-existing) and
 * `tests/vectors/cmt-hash/` (added for issue #50 — see
 * `plans/gate-cmt-hash-vectors.md`) without needing the real spec repo
 * checked out.
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

/** Build a throwaway canonical tree mirroring `$(SPEC_CONFORMANCE_DIR)`: a
 * flat top level plus an optional `cmt-hash/` subdirectory. */
function makeCanon(
  root: string,
  opts: {
    flat?: Record<string, string>;
    cmtHash?: Record<string, string>;
    includeCmtHashDir?: boolean;
  } = {},
): string {
  const canon = path.join(root, 'canon');
  writeFiles(canon, opts.flat);
  if (opts.includeCmtHashDir ?? true) {
    writeFiles(path.join(canon, 'cmt-hash'), opts.cmtHash);
  }
  return canon;
}

/** Build a throwaway repo tree holding just the two directories the
 * Makefile checks: `tests/conformance` and `tests/vectors/cmt-hash`. */
function makeRepo(
  root: string,
  opts: {
    conformance?: Record<string, string>;
    cmtHash?: Record<string, string>;
    createCmtHashDir?: boolean;
  } = {},
): string {
  const repo = path.join(root, 'repo');
  writeFiles(path.join(repo, 'tests', 'conformance'), opts.conformance);
  if (opts.createCmtHashDir ?? true) {
    writeFiles(path.join(repo, 'tests', 'vectors', 'cmt-hash'), opts.cmtHash);
  }
  return repo;
}

function runMake(repo: string, target: string, specDir: string) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.MAKEFLAGS;
  delete env.MAKELEVEL;
  delete env.MFLAGS;
  return spawnSync('make', ['-f', MAKEFILE, target, `SPEC_CONFORMANCE_DIR=${specDir}`], {
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
    expect(result.stdout).toContain('All conformance fixtures and cmt-hash vectors match the canonical source.');
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
});
