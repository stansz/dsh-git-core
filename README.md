# dsh-git-core

The shared core of the dsh-git bundles: one place a git command is run
(`lib/git.mjs`), one state store (`lib/state.mjs`), one record of which files
a session changed (`lib/session-files.mjs`), and the proof that a task branch's
work reached the base (`lib/merge-proof.mjs`).

It is used by [dsh-git](https://github.com/stansz/dsh-git) (the git tool, the
flow guard and the reconciler) and by
[dsh-git-worktrees](https://github.com/stansz/dsh-git-worktrees) (the worktree
tool and the edit guard).

It is a library, not a plugin. It registers no tool, no command, no patch row
and no listener of its own, and installing it alone does nothing you can
observe: no commit, no push, no guard. The behaviour lives in the bundles; this
package is the code they share.

This README is about the library. For what an installed bundle does, read the
README of [dsh-git](https://github.com/stansz/dsh-git) or
[dsh-git-worktrees](https://github.com/stansz/dsh-git-worktrees).

## The modules

Each module imports only `node:` builtins, so a bundle that shells out to git
does not itself depend on the thing it is inspecting.

### `lib/git.mjs` — the one place a git command is run

`run(repoDir, args, opts)` is the single door. No shell is ever involved
(argv only), a git that is not installed is a returned error rather than a
thrown exception, a hung git is killed and reported as `timedOut`, and the
child environment is `process.env` plus `GIT_TERMINAL_PROMPT=0`,
`GIT_ASKPASS=''`, `GIT_OPTIONAL_LOCKS=0` and `LC_ALL=C` — HOME and PATH are
deliberately left alone, because they are what keep the machine's gitconfig,
user identity and credential helper working.

Exports:

- availability: `gitAvailable`, `resolveGit`
- running one command: `run`
- authentication failures, in git's own words: `credentialHint`,
  `explainCredentialFailure`
- repository identity: `toplevel`, `commonDir`, `isRepo`
- worktrees: `parseWorktrees`, `listWorktrees`
- status, branch and history: `parseStatus`, `repoState`, `computeSync`,
  `ancestry`, `remotes`, `defaultBranchOf`, `currentBranch`, `hasHead`,
  `aheadOf`
- changes and committing: `changedPaths`, `stagePaths`, `commit`
- remote traffic: `push`, `fetch`, `fastForward`, `mergeBase`,
  `remoteUrlFor`, `revParse`, `upstreamRef`, `pushRef`
- rebase and merge: `rebase`, `rebaseAbort`, `merge`, `mergeAbort`,
  `conflictedPaths`
- config, remotes and tags: `configList`, `configGet`, `configSet`,
  `configUnset`, `remoteList`, `remoteAdd`, `remoteSetUrl`,
  `remoteRemove`, `tagList`, `tagCreate`, `tagDelete`

Two parsing details are load-bearing and are the reason these helpers exist
rather than ad-hoc parsing at each call site: `status --porcelain=v2 -z` is
never C-quoted, so a filename with a space, a newline or a backslash arrives
verbatim inside a NUL-delimited record; and `worktree list --porcelain`
reports realpaths, so on macOS a `/tmp/...` path comes back as
`/private/tmp/...`. `listWorktrees` returns `undefined` — not an empty array
— when git fails, because "git could not answer" read as "no worktree has it"
is how a branch gets deleted out from under a live worktree.

### `lib/state.mjs` — what a session remembers about its git work

Two facts survive a Host restart: which worktrees this session owns, and which
pushes failed. The file is the truth — nothing is cached in memory between
calls — and every read-modify-write runs as one synchronous stretch with the
state file held exclusively across processes, written to a temporary file and
renamed into place.

The file is `<stateRoot>/dsh-git/sessions/<safeSessionId>.json`, where
`stateRoot` is the caller's override, else `<harness home>/state` — `$DSH_HOME`
when it is set, else the home derived from `$DSH_PROFILE_DIR`, else `~/.dsh`. Session ids are escaped before they become a filename. Every
function is fail-soft: an unreadable, corrupt or unwritable state file costs an
ownership line or a retry schedule, never an exception across a module
boundary.

Exports: `safeSessionId`, `statePath`, `readSession`, `writeSession`,
`addWorktree`, `removeWorktree`, `forgetVanished`, `recordPushFailure`,
`shouldRetryPush`, `clearPushFailure`.

A stored session carries `worktrees` and `pushFailures`. `addWorktree`
identifies a worktree by its path, so a repository may have several in one
session; `removeWorktree` matches a repository realpath-aware, and drops the
push-failure backoff keyed by that path in the same write, because a retired
worktree can never be pushed from again. Push backoff is per repository: 60
seconds, then 5 minutes, 15 minutes, and an hour thereafter.

### `lib/session-files.mjs` — which files this session touched

This answers one question at the turn boundary: which repositories are this
session's to commit? The session keeps its own list, keyed by repository,
rather than committing "every dirty repository under the working directory" —
with several sessions sharing a checkout, that answer commits another session's
work in progress.

The store is `<stateRoot>/dsh-git/touched/<safeSessionId>.log`: one JSON row
per line, `{repoRoot, path}`, both absolute; the newest row wins. It is a file
rather than memory because a Host restart mid-task must not lose the fact that
work is uncommitted; past 1 MB a read keeps the newest rows and drops the
oldest, so the cap narrows what is remembered instead of erasing it.

Exports: `safeSessionId`, `indexPath`, `record`, `reposOf`, `pathsOf`,
`forgetRepo`, `targetPath`, `registerSessionFiles`.

`registerSessionFiles(ctx, rowConfig, resolveRepo)` is the one function here
that attaches a listener — a `tools/pre-execute` listener that records the
target of each mutating file operation before it runs. The core never calls it.
A bundle calls it with its own context, its own config and its own repository
resolver; dsh-git is the bundle that does. Until a bundle calls it, the core
has registered nothing.

### `lib/merge-proof.mjs` — the proof a branch's work landed

Whether a branch may be deleted rests on one question: does a merged pull
request cover the commit this branch points at *right now*? A pull request whose
name matches is not an answer — reusing a slug is normal — so the merged pull
request's head sha must be the very commit about to be deleted, and a branch
that moved after its merge is kept and reported.

The module is pure: it takes pull requests as parsed JSON and returns a verdict.
No network, no git, no filesystem. Squash is why the pull request data is
consulted at all: a squash rewrites the commits, so no local ancestry rule can
see that the work landed.

Exports: `isCommitId`, `normalizePull`, `normalizePulls`,
`proveMergedPull`, `describeProof`. A verdict carries `proven` and, when not
proven, a `reason` of `no-branch`, `no-tip`, `no-pull`, `not-merged`,
`tip-moved` or `base-mismatch`; `describeProof` turns that into one sentence
for a report.

## How a bundle consumes it

Both bundles declare `"dsh-git-core": "link:../dsh-git-core"`, and a `link:`
install does not hoist a bundle's dependencies. A bare
`import 'dsh-git-core/git.mjs'` therefore cannot resolve: Node walks up
from the importing file's real path in the workspace, never through the
profile's `node_modules`. This is the same approach dsh-git already uses to
resolve its schemastery dependency, applied to the core.

Each bundle ships a small `lib/core-loader.mjs` with one export,
`loadCore(name)`, and thin shims — `lib/git.mjs`, `lib/state.mjs`,
`lib/merge-proof.mjs`, and `dsh-git`'s `lib/session-files.mjs` — that re-export
the core's names and add no logic. The loader tries four locations in order:

1. the sibling directory — `../../dsh-git-core/lib/<name>`, relative to the
   loader's own URL (a checkout beside the bundle)
2. `$DSH_PROFILE_DIR/node_modules/dsh-git-core/lib/<name>` — skipped when
   `$DSH_PROFILE_DIR` is unset (an installed bundle)
3. `<cwd>/dsh-git-core/lib/<name>` (a sibling of the working directory)
4. `<cwd>/node_modules/dsh-git-core/lib/<name>`

The first location that imports wins. When none does, the loader throws one
sentence naming what is missing rather than a bare `ERR_MODULE_NOT_FOUND` at
activation:

> dsh-git-core is not installed: could not load `<name>` from any of N
> locations. Install the dsh-git-core bundle beside this one. Tried: ...

(`N` is the number of locations tried: four when `$DSH_PROFILE_DIR` is set,
three when it is not.)

The core's own `package.json` exposes the same four modules as subpath exports
(`dsh-git-core/git.mjs`, `dsh-git-core/state.mjs`,
`dsh-git-core/session-files.mjs`, `dsh-git-core/merge-proof.mjs`), so a
consumer that *can* resolve the package directly may import it by name.

## The empty bundle patch, and the install order

`package.json` declares:

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

and `cordis.patch.yml` contains an empty list. The patch exists for one
reason: the installer only treats a package as an installable bundle when it
declares `dsh.bundle.patch`. Installing this package puts it in the profile's
`node_modules`, which is what makes it resolvable by the bundles that depend on
it. No row is inserted, because there is nothing to mount.

So it is installed first:

1. `dsh-git-core`
2. then [dsh-git](https://github.com/stansz/dsh-git) and/or
   [dsh-git-worktrees](https://github.com/stansz/dsh-git-worktrees)

`core + dsh-git` is the minimum for the everyday flow with automatic commit and
push. A bundle installed without the core fails at activation with the sentence
above, which names the missing core. Installing the core alone changes nothing.

## Files

- `lib/git.mjs` — the git operations layer.
- `lib/state.mjs` — the per-session state store: owned worktrees, push backoff.
- `lib/session-files.mjs` — the record of which files a session changed, and
  the recorder a bundle registers.
- `lib/merge-proof.mjs` — the merged-pull-request proof, pure.
- `cordis.patch.yml` — deliberately empty; installed, mounts nothing.
