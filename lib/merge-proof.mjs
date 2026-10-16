/**
 * The proof that a task branch's work reached the base - and the reason it is
 * the *commit* that is proof, never the branch name.
 *
 * Whether a branch may be deleted is the one decision in this plugin that
 * cannot be undone, so it rests on exactly one question: **does a merged pull
 * request cover the commit this branch points at right now?** A pull request
 * whose *name* matches is not an answer. Reusing a slug is the normal flow -
 * start a task called fix-the-login-bug, merge it, then start another task with
 * the same name - and the second task's branch carries the same name as a merged
 * one. Matching on the name alone deleted that second task's newest commit,
 * silently, from a sweep nobody asked to be destructive.
 *
 * The API hands back head.sha in the same response it hands back the name, so
 * the check costs nothing: the merged pull request's head must be the very
 * commit about to be deleted. A branch that moved after its merge - one commit,
 * or twenty - fails that test and is kept. Kept is the safe direction: a branch
 * that is not proven disposable is reported, never removed.
 *
 * Squash is why the API is consulted at all. A squash rewrites the commits, so
 * the branch is not an ancestor of the base and no local rule can see that the
 * work landed. The head sha recorded at merge time is the only surviving
 * statement of what was merged, and it is a statement about a commit.
 *
 * This module is pure: it takes the pull requests as parsed JSON and returns a
 * verdict. No network, no git, no filesystem - which is what makes the rule
 * itself testable, rather than testable only through a live API.
 */

/** A git object id: 40 hex for SHA-1, 64 for the SHA-256 object format. */
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;

/** Non-empty trimmed text, or undefined. */
function text(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Whether a string is a commit id, in the form a branch tip arrives as.
 *
 * The tip is required for every deletion, and a caller that forgot to pass one
 * must never be read as a caller with nothing to prove: an absent proof is a
 * refusal, and this is how it is recognised.
 */
export function isCommitId(value) {
  const trimmed = text(value);
  return trimmed !== undefined && OBJECT_ID.test(trimmed);
}

/**
 * One pull request reduced to the fields a deletion may rest on.
 *
 * Everything else in the payload is discarded on purpose: a field that cannot
 * influence the verdict must not be able to influence it.
 *
 * @param {object} entry - one element of the pull-request list response.
 * @returns {{number?: number, url?: string, head?: string, headSha?: string,
 *   base?: string, mergedAt?: string, mergeCommitSha?: string}|undefined}
 *   undefined when the entry is not a pull request with a readable head.
 */
export function normalizePull(entry) {
  if (entry === null || typeof entry !== 'object') return undefined;
  const head = entry.head !== null && typeof entry.head === 'object' ? entry.head : undefined;
  const base = entry.base !== null && typeof entry.base === 'object' ? entry.base : undefined;
  const record = {
    number: Number.isInteger(entry.number) ? entry.number : undefined,
    url: text(entry.html_url),
    head: text(head?.ref),
    headSha: text(head?.sha),
    base: text(base?.ref),
    mergedAt: text(entry.merged_at),
    mergeCommitSha: text(entry.merge_commit_sha),
  };
  if (record.head === undefined) return undefined;
  return record;
}

/** Normalize a whole response, dropping what cannot be read. */
export function normalizePulls(data) {
  if (!Array.isArray(data)) return [];
  return data.map((entry) => normalizePull(entry)).filter((entry) => entry !== undefined);
}

/**
 * Does a merged pull request cover this exact commit?
 *
 * The order of the checks is the order of the reasons a caller needs to read:
 * no pull request at all from this branch, one that never merged, one that
 * merged a *different* commit, one that merged into a *different* base.
 *
 * @param {Array<object>} pulls - normalized pull requests, newest first.
 * @param {{branch: string, tip: string, base?: string}} opts - branch is the
 *   head branch name, tip the commit the branch points at now, and base the
 *   branch the work was supposed to land in.
 * @returns {{proven: boolean, reason?: string, number?: number, url?: string,
 *   headSha?: string, mergeCommitSha?: string, base?: string,
 *   seenBase?: string, branch?: string}} reason is one of: no-branch, no-tip,
 *   no-pull, not-merged, tip-moved, base-mismatch.
 */
export function proveMergedPull(pulls, opts = {}) {
  const branch = text(opts.branch);
  if (branch === undefined) return { proven: false, reason: 'no-branch' };
  const tip = text(opts.tip);
  if (!isCommitId(tip)) return { proven: false, reason: 'no-tip', branch };
  const base = text(opts.base);
  const list = Array.isArray(pulls) ? pulls : [];

  const forBranch = list.filter((entry) => entry !== null && typeof entry === 'object' && entry.head === branch);
  const merged = forBranch.filter((entry) => text(entry.mergedAt) !== undefined);
  if (merged.length === 0) {
    return { proven: false, reason: forBranch.length === 0 ? 'no-pull' : 'not-merged', branch };
  }

  // The whole rule, in one line: the merged pull request's head is this commit.
  const exact = merged.filter((entry) => entry.headSha === tip);
  if (exact.length === 0) {
    const nearest = merged[0];
    return {
      proven: false,
      reason: 'tip-moved',
      branch,
      number: nearest.number,
      url: nearest.url,
      headSha: nearest.headSha,
    };
  }

  const based = base === undefined ? exact : exact.filter((entry) => entry.base === base);
  if (based.length === 0) {
    const nearest = exact[0];
    return {
      proven: false,
      reason: 'base-mismatch',
      branch,
      number: nearest.number,
      url: nearest.url,
      headSha: nearest.headSha,
      seenBase: nearest.base,
    };
  }

  const found = based[0];
  return {
    proven: true,
    number: found.number,
    url: found.url,
    headSha: found.headSha,
    mergeCommitSha: found.mergeCommitSha,
    base: found.base,
  };
}

/**
 * The verdict as one sentence, for the report a caller hands back.
 *
 * A kept line that does not say why is how a caller learns to stop reading
 * them, and the interesting case here - a merged pull request that covers a
 * *different* commit - is indistinguishable from nothing was found without it.
 */
export function describeProof(verdict) {
  const reason = verdict?.reason;
  const where = verdict?.number === undefined ? '' : ' (pull request #' + String(verdict.number) + ')';
  if (verdict?.proven === true) return 'a merged pull request covers this commit' + where;
  if (reason === 'tip-moved') {
    return 'a merged pull request exists for this branch' + where
      + ', but it merged ' + String(verdict.headSha ?? 'another commit').slice(0, 12)
      + ' and the branch points somewhere else now, so the newer commit is not covered';
  }
  if (reason === 'base-mismatch') {
    return 'a merged pull request' + where + ' landed in ' + String(verdict.seenBase ?? 'another branch')
      + ', not in the base this cleanup is about';
  }
  if (reason === 'not-merged') return 'a pull request from this branch exists but was not merged';
  if (reason === 'no-pull') return 'no pull request from this branch was found';
  if (reason === 'no-tip') return 'the commit this branch points at could not be read, so nothing can be proven about it';
  if (reason === 'no-branch') return 'no branch name was given';
  return 'not proven';
}
