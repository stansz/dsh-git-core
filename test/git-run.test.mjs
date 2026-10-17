/**
 * lib/git.mjs — the single git door, availability probing, authentication
 * hints, and the repository-identity helpers.
 *
 * Everything runs against real git: temp repositories are arranged with raw
 * subprocesses and the exported functions are then asked for their answers.
 */

import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

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
  refExists,
  stagedPaths,
  tempDir,
  writeFileIn,
} from './helpers.mjs';

import {
  commonDir,
  credentialHint,
  currentBranch,
  explainCredentialFailure,
  gitAvailable,
  hasHead,
  isRepo,
  mergeBase,
  remoteUrlFor,
  resolveGit,
  revParse,
  run,
  toplevel,
  upstreamRef,
} from '../lib/git.mjs';

after(cleanupTempDirs);

describe('availability', () => {
  test('gitAvailable() is true on a machine with git, and resolveGit() agrees', async () => {
    // The rest of this suite needs git; a failure here explains every other one.
    assert.equal(gitAvailable(), true);
    const resolved = await resolveGit();
    assert.equal(resolved.ok, true);
    assert.equal(gitAvailable(), resolved.ok);
    assert.match(resolved.version, /^\d+\.\d+/);
  });

  test('resolveGit() reports an absolute executable path that exists', async () => {
    const resolved = await resolveGit();
    assert.equal(typeof resolved.path, 'string');
    assert.equal(resolved.path.startsWith('/'), true);
    assert.equal(existsSync(resolved.path), true);
  });

  test('resolveGit() returns a fresh copy, so a caller cannot corrupt the memoized probe', async () => {
    const first = await resolveGit();
    first.ok = false;
    first.version = 'not-a-version';
    const second = await resolveGit();
    assert.equal(second.ok, true);
    assert.match(second.version, /^\d+\.\d+/);
    assert.equal(gitAvailable(), true);
  });
});

describe('run()', () => {
  test('runs a real git command and returns its stdout', async () => {
    const result = await run(tempDir(), ['--version']);
    assert.equal(result.ok, true);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /^git version \d+/);
    assert.equal(result.stderr, '');
  });

  test('a non-zero exit is an ordinary result carrying git\'s own code', async () => {
    const repo = await initCommittedRepo();
    const result = await run(repo, ['rev-parse', '-q', '--verify', 'no-such-ref']);
    assert.equal(result.ok, false);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    // git wrote nothing to stderr, so the module names the exit status.
    assert.equal(result.error, 'git rev-parse exited with status 1');
  });

  test('allowFailure suppresses error text but keeps the failure and the code', async () => {
    const repo = await initCommittedRepo();
    const result = await run(repo, ['rev-parse', '-q', '--verify', 'no-such-ref'], { allowFailure: true });
    assert.equal(result.ok, false);
    assert.equal(result.code, 1);
    assert.equal('error' in result, false);
  });

  test('a command that writes to stderr surfaces that text as the error', async () => {
    const plain = tempDir();
    const result = await run(plain, ['status']);
    assert.equal(result.ok, false);
    assert.match(result.error, /not a git repository/);
  });

  test('an empty argv is refused before git is spawned', async () => {
    const result = await run(tempDir(), []);
    assert.equal(result.ok, false);
    assert.equal(result.code, null);
    assert.equal(result.error, 'run() was called with no git arguments');
  });

  test('a hung git is killed at the deadline and reported as timedOut', async () => {
    const repo = await initCommittedRepo();
    // hash-object --stdin blocks forever: execFile gives the child a stdin pipe
    // that is never written to or closed.
    const result = await run(repo, ['hash-object', '--stdin'], { timeoutMs: 50 });
    assert.equal(result.ok, false);
    assert.equal(result.timedOut, true);
    assert.equal(result.code, null);
    assert.match(result.error, /timed out after 50ms/);
  });

  test('a signal that fires mid-flight is reported as aborted', async () => {
    const repo = await initCommittedRepo();
    const controller = new AbortController();
    const pending = run(repo, ['hash-object', '--stdin'], { signal: controller.signal });
    setTimeout(() => controller.abort(), 25);
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.code, null);
    assert.equal(result.error, 'aborted');
  });

  test('an already-aborted signal is reported as aborted', async () => {
    const result = await run(tempDir(), ['status'], { signal: AbortSignal.abort() });
    assert.equal(result.ok, false);
    assert.equal(result.code, null);
    assert.equal(result.error, 'aborted');
  });

  test('a missing working directory is a returned failure, not a throw', async () => {
    const result = await run(join(tempDir(), 'does-not-exist'), ['status']);
    assert.equal(result.ok, false);
    // git never ran, so there is no exit code to report.
    assert.equal(result.code, null);
    assert.equal(typeof result.error, 'string');
  });

  test('no shell is involved: metacharacters in an argument stay one literal argument', async () => {
    const repo = await initCommittedRepo();
    const hostile = 'a b; touch pwned # `echo pwned` $(echo pwned)';
    const set = await run(repo, ['config', 'probe.hostile', hostile]);
    assert.equal(set.ok, true);
    const got = await run(repo, ['config', '--get', 'probe.hostile']);
    assert.equal(got.ok, true);
    assert.equal(got.stdout.trim(), hostile);
    // The marker file a shell would have created is absent.
    assert.equal(existsSync(join(repo, 'pwned')), false);
  });

  test('a filename with spaces and metacharacters is staged as one pathspec', async () => {
    const repo = await initCommittedRepo();
    writeFileIn(repo, 'with space; echo.txt', 'x\n');
    const added = await run(repo, ['add', '--', 'with space; echo.txt']);
    assert.equal(added.ok, true);
    assert.deepEqual(await stagedPaths(repo), ['with space; echo.txt']);
  });

  test('the child environment is process.env plus the caller\'s env, not a clean slate', async () => {
    const repo = await initCommittedRepo();
    const result = await run(repo, ['config', '--get', 'probe.child'], {
      env: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'probe.child', GIT_CONFIG_VALUE_0: 'from-child-env' },
    });
    assert.equal(result.ok, true);
    assert.equal(result.stdout.trim(), 'from-child-env');
    // PATH and HOME survived: git itself was found and the repo-local config read.
    const identity = await run(repo, ['config', '--get', 'user.email']);
    assert.equal(identity.ok, true);
    assert.equal(identity.stdout.trim(), 'tests@example.invalid');
  });

  test('maxBuffer truncates the returned text and reports truncated', async () => {
    const repo = await initCommittedRepo();
    const result = await run(repo, ['config', '--get', 'user.email'], { maxBuffer: 8 });
    assert.equal(result.ok, true);
    assert.equal(result.truncated, true);
    assert.equal(result.stdout, 'tests@ex');
  });

  test('a very long failure message is clipped to a size a tool result can carry', async () => {
    const repo = await initCommittedRepo();
    // git checkout reports every unmatched pathspec, so 400 of them produce a
    // message far longer than the clip a tool result can carry.
    const names = Array.from({ length: 400 }, (_, index) => 'missing-' + index + '-xyz');
    const result = await run(repo, ['checkout', '--', ...names]);
    assert.equal(result.ok, false);
    assert.equal(result.stderr.length > 10_000, true);
    assert.equal(result.error.length <= 2000 + '… (truncated)'.length, true);
    assert.match(result.error, /truncated/);
  });

  test('an empty repoDir falls back to the process working directory', async () => {
    const result = await run('', ['--version']);
    assert.equal(result.ok, true);
    assert.match(result.stdout, /^git version/);
  });
});

describe('authentication hints', () => {
  // The messages are git's own, quoted from real pushes; matched in prose
  // because prose is all git leaves behind.
  const credentialFailures = [
    "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    'remote: Invalid username or token. Password authentication is not supported for Git operations.',
    "fatal: Authentication failed for 'https://github.com/stansz/example'",
    'git@github.com: Permission denied (publickey).',
    'FATAL: AUTHENTICATION FAILED',
  ];

  for (const message of credentialFailures) {
    test('credentialHint names a fix for: ' + message.slice(0, 48) + '…', () => {
      const hint = credentialHint(message);
      assert.equal(typeof hint, 'string');
      assert.match(hint, /SSH remote/);
      assert.match(hint, /credential helper/);
    });
  }

  test('credentialHint stays quiet for failures that are not about credentials', () => {
    const notCredential = [
      "fatal: unable to access 'https://github.com/x': Could not resolve host: github.com",
      'fatal: destination path already exists',
      'error: failed to push some refs to /tmp/remote.git',
      '',
    ];
    for (const message of notCredential) assert.equal(credentialHint(message), undefined);
  });

  test('credentialHint accepts only strings', () => {
    for (const value of [undefined, null, 42, {}, ['fatal: Authentication failed']]) {
      assert.equal(credentialHint(value), undefined);
    }
  });

  test('explainCredentialFailure appends the hint to a credential failure', () => {
    const message = "fatal: could not read Username for 'https://example.invalid'";
    const explained = explainCredentialFailure(message);
    assert.equal(explained.startsWith(message + ' — '), true);
    assert.match(explained, /credential helper/);
  });

  test('explainCredentialFailure leaves other messages exactly as they were', () => {
    for (const message of ['fatal: no upstream configured', '', 'plain failure']) {
      assert.equal(explainCredentialFailure(message), message);
    }
  });

  test('explainCredentialFailure stringifies non-strings the way the module documents', () => {
    assert.equal(explainCredentialFailure(undefined), '');
    assert.equal(explainCredentialFailure(null), '');
    assert.equal(explainCredentialFailure(42), '42');
  });
});

describe('repository identity', () => {
  test('toplevel() answers with the realpath of the repository root from the root, a subdirectory, and a file', async () => {
    const repo = await initCommittedRepo();
    writeFileIn(repo, 'sub/dir/file.txt', 'x\n');
    await commitAll(repo, 'subdirectory');
    assert.equal(await toplevel(repo), repo);
    assert.equal(await toplevel(join(repo, 'sub')), repo);
    assert.equal(await toplevel(join(repo, 'sub/dir')), repo);
    // A FILE path resolves to the repository containing it — the case a caller
    // holding a changed-paths list actually has.
    assert.equal(await toplevel(join(repo, 'sub/dir/file.txt')), repo);
    // A file deleted during the turn still belongs to the repository around it.
    assert.equal(await toplevel(join(repo, 'sub/dir/deleted.txt')), repo);
    // A file being CREATED in a directory that does not exist yet: the recorder
    // resolves the path before the write runs, so every level below the root is
    // absent. It still belongs to the repository, or the write is never recorded
    // and the automatic commit reports the session did no work there.
    assert.equal(await toplevel(join(repo, 'brand/new/dir/file.txt')), repo);
    assert.equal(await toplevel(join(repo, 'brand/new')), repo);
  });

  test('toplevel() is undefined outside a working tree, including a bare repository', async () => {
    assert.equal(await toplevel(tempDir()), undefined);
    const bare = await initBareRepo();
    assert.equal(await toplevel(bare), undefined);
  });

  test('commonDir() is the shared .git from a subdirectory and from a linked worktree', async () => {
    const repo = await initCommittedRepo();
    writeFileIn(repo, 'nested/file.txt', 'x\n');
    await commitAll(repo, 'nested');
    const expected = join(repo, '.git');
    assert.equal(await commonDir(repo), expected);
    assert.equal(await commonDir(join(repo, 'nested')), expected);
    const worktree = join(tempDir(), 'linked');
    await gitOk(repo, ['worktree', 'add', '-q', '-b', 'linked-branch', worktree]);
    // A linked worktree's own gitdir holds its HEAD; the common dir is the main one.
    assert.equal(await commonDir(worktree), expected);
  });

  test('commonDir() is undefined outside a repository', async () => {
    assert.equal(await commonDir(tempDir()), undefined);
  });

  test('isRepo() distinguishes repositories, bare repositories and plain directories', async () => {
    const repo = await initRepo();
    assert.equal(await isRepo(repo), true);
    assert.equal(await isRepo(await initBareRepo()), true);
    assert.equal(await isRepo(tempDir()), false);
  });

  test('currentBranch() reports the checked-out branch, including an unborn one', async () => {
    const repo = await initRepo({ branch: 'topic' });
    assert.equal(await currentBranch(repo), 'topic');
    await commitAll(repo, 'first', { 'a.txt': 'a\n' });
    assert.equal(await currentBranch(repo), 'topic');
    await gitOk(repo, ['checkout', '-q', '-b', 'feature']);
    assert.equal(await currentBranch(repo), 'feature');
  });

  test('currentBranch() is undefined for a detached HEAD and outside a repository', async () => {
    const repo = await initCommittedRepo();
    await gitOk(repo, ['checkout', '-q', '--detach']);
    assert.equal(await currentBranch(repo), undefined);
    assert.equal(await currentBranch(tempDir()), undefined);
  });

  test('hasHead() is true once a commit exists and falsey for an unborn branch', async () => {
    const repo = await initRepo({ branch: 'main' });
    // An unborn branch has a NAME but no commit; callers must not treat it as
    // having something to protect or cut a worktree from.
    assert.equal(Boolean(await hasHead(repo)), false);
    await commitAll(repo, 'first', { 'a.txt': 'a\n' });
    assert.equal(await hasHead(repo), true);
  });
});

describe('ref plumbing helpers', () => {
  test('revParse() resolves refs to full object ids, and short-circuits unknown or option-like refs', async () => {
    const repo = await initCommittedRepo();
    const head = await headSha(repo);
    assert.equal(await revParse(repo, 'HEAD'), head);
    assert.equal(await revParse(repo, 'main'), head);
    assert.match(head, /^[0-9a-f]{40}$/);
    assert.equal(await revParse(repo, 'no-such-ref'), undefined);
    assert.equal(await revParse(repo, '--all'), undefined);
    assert.equal(await revParse(repo, ''), undefined);
  });

  test('upstreamRef() reports a tracking branch as origin/branch and nothing for an untracked branch', async () => {
    const remote = await initBareRepo();
    const repo = await cloneRepo(remote);
    await commitAll(repo, 'first', { 'a.txt': 'a\n' });
    await gitOk(repo, ['push', '-q', '-u', 'origin', 'main']);
    assert.equal(await upstreamRef(repo, 'main'), 'origin/main');
    await gitOk(repo, ['checkout', '-q', '-b', 'untracked-branch']);
    assert.equal(await upstreamRef(repo, 'untracked-branch'), undefined);
    assert.equal(await upstreamRef(repo, ''), undefined);
  });

  test('remoteUrlFor() returns the configured URL, or undefined when there is none', async () => {
    const remote = await initBareRepo();
    const repo = await initCommittedRepo();
    await gitOk(repo, ['remote', 'add', 'origin', remote]);
    assert.equal(await remoteUrlFor(repo, 'origin'), remote);
    assert.equal(await remoteUrlFor(repo, 'no-such-remote'), undefined);
    assert.equal(await remoteUrlFor(repo, ''), undefined);
    assert.equal(await remoteUrlFor(repo, '--upload-pack=evil'), undefined);
    assert.equal(await remoteUrlFor(repo, undefined), undefined);
    // A remote name is a config-key component, so a name that is not one is refused.
    assert.equal(await remoteUrlFor(repo, 'bad name; rm -rf /'), undefined);
    // A remote configured with no URL answers undefined, not a bare name.
    await gitOk(repo, ['config', 'remote.urlless.url', '']);
    assert.equal(await remoteUrlFor(repo, 'urlless'), undefined);
  });

  test('remoteUrlFor() reports the configured identity, not the url.*.insteadOf mirror git would travel to', async () => {
    // A machine can redirect a GitHub URL through a mirror. That changes where
    // git goes, not which repository this is: the plugin matches the GitHub URL
    // and an API host, so the mirror must not leak out as the remote identity.
    const repo = await initCommittedRepo();
    const github = 'https://github.com/stansz/example.git';
    const mirror = 'file:///private/tmp/example-mirror/';
    await gitOk(repo, ['remote', 'add', 'origin', github]);
    await gitOk(repo, ['config', 'url.' + mirror + '.insteadOf', github]);
    // The trap is real: git its own transport naming answers with the mirror.
    assert.equal((await gitOk(repo, ['remote', 'get-url', 'origin'])).trim(), mirror);
    assert.equal(await remoteUrlFor(repo, 'origin'), github);
  });

  test('remoteUrlFor() names the fetch URL when a remote has several', async () => {
    const fetchRemote = await initBareRepo();
    const pushRemote = await initBareRepo();
    const repo = await initCommittedRepo();
    await gitOk(repo, ['remote', 'add', 'origin', fetchRemote]);
    await gitOk(repo, ['remote', 'set-url', '--add', '--push', 'origin', pushRemote]);
    assert.equal(await remoteUrlFor(repo, 'origin'), fetchRemote);
  });

  test('mergeBase() is the shared commit, and undefined for unrelated histories', async () => {
    const repo = await initCommittedRepo();
    const base = await headSha(repo);
    await gitOk(repo, ['checkout', '-q', '-b', 'feature']);
    await commitAll(repo, 'feature work', { 'feature.txt': 'f\n' });
    await gitOk(repo, ['checkout', '-q', 'main']);
    await commitAll(repo, 'main work', { 'main.txt': 'm\n' });
    assert.equal(await mergeBase(repo, 'main', 'feature'), base);
    assert.equal(await mergeBase(repo, 'main', 'no-such-ref'), undefined);
    assert.equal(await mergeBase(repo, 'main', '-x'), undefined);
    // An orphan branch shares no ancestor with main.
    await gitOk(repo, ['checkout', '-q', '--orphan', 'orphan']);
    await gitOk(repo, ['rm', '-rf', '-q', '.']);
    await commitAll(repo, 'orphan root', { 'orphan.txt': 'o\n' });
    assert.equal(await mergeBase(repo, 'main', 'orphan'), undefined);
  });

  test('a ref that was never fetched does not resolve', async () => {
    const repo = await initCommittedRepo();
    assert.equal(await refExists(repo, 'refs/remotes/origin/main'), false);
  });
});