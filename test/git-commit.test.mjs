/**
 * lib/git.mjs — staging and committing.
 *
 * The properties under test are the ones a commit tool must not get wrong:
 * `all` sweeps untracked work in, `paths` commits exactly what was named and
 * leaves the rest staged, nothing-to-commit is refused rather than reported as
 * done, and a conflicted file is never silently resolved with its markers.
 */

import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';

import {
  cleanupTempDirs,
  commitAll,
  commitPaths,
  commitSubject,
  git,
  gitOk,
  headSha,
  initCommittedRepo,
  stageInRepo,
  stagedPaths,
  tempDir,
  writeFileIn,
} from './helpers.mjs';

import {
  changedPaths,
  commit,
  conflictedPaths,
  repoState,
  stagePaths,
} from '../lib/git.mjs';

after(cleanupTempDirs);

describe('stagePaths()', () => {
  test('an empty or non-array list is a success with nothing staged', async () => {
    const repo = await initCommittedRepo();
    writeFileIn(repo, 'untracked.txt', 'u\n');
    assert.deepEqual(await stagePaths(repo, []), { ok: true });
    assert.deepEqual(await stagePaths(repo, null), { ok: true });
    assert.deepEqual(await stagePaths(repo, undefined), { ok: true });
    assert.deepEqual(await stagedPaths(repo), []);
  });

  test('stages exactly the paths named and nothing else', async () => {
    const repo = await initCommittedRepo();
    writeFileIn(repo, 'one.txt', '1\n');
    writeFileIn(repo, 'two.txt', '2\n');
    writeFileIn(repo, 'file.txt', 'changed\n');
    assert.deepEqual(await stagePaths(repo, ['one.txt']), { ok: true });
    assert.deepEqual(await stagedPaths(repo), ['one.txt']);
    assert.deepEqual(await stagePaths(repo, ['two.txt', 'file.txt']), { ok: true });
    assert.deepEqual([...await stagedPaths(repo)].sort(), ['file.txt', 'one.txt', 'two.txt']);
  });

  test('deduplicates paths and drops a trailing slash from an untracked directory', async () => {
    const repo = await initCommittedRepo();
    writeFileIn(repo, 'new-dir/nested/file.txt', 'x\n');
    // `changedPaths` reports untracked directories as `new-dir/` in the normal
    // status form; the literal form needs the directory without the slash.
    assert.deepEqual(await stagePaths(repo, ['new-dir/', 'new-dir/', 'new-dir/']), { ok: true });
    assert.deepEqual(await stagedPaths(repo), ['new-dir/nested/file.txt']);
  });

  test('a filename that looks like a glob is staged literally', async () => {
    const repo = await initCommittedRepo();
    writeFileIn(repo, 'a.log', 'a\n');
    writeFileIn(repo, 'b.log', 'b\n');
    writeFileIn(repo, '*.log', 'literal star\n');
    // A pathspec would otherwise match every .log in the repository.
    assert.deepEqual(await stagePaths(repo, ['*.log']), { ok: true });
    assert.deepEqual(await stagedPaths(repo), ['*.log']);
  });

  test('a path starting with a dash is still a path, because it comes after --', async () => {
    const repo = await initCommittedRepo();
    writeFileIn(repo, '-weird-name.txt', 'dash\n');
    assert.deepEqual(await stagePaths(repo, ['-weird-name.txt']), { ok: true });
    assert.deepEqual(await stagedPaths(repo), ['-weird-name.txt']);
  });

  test('non-string entries are ignored rather than stringified into pathspecs', async () => {
    const repo = await initCommittedRepo();
    writeFileIn(repo, 'real.txt', 'r\n');
    writeFileIn(repo, '42', 'number name\n');
    assert.deepEqual(await stagePaths(repo, [42, null, '', 'real.txt']), { ok: true });
    assert.deepEqual(await stagedPaths(repo), ['real.txt']);
  });

  test('a path that does not exist is a failure carrying git\'s message', async () => {
    const repo = await initCommittedRepo();
    const result = await stagePaths(repo, ['no-such-file.txt']);
    assert.equal(result.ok, false);
    assert.match(result.error, /did not match any files/);
  });

  test('outside a repository staging is a failure, not a throw', async () => {
    const result = await stagePaths(tempDir(), ['anything.txt']);
    assert.equal(result.ok, false);
    assert.match(result.error, /not a git repository/);
  });
});

describe('commit()', () => {
  test('all: true commits every dirty path, untracked nested directories included', async () => {
    const repo = await initCommittedRepo();
    writeFileIn(repo, 'file.txt', 'changed\n');
    writeFileIn(repo, 'new-dir/nested/deep.txt', 'deep\n');
    const before = await headSha(repo);
    const result = await commit(repo, 'sweep everything', { all: true });
    assert.equal(result.ok, true);
    assert.match(result.sha, /^[0-9a-f]{40}$/);
    assert.equal(result.sha, await headSha(repo));
    assert.notEqual(result.sha, before);
    // A brand-new file in a brand-new directory must be in the commit, not
    // skipped because the status showed it as "new-dir/".
    assert.deepEqual([...await commitPaths(repo)].sort(), ['file.txt', 'new-dir/nested/deep.txt']);
    assert.equal(await commitSubject(repo), 'sweep everything');
    const state = await repoState(repo);
    assert.equal(state.dirty, false);
    assert.equal(state.changeCount, 0);
  });

  test('paths: commits only those paths and leaves anything else staged', async () => {
    const repo = await initCommittedRepo();
    writeFileIn(repo, 'staged-elsewhere.txt', 'staged\n');
    await stageInRepo(repo, ['staged-elsewhere.txt']);
    writeFileIn(repo, 'named.txt', 'named\n');
    const result = await commit(repo, 'only the named path', { paths: ['named.txt'] });
    assert.equal(result.ok, true);
    assert.deepEqual(await commitPaths(repo), ['named.txt']);
    // The other staged change is still staged, not swept into this commit.
    assert.deepEqual(await stagedPaths(repo), ['staged-elsewhere.txt']);
  });

  test('an empty or whitespace message is refused before anything is committed', async () => {
    const repo = await initCommittedRepo();
    writeFileIn(repo, 'file.txt', 'changed\n');
    const messageCount = async () => (await gitOk(repo, ['rev-list', '--count', 'HEAD'])).trim();
    const before = await messageCount();
    for (const message of ['', '   ', '\n\t ']) {
      const result = await commit(repo, message, { all: true });
      assert.equal(result.ok, false);
      assert.match(result.error, /empty message/);
    }
    assert.equal(await messageCount(), before);
  });

  test('nothing to commit is a refusal with a clear message', async () => {
    const repo = await initCommittedRepo();
    const result = await commit(repo, 'should not land');
    assert.equal(result.ok, false);
    assert.match(result.error, /nothing to commit/);
    const explicit = await commit(repo, 'nor this', { paths: ['file.txt'] });
    assert.equal(explicit.ok, false);
    assert.match(explicit.error, /nothing to commit/);
  });

  test('allowEmpty: true creates the commit that would otherwise be refused', async () => {
    const repo = await initCommittedRepo();
    const before = await headSha(repo);
    const result = await commit(repo, 'empty on purpose', { allowEmpty: true });
    assert.equal(result.ok, true);
    assert.equal(result.sha, await headSha(repo));
    assert.notEqual(result.sha, before);
    assert.equal(await commitSubject(repo), 'empty on purpose');
    // allowEmpty never overrides the message check.
    assert.equal((await commit(repo, '  ', { allowEmpty: true })).ok, false);
  });

  test('a conflicted path is refused for all and for paths, then an explicit resolution commits', async () => {
    const repo = await initCommittedRepo();
    await gitOk(repo, ['checkout', '-q', '-b', 'side']);
    await commitAll(repo, 'side edit', { 'file.txt': 'side\n' });
    await gitOk(repo, ['checkout', '-q', 'main']);
    await commitAll(repo, 'main edit', { 'file.txt': 'main\n' });
    const merged = await git(repo, ['merge', 'side']);
    assert.equal(merged.ok, false);
    assert.deepEqual(await conflictedPaths(repo), ['file.txt']);

    // git add on a conflicted path would mean "resolved", markers or not.
    for (const options of [{ all: true }, { paths: ['file.txt'] }]) {
      const refused = await commit(repo, 'do not commit markers', options);
      assert.equal(refused.ok, false);
      assert.match(refused.error, /unmerged path/);
      assert.match(refused.error, /conflict markers/);
    }
    // The documented way out: resolve by hand, stage explicitly, commit plainly.
    writeFileIn(repo, 'file.txt', 'resolved\n');
    assert.deepEqual(await stagePaths(repo, ['file.txt']), { ok: true });
    const resolved = await commit(repo, 'resolved the conflict');
    assert.equal(resolved.ok, true);
    assert.deepEqual(await conflictedPaths(repo), []);
    assert.equal(await commitSubject(repo), 'resolved the conflict');
  });

  test('a message starting with a dash is committed verbatim', async () => {
    const repo = await initCommittedRepo();
    writeFileIn(repo, 'file.txt', 'changed\n');
    const result = await commit(repo, '--not-an-option just a message', { all: true });
    assert.equal(result.ok, true);
    assert.equal(await commitSubject(repo), '--not-an-option just a message');
  });

  test('a named path that does not exist fails before creating a commit', async () => {
    const repo = await initCommittedRepo();
    const before = await headSha(repo);
    const result = await commit(repo, 'nothing', { paths: ['no-such-file.txt'] });
    assert.equal(result.ok, false);
    assert.match(result.error, /did not match any files/);
    assert.equal(await headSha(repo), before);
  });

  test('outside a repository the commit is a failure, not a throw', async () => {
    const result = await commit(tempDir(), 'message');
    assert.equal(result.ok, false);
    assert.match(result.error, /not a git repository/);
  });

  test('the paths a commit swept in match what changedPaths() reported', async () => {
    const repo = await initCommittedRepo();
    writeFileIn(repo, 'one.txt', '1\n');
    writeFileIn(repo, 'dir with space/two.txt', '2\n');
    writeFileIn(repo, 'file.txt', 'changed\n');
    const dirty = await changedPaths(repo);
    const result = await commit(repo, 'sweep the reported paths', { all: true });
    assert.equal(result.ok, true);
    assert.deepEqual([...await commitPaths(repo)].sort(), [...dirty].sort());
  });
});