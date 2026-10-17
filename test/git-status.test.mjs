/**
 * lib/git.mjs — status parsing, repository state, and branch/history distance.
 *
 * The parsers are exercised on synthetic porcelain (the documented traps are
 * formats, not behaviours) and then on repositories built with the real git CLI,
 * because the format is a contract with git and a hand-written fixture cannot
 * prove that contract still holds.
 */

import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';

import {
  cloneRepo,
  cleanupTempDirs,
  commitAll,
  git,
  gitOk,
  headSha,
  initBareRepo,
  initCommittedRepo,
  initRepo,
  tempDir,
  writeFileIn,
} from './helpers.mjs';

import {
  aheadOf,
  changedPaths,
  computeSync,
  defaultBranchOf,
  parseStatus,
  repoState,
} from '../lib/git.mjs';

after(cleanupTempDirs);

/** Record ids for synthetic porcelain; the parser only checks their shape. */
const H1 = '1111111111111111111111111111111111111111';
const H2 = '2222222222222222222222222222222222222222';

/** Join porcelain records the way `-z` writes them: NUL after every record. */
function z(...records) {
  return records.map((record) => record + '\0').join('');
}

describe('parseStatus (porcelain v2 -z)', () => {
  test('parses branch headers, every record kind, and the rename record\'s new path', () => {
    const stdout = z(
      '# branch.oid ' + H1,
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +2 -3',
      '1 A. N... 100644 100644 100644 ' + H1 + ' ' + H2 + ' added.txt',
      '1 .M N... 100644 100644 100644 ' + H1 + ' ' + H2 + ' modified.txt',
      '1 MM N... 100644 100644 100644 ' + H1 + ' ' + H2 + ' both.txt',
      '2 R. N... 100644 100644 100644 ' + H1 + ' ' + H2 + ' R100 renamed.txt\toriginal.txt',
      'u UU N... 100644 100644 100644 100644 ' + H1 + ' ' + H2 + ' ' + H1 + ' conflicted.txt',
      '? untracked.txt',
      '! ignored.log',
    );
    const parsed = parseStatus(stdout);
    assert.equal(parsed.oid, H1);
    assert.equal(parsed.branch, 'main');
    assert.equal(parsed.detached, undefined);
    assert.equal(parsed.upstream, 'origin/main');
    assert.equal(parsed.ahead, 2);
    assert.equal(parsed.behind, 3);
    assert.deepEqual(parsed.staged, [
      { path: 'added.txt', xy: 'A.' },
      { path: 'both.txt', xy: 'MM' },
      { path: 'renamed.txt', xy: 'R.' },
    ]);
    assert.deepEqual(parsed.unstaged, [
      { path: 'modified.txt', xy: '.M' },
      { path: 'both.txt', xy: 'MM' },
    ]);
    assert.deepEqual(parsed.untracked, ['untracked.txt']);
    assert.deepEqual(parsed.ignored, ['ignored.log']);
    assert.deepEqual(parsed.unmerged, ['conflicted.txt']);
    // A rename appears under its NEW name only; the original is not a change.
    assert.equal(parsed.staged.some((entry) => entry.path === 'original.txt'), false);
  });

  test('an initial branch has no oid and a detached HEAD has no branch name', () => {
    const parsed = parseStatus(z('# branch.oid (initial)', '# branch.head (detached)'));
    assert.equal(parsed.oid, undefined);
    assert.equal(parsed.detached, true);
    assert.equal(parsed.branch, undefined);
    assert.deepEqual(parsed.staged, []);
  });

  test('filenames arrive verbatim: spaces, newlines and backslashes survive', () => {
    const parsed = parseStatus(z(
      '# branch.head main',
      '1 .M N... 100644 100644 100644 ' + H1 + ' ' + H2 + ' a file with spaces.txt',
      '? line\nbreak.txt',
      '? back\\slash.txt',
      // In -z output a rename record carries only the NEW path; the original
      // path is the next NUL field, and nothing is C-quoted.
      '2 R. N... 100644 100644 100644 ' + H1 + ' ' + H2 + ' R100 new name.txt',
      'original\tname.txt',
    ));
    assert.equal(parsed.unstaged[0].path, 'a file with spaces.txt');
    assert.deepEqual(parsed.untracked, ['line\nbreak.txt', 'back\\slash.txt']);
    assert.equal(parsed.staged[0].path, 'new name.txt');
  });

  test('null, empty and malformed input produce an empty, usable result', () => {
    const empty = parseStatus('');
    assert.deepEqual(empty, { staged: [], unstaged: [], untracked: [], ignored: [], unmerged: [] });
    assert.deepEqual(parseStatus(null), empty);
    assert.deepEqual(parseStatus(undefined), empty);
    const malformed = parseStatus(z('# ', '# branch.ab +x -y', '1 A.', 'nonsense', '2 R.', 'u UU'));
    assert.deepEqual(malformed, { staged: [], unstaged: [], untracked: [], ignored: [], unmerged: [] });
  });

  test('real git output round-trips: rename, unstaged edit, nested untracked directory', async () => {
    const repo = await initCommittedRepo();
    writeFileIn(repo, 'tracked.txt', 'tracked\n');
    await commitAll(repo, 'add tracked');
    await gitOk(repo, ['mv', 'tracked.txt', 'renamed.txt']);
    writeFileIn(repo, 'file.txt', 'edited\n');
    writeFileIn(repo, 'new-dir/nested/deep file.txt', 'deep\n');
    writeFileIn(repo, '.gitignore', '*.log\n');
    writeFileIn(repo, 'ignored.log', 'ignored\n');

    const parsed = parseStatus(await gitOk(repo, ['status', '--porcelain=v2', '--branch', '-z', '--ignored']));
    assert.equal(parsed.branch, 'main');
    assert.deepEqual(parsed.staged.map((entry) => entry.path), ['renamed.txt']);
    assert.deepEqual(parsed.unstaged.map((entry) => entry.path), ['file.txt']);
    assert.equal(parsed.untracked.includes('.gitignore'), true);
    assert.equal(parsed.ignored.includes('ignored.log'), true);
  });
});

describe('changedPaths()', () => {
  test('a brand-new file inside a new nested directory is reported as the file, not as "dir/"', async () => {
    // Pinned deliberately: the session recorder stores per-file paths, so a
    // collapsed "new-dir/" entry never matches and the new file would never be
    // committed. changedPaths asks for untrackedFiles: 'all' for this reason.
    const repo = await initCommittedRepo();
    writeFileIn(repo, 'new-dir/nested/deep file.txt', 'deep\n');
    const paths = await changedPaths(repo);
    assert.deepEqual(paths, ['new-dir/nested/deep file.txt']);
    assert.equal(paths.includes('new-dir/'), false);
  });

  test('staged, unstaged, renamed and untracked paths all appear exactly once', async () => {
    const repo = await initCommittedRepo();
    writeFileIn(repo, 'one.txt', 'one\n');
    await commitAll(repo, 'add one');
    await gitOk(repo, ['mv', 'one.txt', 'renamed.txt']);
    writeFileIn(repo, 'file.txt', 'changed\n');
    writeFileIn(repo, 'untracked.txt', 'u\n');
    const paths = await changedPaths(repo);
    assert.deepEqual([...paths].sort(), ['file.txt', 'renamed.txt', 'untracked.txt']);
  });

  test('filenames with a space, a newline and a backslash survive the trip', async () => {
    const repo = await initCommittedRepo();
    writeFileIn(repo, 'with space.txt', 'a\n');
    writeFileIn(repo, 'line\nbreak.txt', 'b\n');
    writeFileIn(repo, 'back\\slash.txt', 'c\n');
    const paths = await changedPaths(repo);
    assert.deepEqual([...paths].sort(), ['back\\slash.txt', 'line\nbreak.txt', 'with space.txt']);
  });

  test('untrackedFiles: "no" hides untracked paths but keeps tracked changes', async () => {
    const repo = await initCommittedRepo();
    writeFileIn(repo, 'file.txt', 'changed\n');
    writeFileIn(repo, 'untracked.txt', 'u\n');
    assert.deepEqual([...await changedPaths(repo, { untrackedFiles: 'no' })].sort(), ['file.txt']);
  });

  test('a clean repository and a non-repository both answer with an empty list', async () => {
    const repo = await initCommittedRepo();
    assert.deepEqual(await changedPaths(repo), []);
    assert.deepEqual(await changedPaths(await initRepo({ prefix: 'dsh-git-core-empty-' })), []);
    assert.deepEqual(await changedPaths(tempDir()), []);
  });
});

describe('repoState()', () => {
  test('a clean repository reports the documented shape in full', async () => {
    const repo = await initCommittedRepo();
    const state = await repoState(repo);
    const oid = await headSha(repo);
    assert.equal(state.ok, true);
    assert.equal(state.repoRoot, repo);
    assert.equal(state.branch, 'main');
    assert.equal(state.detached, false);
    assert.equal(state.oid, oid);
    assert.equal(state.dirty, false);
    assert.equal(state.changeCount, 0);
    assert.equal(state.staged, 0);
    assert.equal(state.unstaged, 0);
    assert.equal(state.untracked, 0);
    assert.equal(state.unmerged, 0);
    assert.equal(state.upstream, undefined);
    // No upstream is the normal state of a fresh branch, not 0.
    assert.equal(state.ahead, undefined);
    assert.equal(state.behind, undefined);
    assert.deepEqual(state.remotes, []);
    assert.equal(state.defaultBranch, 'main');
    assert.equal(state.rebaseInProgress, false);
    assert.equal(state.mergeInProgress, false);
    assert.equal(state.cherryPickInProgress, false);
    assert.equal('error' in state, false);
  });

  test('a dirty repository counts staged, unstaged, untracked and renamed paths', async () => {
    const repo = await initCommittedRepo();
    writeFileIn(repo, 'tracked.txt', 'tracked\n');
    await commitAll(repo, 'tracked');
    await gitOk(repo, ['mv', 'tracked.txt', 'renamed.txt']);
    writeFileIn(repo, 'file.txt', 'edited\n');
    writeFileIn(repo, 'new.txt', 'new\n');
    const state = await repoState(repo);
    assert.equal(state.ok, true);
    assert.equal(state.dirty, true);
    assert.equal(state.staged, 1);
    assert.equal(state.unstaged, 1);
    assert.equal(state.untracked, 1);
    assert.equal(state.changeCount, 3);
    assert.equal(state.detached, false);
  });

  test('a branch with an upstream reports ahead and behind from git itself', async () => {
    const remote = await initBareRepo();
    const first = await cloneRepo(remote);
    await commitAll(first, 'first', { 'a.txt': 'a\n' });
    await gitOk(first, ['push', '-q', '-u', 'origin', 'main']);
    let state = await repoState(first);
    assert.equal(state.upstream, 'origin/main');
    assert.equal(state.ahead, 0);
    assert.equal(state.behind, 0);

    await commitAll(first, 'local only', { 'b.txt': 'b\n' });
    state = await repoState(first);
    assert.equal(state.ahead, 1);
    assert.equal(state.behind, 0);

    const second = await cloneRepo(remote);
    await commitAll(second, 'remote only', { 'c.txt': 'c\n' });
    await gitOk(second, ['push', '-q', 'origin', 'main']);
    await gitOk(first, ['fetch', '-q', 'origin']);
    state = await repoState(first);
    assert.equal(state.ahead, 1);
    assert.equal(state.behind, 1);
  });

  test('a detached HEAD reports no branch and keeps the oid', async () => {
    const repo = await initCommittedRepo();
    await gitOk(repo, ['checkout', '-q', '--detach']);
    const state = await repoState(repo);
    assert.equal(state.ok, true);
    assert.equal(state.detached, true);
    assert.equal(state.branch, undefined);
    assert.equal(state.oid, await headSha(repo));
  });

  test('a bare repository cannot be described by status, but its branch and oid are still reported', async () => {
    const remote = await initBareRepo();
    const work = await cloneRepo(remote);
    const sha = await commitAll(work, 'first', { 'a.txt': 'a\n' });
    await gitOk(work, ['push', '-q', '-u', 'origin', 'main']);
    const state = await repoState(remote);
    assert.equal(state.ok, false);
    assert.equal(typeof state.error, 'string');
    assert.match(state.error, /work tree/i);
    assert.equal(state.repoRoot, remote);
    assert.equal(state.branch, 'main');
    assert.equal(state.oid, sha);
    assert.equal(state.dirty, false);
    assert.equal(state.changeCount, 0);
  });

  test('a directory that is not a repository answers with the documented shape and ok:false', async () => {
    const plain = (await import('./helpers.mjs')).tempDir();
    const state = await repoState(plain);
    assert.equal(state.ok, false);
    assert.equal(state.repoRoot, plain);
    assert.equal(state.branch, undefined);
    assert.equal(state.detached, false);
    assert.equal(state.dirty, false);
    assert.equal(state.changeCount, 0);
    assert.deepEqual(state.remotes, []);
    assert.equal(state.defaultBranch, undefined);
    assert.equal(typeof state.error, 'string');
  });

  test('a merge in progress marks mergeInProgress and counts the conflict as unmerged', async () => {
    const repo = await initCommittedRepo();
    await gitOk(repo, ['checkout', '-q', '-b', 'side']);
    await commitAll(repo, 'side', { 'file.txt': 'side\n' });
    await gitOk(repo, ['checkout', '-q', 'main']);
    await commitAll(repo, 'main', { 'file.txt': 'main\n' });
    const merged = await git(repo, ['merge', 'side']);
    assert.equal(merged.ok, false);
    const state = await repoState(repo);
    assert.equal(state.mergeInProgress, true);
    assert.equal(state.rebaseInProgress, false);
    assert.equal(state.cherryPickInProgress, false);
    assert.equal(state.unmerged, 1);
    assert.equal(state.dirty, true);
  });

  test('a stopped rebase marks rebaseInProgress', async () => {
    const repo = await initCommittedRepo();
    await gitOk(repo, ['checkout', '-q', '-b', 'side']);
    await commitAll(repo, 'side', { 'file.txt': 'side\n' });
    await gitOk(repo, ['checkout', '-q', 'main']);
    await commitAll(repo, 'main', { 'file.txt': 'main\n' });
    await gitOk(repo, ['checkout', '-q', 'side']);
    const rebased = await git(repo, ['rebase', 'main']);
    assert.equal(rebased.ok, false);
    const state = await repoState(repo);
    assert.equal(state.rebaseInProgress, true);
    assert.equal(state.mergeInProgress, false);
    assert.equal(state.unmerged, 1);
  });

  test('a stopped cherry-pick marks cherryPickInProgress', async () => {
    const repo = await initCommittedRepo();
    await gitOk(repo, ['checkout', '-q', '-b', 'side']);
    await commitAll(repo, 'side', { 'file.txt': 'side\n' });
    const pick = await headSha(repo);
    await gitOk(repo, ['checkout', '-q', 'main']);
    await commitAll(repo, 'main', { 'file.txt': 'main\n' });
    const picked = await git(repo, ['cherry-pick', pick]);
    assert.equal(picked.ok, false);
    const state = await repoState(repo);
    assert.equal(state.cherryPickInProgress, true);
    assert.equal(state.mergeInProgress, false);
    assert.equal(state.rebaseInProgress, false);
  });

  test('untrackedFiles: "no" keeps untracked files out of the counts', async () => {
    const repo = await initCommittedRepo();
    writeFileIn(repo, 'untracked.txt', 'u\n');
    assert.equal((await repoState(repo)).untracked, 1);
    assert.equal((await repoState(repo, { untrackedFiles: 'no' })).untracked, 0);
  });
});

describe('computeSync()', () => {
  /** A repository whose feature branch is 2 ahead and 1 behind main. */
  async function divergedRepo() {
    const repo = await initCommittedRepo();
    await gitOk(repo, ['checkout', '-q', '-b', 'feature']);
    await commitAll(repo, 'feature one', { 'feature-one.txt': '1\n' });
    await commitAll(repo, 'feature two', { 'feature-two.txt': '2\n' });
    await gitOk(repo, ['checkout', '-q', 'main']);
    await commitAll(repo, 'main one', { 'main-one.txt': '1\n' });
    await gitOk(repo, ['checkout', '-q', 'feature']);
    return repo;
  }

  test('reads the left-right counts in the right direction', async () => {
    // `--left-right --count base...HEAD` prints "<behind> <ahead>"; reading it
    // as ahead/behind inverts every answer.
    const repo = await divergedRepo();
    assert.deepEqual(await computeSync(repo, 'main'), { ahead: 2, behind: 1, base: 'main' });
  });

  test('an up-to-date branch is 0/0, and the base name is trimmed', async () => {
    const repo = await divergedRepo();
    assert.deepEqual(await computeSync(repo, 'feature'), { ahead: 0, behind: 0, base: 'feature' });
    // A base that resolves but names the current commit is 0/0, not unknown.
    assert.deepEqual(await computeSync(repo, ' HEAD '), { ahead: 0, behind: 0, base: 'HEAD' });
    assert.deepEqual(await computeSync(repo, ' main '), { ahead: 2, behind: 1, base: 'main' });
  });

  test('unknown, unborn, option-like and non-string bases are undefined rather than invented zeros', async () => {
    const repo = await divergedRepo();
    assert.equal(await computeSync(repo, 'origin/no-such-branch'), undefined);
    assert.equal(await computeSync(repo, ''), undefined);
    assert.equal(await computeSync(repo, '   '), undefined);
    assert.equal(await computeSync(repo, '--all'), undefined);
    assert.equal(await computeSync(repo, undefined), undefined);
    assert.equal(await computeSync(repo, 42), undefined);
    const unborn = await initRepo({ prefix: 'dsh-git-core-unborn-' });
    assert.equal(await computeSync(unborn, 'main'), undefined);
  });

  test('aheadOf() counts only the commits HEAD has that the base does not', async () => {
    const repo = await divergedRepo();
    assert.equal(await aheadOf(repo, 'main'), 2);
    assert.equal(await aheadOf(repo, 'feature'), 0);
    assert.equal(await aheadOf(repo, 'no-such-ref'), undefined);
    assert.equal(await aheadOf(repo, '-x'), undefined);
    assert.equal(await aheadOf(repo, ''), undefined);
    const unborn = await initRepo({ prefix: 'dsh-git-core-unborn2-' });
    assert.equal(await aheadOf(unborn, 'main'), undefined);
  });
});

describe('defaultBranchOf()', () => {
  test('finds a committed local main or master, and answers undefined when neither exists', async () => {
    assert.equal(await defaultBranchOf(await initCommittedRepo()), 'main');
    const master = await initRepo({ branch: 'master', prefix: 'dsh-git-core-master-' });
    await commitAll(master, 'first', { 'a.txt': 'a\n' });
    assert.equal(await defaultBranchOf(master), 'master');
    const trunk = await initRepo({ branch: 'trunk', prefix: 'dsh-git-core-trunk-' });
    await commitAll(trunk, 'first', { 'a.txt': 'a\n' });
    assert.equal(await defaultBranchOf(trunk), undefined);
    // A repository with no commits has no local branch ref yet.
    assert.equal(await defaultBranchOf(await initRepo({ prefix: 'dsh-git-core-unborn3-' })), undefined);
  });

  test('prefers origin/HEAD, falls back to origin/main and master, in that order', async () => {
    const remote = await initBareRepo();
    const work = await cloneRepo(remote);
    await commitAll(work, 'first', { 'a.txt': 'a\n' });
    await gitOk(work, ['push', '-q', '-u', 'origin', 'main']);
    const clone = await cloneRepo(remote);
    // A clone has refs/remotes/origin/HEAD -> origin/main.
    assert.equal(await defaultBranchOf(clone), 'main');
    // Retarget it at a trunk branch and the symbolic ref wins over the fallbacks.
    await gitOk(clone, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk']);
    assert.equal(await defaultBranchOf(clone), 'trunk');
    // With no origin/HEAD, origin/main still answers.
    await gitOk(clone, ['symbolic-ref', '--delete', 'refs/remotes/origin/HEAD']);
    assert.equal(await defaultBranchOf(clone), 'main');
    // With no origin refs at all, the local main does.
    await gitOk(clone, ['remote', 'remove', 'origin']);
    assert.equal(await defaultBranchOf(clone), 'main');
  });
});