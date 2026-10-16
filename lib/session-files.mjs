/**
 * Which files this session has touched, by repository.
 *
 * This exists to answer one question honestly: **when a turn ends, which
 * repositories are this session's to commit?**
 *
 * There are two bad answers, and one of them is bad in a way that is easy to
 * miss.
 *
 * Answer one: "the repository the session's working directory is in". Wrong
 * whenever the workspace root is not itself a repository — the layout here —
 * because a session that edited `dsh-foo/src/x.mjs` then looks like it touched
 * nothing at all.
 *
 * Answer two: "every repository under the working directory with a dirty tree".
 * This is what the automatic turn sync originally did, and it is right for one
 * session working alone. It is actively wrong once several sessions share a
 * checkout: an Agent Team's teammates are separate sessions dirtying the same
 * filesystem, so this answer commits **their** work in progress under **this**
 * session's turn number. Nothing is lost, but the attribution is scrambled and
 * the commits are not the ones anybody asked for.
 *
 * So the session keeps its own list, keyed by repository. Every mutating file
 * operation the tools layer dispatches is recorded through the same interception
 * point the shipped `@deepseek-ai/dsh-workspace-changes` recorder uses, and a
 * turn end commits only what appears in it. Another session's edits are
 * reported, never committed.
 *
 * The store is a plain one-line-per-record file rather than memory, because a
 * Host restart mid-task must not lose the fact that work is uncommitted. Rows
 * are `{repoRoot, path}`, both absolute; the newest row wins. Past
 * `MAX_BYTES` a read keeps the newest rows and drops the oldest, so the cap
 * narrows what is remembered instead of erasing it.
 *
 * Only `node:` builtins are imported, and every function is fail-soft: an
 * unusable store costs precision, never the process.
 */

import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Tools whose arguments name a file this session is about to change. */
const MUTATING_TOOLS = new Set(['write', 'edit', 'str_replace_editor', 'notebook_edit', 'apply_patch']);

/** Argument names that carry a target path, across the file tools. */
const PATH_ARGUMENTS = ['file_path', 'path', 'filePath', 'notebook_path', 'target_file'];

/** Session ids become file names, so anything outside this set is escaped. */
const UNSAFE_ID = /[^A-Za-z0-9._-]/gu;

/** Above this size a read keeps the newest rows and drops the oldest. */
const MAX_BYTES = 1_000_000;

/**
 * The modes the store is created with.
 *
 * The store names the files a session is editing, so it is private for the same
 * reason the session state is: another user on the machine has no business
 * reading which paths this session works on. The directory is 0700 and the log
 * is 0600, matching `state.mjs`.
 */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * A session id that cannot escape the store directory.
 *
 * A session id containing a path separator would otherwise let the store be
 * written anywhere the process can reach, which is not worth saving an escape.
 */
export function safeSessionId(sessionId) {
  const text = typeof sessionId === 'string' && sessionId !== '' ? sessionId : 'unknown';
  return text.replace(UNSAFE_ID, '_');
}

/** Where one session's touched paths are recorded. */
export function indexPath(sessionId, opts = {}) {
  const root = typeof opts?.stateRoot === 'string' && opts.stateRoot !== ''
    ? opts.stateRoot
    : join(dshHome(), 'state');
  return join(root, 'dsh-git', 'touched', safeSessionId(sessionId) + '.log');
}

/**
 * The Harness home, resolved the same way every shipped package resolves it.
 *
 * Duplicated from `config.mjs` rather than imported so this module keeps the
 * property that makes it testable: no relative imports, no git, nothing but
 * `node:` builtins. Three lines of duplication is a smaller cost than a module
 * that cannot be exercised on its own.
 */
function dshHome(env = process.env) {
  const configured = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  if (configured !== '') return configured;
  const profileDir = typeof env?.DSH_PROFILE_DIR === 'string' ? env.DSH_PROFILE_DIR.trim() : '';
  if (profileDir !== '') {
    const parts = profileDir.split(/[/\\]/u);
    if (parts.length >= 3 && parts[parts.length - 2] === 'profiles') {
      return parts.slice(0, -2).join('/');
    }
  }
  return join(process.env.HOME ?? process.cwd(), '.dsh');
}

/**
 * Record that this session changed one file in one repository.
 *
 * A JSON string per line, so a filename containing a newline cannot forge a
 * second record — the same reason the git parsers use NUL separators.
 */
export function record(sessionId, repoRoot, path, opts = {}) {
  if (typeof sessionId !== 'string' || sessionId === '') return false;
  if (typeof repoRoot !== 'string' || repoRoot === '') return false;
  if (typeof path !== 'string' || path === '') return false;
  const file = indexPath(sessionId, opts);
  try {
    mkdirSync(join(file, '..'), { recursive: true, mode: DIR_MODE });
    appendFileSync(file, JSON.stringify({ repoRoot, path }) + '\n', { encoding: 'utf8', mode: FILE_MODE });
    return true;
  } catch {
    return false;
  }
}

/**
 * The rows in one store's text, oldest first.
 *
 * A line that is not a complete row is skipped, never fatal: an interrupted
 * write leaves a torn final line, and losing the rest of the store over it is
 * the failure this module cannot afford.
 */
function parseRows(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    try {
      const row = JSON.parse(line);
      if (typeof row?.repoRoot === 'string' && row.repoRoot !== '' && typeof row?.path === 'string' && row.path !== '') {
        out.push(row);
      }
    } catch {
      /* a torn final line from an interrupted write is not a reason to lose the rest */
    }
  }
  return out;
}

/** One row exactly as the store holds it, newline included. */
function serializeRow(row) {
  return JSON.stringify(row) + '\n';
}

/**
 * The newest rows that fit within MAX_BYTES, oldest first.
 *
 * The newest row is kept even when it alone is larger than the cap. The store
 * exists so that work is not forgotten, and a cap that could discard the record
 * just written would defeat exactly that.
 */
function newestWithin(list) {
  let bytes = 0;
  let start = list.length;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const size = Buffer.byteLength(serializeRow(list[index]), 'utf8');
    if (start < list.length && bytes + size > MAX_BYTES) break;
    bytes += size;
    start = index;
  }
  return list.slice(start);
}

/** Replace a store's contents with these rows. Fail-soft: false when it cannot write. */
function rewrite(file, list) {
  try {
    writeFileSync(file, list.map(serializeRow).join(''), { encoding: 'utf8', mode: FILE_MODE });
    return true;
  } catch {
    return false;
  }
}

/**
 * Every parsed row, oldest first. Unparseable lines are skipped, never fatal.
 *
 * Past the cap the store is trimmed to its newest rows, on the read path that
 * finds it too large — never emptied. The rows a turn end still has to commit
 * are the newest ones, so wiping them is how a long session commits nothing
 * while reporting nothing. An unusable store costs precision, never the
 * process: a trim that cannot be written is shrugged off.
 */
function rows(sessionId, opts) {
  const file = indexPath(sessionId, opts);
  let text;
  let oversized;
  try {
    oversized = statSync(file).size > MAX_BYTES;
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const parsed = parseRows(text);
  if (!oversized) return parsed;
  const kept = newestWithin(parsed);
  rewrite(file, kept);
  return kept;
}

/**
 * The distinct repositories this session has touched, most recently touched
 * first.
 *
 * Read once at turn end. A path that could not be resolved to a repository was
 * never recorded, so nothing here is guessed at — which is the point: this list
 * decides what the automatic commit is allowed to touch.
 */
export function reposOf(sessionId, opts = {}) {
  const seen = new Set();
  const order = [];
  const list = rows(sessionId, opts);
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const root = list[index].repoRoot;
    if (seen.has(root)) continue;
    seen.add(root);
    order.push(root);
  }
  return order;
}

/** The files this session touched in one repository, most recent first. */
export function pathsOf(sessionId, repoRoot, opts = {}) {
  const seen = new Set();
  const order = [];
  const list = rows(sessionId, opts);
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const row = list[index];
    if (row.repoRoot !== repoRoot) continue;
    if (seen.has(row.path)) continue;
    seen.add(row.path);
    order.push(row.path);
  }
  return order;
}

/**
 * Forget one repository's rows, and only that repository's rows.
 *
 * The turn boundary needs the narrow one: a repository whose automatic commit
 * has landed is done with, while the session's other repositories may still
 * hold work in progress. Without it the store only ever grows, and its cap
 * becomes the thing that decides what a turn still remembers.
 *
 * Fail-soft like everything here: false when the store cannot be written.
 * Otherwise true, including when the store already held nothing for this
 * repository — that is the state being asked for.
 */
export function forgetRepo(sessionId, repoRoot, opts = {}) {
  if (typeof sessionId !== 'string' || sessionId === '') return false;
  if (typeof repoRoot !== 'string' || repoRoot === '') return false;
  const file = indexPath(sessionId, opts);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    // No store yet means nothing is recorded for this repository, which is the
    // state being asked for rather than a failure.
    return true;
  }
  const parsed = parseRows(text);
  const kept = parsed.filter((row) => row.repoRoot !== repoRoot);
  // Leave the file untouched when it holds nothing of this repository, so a
  // no-op forget cannot race an append that landed after the read.
  if (kept.length === parsed.length) return true;
  return rewrite(file, kept);
}

/**
 * The file path a pending tool call is about, or undefined when the call is not
 * a mutating file operation.
 *
 * Exported because this decision — which tool, which argument — is worth testing
 * directly, and because a wrong answer here quietly changes what the automatic
 * commit may touch.
 */
export function targetPath(exec) {
  const name = typeof exec?.name === 'string' ? exec.name : '';
  if (!MUTATING_TOOLS.has(name)) return undefined;
  const args = exec?.arguments;
  if (args === null || typeof args !== 'object') return undefined;
  for (const key of PATH_ARGUMENTS) {
    const value = args[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

/**
 * Register the recorder.
 *
 * A `tools/pre-execute` listener: the same interception point the shipped turn
 * recorder uses, so an edit cannot precede its own record. It is synchronous and
 * cheap — a Set lookup for any tool that is not a file mutation.
 *
 * `resolveRepo` is injected rather than imported because resolving a repository
 * needs git, and this module stays dependency-free so it can be reasoned about
 * and tested on its own. A path whose repository cannot be resolved is simply
 * not recorded; the turn end then reports that repository as untouched rather
 * than committing something whose ownership is unclear.
 */
export function registerSessionFiles(ctx, rowConfig, resolveRepo) {
  const stateRoot = typeof rowConfig?.stateRoot === 'string' && rowConfig.stateRoot !== ''
    ? rowConfig.stateRoot
    : undefined;

  ctx.on('tools/pre-execute', async (exec, next) => {
    const path = targetPath(exec);
    if (path === undefined || typeof resolveRepo !== 'function') return next();
    const sessionId = String(exec?.agent?.id ?? exec?.agent?.session ?? '');
    if (sessionId === '') return next();
    try {
      // The session is passed through because resolving a relative path needs
      // *that* session's working directory. Reaching for "the" session would
      // pick whichever one the context happens to expose, which in a team of
      // sessions is the wrong one.
      const resolved = await resolveRepo(path, { agent: exec?.agent, sessionId });
      if (resolved?.repoRoot !== undefined && resolved?.path !== undefined) {
        record(sessionId, resolved.repoRoot, resolved.path, { stateRoot });
      }
    } catch {
      // Recording is best effort by design: a failure here narrows what the turn
      // end may commit, and must never block the edit the user actually asked for.
    }
    return next();
  });
}
