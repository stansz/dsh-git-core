/**
 * lib/git.mjs — push.
 *
 * Pushes go to a bare repository in a temp directory over git's file protocol:
 * real refs, real rejection messages, no network. The contract under test is
 * that `pushed` means something was sent, an upstream is configured exactly
 * when it needs to be, and nothing is ever forced unless asked for.
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
  upstreamOf,
} from './helpers.mjs';

import { push, revParse } from '../lib/git.mjs';

after(cleanupTempDirs);

/** A committed repository with `origin` pointing at a fresh bare remote. */
async function repoWithOrigin() {
  const remote = await initBareRepo();
  const repo = await initCommittedRepo();
  await gitOk(repo, ['remote', 'add', 'origin', remote]);
  return { remote, repo };
}

/** The commit a ref resolves to in a bare repository, or undefined. */
async function remoteHead(remote, branch = 'main') {
  const result = await git(remote, ['rev-parse', '-q', '--verify', 'refs/heads/' + branch]);
  return result.ok ? result.stdout.trim() : undefined;
}

describe('push()', () => {
  test('the first push sends the branch, reports it, and configures the upstream', async () => {
    const { remote, repo } = await repoWithOrigin();
    const sha = await headSha(repo);
    const result = await push(repo);
    assert.equal(result.ok, true);
    assert.equal(result.pushed, true);
    assert.equal(result.setUpstream, true);
    assert.equal(result.remote, 'origin');
    assert.equal(result.branch, 'main');
    assert.equal(await upstreamOf(repo, 'main'), 'origin/main');
    // The remote ref really moved.
    assert.equal(await revParse(remote, 'refs/heads/main'), sha);
  });

  test('pushing an already up-to-date branch sends nothing and reports pushed:false', async () => {
    const { repo } = await repoWithOrigin();
    assert.equal((await push(repo)).pushed, true);
    const second = await push(repo);
    assert.equal(second.ok, true);
    assert.equal(second.pushed, false);
    assert.equal(second.setUpstream, false);
    assert.match(second.output, /up to date|up-to-date/);
  });

  test('a new local commit is sent by the next push', async () => {
    const { remote, repo } = await repoWithOrigin();
    await push(repo);
    const sha = await commitAll(repo, 'second', { 'second.txt': '2\n' });
    const result = await push(repo);
    assert.equal(result.ok, true);
    assert.equal(result.pushed, true);
    assert.equal(result.setUpstream, false);
    assert.equal(await remoteHead(remote), sha);
  });

  test('setUpstream: true forces --set-upstream even when nothing needs sending', async () => {
    const { repo } = await repoWithOrigin();
    await push(repo);
    const result = await push(repo, { setUpstream: true });
    assert.equal(result.ok, true);
    assert.equal(result.pushed, false);
    assert.equal(result.setUpstream, true);
    assert.equal(await upstreamOf(repo, 'main'), 'origin/main');
  });

  test('setUpstream: false leaves a branch with no upstream untracked', async () => {
    const { repo } = await repoWithOrigin();
    const result = await push(repo, { setUpstream: false });
    assert.equal(result.ok, true);
    assert.equal(result.pushed, true);
    assert.equal(result.setUpstream, false);
    assert.equal(await upstreamOf(repo, 'main'), undefined);
  });

  test('a branch tracking a different ref is repointed at its own remote branch', async () => {
    const { repo } = await repoWithOrigin();
    await push(repo);
    await gitOk(repo, ['checkout', '-q', '-b', 'feature']);
    const sha = await commitAll(repo, 'feature work', { 'feature.txt': 'f\n' });
    // Work as `git worktree add` does: the new branch starts out tracking the
    // base it was cut from, not its own name.
    await gitOk(repo, ['branch', '--set-upstream-to=origin/main', 'feature']);
    assert.equal(await upstreamOf(repo, 'feature'), 'origin/main');
    const result = await push(repo);
    assert.equal(result.ok, true);
    assert.equal(result.pushed, true);
    assert.equal(result.setUpstream, true);
    assert.equal(await upstreamOf(repo, 'feature'), 'origin/feature');
    assert.equal(await revParse(repo, 'origin/feature'), sha);
  });

  test('the result always carries ok, pushed, setUpstream, remote and branch', async () => {
    const { repo } = await repoWithOrigin();
    const result = await push(repo);
    for (const key of ['ok', 'pushed', 'setUpstream', 'remote', 'branch']) {
      assert.equal(key in result, true, 'missing ' + key);
    }
  });

  test('a detached HEAD has nothing to push', async () => {
    const { repo } = await repoWithOrigin();
    await gitOk(repo, ['checkout', '-q', '--detach']);
    const result = await push(repo);
    assert.equal(result.ok, false);
    assert.equal(result.pushed, false);
    assert.match(result.error, /detached/);
  });

  test('an option-like remote or branch is refused rather than passed to git', async () => {
    const { repo } = await repoWithOrigin();
    const badRemote = await push(repo, { remote: '-x' });
    assert.equal(badRemote.ok, false);
    assert.match(badRemote.error, /looks like an option/);
    const badBranch = await push(repo, { branch: '-x' });
    assert.equal(badBranch.ok, false);
    assert.match(badBranch.error, /looks like an option/);
  });

  test('an unreachable remote fails with git\'s message and a route forward', async () => {
    const { repo } = await repoWithOrigin();
    const result = await push(repo, { remote: 'missing-remote' });
    assert.equal(result.ok, false);
    assert.equal(result.pushed, false);
    assert.match(result.error, /does not appear to be a git repository/);
    assert.match(result.hint, /could not be reached/);
  });

  test('a repository with no remotes at all fails the same way', async () => {
    const repo = await initCommittedRepo();
    const result = await push(repo);
    assert.equal(result.ok, false);
    assert.equal(result.pushed, false);
    assert.match(result.error, /does not appear to be a git repository/);
  });

  test('a rejected non-fast-forward push reports failure and the recovery route', async () => {
    const { remote, repo } = await repoWithOrigin();
    await push(repo);
    const other = await cloneRepo(remote);
    await commitAll(other, 'other work', { 'other.txt': 'o\n' });
    await gitOk(other, ['push', '-q', 'origin', 'main']);
    const remoteBefore = await remoteHead(remote);
    await commitAll(repo, 'my work', { 'my.txt': 'm\n' });
    const result = await push(repo);
    assert.equal(result.ok, false);
    assert.equal(result.pushed, false);
    assert.match(result.output, /rejected/);
    assert.match(result.hint, /remote refused this update/);
    assert.match(result.hint, /git fetch origin/);
    // Nothing was forced: the remote still points where the other push left it.
    assert.equal(await remoteHead(remote), remoteBefore);
  });

  test('forceWithLease replaces this branch\'s own rewritten remote ref', async () => {
    const { remote, repo } = await repoWithOrigin();
    await push(repo);
    await commitAll(repo, 'rewritten', { 'rewritten.txt': 'r\n' });
    await gitOk(repo, ['commit', '--amend', '-q', '-m', 'rewritten and amended']);
    const amended = await headSha(repo);
    const result = await push(repo, { forceWithLease: true });
    assert.equal(result.ok, true);
    assert.equal(result.pushed, true);
    assert.equal(await remoteHead(remote), amended);
  });

  test('forceWithLease is refused when the remote moved since the last fetch', async () => {
    const { remote, repo } = await repoWithOrigin();
    await push(repo);
    await commitAll(repo, 'rewritten', { 'rewritten.txt': 'r\n' });
    await gitOk(repo, ['commit', '--amend', '-q', '-m', 'rewritten and amended']);
    assert.equal((await push(repo, { forceWithLease: true })).ok, true);

    // Somebody else moves the branch; this repository has not fetched.
    const other = await cloneRepo(remote);
    const otherSha = await commitAll(other, 'somebody else', { 'theirs.txt': 't\n' });
    await gitOk(other, ['push', '-q', 'origin', 'main']);
    await commitAll(repo, 'mine', { 'mine.txt': 'm\n' });

    const result = await push(repo, { forceWithLease: true });
    assert.equal(result.ok, false);
    assert.equal(result.pushed, false);
    // The lease is what stops the rewrite from discarding the other commit.
    assert.equal(await remoteHead(remote), otherSha);
    assert.match(result.output, /rejected|stale/i);
  });

  test('an unborn branch cannot be pushed', async () => {
    const remote = await initBareRepo();
    const repo = await initRepo();
    await gitOk(repo, ['remote', 'add', 'origin', remote]);
    const result = await push(repo);
    assert.equal(result.ok, false);
    assert.equal(result.pushed, false);
    assert.match(result.error, /does not match any|failed to push/);
  });
});