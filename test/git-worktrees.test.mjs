/**
 * lib/git.mjs — worktree listing.
 *
 * `parseWorktrees` is fed synthetic porcelain (the format has a realpath trap
 * and optional reasons, which are format facts) and `listWorktrees` is then
 * exercised on worktrees created with the real git CLI.
 */

import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import {
  cleanupTempDirs,
  git,
  gitOk,
  initBareRepo,
  initCommittedRepo,
  tempDir,
  tempDirWithRaw,
} from './helpers.mjs';

import { listWorktrees, parseWorktrees } from '../lib/git.mjs';

after(cleanupTempDirs);

const SHA = '0123456789abcdef0123456789abcdef01234567';

describe('parseWorktrees (git worktree list --porcelain)', () => {
  test('parses main, linked, locked, prunable and bare records in git\'s order', async () => {
    const realMain = tempDir('dsh-git-core-wt-main-');
    const realLinked = tempDir('dsh-git-core-wt-linked-');
    const realLocked = tempDir('dsh-git-core-wt-locked-');
    const gonePath = join(tempDir('dsh-git-core-wt-gone-'), 'already-deleted');
    const stdout = [
      'worktree ' + realMain,
      'HEAD ' + SHA,
      'branch refs/heads/main',
      '',
      'worktree ' + realLinked,
      'HEAD ' + SHA,
      'branch refs/heads/feature/task-1',
      '',
      'worktree ' + realLocked,
      'HEAD ' + SHA,
      'detached',
      'locked in use by a teammate',
      '',
      'worktree ' + gonePath,
      'HEAD ' + SHA,
      'prunable gitdir file points to non-existent location',
      '',
      'worktree ' + (await initBareRepo()),
      'bare',
      '',
    ].join('\n');
    const entries = parseWorktrees(stdout);
    assert.equal(entries.length, 5);
    assert.equal(entries[0].path, realMain);
    assert.equal(entries[0].branch, 'main');
    assert.equal(entries[0].head, SHA);
    assert.equal(entries[1].path, realLinked);
    // A branch ref is reported short, not as refs/heads/...
    assert.equal(entries[1].branch, 'feature/task-1');
    assert.equal(entries[2].locked, true);
    assert.equal(entries[2].lockReason, 'in use by a teammate');
    assert.equal(entries[2].detached, true);
    assert.equal(entries[2].branch, undefined);
    assert.equal(entries[3].prunable, true);
    assert.equal(entries[3].pruneReason, 'gitdir file points to non-existent location');
    // A path that no longer exists cannot be realpath'd and is kept verbatim.
    assert.equal(entries[3].path, gonePath);
    assert.equal(entries[4].bare, true);
    assert.equal(entries[4].path.startsWith('/'), true);
  });

  test('a locked or prunable record with no reason gets the flag and no reason', () => {
    const entries = parseWorktrees([
      'worktree /private/tmp/x',
      'HEAD ' + SHA,
      'branch refs/heads/main',
      'locked',
      '',
      'worktree /private/tmp/y',
      'HEAD ' + SHA,
      'branch refs/heads/other',
      'prunable',
      '',
    ].join('\n'));
    assert.equal(entries[0].locked, true);
    assert.equal(entries[0].lockReason, undefined);
    assert.equal(entries[1].prunable, true);
    assert.equal(entries[1].pruneReason, undefined);
  });

  test('empty, null and malformed input produce an empty list without throwing', () => {
    assert.deepEqual(parseWorktrees(''), []);
    assert.deepEqual(parseWorktrees(null), []);
    assert.deepEqual(parseWorktrees(undefined), []);
    // Records before any "worktree" line are not entries.
    assert.deepEqual(parseWorktrees('HEAD ' + SHA + '\nbranch refs/heads/main\n\n'), []);
  });

  test('returns the same shape for trailing whitespace and extra blank lines', () => {
    const entries = parseWorktrees('\n\nworktree /private/tmp/x\nHEAD ' + SHA + '\nbranch refs/heads/main\n\n\n');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].branch, 'main');
  });
});

describe('listWorktrees()', () => {
  test('lists the main worktree first, then linked worktrees, with realpath\'d paths', async () => {
    const repo = await initCommittedRepo();
    // Create the linked worktree through the *un*-realpath'd spelling of the
    // temp dir (/var/... on macOS) so the realpath conversion is proved.
    const { raw, real } = tempDirWithRaw('dsh-git-core-wt-raw-');
    const rawWorktree = join(raw, 'linked');
    const realWorktree = join(real, 'linked');
    await gitOk(repo, ['worktree', 'add', '-q', '-b', 'linked-task', rawWorktree]);

    const entries = await listWorktrees(repo);
    assert.equal(Array.isArray(entries), true);
    assert.equal(entries.length, 2);
    // Main first, in git's own order.
    assert.equal(entries[0].path, repo);
    assert.equal(entries[0].branch, 'main');
    // The linked path comes back realpath'd, comparable with every other path.
    assert.equal(entries[1].path, realpathSync(realWorktree));
    if (raw !== real) assert.notEqual(entries[1].path, rawWorktree);
    assert.equal(entries[1].branch, 'linked-task');
  });

  test('reports a locked worktree and its reason', async () => {
    const repo = await initCommittedRepo();
    const worktree = join(tempDir(), 'locked');
    await gitOk(repo, ['worktree', 'add', '-q', '-b', 'locked-task', worktree]);
    await gitOk(repo, ['worktree', 'lock', '--reason', 'held for the test', worktree]);
    const entries = await listWorktrees(repo);
    const linked = entries.find((entry) => entry.branch === 'locked-task');
    assert.equal(linked.locked, true);
    assert.equal(linked.lockReason, 'held for the test');
  });

  test('reports a prunable worktree whose directory was deleted, and stops doing so after prune', async () => {
    const repo = await initCommittedRepo();
    const worktree = join(tempDir(), 'prunable');
    await gitOk(repo, ['worktree', 'add', '-q', '-b', 'prunable-task', worktree]);
    // Delete the checkout the way a crashed task would, leaving the record.
    rmSync(worktree, { recursive: true, force: true });
    let entries = await listWorktrees(repo);
    const prunable = entries.find((entry) => entry.branch === 'prunable-task');
    assert.equal(prunable.prunable, true);
    assert.equal(typeof prunable.pruneReason, 'string');
    assert.equal(prunable.path, worktree);
    await gitOk(repo, ['worktree', 'prune']);
    entries = await listWorktrees(repo);
    assert.equal(entries.some((entry) => entry.branch === 'prunable-task'), false);
  });

  test('a bare repository lists itself as a bare worktree', async () => {
    const bare = await initBareRepo();
    const entries = await listWorktrees(bare);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].path, bare);
    assert.equal(entries[0].bare, true);
  });

  test('is undefined — not an empty array — when git cannot answer', async () => {
    // A caller about to delete a branch must be able to tell "no worktree has
    // it" from "git could not say".
    assert.equal(await listWorktrees(tempDir()), undefined);
  });

  test('detached linked worktrees keep their HEAD and have no branch', async () => {
    const repo = await initCommittedRepo();
    const worktree = join(tempDir(), 'detached');
    await gitOk(repo, ['worktree', 'add', '-q', '--detach', worktree]);
    const entries = await listWorktrees(repo);
    const linked = entries.find((entry) => entry.path === worktree);
    assert.equal(linked.detached, true);
    assert.equal(linked.branch, undefined);
    assert.match(linked.head, /^[0-9a-f]{40}$/);
  });
});