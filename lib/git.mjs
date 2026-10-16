/**
 * dsh-git — the one place a git command is run.
 *
 * Every git call in this bundle goes through `run`, for two reasons that are
 * easy to get wrong one call at a time.
 *
 * The first is the environment. A tool that builds its own env from scratch
 * breaks authentication: this machine's credential helper (`osxkeychain`) is
 * configured in the system gitconfig, and git finds the system config through
 * the normal lookup — HOME and PATH must survive into the child. So the child
 * env is `process.env`, never a clean slate, with only prompt suppression
 * added. Setting GIT_CONFIG_NOSYSTEM or GIT_CONFIG_GLOBAL to "isolate" a call
 * is the trap this module exists to prevent: it silently disables the machine's
 * identity and its credential helper, and pushes start failing with an
 * authentication error that looks like a network problem.
 *
 * The second is output shape. `status --porcelain=v2 -z` and `worktree list
 * --porcelain` are the machine-readable forms, and both have a detail that
 * produces a wrong answer rather than an error if it is missed: `-z` output is
 * never C-quoted, so a filename with a space, a newline, or a backslash arrives
 * verbatim inside a NUL-delimited record; and `worktree list` reports realpaths,
 * so on macOS a `/tmp/...` path comes back as `/private/tmp/...` and a naive
 * `===` against the caller's path is false for the worktree that is right there.
 *
 * Defence in depth: no shell is ever involved (argv only), a git that is not
 * installed is a returned error rather than a thrown exception, and a hung git
 * is killed and reported as `timedOut` rather than hanging the agent.
 *
 * Only `node:` builtins are imported: a bundle that shells out to git must not
 * itself depend on the thing it is inspecting.
 */

import { execFile, execFileSync } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';

/** Default cap on returned output, in characters, per stream. */
const DEFAULT_MAX_BUFFER = 1024 * 1024;
/** Default kill deadline for one git call. Generous: a fetch on a slow link is normal. */
const DEFAULT_TIMEOUT_MS = 120000;
/** A longer deadline for the calls that talk to a remote. */
const NETWORK_TIMEOUT_MS = 300000;
/** The availability probe must never be the thing that makes the tool feel hung. */
const PROBE_TIMEOUT_MS = 5000;
/** How much stderr is quoted back in an `error` string. */
const ERROR_CLIP = 2000;

let gitProbe;

/**
 * Whether a usable git is on PATH, probed once per process.
 *
 * A machine without git is a supported state, not a failure: callers report it
 * and stop, instead of reporting every repository as broken. Memoized on
 * purpose — the probe is a process spawn, and this module's only module-level
 * state.
 */
export function gitAvailable() {
  return probeGit().ok;
}

/**
 * Where git is, whether it runs, and which version it is.
 *
 * @returns {Promise<{ok: boolean, path?: string, version?: string, error?: string}>}
 *   `ok:false` plus `error` when git cannot be spawned; the probe answers the
 *   same way through `gitAvailable`, so the two never disagree.
 */
export async function resolveGit() {
  return { ...probeGit() };
}

/** The memoized probe behind both `gitAvailable` and `resolveGit`. */
function probeGit() {
  if (gitProbe === undefined) {
    try {
      const raw = execFileSync('git', ['--version'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: PROBE_TIMEOUT_MS,
        windowsHide: true,
      });
      const text = String(raw).trim();
      const match = /(\d+(?:\.\d+)+)/.exec(text);
      gitProbe = { ok: true, path: locateGit(), version: match === null ? text : match[1] };
    } catch (error) {
      gitProbe = { ok: false, error: describeSpawnError(error) };
    }
  }
  return gitProbe;
}

/**
 * The git executable's absolute path, from PATH.
 *
 * `git --version` proves git runs but not where it lives, and a resolved path
 * is what lets a report say "the git you are using is the Command Line Tools
 * one". Returns undefined when PATH is unusable; that is not an error, because
 * the version probe already succeeded through PATH lookup.
 */
function locateGit() {
  try {
    const path = process.env.PATH;
    if (typeof path !== 'string' || path === '') return undefined;
    const names = process.platform === 'win32' ? ['git.exe', 'git.cmd', 'git.bat'] : ['git'];
    for (const dir of path.split(delimiter)) {
      if (dir === '') continue;
      for (const name of names) {
        const candidate = join(dir, name);
        if (existsSync(candidate)) return candidate;
      }
    }
  } catch {
    // A malformed PATH is not worth failing the probe over.
  }
  return undefined;
}

/**
 * Run one git command in a directory.
 *
 * Never throws and never uses a shell: `args` goes to `execFile` as argv, so a
 * path with a space, a quote, or a `;` is one argument and cannot become a
 * command. A non-zero exit is a normal result (`ok:false`) — `git rev-parse -q
 * --verify` is *supposed* to exit 1 — and the caller decides whether that
 * matters.
 *
 * The child env is explicit and additive: `process.env` plus prompt suppression
 * plus a C locale for parseable messages. HOME and PATH are deliberately left
 * alone so the system gitconfig, the machine's user identity, and
 * `credential.helper = osxkeychain` keep working. GIT_CONFIG_NOSYSTEM and
 * GIT_CONFIG_GLOBAL are never set: they would disable exactly those.
 *
 * @param {string} repoDir - working directory for the command.
 * @param {string[]} args - argv after the program name, e.g. `['status', '-s']`.
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal] - aborts the child; reported as `error: 'aborted'`.
 * @param {number} [opts.timeoutMs] - kill deadline; reported as `timedOut: true`.
 * @param {object} [opts.env] - extra environment, merged over the defaults.
 * @param {number} [opts.maxBuffer] - cap per stream, in characters, default 1 MiB.
 * @param {boolean} [opts.allowFailure] - suppress `error` for a non-zero exit.
 * @returns {Promise<{ok: boolean, code: number|null, stdout: string, stderr: string,
 *   error?: string, timedOut?: boolean, truncated?: boolean}>}
 *   `code` is null when git never ran or died from a signal; `truncated` is
 *   present only when output was cut at `maxBuffer`.
 */
export async function run(repoDir, args, opts = {}) {
  const argv = Array.isArray(args) ? args.map((value) => String(value)) : [];
  const options = opts !== null && typeof opts === 'object' ? opts : {};
  const cwd = typeof repoDir === 'string' && repoDir !== '' ? repoDir : process.cwd();
  const buffered = Number.isFinite(options.maxBuffer) && options.maxBuffer > 0
    ? Math.floor(options.maxBuffer)
    : DEFAULT_MAX_BUFFER;
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? Math.floor(options.timeoutMs)
    : DEFAULT_TIMEOUT_MS;
  const signal = options.signal;
  const allowFailure = options.allowFailure === true;

  if (argv.length === 0) {
    return { ok: false, code: null, stdout: '', stderr: '', error: 'run() was called with no git arguments' };
  }
  if (signal !== undefined && signal !== null && signal.aborted === true) {
    return { ok: false, code: null, stdout: '', stderr: '', error: 'aborted' };
  }

  return await new Promise((settle) => {
    let timerFired = false;
    let timer;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timerFired = true;
      }, timeoutMs);
    }

    try {
      // The execFile ceiling is deliberately larger than the reported cap: the
      // caller asked for truncated output, not for the child to be killed the
      // moment it says more than it needs to.
      execFile('git', argv, {
        cwd,
        env: childEnv(options.env),
        encoding: 'buffer',
        maxBuffer: buffered * 4,
        timeout: timeoutMs,
        killSignal: 'SIGTERM',
        windowsHide: true,
        ...(signal === undefined || signal === null ? {} : { signal }),
      }, (error, stdoutRaw, stderrRaw) => {
        clearTimeout(timer);
        const stdout = decode(stdoutRaw);
        const stderr = decode(stderrRaw);
        const aborted = signal !== undefined && signal !== null && signal.aborted === true;
        const timedOut = error !== undefined && error !== null && !aborted && timerFired;
        const code = error === undefined || error === null
          ? 0
          : typeof error.code === 'number' ? error.code : null;

        let errorText;
        if (error === undefined || error === null) {
          errorText = undefined;
        } else if (aborted) {
          errorText = 'aborted';
        } else if (timedOut) {
          errorText = 'git ' + argv[0] + ' timed out after ' + timeoutMs + 'ms';
        } else if (code !== null) {
          errorText = allowFailure
            ? undefined
            : stderr.trim() === ''
              ? 'git ' + argv[0] + ' exited with status ' + code
              : clip(stderr.trim());
        } else if (typeof error.signal === 'string' && error.signal !== '') {
          errorText = 'git ' + argv[0] + ' was killed by ' + error.signal;
        } else {
          errorText = describeSpawnError(error);
        }

        const outTrimmed = truncate(stdout, buffered);
        const errTrimmed = truncate(stderr, buffered);
        const result = {
          ok: error === undefined || error === null,
          code,
          stdout: outTrimmed.text,
          stderr: errTrimmed.text,
        };
        if (errorText !== undefined) result.error = errorText;
        if (timedOut) result.timedOut = true;
        if (outTrimmed.truncated || errTrimmed.truncated) result.truncated = true;
        settle(result);
      });
    } catch (error) {
      clearTimeout(timer);
      settle({
        ok: false,
        code: null,
        stdout: '',
        stderr: '',
        error: describeSpawnError(error),
      });
      return;
    }
  });
}

/**
 * The child environment for one git call.
 *
 * `process.env` first, always: HOME carries the user's gitconfig and PATH
 * carries the git itself, and both are what make the machine's credential
 * helper reachable. The four additions only stop git from ever *asking* a
 * question — which in an agent has no answer and would hang the call.
 */
function childEnv(extra) {
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    GIT_OPTIONAL_LOCKS: '0',
    LC_ALL: 'C',
  };
  if (extra !== null && typeof extra === 'object') Object.assign(env, extra);
  return env;
}

/** Decode a captured stream as UTF-8, replacing anything invalid. */
function decode(chunk) {
  if (chunk === undefined || chunk === null) return '';
  if (Buffer.isBuffer(chunk)) return chunk.toString('utf8');
  return String(chunk);
}

/** Cut text to a cap, reporting whether anything was dropped. */
function truncate(text, cap) {
  if (text.length <= cap) return { text, truncated: false };
  return { text: text.slice(0, cap), truncated: true };
}

/** Keep an error string to a size a tool result can carry. */
function clip(text) {
  return text.length <= ERROR_CLIP ? text : text.slice(0, ERROR_CLIP) + '… (truncated)';
}

/** A sentence for the failures that mean "git never ran". */
function describeSpawnError(error) {
  if (error === undefined || error === null) return 'git failed for an unknown reason';
  if (error.name === 'AbortError') return 'aborted';
  if (error.code === 'ENOENT') return 'git is not installed or is not on PATH';
  if (error.code === 'EACCES') return 'git is not executable';
  return clip(String(error.message ?? error));
}

/**
 * The ways git says it had no usable credential, in git's own words.
 *
 * The transport half of authentication fails in prose: `could not read
 * Username` (nothing stored, and prompting is off — the fresh-machine case),
 * `Authentication failed` or `Invalid username or token` (something stored and
 * the server refused it), and `Permission denied (publickey)` (an SSH key was
 * offered and rejected). Matched on the message because the message is all git
 * leaves behind: it exits 128 and writes a sentence.
 */
const CREDENTIAL_FAILURE = /could not read Username|terminal prompts disabled|Authentication failed|Invalid username or token|Permission denied \(publickey\)/iu;

/**
 * A sentence naming the fix when a failure is a missing credential.
 *
 * The order is deliberate. The two routes that need nothing installed come
 * first — an SSH remote, or the credential helper that ships with the operating
 * system — and the GitHub CLI is named last, as the convenience it is. A machine
 * without it is not told to install a tool in order to push.
 *
 * @param {string} errorText - git's own message.
 * @returns {string|undefined} undefined when this is not a credential failure,
 *   which is the answer for most failures and the reason callers may pass it
 *   straight into a field that is only printed when it is set.
 */
export function credentialHint(errorText) {
  if (typeof errorText !== 'string' || !CREDENTIAL_FAILURE.test(errorText)) return undefined;
  return 'git could not authenticate to the remote: this machine has no working credential for it. Use an SSH remote, or set a credential helper for HTTPS — on macOS `git config --global credential.helper osxkeychain`, on Linux `libsecret` or `cache` — and authenticate once in a terminal; neither needs anything installed. The GitHub CLI is optional here: if it is present, `gh auth setup-git` does the helper half.';
}

/**
 * Git's message for a human, with the credential fix appended when that is
 * what went wrong. Anything else comes back unchanged.
 *
 * Two doors use it. A push failure is *written down* — the record `status` prints
 * as the automatic push's failure — because that record outlives the result
 * envelope; a fetch failure is reported in the result alone, as `hint`. Both are
 * places where "could not read Username" on its own tells a reader nothing they
 * can act on, and a first run on a machine with no credential is where it is met.
 *
 * @param {string} errorText - git's own message.
 * @returns {string}
 */
export function explainCredentialFailure(errorText) {
  const text = typeof errorText === 'string' ? errorText : String(errorText ?? '');
  const hint = credentialHint(text);
  return hint === undefined ? text : text + ' — ' + hint;
}

/** realpath when the path exists, the path as given when it does not. */
function realpathOr(path) {
  try {
    return realpathSync(path);
  } catch {
    // A path git reported but that is gone now (a pruned worktree) stays as-is.
    return path;
  }
}

/** Whether a caller-supplied name would be read by git as an option. */
function looksLikeOption(value) {
  return typeof value === 'string' && value.startsWith('-');
}

/** The remainder of a record after `count` space separators, or undefined. */
function fieldsAfter(record, count) {
  let index = -1;
  for (let step = 0; step < count; step += 1) {
    index = record.indexOf(' ', index + 1);
    if (index === -1) return undefined;
  }
  return record.slice(index + 1);
}

/**
 * The repository root for a directory, realpath'd.
 *
 * Realpath because macOS reports `/private/tmp/...` for `/tmp/...`: every path
 * this module returns has to be comparable with every other path it returns,
 * and with the paths git itself prints.
 *
 * A FILE path is accepted and resolved to the repository containing it. That is
 * not a convenience: the caller who needs this most is the one holding a list of
 * changed files, and `execFile` with a file as `cwd` fails outright rather than
 * reporting "not a directory" as a git result — so the failure would surface as
 * an empty repository list and a silently skipped commit.
 *
 * @param {string} dir - a directory, or any file inside the repository.
 * @returns {Promise<string|undefined>} undefined when the path is not in a
 *   working tree (including a bare repository, which has no toplevel).
 */
export async function toplevel(dir) {
  const at = await directoryFor(dir);
  if (at === undefined) return undefined;
  const out = await run(at, ['rev-parse', '--show-toplevel']);
  if (!out.ok) return undefined;
  const raw = out.stdout.trim();
  return raw === '' ? undefined : realpathOr(raw);
}

/**
 * The nearest existing directory for a path: the path itself, or its containing
 * directory when it is a file or no longer exists.
 *
 * `git -C <file>` fails, and `statSync` is the only way to tell a file from a
 * directory here. A path that does not exist resolves to its parent, because
 * "a file that was deleted during the turn" is a real input and the repository
 * containing it is still the right answer.
 */
async function directoryFor(dir) {
  const resolved = resolve(dir);
  try {
    return statSync(resolved).isDirectory() ? resolved : dirname(resolved);
  } catch {
    return dirname(resolved);
  }
}

/**
 * The shared git directory of a repository (`.git`, or the main repository's
 * `.git` when called from a linked worktree), realpath'd.
 *
 * The two forms matter: a worktree's `--git-common-dir` is where shared state
 * like `worktrees/` lives, while its own `--git-dir` holds that worktree's
 * HEAD. Callers asking about worktrees want this one.
 *
 * @returns {Promise<string|undefined>} undefined outside a repository.
 */
export async function commonDir(repoDir) {
  const out = await run(repoDir, ['rev-parse', '--git-common-dir']);
  if (!out.ok) return undefined;
  const raw = out.stdout.trim();
  if (raw === '') return undefined;
  // git prints this relative to the working directory, not to the toplevel.
  return realpathOr(isAbsolute(raw) ? raw : resolve(repoDir, raw));
}

/**
 * Whether a directory is inside a git repository (bare repositories included).
 *
 * @returns {Promise<boolean>} false when git is missing or fails; no throw.
 */
export async function isRepo(dir) {
  const out = await run(dir, ['rev-parse', '--git-dir']);
  return out.ok && out.stdout.trim() !== '';
}

/**
 * Parse `git worktree list --porcelain`.
 *
 * Two traps here, both of which produce a wrong answer rather than an error.
 * The output is a blank-line-separated record block, and the first line of a
 * record is the only one whose key is not fixed-width — `locked` and `prunable`
 * may carry a reason, and a bare record carries `bare` with no value at all.
 * Second, every path is a realpath, so `/tmp/x` arrives as `/private/tmp/x`; a
 * caller comparing against the path it passed in must compare against these
 * values, not against its own string.
 *
 * A path that no longer exists cannot be realpath'd and is kept verbatim: a
 * prunable entry is exactly the case where the directory is gone and the path
 * still matters.
 *
 * @param {string} stdout - the raw stdout of `git worktree list --porcelain`.
 * @returns {{path: string, head?: string, branch?: string, detached?: boolean,
 *   bare?: boolean, locked?: boolean, lockReason?: string, prunable?: boolean,
 *   pruneReason?: string}[]} in the order git printed them, main worktree first.
 */
export function parseWorktrees(stdout) {
  const entries = [];
  let current;
  const flush = () => {
    if (current !== undefined && typeof current.path === 'string' && current.path !== '') entries.push(current);
    current = undefined;
  };

  for (const line of String(stdout ?? '').split('\n')) {
    if (line.trim() === '') {
      flush();
      continue;
    }
    const space = line.indexOf(' ');
    const key = space === -1 ? line : line.slice(0, space);
    const value = space === -1 ? '' : line.slice(space + 1);

    if (key === 'worktree') {
      flush();
      current = { path: realpathOr(value) };
      continue;
    }
    if (current === undefined) continue;

    if (key === 'HEAD') {
      if (value !== '') current.head = value;
    } else if (key === 'branch') {
      current.branch = value.replace(/^refs\/heads\//u, '');
    } else if (key === 'detached') {
      current.detached = true;
    } else if (key === 'bare') {
      current.bare = true;
    } else if (key === 'locked') {
      current.locked = true;
      if (value.trim() !== '') current.lockReason = value.trim();
    } else if (key === 'prunable') {
      current.prunable = true;
      if (value.trim() !== '') current.pruneReason = value.trim();
    }
  }
  flush();
  return entries;
}

/**
 * Every worktree registered to a repository, with realpath'd paths.
 *
 * @returns {Promise<Array<object>|undefined>} the shape `parseWorktrees`
 *   produces, or **undefined when git fails**. That is deliberately not an empty
 *   array. Every caller of this function is asking where a branch is checked
 *   out, and "git could not answer" read as "no worktree has it" is how a branch
 *   gets deleted out from under a live worktree. A caller that only reports may
 *   treat undefined as empty; a caller about to delete something must stop.
 */
export async function listWorktrees(repoDir) {
  const out = await run(repoDir, ['worktree', 'list', '--porcelain']);
  if (!out.ok) return undefined;
  return parseWorktrees(out.stdout);
}

/**
 * Parse `git status --porcelain=v2 --branch -z`.
 *
 * The `-z` form is the only one that survives a filename with a space, a
 * newline, or a backslash, and it is also the only one that is *never*
 * C-quoted: a record's path is the literal bytes of the filename, so any
 * unquoting step would corrupt the very names this parser exists to preserve.
 * Records are split on NUL and nothing else.
 *
 * `# branch.ab +N -M` is absent whenever there is no upstream. That is the
 * normal state of a fresh branch, not a parse failure, and `ahead`/`behind`
 * stay undefined rather than becoming 0 — `computeSync` answers the question
 * properly against an explicit base.
 *
 * @param {string} stdoutZ - raw stdout of `git status --porcelain=v2 --branch -z`.
 * @returns {{branch?: string, detached?: boolean, oid?: string, upstream?: string,
 *   ahead?: number, behind?: number, staged: {path: string, xy: string}[],
 *   unstaged: {path: string, xy: string}[], untracked: string[],
 *   ignored: string[], unmerged: string[]}} a path whose index entry is renamed
 *   appears under its new name.
 */
export function parseStatus(stdoutZ) {
  const result = { staged: [], unstaged: [], untracked: [], ignored: [], unmerged: [] };
  const records = String(stdoutZ ?? '').split('\0');

  for (const record of records) {
    if (record === '') continue;

    if (record.startsWith('# ')) {
      const space = record.indexOf(' ', 2);
      const key = space === -1 ? record.slice(2) : record.slice(2, space);
      const value = space === -1 ? '' : record.slice(space + 1);
      if (key === 'branch.oid') {
        // `(initial)` is an unborn branch: no commit, so no oid.
        if (value !== '' && value !== '(initial)') result.oid = value;
      } else if (key === 'branch.head') {
        if (value === '(detached)') result.detached = true;
        else if (value !== '') result.branch = value;
      } else if (key === 'branch.upstream') {
        if (value !== '') result.upstream = value;
      } else if (key === 'branch.ab') {
        const counts = /^\+(\d+) -(\d+)$/u.exec(value);
        if (counts !== null) {
          result.ahead = Number.parseInt(counts[1], 10);
          result.behind = Number.parseInt(counts[2], 10);
        }
      }
      continue;
    }

    if (record.startsWith('1 ')) {
      const xy = record.slice(2, 4);
      const path = fieldsAfter(record, 8);
      if (path === undefined) continue;
      recordChange(result, xy, path);
      continue;
    }

    if (record.startsWith('2 ')) {
      const xy = record.slice(2, 4);
      const payload = fieldsAfter(record, 9);
      if (payload === undefined) continue;
      // The rename record is `<new path>\t<original path>`; split on the first
      // tab only, because a path may itself contain one.
      const tab = payload.indexOf('\t');
      const path = tab === -1 ? payload : payload.slice(0, tab);
      recordChange(result, xy, path);
      continue;
    }

    if (record.startsWith('u ')) {
      const path = fieldsAfter(record, 10);
      if (path !== undefined) result.unmerged.push(path);
      continue;
    }

    if (record.startsWith('? ')) {
      result.untracked.push(record.slice(2));
      continue;
    }

    if (record.startsWith('! ')) {
      result.ignored.push(record.slice(2));
      continue;
    }
  }
  return result;
}

/** Sort one `<XY> <path>` record into the staged and/or unstaged lists. */
function recordChange(result, xy, path) {
  if (xy.length !== 2) return;
  if (xy[0] !== '.') result.staged.push({ path, xy });
  if (xy[1] !== '.') result.unstaged.push({ path, xy });
}

/** Distinct dirty paths of a parsed status, in the order git listed them. */
function dirtyPaths(parsed) {
  const seen = new Set();
  const paths = [];
  const add = (path) => {
    if (typeof path !== 'string' || path === '' || seen.has(path)) return;
    seen.add(path);
    paths.push(path);
  };
  for (const entry of parsed.staged) add(entry.path);
  for (const entry of parsed.unstaged) add(entry.path);
  for (const path of parsed.unmerged) add(path);
  for (const path of parsed.untracked) add(path);
  return paths;
}

/** Run the status command `parseStatus` expects, with caller-chosen breadth. */
async function statusOf(repoDir, opts = {}) {
  const args = ['status', '--porcelain=v2', '--branch', '-z'];
  const untracked = opts.untrackedFiles;
  if (untracked === 'all' || untracked === 'normal' || untracked === 'no') {
    args.push('--untracked-files=' + untracked);
  }
  // Ignored files are off by default: listing them costs a full walk of every
  // ignored tree, and most callers only care that they are not dirty.
  if (opts.ignored === true) args.push('--ignored');
  return await run(repoDir, args, opts);
}

/**
 * Everything a tool needs to describe a repository in one call.
 *
 * Always returns the documented shape, including when git fails — a caller
 * reading `repoRoot` or `remotes` should not have to branch on `ok` first.
 * `ok:false` means the *status* could not be read (a bare repository, or a
 * directory that is not one), and the best-effort fields are filled from the
 * cheaper plumbing commands that still work.
 *
 * @param {string} repoDir - any directory inside the repository.
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal] - aborts every git call.
 * @param {number} [opts.timeoutMs] - per-call kill deadline.
 * @param {boolean} [opts.ignored] - also collect ignored paths (off by default).
 * @param {'all'|'normal'|'no'} [opts.untrackedFiles] - untracked breadth.
 * @returns {Promise<{ok: boolean, repoRoot: string, branch?: string, detached: boolean,
 *   oid?: string, dirty: boolean, changeCount: number, staged: number, unstaged: number,
 *   untracked: number, unmerged: number, upstream?: string, ahead?: number,
 *   behind?: number, remotes: {name: string, url: string}[], defaultBranch?: string,
 *   rebaseInProgress: boolean, mergeInProgress: boolean, cherryPickInProgress: boolean,
 *   error?: string}>} `ahead`/`behind` are undefined without an upstream; use
 *   `computeSync` against an explicit base for that answer.
 */
export async function repoState(repoDir, opts = {}) {
  const status = await statusOf(repoDir, opts);
  const parsed = parseStatus(status.stdout);
  const root = await toplevel(repoDir);
  const repoRoot = root ?? realpathOr(resolve(repoDir));
  const [remoteList, base, marks] = await Promise.all([
    remotes(repoDir),
    defaultBranchOf(repoDir),
    ancestry(repoDir, opts),
  ]);

  // A bare repository has no working tree, so status fails while rev-parse
  // still answers; the branch and oid are worth returning even then.
  let branch = parsed.branch;
  let oid = parsed.oid;
  let detached = parsed.detached === true;
  if (!status.ok) {
    const [headRef, headOid] = await Promise.all([
      run(repoDir, ['symbolic-ref', '-q', '--short', 'HEAD'], opts),
      run(repoDir, ['rev-parse', '-q', '--verify', 'HEAD'], opts),
    ]);
    if (headRef.ok && headRef.stdout.trim() !== '') branch = headRef.stdout.trim();
    else if (headOid.ok) detached = true;
    if (headOid.ok && headOid.stdout.trim() !== '') oid = headOid.stdout.trim();
  }

  const count = (list) => list.length;
  const paths = dirtyPaths(parsed);
  const state = {
    ok: status.ok,
    repoRoot,
    branch,
    detached,
    oid,
    dirty: status.ok && paths.length > 0,
    changeCount: status.ok ? paths.length : 0,
    staged: count(parsed.staged),
    unstaged: count(parsed.unstaged),
    untracked: count(parsed.untracked),
    unmerged: count(parsed.unmerged),
    upstream: parsed.upstream,
    ahead: parsed.ahead,
    behind: parsed.behind,
    remotes: remoteList,
    defaultBranch: base,
    rebaseInProgress: marks.rebase,
    mergeInProgress: marks.merge,
    cherryPickInProgress: marks.cherryPick,
  };
  if (!status.ok) state.error = status.error ?? 'git status failed';
  return state;
}

/**
 * How far HEAD is from a base ref, in both directions.
 *
 * Needed because `# branch.ab` only exists when the branch has an upstream, so
 * a fresh task branch always reports "unknown" through `repoState`. The
 * left-right count answers the same question against any ref, and its output
 * order is the trap: `--left-right --count A...B` prints `<left> <right>`, so
 * with `base...HEAD` the *first* number is how far behind HEAD is, and reading
 * it as `ahead` inverts every answer.
 *
 * @param {string} repoDir - repository directory.
 * @param {string} baseRef - e.g. `origin/main`, `main`.
 * @param {object} [opts] - `{signal, timeoutMs, env}` passed to git.
 * @returns {Promise<{ahead: number, behind: number, base: string}|undefined>}
 *   undefined when the base ref is unknown or HEAD has no commits — the caller
 *   reports "unknown", it does not get a made-up 0.
 */
export async function computeSync(repoDir, baseRef, opts = {}) {
  if (typeof baseRef !== 'string' || baseRef.trim() === '' || looksLikeOption(baseRef)) return undefined;
  const ref = baseRef.trim();
  const out = await run(repoDir, ['rev-list', '--left-right', '--count', ref + '...HEAD'], opts);
  if (!out.ok) return undefined;
  const counts = /^(\d+)\s+(\d+)/u.exec(out.stdout.trim());
  if (counts === null) return undefined;
  return {
    ahead: Number.parseInt(counts[2], 10),
    behind: Number.parseInt(counts[1], 10),
    base: ref,
  };
}

/**
 * Whether a merge, rebase, or cherry-pick is stopping the repository mid-flight.
 *
 * A rebase has no single marker: `REBASE_HEAD` covers the stopped states, and
 * the `rebase-merge`/`rebase-apply` directory covers the rest (an interactive
 * rebase that stopped to edit). Both the worktree's own git directory and the
 * shared one are checked, because a rebase started in a linked worktree keeps
 * its state there, not in the main `.git`.
 *
 * @param {string} repoDir - repository directory.
 * @param {object} [opts] - `{signal, timeoutMs, env}` passed to git.
 * @returns {Promise<{merge: boolean, rebase: boolean, cherryPick: boolean, any: boolean}>}
 *   all false outside a repository; no throw.
 */
export async function ancestry(repoDir, opts = {}) {
  const [merge, rebaseHead, cherryPick] = await Promise.all([
    run(repoDir, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], opts),
    run(repoDir, ['rev-parse', '-q', '--verify', 'REBASE_HEAD'], opts),
    run(repoDir, ['rev-parse', '-q', '--verify', 'CHERRY_PICK_HEAD'], opts),
  ]);

  let rebase = rebaseHead.ok;
  if (!rebase) {
    const dirs = await Promise.all([
      gitPath(repoDir, 'rebase-merge', opts),
      gitPath(repoDir, 'rebase-apply', opts),
      commonDir(repoDir),
    ]);
    const [mergeDir, applyDir, common] = dirs;
    const candidates = [mergeDir, applyDir];
    if (common !== undefined) {
      candidates.push(join(common, 'rebase-merge'), join(common, 'rebase-apply'));
    }
    rebase = candidates.some((path) => typeof path === 'string' && existsSync(path));
  }

  const marks = { merge: merge.ok, rebase, cherryPick: cherryPick.ok };
  marks.any = marks.merge || marks.rebase || marks.cherryPick;
  return marks;
}

/** A git path (`--git-path`), resolved so it can be tested with existsSync. */
async function gitPath(repoDir, name, opts = {}) {
  const out = await run(repoDir, ['rev-parse', '--git-path', name], opts);
  if (!out.ok) return undefined;
  const raw = out.stdout.trim();
  if (raw === '') return undefined;
  return isAbsolute(raw) ? raw : resolve(repoDir, raw);
}

/**
 * The configured remotes and their fetch URLs.
 *
 * Read from `git remote` rather than by parsing `remote -v`, so a remote with
 * no URL is still listed (with an empty `url`) instead of silently vanishing —
 * "no remote" and "a remote with no URL" need different fixes.
 *
 * @returns {Promise<{name: string, url: string}[]>} empty when git fails.
 */
export async function remotes(repoDir) {
  const out = await run(repoDir, ['remote']);
  if (!out.ok) return [];
  const list = [];
  for (const name of out.stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '')) {
    const url = await run(repoDir, ['remote', 'get-url', name]);
    list.push({ name, url: url.ok ? url.stdout.trim() : '' });
  }
  return list;
}

/**
 * The branch a repository is "based on": `origin/HEAD`, then origin's main or
 * master, then a local main or master.
 *
 * Answered from refs only — never from `git remote show`, which would go to the
 * network for a question about local state.
 *
 * @returns {Promise<string|undefined>} a short name such as `main`; undefined
 *   when the repository has no recognizable default and no commits.
 */
export async function defaultBranchOf(repoDir) {
  const head = await run(repoDir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (head.ok) {
    const short = head.stdout.trim();
    const name = short.startsWith('origin/') ? short.slice('origin/'.length) : short;
    if (name !== '') return name;
  }
  for (const candidate of ['main', 'master']) {
    const remote = await run(repoDir, ['rev-parse', '-q', '--verify', 'refs/remotes/origin/' + candidate]);
    if (remote.ok) return candidate;
  }
  for (const candidate of ['main', 'master']) {
    const local = await run(repoDir, ['show-ref', '--verify', '--quiet', 'refs/heads/' + candidate], { allowFailure: true });
    if (local.ok) return candidate;
  }
  return undefined;
}

/**
 * The checked-out branch, or undefined when HEAD is detached.
 *
 * `symbolic-ref` is used rather than `rev-parse --abbrev-ref` because it exits
 * 1 on a detached HEAD instead of printing the literal `HEAD`, which would be
 * indistinguishable from a branch actually named HEAD.
 *
 * @returns {Promise<string|undefined>} the short branch name, including an
 *   unborn branch's name; undefined outside a repository.
 */
export async function currentBranch(repoDir) {
  const out = await run(repoDir, ['symbolic-ref', '-q', '--short', 'HEAD']);
  if (!out.ok) return undefined;
  const name = out.stdout.trim();
  return name === '' ? undefined : name;
}

/**
 * Whether the repository has a commit: `HEAD` resolves.
 *
 * An unborn branch — a repository created and not yet committed to — has a branch
 * NAME and no commit: `git init -b main` answers `main` to `symbolic-ref` before
 * `main` exists. Anything reasoning about what a branch contains has to tell the
 * two apart, and the worktree enforcement is the case that matters: a branch with
 * no commits cannot be protected, and no worktree can be cut from it.
 *
 * @returns {Promise<boolean|undefined>} undefined when the answer could not be
 *   read at all, which is not the same as "no commits".
 */
export async function hasHead(repoDir, opts = {}) {
  const out = await run(repoDir, ['rev-parse', '-q', '--verify', 'HEAD'], opts);
  if (!out.ok) return undefined;
  return out.stdout.trim() !== '';
}

/**
 * How many commits HEAD has that `baseRef` does not.
 *
 * @param {string} repoDir - repository directory.
 * @param {string} baseRef - the ref to count against.
 * @returns {Promise<number|undefined>} undefined when the ref is unknown or
 *   HEAD is unborn, rather than 0.
 */
export async function aheadOf(repoDir, baseRef) {
  if (typeof baseRef !== 'string' || baseRef.trim() === '' || looksLikeOption(baseRef)) return undefined;
  const out = await run(repoDir, ['rev-list', '--count', baseRef.trim() + '..HEAD']);
  if (!out.ok) return undefined;
  const count = Number.parseInt(out.stdout.trim(), 10);
  return Number.isNaN(count) ? undefined : count;
}

/**
 * Every dirty path in the repository, relative to its root, untracked included.
 *
 * Built from the porcelain v2 status, so a filename with a space or a newline
 * survives; an untracked directory may appear as `dir/`, which `git add`
 * accepts as-is.
 *
 * @param {string} repoDir - repository directory.
 * @param {object} [opts] - `{signal, timeoutMs, untrackedFiles}`.
 * @returns {Promise<string[]>} empty when the repository is clean *and* when
 *   git fails; callers that must tell those apart use `repoState`.
 */
export async function changedPaths(repoDir, opts = {}) {
  const status = await statusOf(repoDir, opts);
  if (!status.ok) return [];
  return dirtyPaths(parseStatus(status.stdout));
}

/**
 * Stage the given paths, exactly as given.
 *
 * `--literal-pathspecs` is not decoration: git pathspecs are globs, so a dirty
 * file literally named `*.log` would otherwise stage every `.log` in the
 * repository. With the literal flag the string is the filename, which is what
 * every caller of this function means. A trailing slash on an untracked
 * directory entry is dropped, because the literal form matches the directory.
 *
 * @param {string} repoDir - repository directory.
 * @param {string[]} paths - repo-relative paths from `changedPaths`.
 * @param {object} [opts] - `{signal, timeoutMs, env}` passed to git.
 * @returns {Promise<{ok: boolean, error?: string}>} `ok:true` for an empty list
 *   (nothing to stage is not a failure); `ok:false` with git's own message when
 *   a path does not exist.
 */
export async function stagePaths(repoDir, paths, opts = {}) {
  const list = normalizePaths(paths);
  if (list.length === 0) return { ok: true };
  const out = await run(repoDir, ['--literal-pathspecs', 'add', '--', ...list], opts);
  return out.ok ? { ok: true } : { ok: false, error: out.error ?? 'git add failed' };
}

/** The paths git currently considers unmerged (conflicted), if any. */
async function unmergedPaths(repoDir, opts = {}) {
  const status = await statusOf(repoDir, opts);
  if (!status.ok) return [];
  return parseStatus(status.stdout).unmerged;
}

/** Repo-relative paths, trimmed of trailing slashes and of duplicates. */
function normalizePaths(paths) {  if (!Array.isArray(paths)) return [];
  const seen = new Set();
  const list = [];
  for (const value of paths) {
    if (typeof value !== 'string') continue;
    const path = value.replace(/\/+$/u, '');
    if (path === '' || seen.has(path)) continue;
    seen.add(path);
    list.push(path);
  }
  return list;
}

/**
 * Create one commit.
 *
 * Refusing an empty commit is deliberate: a tool that answers "done" after
 * creating a commit with no changes teaches the agent that its edit landed when
 * it did not. `opts.allowEmpty` is the explicit opt-in for the cases that
 * really do want one.
 *
 * With `opts.paths`, the commit is pathspec-limited, so anything else already
 * staged stays staged instead of being swept into this commit.
 *
 * Staging is refused while paths are unmerged. `git add` on a conflicted path
 * means "resolved, take the working tree" — and if the conflict markers are
 * still in the file, that silently commits them. A caller that really has
 * resolved a conflict says so explicitly with `stagePaths` and then commits;
 * `commit` itself never resolves a conflict on the caller's behalf.
 *
 * @param {string} repoDir - repository directory.
 * @param {string} message - commit message; empty or whitespace is refused.
 * @param {object} [opts]
 * @param {string[]} [opts.paths] - stage and commit only these paths.
 * @param {boolean} [opts.all] - stage every dirty path first, untracked included.
 * @param {AbortSignal} [opts.signal] - aborts the git calls.
 * @param {boolean} [opts.allowEmpty] - permit a commit with no changes.
 * @returns {Promise<{ok: boolean, sha?: string, error?: string}>} `ok:false`
 *   with a clear message when there is nothing to commit, when the message is
 *   empty, when a conflict is unresolved, or when a hook rejected the commit.
 */
export async function commit(repoDir, message, opts = {}) {
  const options = opts !== null && typeof opts === 'object' ? opts : {};
  const text = typeof message === 'string' ? message : '';
  if (text.trim() === '') {
    return { ok: false, error: 'refusing to commit with an empty message' };
  }

  const paths = normalizePaths(options.paths);
  if (options.all === true || paths.length > 0) {
    const unmerged = await unmergedPaths(repoDir, options);
    if (unmerged.length > 0) {
      return {
        ok: false,
        error: 'cannot stage ' + unmerged.length + ' unmerged path(s) (' + unmerged.slice(0, 5).join(', ')
          + '): git add would resolve the conflict with whatever is in the file, conflict markers included. '
          + 'Resolve them, then stage with stagePaths and commit without paths.',
      };
    }
  }
  if (options.all === true) {
    const staged = await stagePaths(repoDir, await changedPaths(repoDir, options), options);
    if (!staged.ok) return { ok: false, error: staged.error ?? 'staging failed' };
  } else if (paths.length > 0) {
    const staged = await stagePaths(repoDir, paths, options);
    if (!staged.ok) return { ok: false, error: staged.error ?? 'staging failed' };
  }

  const args = ['--literal-pathspecs', 'commit'];
  if (options.allowEmpty === true) args.push('--allow-empty');
  args.push('-m', text);
  if (paths.length > 0) args.push('--', ...paths);

  const out = await run(repoDir, args, { ...options, allowFailure: true });
  if (!out.ok) {
    const combined = (out.stdout + '\n' + out.stderr).trim();
    if (/nothing to commit|no changes added to commit|nothing added to commit/iu.test(combined)) {
      return { ok: false, error: options.allowEmpty === true
        ? 'nothing to commit, and --allow-empty did not take'
        : 'nothing to commit: no staged changes matched the request' };
    }
    return { ok: false, error: out.error ?? firstLine(combined) ?? 'git commit failed' };
  }

  const head = await run(repoDir, ['rev-parse', '--verify', 'HEAD'], options);
  const sha = head.ok ? head.stdout.trim() : '';
  return sha === '' ? { ok: true } : { ok: true, sha };
}

/**
 * Push the current branch to a remote.
 *
 * `--porcelain` is used for the answer, not for looks: it reports `=` for
 * "up to date", `*` for a new branch, and a space for a real update, so
 * `pushed:false` means nothing was sent rather than "the output did not contain
 * the phrase we hoped for". The remote-tracking count is only a cross-check,
 * because an unfetched repository has a stale tracking ref and would otherwise
 * claim there was something to push.
 *
 * An upstream is set when the branch has none, when the branch tracks a
 * *different* ref, or when the caller asks for it. That last case matters
 * because `git worktree add` points a new branch at the base it was created
 * from (`origin/main`), so the first push of a task branch that does not
 * repoint it would leave `repoState` reporting sync against the base instead of
 * against the branch's own remote. `setUpstream:false` in the result means no
 * upstream was configured by this call.
 *
 * @param {string} repoDir - repository directory.
 * @param {object} [opts]
 * @param {string} [opts.remote] - default `origin`.
 * @param {string} [opts.branch] - default the checked-out branch.
 * @param {boolean} [opts.setUpstream] - force or forbid `--set-upstream`.
 * @param {boolean} [opts.forceWithLease] - pass `--force-with-lease`; a
 *   deliberate replacement of this branch's own remote ref, never forced on a
 *   caller, and refused by git when the remote has moved since the last fetch.
 * @param {AbortSignal} [opts.signal] - aborts the push.
 * @param {number} [opts.timeoutMs] - kill deadline, default 5 minutes.
 * @returns {Promise<{ok: boolean, pushed: boolean, setUpstream: boolean, remote: string,
 *   branch: string, error?: string, hint?: string, output?: string}>} `ok:false` on a rejected
 *   push (non-fast-forward, auth, no such remote) with git's own message
 *   appended to `output`; never a throw, and never a force.
 */
export async function push(repoDir, opts = {}) {
  const options = opts !== null && typeof opts === 'object' ? opts : {};
  const remote = typeof options.remote === 'string' && options.remote.trim() !== ''
    ? options.remote.trim()
    : 'origin';
  const branch = typeof options.branch === 'string' && options.branch.trim() !== ''
    ? options.branch.trim()
    : await currentBranch(repoDir);
  const signals = { signal: options.signal, timeoutMs: Number.isFinite(options.timeoutMs) ? options.timeoutMs : NETWORK_TIMEOUT_MS };
  const result = { ok: false, pushed: false, setUpstream: false, remote, branch: branch ?? '' };

  if (branch === undefined || branch === '') {
    return { ...result, error: 'nothing to push: HEAD is detached' };
  }
  if (looksLikeOption(remote) || looksLikeOption(branch)) {
    return { ...result, error: 'refusing to pass a remote or branch that looks like an option' };
  }

  // --abbrev-ref, not --verify: the question is which ref the branch tracks,
  // and --verify answers with the commit it points at.
  const upstream = await run(repoDir, ['rev-parse', '--abbrev-ref', branch + '@{upstream}'], { signal: options.signal });
  const trackedRef = upstream.ok ? upstream.stdout.trim() : '';
  const wantUpstream = options.setUpstream === true
    ? true
    : options.setUpstream === false ? false : trackedRef !== remote + '/' + branch;

  const tracked = await run(repoDir, ['rev-list', '--count', remote + '/' + branch + '..' + branch], signals);
  const before = tracked.ok ? Number.parseInt(tracked.stdout.trim(), 10) : undefined;

  const args = ['push', '--porcelain'];
  if (wantUpstream) args.push('--set-upstream');
  // `--force-with-lease` is the only force this tool will ever pass, and only
  // when the caller asked in so many words: it refuses if the remote moved
  // since the last fetch, so it replaces YOUR rewritten branch without
  // discarding a commit somebody else pushed in the meantime.
  if (options.forceWithLease === true) args.push('--force-with-lease');
  args.push(remote, branch);
  const out = await run(repoDir, args, signals);

  const output = (out.stdout + '\n' + out.stderr).trim();
  const flags = parsePushFlags(out.stdout);
  const upToDate = flags.length > 0 && flags.every((flag) => flag === '=' || flag === '-');
  const updated = flags.some((flag) => flag === ' ' || flag === '*' || flag === '+');
  const pushed = out.ok && !upToDate
    && (updated || (Number.isFinite(before) ? before > 0 : flags.length === 0));

  const pushedResult = {
    ok: out.ok,
    pushed,
    setUpstream: wantUpstream && out.ok,
    remote,
    branch,
  };
  if (output !== '') pushedResult.output = clip(output);
  if (!out.ok) {
    pushedResult.error = out.error ?? 'git push failed';
    const hint = pushRejectionHint(output);
    if (hint !== undefined) pushedResult.hint = hint;
  }
  return pushedResult;
}

/**
 * The next step for a push git rejected, or undefined when the failure is one
 * the caller already explains (a missing credential).
 *
 * A rejected push used to be a dead end: `push` never forces, `sync` is
 * fast-forward only, and raw `git push --force` was refused in bash, so a task
 * branch whose remote counterpart had moved could not be published by either
 * route. The ordinary GitHub recovery — fetch, rebase, push — is allowed now,
 * and naming it here is what turns git's `failed to push some refs` into a
 * route out instead of a wall.
 *
 * @param {string} output - git's own stdout+stderr for the push.
 * @returns {string|undefined}
 */
function pushRejectionHint(output) {
  const text = String(output ?? '');
  if (text === '') return undefined;
  if (/non-fast-forward|fetch first|\[rejected\]|failed to push some refs/iu.test(text)) {
    return 'The remote refused this update. The usual cause is that the remote branch holds commits this branch does not: run `git fetch origin`, then `git rebase origin/<branch>`, then push again. Nothing is lost — the commits stay local until the push succeeds.';
  }
  if (/does not appear to be a git repository|could not read from remote repository|could not resolve host|connection (timed out|refused)/iu.test(text)) {
    return 'The remote could not be reached. Check `git remote -v` and the network, then push again.';
  }
  return undefined;
}

/** The status flags of a `git push --porcelain` result, one per updated ref. */
function parsePushFlags(stdout) {
  const flags = [];
  for (const line of String(stdout ?? '').split('\n')) {
    const match = /^([ =*+!-])\t/u.exec(line);
    if (match !== null) flags.push(match[1]);
  }
  return flags;
}

/**
 * Fetch one remote, and prune the tracking refs whose branch is gone.
 *
 * `--prune` is the other half of deleting a task branch. The plugin removes the
 * branch on the remote when a merge retires it, but without this the local
 * `refs/remotes/<remote>/<branch>` outlived it forever: every merged task branch
 * left one behind, seventeen of them accumulated in this repository's own
 * checkout, and `git branch -a` kept listing branches that exist nowhere. A
 * hand-run `git fetch --prune` is gated by the guard, and it should stay gated —
 * which is exactly why the plugin's own fetch has to do this itself.
 *
 * Pruning cannot change an answer any caller depends on, because it removes only
 * refs the remote itself no longer has. A branch still on the remote survives by
 * definition, a local branch is not a remote-tracking ref at all, and `--prune`
 * leaves tags and `<remote>/HEAD` alone. The one answer it does change is the
 * one that was wrong: a base branch deleted on the remote no longer resolves to
 * a stale ref, so `sync` reports it cannot compare instead of fast-forwarding
 * toward a branch that is gone.
 *
 * @param {string} repoDir - repository directory.
 * @param {string} remote - remote name, e.g. `origin`.
 * @param {object} [opts] - `{signal, timeoutMs, env}` passed to git.
 * @returns {Promise<{ok: boolean, error?: string}>} `ok:false` with git's
 *   message when the remote is unreachable or unknown; remote failures are
 *   ordinary results here, never exceptions.
 */
export async function fetch(repoDir, remote, opts = {}) {
  if (typeof remote !== 'string' || remote.trim() === '') {
    return { ok: false, error: 'no remote name was given' };
  }
  const name = remote.trim();
  if (looksLikeOption(name)) return { ok: false, error: 'refusing to pass a remote that looks like an option' };
  const out = await run(repoDir, ['fetch', '--prune', name], {
    timeoutMs: NETWORK_TIMEOUT_MS,
    ...opts,
  });
  return out.ok ? { ok: true } : { ok: false, error: out.error ?? 'git fetch failed' };
}

/**
 * Fast-forward the current branch to a target ref, and only fast-forward.
 *
 * A merge in disguise is what this refuses to be: `merge --ff-only` moves the
 * branch when the target is a descendant, and refuses — leaving everything
 * untouched — when it is not. `reset --hard` is never used, because it would
 * discard uncommitted work to answer a question about history.
 *
 * @param {string} repoDir - repository directory.
 * @param {string} target - e.g. `origin/main`.
 * @param {object} [opts] - `{signal, timeoutMs, env}` passed to git.
 * @returns {Promise<{ok: boolean, moved: boolean, from?: string, to?: string,
 *   error?: string}>} `ok:true, moved:false` when HEAD is already there;
 *   `ok:false` when the branches have diverged or an operation is in progress.
 */
export async function fastForward(repoDir, target, opts = {}) {
  if (typeof target !== 'string' || target.trim() === '' || looksLikeOption(target)) {
    return { ok: false, moved: false, error: 'no usable target ref was given' };
  }
  const ref = target.trim();
  const inProgress = await ancestry(repoDir, opts);
  if (inProgress.any) {
    return { ok: false, moved: false, error: 'a merge, rebase, or cherry-pick is in progress; finish or abort it first' };
  }

  const [fromOut, toOut] = await Promise.all([
    run(repoDir, ['rev-parse', '-q', '--verify', 'HEAD'], opts),
    run(repoDir, ['rev-parse', '-q', '--verify', ref], opts),
  ]);
  if (!toOut.ok || toOut.stdout.trim() === '') {
    return { ok: false, moved: false, error: 'unknown ref: ' + ref };
  }
  const from = fromOut.ok ? fromOut.stdout.trim() : undefined;
  const to = toOut.stdout.trim();
  if (from === to) return { ok: true, moved: false, from, to };

  if (from !== undefined) {
    const ancestor = await run(repoDir, ['merge-base', '--is-ancestor', from, to], { ...opts, allowFailure: true });
    if (!ancestor.ok) {
      return { ok: false, moved: false, from, to, error: ref + ' is not a descendant of HEAD, so this is not a fast-forward' };
    }
  }

  const merged = await run(repoDir, ['merge', '--ff-only', ref], opts);
  if (!merged.ok) {
    return { ok: false, moved: false, from, to, error: merged.error ?? 'git merge --ff-only failed' };
  }
  const head = await run(repoDir, ['rev-parse', '-q', '--verify', 'HEAD'], opts);
  const now = head.ok ? head.stdout.trim() : to;
  return { ok: true, moved: now !== from, from, to: now };
}

/**
 * The merge base of two refs.
 *
 * @returns {Promise<string|undefined>} the commit they share, or undefined when
 *   either ref is unknown or they are unrelated histories.
 */
export async function mergeBase(repoDir, refA, refB) {
  if (typeof refA !== 'string' || typeof refB !== 'string' || refA === '' || refB === '') return undefined;
  if (looksLikeOption(refA) || looksLikeOption(refB)) return undefined;
  const out = await run(repoDir, ['merge-base', refA, refB]);
  if (!out.ok) return undefined;
  const sha = out.stdout.trim();
  return sha === '' ? undefined : sha;
}

/**
 * The URL configured for one remote.
 *
 * @returns {Promise<string|undefined>} undefined when the remote is unknown or
 *   has no URL — the two cases a caller handles the same way.
 */
export async function remoteUrlFor(repoDir, name) {
  if (typeof name !== 'string' || name.trim() === '' || looksLikeOption(name)) return undefined;
  const out = await run(repoDir, ['remote', 'get-url', name.trim()]);
  if (!out.ok) return undefined;
  const url = out.stdout.trim();
  return url === '' ? undefined : url;
}

/* ------------------------------------------------------------------ *
 * The operations the actions compose
 *
 * One function per git command, so `actions.mjs` never builds argv itself.
 * Each returns a plain result and never throws; `ok:false` carries git's own
 * message, because that message is what a caller can act on.
 * ------------------------------------------------------------------ */

/**
 * The commit a ref points at, or undefined when it does not resolve.
 *
 * `-q --verify` is used rather than `rev-parse` alone because it exits 1 with
 * no output for an unknown ref instead of printing the ref back.
 */
export async function revParse(repoDir, ref, opts = {}) {
  if (!usableRef(ref)) return undefined;
  const out = await run(repoDir, ['rev-parse', '-q', '--verify', ref.trim()], { ...opts, allowFailure: true });
  if (!out.ok) return undefined;
  const oid = out.stdout.trim();
  return oid === '' ? undefined : oid;
}

/**
 * The ref a branch tracks, as `origin/main`, or undefined when it tracks nothing.
 *
 * `--symbolic-full-name` is the part that matters: without it git answers with
 * the short name, which is ambiguous the moment two remotes have the branch.
 */
export async function upstreamRef(repoDir, branch, opts = {}) {
  if (typeof branch !== 'string' || branch.trim() === '') return undefined;
  const out = await run(repoDir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', branch.trim() + '@{upstream}'], { ...opts, allowFailure: true });
  if (!out.ok) return undefined;
  const ref = out.stdout.trim();
  return ref === '' ? undefined : ref;
}

/** Replay the current branch onto `onto`. Nothing is forced and no editor opens. */
export async function rebase(repoDir, onto, opts = {}) {
  if (!usableRef(onto)) return { ok: false, error: 'no usable ref was given to rebase onto' };
  const out = await run(repoDir, ['rebase', onto.trim()], opts);
  return out.ok ? { ok: true } : { ok: false, error: out.error ?? 'git rebase failed', output: (out.stdout + out.stderr).trim() };
}

/** Abandon a rebase in progress, leaving the branch exactly where it was. */
export async function rebaseAbort(repoDir, opts = {}) {
  const out = await run(repoDir, ['rebase', '--abort'], { ...opts, allowFailure: true });
  return { ok: out.ok };
}

/**
 * Merge a ref into the current branch without opening an editor.
 *
 * `--no-edit` is required rather than cosmetic: without it git opens an editor
 * on a non-fast-forward merge, and in an agent there is nobody to close it — the
 * call would hang until the timeout instead of reporting what happened.
 */
export async function merge(repoDir, ref, opts = {}) {
  if (!usableRef(ref)) return { ok: false, error: 'no usable ref was given to merge' };
  const out = await run(repoDir, ['merge', '--no-edit', ref.trim()], opts);
  return out.ok ? { ok: true } : { ok: false, error: out.error ?? 'git merge failed', output: (out.stdout + out.stderr).trim() };
}

/** Abandon a merge in progress. */
export async function mergeAbort(repoDir, opts = {}) {
  const out = await run(repoDir, ['merge', '--abort'], { ...opts, allowFailure: true });
  return { ok: out.ok };
}

/** The paths git left unmerged, repo-relative. Empty when nothing conflicts. */
export async function conflictedPaths(repoDir, opts = {}) {
  const out = await run(repoDir, ['diff', '--name-only', '--diff-filter=U'], { ...opts, allowFailure: true });
  if (!out.ok) return [];
  return out.stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '');
}

/** Every configured value, as `{key, value}` pairs, in git's own order. */
export async function configList(repoDir, opts = {}) {
  const out = await run(repoDir, ['config', ...scopeArgs(opts), '--list'], { ...opts, allowFailure: true });
  if (!out.ok) return { ok: false, error: out.error ?? 'git config --list failed', entries: [] };
  const entries = out.stdout.split('\n').filter((line) => line !== '').map((line) => {
    const at = line.indexOf('=');
    return at === -1 ? { key: line, value: '' } : { key: line.slice(0, at), value: line.slice(at + 1) };
  });
  return { ok: true, entries };
}

/** One value, or `ok:false` when the key is not set in that scope. */
export async function configGet(repoDir, key, opts = {}) {
  if (typeof key !== 'string' || key.trim() === '') return { ok: false, error: 'no config key was given' };
  const out = await run(repoDir, ['config', ...scopeArgs(opts), '--get', key.trim()], { ...opts, allowFailure: true });
  if (!out.ok) return { ok: false, error: 'not set' };
  return { ok: true, value: out.stdout.trim() };
}

/** Write one value. `--local` is the default scope, `opts.global` the user's. */
export async function configSet(repoDir, key, value, opts = {}) {
  if (typeof key !== 'string' || key.trim() === '') return { ok: false, error: 'no config key was given' };
  const out = await run(repoDir, ['config', ...scopeArgs(opts), key.trim(), String(value)], { ...opts, allowFailure: true });
  return out.ok ? { ok: true } : { ok: false, error: out.error ?? 'git config failed' };
}

/** Remove one value. */
export async function configUnset(repoDir, key, opts = {}) {
  if (typeof key !== 'string' || key.trim() === '') return { ok: false, error: 'no config key was given' };
  const out = await run(repoDir, ['config', ...scopeArgs(opts), '--unset', key.trim()], { ...opts, allowFailure: true });
  return out.ok ? { ok: true } : { ok: false, error: out.error ?? ('could not unset ' + key) };
}

/** The remotes and their fetch URLs. A remote with no URL is listed with an empty one. */
export async function remoteList(repoDir, opts = {}) {
  const names = await run(repoDir, ['remote'], { ...opts, allowFailure: true });
  if (!names.ok) return { ok: false, error: names.error ?? 'git remote failed', entries: [] };
  const entries = [];
  for (const name of names.stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '')) {
    const url = await run(repoDir, ['remote', 'get-url', name], { ...opts, allowFailure: true });
    entries.push({ name, url: url.ok ? url.stdout.trim() : '' });
  }
  return { ok: true, entries };
}

/** Add a remote. */
export async function remoteAdd(repoDir, name, url, opts = {}) {
  if (!usableName(name) || !usableName(url)) return { ok: false, error: 'a remote needs a name and a URL' };
  const out = await run(repoDir, ['remote', 'add', name, url], { ...opts, allowFailure: true });
  return out.ok ? { ok: true } : { ok: false, error: out.error ?? 'git remote add failed' };
}

/** Point an existing remote at a different URL. */
export async function remoteSetUrl(repoDir, name, url, opts = {}) {
  if (!usableName(name) || !usableName(url)) return { ok: false, error: 'a remote needs a name and a URL' };
  const out = await run(repoDir, ['remote', 'set-url', name, url], { ...opts, allowFailure: true });
  return out.ok ? { ok: true } : { ok: false, error: out.error ?? 'git remote set-url failed' };
}

/** Remove a remote. */
export async function remoteRemove(repoDir, name, opts = {}) {
  if (!usableName(name)) return { ok: false, error: 'no remote name was given' };
  const out = await run(repoDir, ['remote', 'remove', name], { ...opts, allowFailure: true });
  return out.ok ? { ok: true } : { ok: false, error: out.error ?? 'git remote remove failed' };
}

/** Every tag name. */
export async function tagList(repoDir, opts = {}) {
  const out = await run(repoDir, ['tag', '--list'], { ...opts, allowFailure: true });
  if (!out.ok) return { ok: false, error: out.error ?? 'git tag --list failed', tags: [] };
  return { ok: true, tags: out.stdout.split('\n').filter((line) => line !== '') };
}

/** Create a tag at HEAD, or at `at` when given; annotated when `message` is. */
export async function tagCreate(repoDir, name, opts = {}) {
  if (!usableName(name)) return { ok: false, error: 'no tag name was given' };
  const argv = ['tag'];
  const message = typeof opts.message === 'string' && opts.message.trim() !== '' ? opts.message : undefined;
  if (message === undefined) argv.push(name);
  else argv.push('-a', name, '-m', message);
  const at = typeof opts.at === 'string' && opts.at.trim() !== '' ? opts.at.trim() : undefined;
  if (at !== undefined) argv.push(at);
  const out = await run(repoDir, argv, { ...opts, allowFailure: true });
  return out.ok ? { ok: true } : { ok: false, error: out.error ?? 'git tag failed' };
}

/** Delete a local tag. */
export async function tagDelete(repoDir, name, opts = {}) {
  if (!usableName(name)) return { ok: false, error: 'no tag name was given' };
  const out = await run(repoDir, ['tag', '-d', name], { ...opts, allowFailure: true });
  return out.ok ? { ok: true } : { ok: false, error: out.error ?? 'git tag -d failed' };
}

/**
 * Publish one ref to a remote, or delete it there with `refs/tags/<name>`-style
 * `:refs/...` syntax. Used for tags, which a branch push never sends.
 */
export async function pushRef(repoDir, remote, refspec, opts = {}) {
  if (!usableName(remote) || !usableName(refspec)) return { ok: false, error: 'a ref push needs a remote and a ref' };
  const out = await run(repoDir, ['push', remote, refspec], { timeoutMs: Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : NETWORK_TIMEOUT_MS, ...opts });
  return out.ok ? { ok: true } : { ok: false, error: out.error ?? 'git push failed' };
}

/** The `--global`/`--local` scope arguments for a config call. */
function scopeArgs(opts) {
  return opts !== null && typeof opts === 'object' && opts.global === true ? ['--global'] : [];
}

/** Whether a caller-supplied ref is safe to hand to git as an operand. */
function usableRef(ref) {
  return typeof ref === 'string' && ref.trim() !== '' && !looksLikeOption(ref.trim());
}

/** Whether a caller-supplied name (remote, tag, URL) is safe as one operand. */
function usableName(name) {
  return typeof name === 'string' && name.trim() !== '' && !looksLikeOption(name.trim());
}
/** First non-empty line of a multi-line message, or undefined. */
function firstLine(text) {
  const line = String(text ?? '').split('\n').map((value) => value.trim()).find((value) => value !== '');
  return line === undefined ? undefined : line;
}
