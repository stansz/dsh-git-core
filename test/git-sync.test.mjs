/**
 * lib/git.mjs — remote traffic, fast-forwarding, merging and rebasing.
 *
 * Every "remote" here is a bare repository in a temp directory, so git really
 * does run fetch/push over the file protocol while no network is involved.
 */

import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { join } from 'node:path';

import {
  cloneRepo,
  cleanupTempDirs,
  commitAll,
  commitSubject,
  git,
  gitOk,
  headSha,
  initBareRepo,
  initCommittedRepo,
  refExists,
  tempDir,
  writeFileIn,
} from './helpers.mjs';

import {
  ancestry,
  changedPaths,
  conflictedPaths,
  fastForward,
  fetch,
  merge,
  mergeAbort,
  rebase,
  rebaseAbort,
  repoState,
  revParse,
} from '../lib/git.mjs';

after(cleanupTempDirs);

/**
 * A bare origin plus two clones of it, with `origin/main` at one commit.
 * `a` has push rights as the author; `b` is the repository being updated.
 */
async function originAndClones() {
  const remote = await initBareRepo();
  const a = await cloneRepo(remote);
  await commitAll(a, 'shared first commit', { 'base.txt': 'base\n' });
  await gitOk(a, ['push', '-q', '-u', 'origin', 'main']);
  const b = await cloneRepo(remote);
  return { remote, a, b };
}

describe('fetch()', () => {
  test('fetches a new commit into the remote-tracking ref without touching the checkout', async () => {
    const { a, b } = await originAndClones();
    const sha = await commitAll(a, 'second commit', { 'second.txt': '2\n' });
    await gitOk(a, ['push', '-q', 'origin', 'main']);
    const beforeHead = await headSha(b);
    assert.deepEqual(await fetch(b, 'origin'), { ok: true });
    assert.equal(await revParse(b, 'origin/main'), sha);
    // A fetch updates refs, not the working tree.
    assert.equal(await headSha(b), beforeHead);
  });

  test('prunes a remote-tracking branch that the remote deleted', async () => {
    const { a, b } = await originAndClones();
    await gitOk(a, ['push', '-q', 'origin', 'main:refs/heads/task-branch']);
    await fetch(b, 'origin');
    assert.equal(await refExists(b, 'origin/task-branch'), true);
    await gitOk(a, ['push', '-q', 'origin', ':refs/heads/task-branch']);
    assert.deepEqual(await fetch(b, 'origin'), { ok: true });
    // The whole point of --prune: a branch that exists nowhere is not left
    // behind as a stale ref that `sync` would then fast-forward toward.
    assert.equal(await refExists(b, 'origin/task-branch'), false);
  });

  test('rejects a missing, option-like or unreachable remote as a result, not a throw', async () => {
    const { b } = await originAndClones();
    const missing = await fetch(b, '');
    assert.equal(missing.ok, false);
    assert.match(missing.error, /no remote name/);
    const option = await fetch(b, '-x');
    assert.equal(option.ok, false);
    assert.match(option.error, /looks like an option/);
    const unknown = await fetch(b, 'no-such-remote');
    assert.equal(unknown.ok, false);
    assert.match(unknown.error, /does not appear to be a git repository/);
  });
});

describe('fastForward()', () => {
  test('moves a behind branch to the target and checks out its files', async () => {
    const { a, b } = await originAndClones();
    const sha = await commitAll(a, 'incoming', { 'incoming.txt': 'in\n' });
    await gitOk(a, ['push', '-q', 'origin', 'main']);
    await fetch(b, 'origin');
    const from = await headSha(b);
    const result = await fastForward(b, 'origin/main');
    assert.equal(result.ok, true);
    assert.equal(result.moved, true);
    assert.equal(result.from, from);
    assert.equal(result.to, sha);
    assert.equal(await headSha(b), sha);
    assert.deepEqual(await changedPaths(b), []);
    assert.equal((await import('node:fs')).readFileSync(join(b, 'incoming.txt'), 'utf8'), 'in\n');
  });

  test('an already up-to-date branch reports ok with moved:false', async () => {
    const { a, b } = await originAndClones();
    await commitAll(a, 'incoming', { 'incoming.txt': 'in\n' });
    await gitOk(a, ['push', '-q', 'origin', 'main']);
    await fetch(b, 'origin');
    assert.equal((await fastForward(b, 'origin/main')).moved, true);
    const again = await fastForward(b, 'origin/main');
    assert.equal(again.ok, true);
    assert.equal(again.moved, false);
    assert.equal(again.from, again.to);
  });

  test('refuses a target that is not a descendant and leaves HEAD untouched', async () => {
    const { a, b } = await originAndClones();
    // b moves forward on its own, so origin/main is no longer a descendant.
    await commitAll(b, 'b local work', { 'b-local.txt': 'b\n' });
    const before = await headSha(b);
    await commitAll(a, 'a remote work', { 'a-remote.txt': 'a\n' });
    await gitOk(a, ['push', '-q', 'origin', 'main']);
    await fetch(b, 'origin');
    const result = await fastForward(b, 'origin/main');
    assert.equal(result.ok, false);
    assert.equal(result.moved, false);
    assert.match(result.error, /not a fast-forward/);
    assert.equal(await headSha(b), before);
  });

  test('never discards uncommitted work: an unrelated dirty file survives', async () => {
    const { a, b } = await originAndClones();
    await commitAll(a, 'incoming', { 'incoming.txt': 'in\n' });
    await gitOk(a, ['push', '-q', 'origin', 'main']);
    await fetch(b, 'origin');
    writeFileIn(b, 'base.txt', 'locally edited\n');
    const result = await fastForward(b, 'origin/main');
    assert.equal(result.ok, true);
    assert.equal(result.moved, true);
    // reset --hard would have thrown this edit away to answer a history question.
    assert.deepEqual(await changedPaths(b), ['base.txt']);
  });

  test('refuses while a merge, rebase or cherry-pick is in progress', async () => {
    const repo = await initCommittedRepo();
    await gitOk(repo, ['checkout', '-q', '-b', 'side']);
    await commitAll(repo, 'side', { 'file.txt': 'side\n' });
    await gitOk(repo, ['checkout', '-q', 'main']);
    await commitAll(repo, 'main', { 'file.txt': 'main\n' });
    assert.equal((await git(repo, ['merge', 'side'])).ok, false);
    const result = await fastForward(repo, 'main');
    assert.equal(result.ok, false);
    assert.match(result.error, /in progress/);
  });

  test('rejects unknown and option-like targets without running anything', async () => {
    const repo = await initCommittedRepo();
    const unknown = await fastForward(repo, 'origin/no-such-ref');
    assert.equal(unknown.ok, false);
    assert.match(unknown.error, /unknown ref/);
    for (const target of ['', '   ', '-x', undefined, 42]) {
      const result = await fastForward(repo, target);
      assert.equal(result.ok, false);
      assert.match(result.error, /no usable target ref/);
    }
    // Outside a repository the target cannot resolve either.
    const outside = await fastForward(tempDir(), 'origin/main');
    assert.equal(outside.ok, false);
    assert.match(outside.error, /unknown ref/);
  });
});

describe('ancestry()', () => {
  test('a clean repository and a non-repository report nothing in progress', async () => {
    assert.deepEqual(await ancestry(await initCommittedRepo()), {
      merge: false, rebase: false, cherryPick: false, any: false,
    });
    assert.deepEqual(await ancestry(tempDir()), {
      merge: false, rebase: false, cherryPick: false, any: false,
    });
  });

  test('detects a stopped merge and stops reporting it after the abort', async () => {
    const repo = await initCommittedRepo();
    await gitOk(repo, ['checkout', '-q', '-b', 'side']);
    await commitAll(repo, 'side', { 'file.txt': 'side\n' });
    await gitOk(repo, ['checkout', '-q', 'main']);
    await commitAll(repo, 'main', { 'file.txt': 'main\n' });
    assert.equal((await git(repo, ['merge', 'side'])).ok, false);
    const marks = await ancestry(repo);
    assert.equal(marks.merge, true);
    assert.equal(marks.any, true);
    assert.equal((await mergeAbort(repo)).ok, true);
    assert.deepEqual(await ancestry(repo), {
      merge: false, rebase: false, cherryPick: false, any: false,
    });
  });

  test('finds a rebase started in a linked worktree, where the state lives in that gitdir', async () => {
    const repo = await initCommittedRepo();
    await gitOk(repo, ['checkout', '-q', '-b', 'feature']);
    await commitAll(repo, 'feature edit', { 'file.txt': 'feature\n' });
    await gitOk(repo, ['checkout', '-q', 'main']);
    await commitAll(repo, 'main edit', { 'file.txt': 'main\n' });
    const worktree = join(tempDir(), 'linked-rebase');
    await gitOk(repo, ['worktree', 'add', '-q', worktree, 'feature']);
    // The main repository is clean while the linked worktree is mid-rebase.
    assert.equal((await ancestry(repo)).any, false);
    assert.equal((await git(worktree, ['rebase', 'main'])).ok, false);
    const marks = await ancestry(worktree);
    assert.equal(marks.rebase, true);
    assert.equal(marks.any, true);
    assert.equal((await rebaseAbort(worktree)).ok, true);
    assert.equal((await ancestry(worktree)).any, false);
  });
});

describe('merge(), mergeAbort() and conflictedPaths()', () => {
  test('merges a diverged branch without opening an editor and lists no conflict', async () => {
    const repo = await initCommittedRepo();
    await gitOk(repo, ['checkout', '-q', '-b', 'feature']);
    const feature = await commitAll(repo, 'feature work', { 'feature.txt': 'f\n' });
    await gitOk(repo, ['checkout', '-q', 'main']);
    await commitAll(repo, 'main work', { 'main.txt': 'm\n' });
    assert.deepEqual(await conflictedPaths(repo), []);
    const result = await merge(repo, 'feature');
    assert.equal(result.ok, true);
    assert.deepEqual(await conflictedPaths(repo), []);
    assert.equal(await commitSubject(repo), "Merge branch 'feature'");
    const parents = (await gitOk(repo, ['rev-list', '--parents', '-n', '1', 'HEAD'])).trim().split(' ');
    assert.equal(parents.length, 3);
    assert.equal(await revParse(repo, 'feature'), feature);
    assert.equal((await repoState(repo)).mergeInProgress, false);
  });

  test('a conflicting merge fails with git\'s output, and mergeAbort restores HEAD and the tree', async () => {
    const repo = await initCommittedRepo();
    await gitOk(repo, ['checkout', '-q', '-b', 'side']);
    await commitAll(repo, 'side', { 'file.txt': 'side\n' });
    await gitOk(repo, ['checkout', '-q', 'main']);
    const mainSha = await commitAll(repo, 'main', { 'file.txt': 'main\n' });
    const result = await merge(repo, 'side');
    assert.equal(result.ok, false);
    assert.match(result.output, /CONFLICT/);
    assert.deepEqual(await conflictedPaths(repo), ['file.txt']);
    assert.equal((await repoState(repo)).mergeInProgress, true);

    assert.deepEqual(await mergeAbort(repo), { ok: true });
    assert.equal(await headSha(repo), mainSha);
    assert.deepEqual(await conflictedPaths(repo), []);
    assert.deepEqual(await changedPaths(repo), []);
    assert.equal((await repoState(repo)).mergeInProgress, false);
  });

  test('rejects an option-like or empty ref before touching the worktree', async () => {
    const repo = await initCommittedRepo();
    for (const ref of ['-x', '', '   ', undefined]) {
      const result = await merge(repo, ref);
      assert.equal(result.ok, false);
      assert.match(result.error, /no usable ref/);
    }
  });

  test('an unknown ref fails the merge without changing HEAD', async () => {
    const repo = await initCommittedRepo();
    const before = await headSha(repo);
    const result = await merge(repo, 'no-such-branch');
    assert.equal(result.ok, false);
    assert.equal(await headSha(repo), before);
    assert.equal((await repoState(repo)).mergeInProgress, false);
  });

  test('aborting a merge or rebase that is not in progress reports failure', async () => {
    const repo = await initCommittedRepo();
    assert.deepEqual(await mergeAbort(repo), { ok: false });
    assert.deepEqual(await rebaseAbort(repo), { ok: false });
  });

  test('conflictedPaths() is an empty list outside a repository', async () => {
    assert.deepEqual(await conflictedPaths(tempDir()), []);
  });
});

describe('rebase() and rebaseAbort()', () => {
  test('replays the current branch onto the target, leaving a linear history', async () => {
    const repo = await initCommittedRepo();
    await gitOk(repo, ['checkout', '-q', '-b', 'feature']);
    await commitAll(repo, 'feature work', { 'feature.txt': 'f\n' });
    await gitOk(repo, ['checkout', '-q', 'main']);
    const mainSha = await commitAll(repo, 'main work', { 'main.txt': 'm\n' });
    await gitOk(repo, ['checkout', '-q', 'feature']);
    const result = await rebase(repo, 'main');
    assert.equal(result.ok, true);
    assert.equal(await revParse(repo, 'HEAD^'), mainSha);
    assert.equal(await commitSubject(repo), 'feature work');
    assert.deepEqual(await ancestry(repo), {
      merge: false, rebase: false, cherryPick: false, any: false,
    });
    assert.deepEqual(await conflictedPaths(repo), []);
  });

  test('rebasing onto the current base is a success', async () => {
    const repo = await initCommittedRepo();
    await gitOk(repo, ['checkout', '-q', '-b', 'feature']);
    await commitAll(repo, 'feature work', { 'feature.txt': 'f\n' });
    assert.equal((await rebase(repo, 'main')).ok, true);
  });

  test('a conflicting rebase fails and rebaseAbort puts the branch exactly back', async () => {
    const repo = await initCommittedRepo();
    await gitOk(repo, ['checkout', '-q', '-b', 'feature']);
    await commitAll(repo, 'feature edit', { 'file.txt': 'feature\n' });
    const before = await headSha(repo);
    await gitOk(repo, ['checkout', '-q', 'main']);
    await commitAll(repo, 'main edit', { 'file.txt': 'main\n' });
    await gitOk(repo, ['checkout', '-q', 'feature']);
    const result = await rebase(repo, 'main');
    assert.equal(result.ok, false);
    assert.match(result.output, /CONFLICT/);
    const names = await conflictedPaths(repo);
    assert.equal(names.length > 0, true);
    assert.equal((await ancestry(repo)).rebase, true);

    assert.deepEqual(await rebaseAbort(repo), { ok: true });
    assert.equal(await headSha(repo), before);
    assert.deepEqual(await conflictedPaths(repo), []);
    assert.deepEqual(await ancestry(repo), {
      merge: false, rebase: false, cherryPick: false, any: false,
    });
  });

  test('rejects an option-like or empty target', async () => {
    const repo = await initCommittedRepo();
    for (const onto of ['-x', '', '  ', undefined]) {
      const result = await rebase(repo, onto);
      assert.equal(result.ok, false);
      assert.match(result.error, /no usable ref/);
    }
  });
});