# dsh-git-core

The shared core of the dsh-git bundles. One place a git command is run
(`git.mjs`), one state store (`state.mjs`), one record of which files a session
changed (`session-files.mjs`), and the merge proofs (`merge-proof.mjs`).

It is a library, not a plugin: no patch row, nothing registered. The bundles that
use it (`dsh-git`, and the worktrees bundle when it is split out) re-export it
through their own `lib/<module>.mjs` shim, which resolves it by probing the
sibling directory, `$DSH_PROFILE_DIR`, and the working directory — the same
approach this codebase already uses for schemastery, because a `link:` install
does not hoist a bundle's dependencies.
