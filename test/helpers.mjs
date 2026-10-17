/**
 * Shared setup for the dsh-git-core test suite.
 *
 * Everything here builds *real* git repositories with the real git CLI, in a
 * private temp directory per test, and tears them down afterwards. No network is
 * ever involved: a "remote" is always another temp directory reached over git's
 * `file` protocol.
 *
 * This file is a module, not a test file. Node's test runner does walk every
 * file under `test/`, so this file is also loaded as an (empty) test file and
 * passes by doing nothing: it only defines functions and constants at load time.
 */

import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The environment every *arrange* git call runs with.
 *
 * `process.env` is the base for the same reason the module under test uses it:
 * HOME and PATH must survive so git can find its config and itself. Only the
 * prompt-suppressing variables and a C locale are added, so the output is
 * parseable and git can never ask a question.
 */
const ARRANGE_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '',
  GIT_OPTIONAL_LOCKS: '0',
  LC_ALL: 'C',
  // Local-path remotes are the only transport this suite uses; make the file
  // protocol unambiguous regardless of the machine's `protocol.file.allow`.
  GIT_ALLOW_PROTOCOL: 'file',
};

/** Directories created by `tempDir()`, removed by `cleanupTempDirs()`. */
const tempDirs = [];

/**
 * A private temp directory, realpath'd.
 *
 * Realpath because macOS reports `/private/var/...` for `/var/...`: the module
 * under test realpaths every path it returns, so every expected path here has
 * to be the real one or nothing compares equal.
 */
export function tempDir(prefix = 'dsh-git-core-test-') {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

/**
 * A temp directory in both spellings.
 *
 * On macOS os.tmpdir() hands back /var/... while the real path is
 * /private/var/...; tests that prove the module's realpath normalisation need
 * the un-realpath'd spelling as an input.
 */
export function tempDirWithRaw(prefix = 'dsh-git-core-test-') {
  const raw = mkdtempSync(join(tmpdir(), prefix));
  const real = realpathSync(raw);
  tempDirs.push(real);
  return { raw, real };
}

/** Remove every temp directory this file created. Call from an `after()` hook. */
export function cleanupTempDirs() {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      // A leftover temp directory is not a test failure.
    }
  }
}

/** Run one git command, never throwing; the shape mirrors `run()` in the lib. */
export function git(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', args.map((value) => String(value)), {
      cwd,
      env: ARRANGE_ENV,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      resolve({
        ok: error === null || error === undefined,
        code: error === null || error === undefined
          ? 0
          : typeof error.code === 'number' ? error.code : null,
        stdout: stdout ?? '',
        stderr: stderr ?? '',
      });
    });
  });
}

/** Run one git command and fail the test if it does not succeed. */
export async function gitOk(cwd, args) {
  const result = await git(cwd, args);
  if (!result.ok) {
    throw new Error('git ' + args.join(' ') + ' failed (' + result.code + '): '
      + (result.stderr || result.stdout).trim());
  }
  return result.stdout;
}

/**
 * Deterministic repository config.
 *
 * Written as a block appended to the repository's own config rather than a
 * dozen `git config` calls, and covering every machine-wide setting that could
 * otherwise change an answer: signing, hooks, the global excludes file, rename
 * detection in status output, merge fast-forward policy, rerere (which would
 * auto-resolve the conflicts this suite creates on purpose), and autocrlf.
 */
function deterministicConfig(repo) {
  const noHooks = join(tmpdir(), 'dsh-git-core-test-no-hooks');
  const noIgnores = join(tmpdir(), 'dsh-git-core-test-no-global-ignore');
  return [
    '[user]',
    '\tname = dsh-git-core tests',
    '\temail = tests@example.invalid',
    '[commit]',
    '\tgpgsign = false',
    '[tag]',
    '\tgpgsign = false',
    '[core]',
    '\thooksPath = ' + noHooks,
    '\texcludesFile = ' + noIgnores,
    '\tautocrlf = false',
    '[status]',
    '\trenames = true',
    '\tshowUntrackedFiles = normal',
    '[merge]',
    '\tff = true',
    '[rebase]',
    '\tautoSquash = false',
    '\tautoStash = false',
    '[rerere]',
    '\tenabled = false',
    '[gc]',
    '\tauto = 0',
    '[protocol "file"]',
    '\tallow = always',
    '[advice]',
    '\tdetachedHead = false',
    '\tmergeConflict = false',
    '',
  ].join('\n');
}

/** Apply the deterministic config to a repository (or bare repo) directory. */
export async function configureRepo(repo) {
  const configPath = join(repo, (await gitOk(repo, ['rev-parse', '--git-path', 'config'])).trim());
  const existing = readFileSync(configPath, 'utf8');
  writeFileSync(configPath, (existing.endsWith('\n') ? existing : existing + '\n') + deterministicConfig(repo));
}

/** A fresh repository whose first commit has NOT been made yet. */
export async function initRepo({ branch = 'main', prefix = 'dsh-git-core-repo-' } = {}) {
  const repo = tempDir(prefix);
  await gitOk(repo, ['init', '-q', '-b', branch]);
  await configureRepo(repo);
  return repo;
}

/** A repository with one commit, so HEAD exists and most commands agree to run. */
export async function initCommittedRepo({ branch = 'main', prefix = 'dsh-git-core-repo-' } = {}) {
  const repo = await initRepo({ branch, prefix });
  await commitAll(repo, 'initial commit', { 'file.txt': 'initial\n' });
  return repo;
}

/** Write a file inside a repository, creating parent directories as needed. */
export function writeFileIn(repo, relativePath, content) {
  const target = join(repo, relativePath);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, content);
  return target;
}

/** A bare repository usable as a `file://`-style remotes over a plain path. */
export async function initBareRepo({ branch = 'main', prefix = 'dsh-git-core-remote-' } = {}) {
  const repo = tempDir(prefix);
  await gitOk(repo, ['init', '-q', '--bare', '-b', branch]);
  await configureRepo(repo);
  return repo;
}

/** Clone a repository into a fresh temp directory (the clone is realpath'd). */
export async function cloneRepo(origin, { prefix = 'dsh-git-core-clone-' } = {}) {
  const dest = tempDir(prefix);
  await gitOk(tmpdir(), ['clone', '-q', origin, dest]);
  await configureRepo(dest);
  return dest;
}

/** Write the given files, stage everything, and commit; returns the new HEAD sha. */
export async function commitAll(repo, message, files = {}) {
  for (const [relativePath, content] of Object.entries(files)) writeFileIn(repo, relativePath, content);
  await gitOk(repo, ['add', '-A']);
  await gitOk(repo, ['commit', '-qm', message]);
  return headSha(repo);
}

/** Stage exactly these paths (raw `git add`), for arranging a partial index. */
export async function stageInRepo(repo, paths = []) {
  await gitOk(repo, ['add', '--', ...paths]);
}

/** The current HEAD commit id. */
export async function headSha(repo) {
  return (await gitOk(repo, ['rev-parse', 'HEAD'])).trim();
}

/** Names of the paths currently staged (index differs from HEAD), NUL-safe. */
export async function stagedPaths(repo) {
  const out = await gitOk(repo, ['diff', '--cached', '--name-only', '-z']);
  return out.split('\0').filter((value) => value !== '');
}

/** Names of the files in one commit, NUL-safe. */
export async function commitPaths(repo, rev = 'HEAD') {
  const out = await gitOk(repo, ['show', '--name-only', '--format=', '-z', rev]);
  return out.split('\0').filter((value) => value !== '');
}

/** The subject line of one commit. */
export async function commitSubject(repo, rev = 'HEAD') {
  return (await gitOk(repo, ['log', '-1', '--format=%s', rev])).trim();
}

/** The ref a branch tracks, as git prints it (`origin/main`), or undefined. */
export async function upstreamOf(repo, branch) {
  const result = await git(repo, ['rev-parse', '--abbrev-ref', branch + '@{upstream}']);
  return result.ok ? result.stdout.trim() : undefined;
}

/** Whether a ref resolves. */
export async function refExists(repo, ref) {
  const result = await git(repo, ['rev-parse', '-q', '--verify', ref]);
  return result.ok;
}

/** The files a directory holds, sorted, for a worktree-content assertion. */
export async function directoryBytes(repo, relativePath) {
  return readFileSync(join(repo, relativePath), 'utf8');
}