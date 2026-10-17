/**
 * lib/git.mjs — configuration, remotes and tags.
 *
 * These are the read/write helpers the bundles use to keep a repository's
 * identity (remote URLs, config values) and its releases (tags) in order.
 * Global-scope config writes are isolated to a temp file through the child
 * environment, so no test can touch the machine's real gitconfig.
 */

import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  cleanupTempDirs,
  commitAll,
  git,
  gitOk,
  headSha,
  initBareRepo,
  initCommittedRepo,
  tempDir,
} from './helpers.mjs';

import {
  configGet,
  configList,
  configSet,
  configUnset,
  pushRef,
  remoteAdd,
  remoteList,
  remoteRemove,
  remoteSetUrl,
  remoteUrlFor,
  remotes,
  tagCreate,
  tagDelete,
  tagList,
} from '../lib/git.mjs';

after(cleanupTempDirs);

/** An env that points git's global/system config at throwaway files. */
function isolatedGlobalConfig() {
  return {
    GIT_CONFIG_GLOBAL: join(tempDir('dsh-git-core-global-'), 'gitconfig'),
    GIT_CONFIG_SYSTEM: '/dev/null',
  };
}

describe('config helpers', () => {
  test('set/get/list/unset one local value round-trips', async () => {
    const repo = await initCommittedRepo();
    assert.deepEqual(await configSet(repo, 'probe.value', 'hello world'), { ok: true });
    assert.deepEqual(await configGet(repo, 'probe.value'), { ok: true, value: 'hello world' });

    const listed = await configList(repo, { env: isolatedGlobalConfig() });
    assert.equal(listed.ok, true);
    assert.deepEqual(listed.entries.find((entry) => entry.key === 'probe.value'), {
      key: 'probe.value', value: 'hello world',
    });
    // The repository-local deterministic config is visible through the same read.
    assert.deepEqual(listed.entries.find((entry) => entry.key === 'user.email'), {
      key: 'user.email', value: 'tests@example.invalid',
    });

    assert.deepEqual(await configUnset(repo, 'probe.value'), { ok: true });
    const gone = await configGet(repo, 'probe.value');
    assert.equal(gone.ok, false);
    assert.equal(gone.error, 'not set');
  });

  test('unsetting a key that is not set is a reported failure', async () => {
    const repo = await initCommittedRepo();
    const result = await configUnset(repo, 'probe.never-set');
    assert.equal(result.ok, false);
    assert.match(result.error, /could not unset/);
  });

  test('an empty key is refused by every config helper', async () => {
    const repo = await initCommittedRepo();
    assert.match((await configGet(repo, '')).error, /no config key/);
    assert.match((await configSet(repo, '', 'x')).error, /no config key/);
    assert.match((await configUnset(repo, '')).error, /no config key/);
  });

  test('global scope writes to the configured global file, not the repository', async () => {
    const repo = await initCommittedRepo();
    const env = isolatedGlobalConfig();
    assert.deepEqual(await configSet(repo, 'probe.global', 'yes', { global: true, env }), { ok: true });
    assert.deepEqual(await configGet(repo, 'probe.global', { global: true, env }), { ok: true, value: 'yes' });
    // It really landed in the isolated file, and nowhere in the repository.
    assert.match(readFileSync(env.GIT_CONFIG_GLOBAL, 'utf8'), /probe\.global = yes|\[probe]/);
    assert.equal((await configGet(repo, 'probe.global')).ok, false);
  });

  test('configList reports the failure of an unreadable repository instead of throwing', async () => {
    const result = await configList(join(tempDir(), 'does-not-exist'));
    assert.equal(result.ok, false);
    assert.deepEqual(result.entries, []);
  });
});

describe('remote helpers', () => {
  test('a repository with no remotes answers with empty lists', async () => {
    const repo = await initCommittedRepo();
    assert.deepEqual(await remotes(repo), []);
    assert.deepEqual(await remoteList(repo), { ok: true, entries: [] });
  });

  test('add/list/set-url/remove round-trips a remote', async () => {
    const repo = await initCommittedRepo();
    const first = await initBareRepo();
    const second = await initBareRepo();
    assert.deepEqual(await remoteAdd(repo, 'origin', first), { ok: true });
    assert.deepEqual(await remotes(repo), [{ name: 'origin', url: first }]);
    assert.deepEqual(await remoteList(repo), { ok: true, entries: [{ name: 'origin', url: first }] });
    assert.equal(await remoteUrlFor(repo, 'origin'), first);

    assert.deepEqual(await remoteSetUrl(repo, 'origin', second), { ok: true });
    assert.deepEqual(await remotes(repo), [{ name: 'origin', url: second }]);

    assert.deepEqual(await remoteRemove(repo, 'origin'), { ok: true });
    assert.deepEqual(await remotes(repo), []);
  });

  test('several remotes are listed in git\'s order with their URLs', async () => {
    const repo = await initCommittedRepo();
    const originRemote = await initBareRepo();
    const upstreamRemote = await initBareRepo();
    await remoteAdd(repo, 'upstream', upstreamRemote);
    await remoteAdd(repo, 'origin', originRemote);
    const names = (await remoteList(repo)).entries.map((entry) => entry.name);
    assert.deepEqual(names, ['origin', 'upstream']);
    assert.deepEqual((await remotes(repo)).map((entry) => entry.name), names);
  });

  test('a remote configured with no URL is still listed, and its URL is undefined', async () => {
    const repo = await initCommittedRepo();
    await gitOk(repo, ['config', 'remote.urlless.url', '']);
    // The fix for "no remote" and "a remote with no URL" differs, so a remote
    // that exists must not silently vanish from the list.
    assert.equal((await remotes(repo)).some((entry) => entry.name === 'urlless'), true);
    assert.equal((await remoteList(repo)).entries.some((entry) => entry.name === 'urlless'), true);
    assert.equal(await remoteUrlFor(repo, 'urlless'), undefined);
  });

  test('invalid remote arguments are refused before git runs', async () => {
    const repo = await initCommittedRepo();
    const url = (await initBareRepo());
    for (const result of [
      await remoteAdd(repo, '', url),
      await remoteAdd(repo, '-x', url),
      await remoteAdd(repo, 'origin', '-x'),
      await remoteSetUrl(repo, '', url),
      await remoteRemove(repo, ''),
    ]) {
      assert.equal(result.ok, false);
      assert.match(result.error, /remote/);
    }
    const unknown = await remoteRemove(repo, 'never-added');
    assert.equal(unknown.ok, false);
    assert.match(unknown.error, /remote/i);
  });
});

describe('tag helpers', () => {
  test('a repository with no tags answers with an empty list', async () => {
    assert.deepEqual(await tagList(await initCommittedRepo()), { ok: true, tags: [] });
  });

  test('creates a lightweight tag, and a tag at an older commit', async () => {
    const repo = await initCommittedRepo();
    const first = await headSha(repo);
    await commitAll(repo, 'second', { 'second.txt': '2\n' });
    assert.deepEqual(await tagCreate(repo, 'v1-light'), { ok: true });
    assert.deepEqual((await tagList(repo)).tags, ['v1-light']);
    assert.equal((await gitOk(repo, ['cat-file', '-t', 'v1-light'])).trim(), 'commit');
    assert.equal((await gitOk(repo, ['rev-parse', 'v1-light^{}'])).trim(), await headSha(repo));

    assert.deepEqual(await tagCreate(repo, 'v0-old', { at: first }), { ok: true });
    assert.equal((await gitOk(repo, ['rev-parse', 'v0-old^{}'])).trim(), first);
  });

  test('creates an annotated tag when a message is given', async () => {
    const repo = await initCommittedRepo();
    assert.deepEqual(await tagCreate(repo, 'v2-release', { message: 'release two' }), { ok: true });
    assert.equal((await gitOk(repo, ['cat-file', '-t', 'v2-release'])).trim(), 'tag');
    const message = await gitOk(repo, ['tag', '-n99', '--list', 'v2-release']);
    assert.match(message, /release two/);
  });

  test('a duplicate tag name is a reported failure', async () => {
    const repo = await initCommittedRepo();
    await tagCreate(repo, 'v1');
    const duplicate = await tagCreate(repo, 'v1');
    assert.equal(duplicate.ok, false);
    assert.match(duplicate.error, /tag/i);
  });

  test('deletes a local tag; deleting an unknown one fails', async () => {
    const repo = await initCommittedRepo();
    await tagCreate(repo, 'v1');
    assert.deepEqual(await tagDelete(repo, 'v1'), { ok: true });
    assert.deepEqual((await tagList(repo)).tags, []);
    const unknown = await tagDelete(repo, 'v1');
    assert.equal(unknown.ok, false);
  });

  test('rejects empty and option-like tag names before git runs', async () => {
    const repo = await initCommittedRepo();
    for (const name of ['', '  ', '-x', undefined]) {
      const created = await tagCreate(repo, name);
      assert.equal(created.ok, false);
      assert.match(created.error, /no tag name/);
      const deleted = await tagDelete(repo, name);
      assert.equal(deleted.ok, false);
      assert.match(deleted.error, /no tag name/);
    }
  });

  test('tagList outside a repository is a reported failure with an empty list', async () => {
    const result = await tagList(tempDir());
    assert.equal(result.ok, false);
    assert.deepEqual(result.tags, []);
    assert.match(result.error, /tag/i);
  });
});

describe('pushRef()', () => {
  test('publishes a tag to a remote and deletes it there with the :refs syntax', async () => {
    const remote = await initBareRepo();
    const repo = await initCommittedRepo();
    await gitOk(repo, ['remote', 'add', 'origin', remote]);
    await commitAll(repo, 'release', { 'release.txt': 'r\n' });
    await tagCreate(repo, 'v1.0.0', { message: 'first release' });
    const tagSha = (await gitOk(repo, ['rev-parse', 'v1.0.0'])).trim();

    assert.deepEqual(await pushRef(repo, 'origin', 'refs/tags/v1.0.0'), { ok: true });
    assert.equal((await gitOk(remote, ['rev-parse', '-q', '--verify', 'refs/tags/v1.0.0'])).trim(), tagSha);

    assert.deepEqual(await pushRef(repo, 'origin', ':refs/tags/v1.0.0'), { ok: true });
    assert.equal(existsSync(join(remote, 'refs/tags/v1.0.0')), false);
    const gone = await git(remote, ['rev-parse', '-q', '--verify', 'refs/tags/v1.0.0']);
    assert.equal(gone.ok, false);
  });

  test('invalid refspecs and unknown remotes are reported failures', async () => {
    const repo = await initCommittedRepo();
    for (const result of [
      await pushRef(repo, '', 'refs/tags/v1'),
      await pushRef(repo, 'origin', ''),
      await pushRef(repo, '-x', 'refs/tags/v1'),
      await pushRef(repo, 'origin', '-x'),
    ]) {
      assert.equal(result.ok, false);
      assert.match(result.error, /a ref push needs a remote and a ref/);
    }
    await tagCreate(repo, 'v1');
    const noRemote = await pushRef(repo, 'no-such-remote', 'refs/tags/v1');
    assert.equal(noRemote.ok, false);
    assert.match(noRemote.error, /does not appear to be a git repository|No such remote/);
  });
});