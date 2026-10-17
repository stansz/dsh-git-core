/**
 * lib/state.mjs - the per-session state store.
 *
 * The store is the truth across a Host restart, so the tests are about
 * durability and failure modes: a corrupt file costs precision and never an
 * exception, a partial write never erases the other half, two processes cannot
 * silently overwrite each other, and a crash left lock does not wedge the plugin
 * forever. Every test gets its own state root.
 */

import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  cleanupTempDirs,
  initCommittedRepo,
  tempDir,
  tempDirWithRaw,
} from "./helpers.mjs";

import {
  addWorktree,
  clearPushFailure,
  forgetVanished,
  readSession,
  recordPushFailure,
  removeWorktree,
  safeSessionId,
  shouldRetryPush,
  statePath,
  writeSession,
} from "../lib/state.mjs";

after(cleanupTempDirs);

/** A fresh state root for one test: <tempdir>/state. */
function freshRoot() {
  return join(tempDir("dsh-git-core-state-"), "state");
}

/** An ISO timestamp "seconds" after "base" (both in epoch milliseconds). */
function at(base, seconds) {
  return new Date(base + seconds * 1000).toISOString();
}

const T0 = Date.parse("2025-01-01T00:00:00.000Z");

/** Run fn with the given environment variables set (undefined deletes). */
function withEnv(values, fn) {
  const saved = new Map();
  for (const [key, value] of Object.entries(values)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Whether a path exists, without a second stat import at every call site. */
function exists(path) {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

let keyCounter = 0;
/** A unique, non-empty path key for the wrong-type fixtures. */
function freeKey() {
  keyCounter += 1;
  return join(tempDir("dsh-git-core-key-"), "repo-" + keyCounter);
}

describe("safeSessionId()", () => {
  test("keeps a plain id and the characters a filename can hold", () => {
    assert.equal(safeSessionId("session-2cfd2cf0_32bc"), "session-2cfd2cf0_32bc");
    assert.equal(safeSessionId("a.b-c_D"), "a.b-c_D");
  });

  test("escapes path separators, parent references and spaces so the file stays a direct child", () => {
    const escaped = [
      safeSessionId("a/b"),
      safeSessionId("../x"),
      safeSessionId("a b%c"),
      safeSessionId("back\\\\slash"),
    ];
    for (const id of escaped) {
      assert.equal(id.includes("/"), false);
      assert.equal(id.includes("\\\\"), false);
    }
    assert.equal(safeSessionId("a/b"), "a%2Fb");
    assert.equal(safeSessionId("../x"), "%2E%2E%2Fx");
    // The encoding is injective: percent itself is escaped, so no two ids collide.
    assert.notEqual(safeSessionId("a%2Fb"), safeSessionId("a/b"));
  });

  test("escapes leading and trailing dots instead of dropping them", () => {
    assert.equal(safeSessionId(".."), "%2E%2E");
    assert.equal(safeSessionId(".hidden"), "%2Ehidden");
    assert.equal(safeSessionId("hidden."), "hidden%2E");
    // The mapping stays one-to-one: these are not collapsed to the same name.
    assert.notEqual(safeSessionId(".."), safeSessionId("."));
  });

  test("an empty or missing id becomes a deterministic digest name", () => {
    const empty = safeSessionId("");
    assert.match(empty, /^session-[0-9a-f]{16}$/);
    assert.equal(safeSessionId(undefined), empty);
    assert.equal(safeSessionId(null), empty);
    assert.equal(safeSessionId(""), empty);
  });

  test("a very long id is truncated to a bounded, still-distinct filename", () => {
    const long = safeSessionId("x".repeat(300));
    assert.equal(long.length <= 120, true);
    assert.match(long, /^x+-[0-9a-f]{16}$/);
    const longer = safeSessionId("x".repeat(301));
    assert.notEqual(long, longer);
  });
});

describe("statePath()", () => {
  test("is an absolute path inside <stateRoot>/dsh-git/sessions", () => {
    const stateRoot = freshRoot();
    const path = statePath("s1", { stateRoot });
    assert.equal(path, join(stateRoot, "dsh-git", "sessions", "s1.json"));
    assert.equal(path.startsWith("/"), true);
  });

  test("a traversal session id still names a direct child of the sessions directory", () => {
    const stateRoot = freshRoot();
    const sessions = join(stateRoot, "dsh-git", "sessions");
    for (const id of ["../../etc/passwd", "..", "", "a/b/c"]) {
      const path = statePath(id, { stateRoot });
      assert.equal(join(path, ".."), sessions);
    }
  });

  test("two different sessions never share one file", () => {
    const stateRoot = freshRoot();
    assert.notEqual(statePath("a", { stateRoot }), statePath("b", { stateRoot }));
    assert.notEqual(statePath("a/b", { stateRoot }), statePath("a%2Fb", { stateRoot }));
  });

  test("the default root follows $DSH_HOME, then $DSH_PROFILE_DIR, then ~/.dsh", () => {
    const home = tempDir("dsh-git-core-home-");
    withEnv({ DSH_HOME: home, DSH_PROFILE_DIR: undefined }, () => {
      assert.equal(statePath("s1"), join(home, "state", "dsh-git", "sessions", "s1.json"));
    });
    withEnv({ DSH_HOME: undefined, DSH_PROFILE_DIR: join(home, "profiles", "desk") }, () => {
      assert.equal(statePath("s1"), join(home, "state", "dsh-git", "sessions", "s1.json"));
    });
    withEnv({ DSH_HOME: undefined, DSH_PROFILE_DIR: undefined }, () => {
      assert.match(statePath("s1"), /\/\.dsh\/state\/dsh-git\/sessions\/s1\.json$/);
    });
  });
});

describe("readSession() and writeSession()", () => {
  test("a missing file reads as the documented empty state", () => {
    assert.deepEqual(readSession("nobody", { stateRoot: freshRoot() }), {
      sessionId: "nobody",
      worktrees: [],
      pushFailures: {},
      updatedAt: null,
    });
  });

  test("write then read round-trips worktrees and push failures", () => {
    const stateRoot = freshRoot();
    const repoRoot = tempDir("dsh-git-core-repo-");
    const worktreePath = tempDir("dsh-git-core-wt-");
    assert.equal(writeSession("s1", {
      worktrees: [{
        repo: "example", repoRoot, path: worktreePath, branch: "task-1", slug: "task-1",
      }],
      pushFailures: { [repoRoot]: { attempts: 2, nextAttemptAt: at(T0, 300) } },
    }, { stateRoot }), true);

    const state = readSession("s1", { stateRoot });
    assert.equal(state.sessionId, "s1");
    assert.match(state.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(state.worktrees.length, 1);
    assert.equal(state.worktrees[0].repoRoot, repoRoot);
    assert.equal(state.worktrees[0].path, worktreePath);
    assert.equal(state.worktrees[0].branch, "task-1");
    assert.match(state.worktrees[0].createdAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(state.pushFailures[repoRoot], { attempts: 2, nextAttemptAt: at(T0, 300) });
  });

  test("the store is created private and written through a temp file", () => {
    const stateRoot = freshRoot();
    const repoRoot = tempDir("dsh-git-core-repo-");
    assert.equal(writeSession("s1", { worktrees: [{ repoRoot, path: repoRoot }] }, { stateRoot }), true);
    const sessions = join(stateRoot, "dsh-git", "sessions");
    // Group/other have no business reading which paths this session works on.
    assert.equal(statSync(join(stateRoot, "dsh-git")).mode & 0o077, 0);
    assert.equal(statSync(sessions).mode & 0o077, 0);
    assert.equal(statSync(statePath("s1", { stateRoot })).mode & 0o077, 0);
    assert.match(readFileSync(statePath("s1", { stateRoot }), "utf8"), /"worktrees"/);
  });

  test("a partial write keeps fields it does not mention, and an explicit empty list clears them", () => {
    const stateRoot = freshRoot();
    const repoRoot = tempDir("dsh-git-core-repo-");
    writeSession("s1", { worktrees: [{ repoRoot, path: repoRoot, branch: "task" }] }, { stateRoot });
    // A push-failure update is not allowed to erase the worktree list.
    writeSession("s1", { pushFailures: { [repoRoot]: { attempts: 1, nextAttemptAt: at(T0, 60) } } }, { stateRoot });
    assert.equal(readSession("s1", { stateRoot }).worktrees.length, 1);
    // An explicitly empty array is a request to clear.
    writeSession("s1", { worktrees: [] }, { stateRoot });
    assert.equal(readSession("s1", { stateRoot }).worktrees.length, 0);
  });

  test("corrupt, truncated and non-object files read as empty instead of throwing", () => {
    const stateRoot = freshRoot();
    const path = statePath("broken", { stateRoot });
    mkdirSync(join(path, ".."), { recursive: true });
    for (const corrupt of ["{not json", "", "[]", "null", "\"a string\"", "42"]) {
      writeFileSync(path, corrupt);
      assert.deepEqual(readSession("broken", { stateRoot }), {
        sessionId: "broken", worktrees: [], pushFailures: {}, updatedAt: null,
      });
    }
  });

  test("fields of the wrong type are dropped rather than trusted", () => {
    const stateRoot = freshRoot();
    const repoRoot = tempDir("dsh-git-core-repo-");
    const path = statePath("typed", { stateRoot });
    mkdirSync(join(path, ".."), { recursive: true });
    const oddKey = freeKey();
    writeFileSync(path, JSON.stringify({
      sessionId: 42,
      worktrees: [
        null,
        "not an entry",
        { branch: "no-path" },
        { path: "" },
        { path: repoRoot, repo: 7, branch: null, createdAt: 9 },
      ],
      pushFailures: {
        "": { attempts: 1 },
        [repoRoot]: "not a record",
        [oddKey]: { attempts: 0, nextAttemptAt: "not-a-time", error: 5 },
      },
    }));
    const state = readSession("typed", { stateRoot });
    assert.equal(state.sessionId, "typed");
    assert.equal(state.worktrees.length, 1);
    assert.equal(state.worktrees[0].path, repoRoot);
    assert.equal(state.worktrees[0].repo, "", "wrong-typed fields become empty strings");
    assert.match(state.worktrees[0].createdAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(state.pushFailures[oddKey], { attempts: 1, nextAttemptAt: "not-a-time" });
  });

  test("sessions are isolated from each other", () => {
    const stateRoot = freshRoot();
    const repoRoot = tempDir("dsh-git-core-repo-");
    writeSession("one", { worktrees: [{ repoRoot, path: repoRoot }] }, { stateRoot });
    writeSession("two", { worktrees: [] }, { stateRoot });
    assert.equal(readSession("one", { stateRoot }).worktrees.length, 1);
    assert.equal(readSession("two", { stateRoot }).worktrees.length, 0);
  });

  test("an unwritable state directory is a false, not an exception", async () => {
    const fileAsDir = join(tempDir(), "file-as-directory");
    writeFileSync(fileAsDir, "x");
    const stateRoot = join(fileAsDir, "state");
    assert.equal(writeSession("s1", {}, { stateRoot }), false);
    const repoRoot = await initCommittedRepo();
    assert.equal(addWorktree("s1", { repoRoot, path: repoRoot }, { stateRoot }), false);
    assert.equal(recordPushFailure("s1", repoRoot, "boom", { stateRoot, now: T0 }).persisted, false);
  });
});

describe("addWorktree()", () => {
  test("records the documented fields and derives createdAt", () => {
    const stateRoot = freshRoot();
    const repoRoot = tempDir("dsh-git-core-repo-");
    const worktree = tempDir("dsh-git-core-wt-");
    assert.equal(addWorktree("s1", {
      repo: "example", repoRoot, path: worktree, branch: "task-1", slug: "task-1",
    }, { stateRoot }), true);
    const entry = readSession("s1", { stateRoot }).worktrees[0];
    assert.equal(entry.repo, "example");
    assert.equal(entry.repoRoot, repoRoot);
    assert.equal(entry.path, worktree);
    assert.equal(entry.branch, "task-1");
    assert.equal(entry.slug, "task-1");
    assert.match(entry.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  });

  test("re-adding the same path replaces that record instead of duplicating it", () => {
    const stateRoot = freshRoot();
    const repoRoot = tempDir("dsh-git-core-repo-");
    const worktree = tempDir("dsh-git-core-wt-");
    addWorktree("s1", { repoRoot, path: worktree, branch: "first" }, { stateRoot });
    addWorktree("s1", { repoRoot, path: worktree, branch: "second" }, { stateRoot });
    const entries = readSession("s1", { stateRoot }).worktrees;
    assert.equal(entries.length, 1);
    assert.equal(entries[0].branch, "second");
  });

  test("a repository may own several worktrees in one session: identity is the path", () => {
    const stateRoot = freshRoot();
    const repoRoot = tempDir("dsh-git-core-repo-");
    const first = tempDir("dsh-git-core-wt-");
    const second = tempDir("dsh-git-core-wt-");
    addWorktree("s1", { repoRoot, path: first, branch: "task-1" }, { stateRoot });
    addWorktree("s1", { repoRoot, path: second, branch: "task-2" }, { stateRoot });
    assert.deepEqual(readSession("s1", { stateRoot }).worktrees.map((entry) => entry.branch), ["task-1", "task-2"]);
  });

  test("an entry with no path is refused and nothing is written", () => {
    const stateRoot = freshRoot();
    assert.equal(addWorktree("s1", { repoRoot: "/tmp/x" }, { stateRoot }), false);
    assert.equal(addWorktree("s1", { path: "" }, { stateRoot }), false);
    assert.equal(addWorktree("s1", null, { stateRoot }), false);
    assert.equal(readSession("s1", { stateRoot }).updatedAt, null);
    assert.equal(exists(statePath("s1", { stateRoot })), false);
  });
});

describe("removeWorktree()", () => {
  test("matches a repository realpath-aware, so /var and /private/var are one repository", () => {
    const stateRoot = freshRoot();
    const { raw, real } = tempDirWithRaw("dsh-git-core-repo-");
    const worktree = tempDir("dsh-git-core-wt-");
    addWorktree("s1", { repoRoot: real, path: worktree, branch: "task" }, { stateRoot });
    // The caller may hold the un-realpath-ed spelling of the same directory.
    assert.equal(removeWorktree("s1", raw, { stateRoot }), true);
    assert.deepEqual(readSession("s1", { stateRoot }).worktrees, []);
  });

  test("opts.path and opts.slug narrow the removal to one worktree", () => {
    const stateRoot = freshRoot();
    const repoRoot = tempDir("dsh-git-core-repo-");
    const first = tempDir("dsh-git-core-wt-");
    const second = tempDir("dsh-git-core-wt-");
    addWorktree("s1", { repoRoot, path: first, branch: "one", slug: "one" }, { stateRoot });
    addWorktree("s1", { repoRoot, path: second, branch: "two", slug: "two" }, { stateRoot });
    assert.equal(removeWorktree("s1", repoRoot, { stateRoot, path: first }), true);
    assert.deepEqual(readSession("s1", { stateRoot }).worktrees.map((entry) => entry.slug), ["two"]);
    assert.equal(removeWorktree("s1", repoRoot, { stateRoot, slug: "two" }), true);
    assert.deepEqual(readSession("s1", { stateRoot }).worktrees, []);
  });

  test("drops the push-failure backoff keyed by the retired worktree in the same write", () => {
    const stateRoot = freshRoot();
    const repoRoot = tempDir("dsh-git-core-repo-");
    const { raw, real } = tempDirWithRaw("dsh-git-core-wt-");
    // The backoff is recorded against the worktree path while it exists (and so
    // is stored realpath-ed), then the worktree directory is deleted.
    assert.equal(recordPushFailure("s1", real, "network down", { stateRoot, now: T0 }).persisted, true);
    addWorktree("s1", { repoRoot, path: raw, branch: "task" }, { stateRoot });
    rmSync(raw, { recursive: true, force: true });
    // The retire path holds the spelling it knows; the directory is gone, so the
    // backoff key stored realpath-ed must still match it through the parent.
    assert.equal(removeWorktree("s1", repoRoot, { stateRoot, path: raw }), true);
    const state = readSession("s1", { stateRoot });
    assert.deepEqual(state.worktrees, []);
    assert.deepEqual(state.pushFailures, {});
  });

  test("nothing matched is a success for a readable file and a failure for an unreadable one", () => {
    const stateRoot = freshRoot();
    const repoRoot = tempDir("dsh-git-core-repo-");
    // No file at all: nothing to drop is the state being asked for.
    assert.equal(removeWorktree("s1", repoRoot, { stateRoot }), true);
    // A file that exists but cannot be read is a guess, so it must not claim success.
    const path = statePath("broken", { stateRoot });
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "{not json");
    assert.equal(removeWorktree("broken", repoRoot, { stateRoot }), false);
  });

  test("arguments that identify nothing are refused", () => {
    const stateRoot = freshRoot();
    assert.equal(removeWorktree("s1", "", { stateRoot }), false);
    assert.equal(removeWorktree("s1", undefined, { stateRoot }), false);
  });
});

describe("forgetVanished()", () => {
  test("drops the records whose directory is gone, and only those, in one write", () => {
    const stateRoot = freshRoot();
    const repoRoot = tempDir("dsh-git-core-repo-");
    const keep = tempDir("dsh-git-core-wt-");
    const gone = tempDir("dsh-git-core-wt-");
    const goneForPush = tempDir("dsh-git-core-wt-");
    addWorktree("s1", { repoRoot, path: keep, branch: "keep" }, { stateRoot });
    addWorktree("s1", { repoRoot, path: gone, branch: "gone" }, { stateRoot });
    recordPushFailure("s1", keep, "still here", { stateRoot, now: T0 });
    recordPushFailure("s1", goneForPush, "worktree retired", { stateRoot, now: T0 });
    rmSync(gone, { recursive: true, force: true });
    rmSync(goneForPush, { recursive: true, force: true });

    const result = forgetVanished("s1", { stateRoot });
    assert.deepEqual(result.worktrees, [gone]);
    assert.deepEqual(result.pushFailures, [goneForPush]);
    assert.equal(result.persisted, true);
    const state = readSession("s1", { stateRoot });
    assert.deepEqual(state.worktrees.map((entry) => entry.path), [keep]);
    assert.deepEqual(Object.keys(state.pushFailures), [keep]);

    // Nothing vanished the second time, and a second call writes nothing.
    assert.deepEqual(forgetVanished("s1", { stateRoot }), { worktrees: [], pushFailures: [], persisted: true });
  });

  test("a session that never wrote a state file gets no state file", () => {
    const stateRoot = freshRoot();
    assert.deepEqual(forgetVanished("never-used", { stateRoot }), {
      worktrees: [], pushFailures: [], persisted: true,
    });
    assert.equal(exists(statePath("never-used", { stateRoot })), false);
  });

  test("reports persisted:false when the drop cannot be written", () => {
    const fileAsDir = join(tempDir(), "file-as-directory");
    writeFileSync(fileAsDir, "x");
    assert.deepEqual(forgetVanished("s1", { stateRoot: join(fileAsDir, "state") }), {
      worktrees: [], pushFailures: [], persisted: false,
    });
  });
});

describe("recordPushFailure(), shouldRetryPush() and clearPushFailure()", () => {
  test("the first failure schedules a retry one minute later", () => {
    const stateRoot = freshRoot();
    const repoRoot = tempDir("dsh-git-core-repo-");
    const recorded = recordPushFailure("s1", repoRoot, "could not resolve host", { stateRoot, now: T0 });
    assert.equal(recorded.attempts, 1);
    assert.equal(recorded.nextAttemptAt, at(T0, 60));
    assert.equal(recorded.persisted, true);
    assert.equal(shouldRetryPush("s1", repoRoot, T0, { stateRoot }), false);
    assert.equal(shouldRetryPush("s1", repoRoot, T0 + 59_999, { stateRoot }), false);
    assert.equal(shouldRetryPush("s1", repoRoot, T0 + 60_000, { stateRoot }), true);
  });

  test("the schedule backs off 60s, 5min, 15min, then an hour, and stays at an hour", () => {
    const stateRoot = freshRoot();
    const repoRoot = tempDir("dsh-git-core-repo-");
    const delays = [60, 300, 900, 3600, 3600, 3600];
    let now = T0;
    for (let index = 0; index < delays.length; index += 1) {
      const recorded = recordPushFailure("s1", repoRoot, "failure " + index, { stateRoot, now });
      assert.equal(recorded.attempts, index + 1);
      assert.equal(recorded.nextAttemptAt, at(now, delays[index]));
      now += delays[index] * 1000;
    }
  });

  test("shouldRetryPush accepts a Date, an ISO string and epoch milliseconds", () => {
    const stateRoot = freshRoot();
    const repoRoot = tempDir("dsh-git-core-repo-");
    recordPushFailure("s1", repoRoot, "boom", { stateRoot, now: T0 });
    assert.equal(shouldRetryPush("s1", repoRoot, new Date(T0 + 60_000), { stateRoot }), true);
    assert.equal(shouldRetryPush("s1", repoRoot, at(T0, 60), { stateRoot }), true);
    assert.equal(shouldRetryPush("s1", repoRoot, T0 + 60_000, { stateRoot }), true);
  });

  test("unknown repositories, unknown times and unreadable records all fail open", () => {
    const stateRoot = freshRoot();
    const repoRoot = tempDir("dsh-git-core-repo-");
    assert.equal(shouldRetryPush("s1", repoRoot, T0, { stateRoot }), true);
    assert.equal(shouldRetryPush("s1", "", T0, { stateRoot }), true);
    assert.equal(shouldRetryPush("s1", undefined, T0, { stateRoot }), true);
    recordPushFailure("s1", repoRoot, "boom", { stateRoot, now: T0 });
    assert.equal(shouldRetryPush("s1", repoRoot, "not-a-date", { stateRoot }), true);
    // A record whose nextAttemptAt cannot be parsed must not stop pushing forever.
    const path = statePath("s1", { stateRoot });
    const stored = JSON.parse(readFileSync(path, "utf8"));
    stored.pushFailures[Object.keys(stored.pushFailures)[0]].nextAttemptAt = "garbage";
    writeFileSync(path, JSON.stringify(stored));
    assert.equal(shouldRetryPush("s1", repoRoot, T0, { stateRoot }), true);
    // So must a fully corrupt state file.
    writeFileSync(path, "{not json");
    assert.equal(shouldRetryPush("s1", repoRoot, T0, { stateRoot }), true);
  });

  test("backoff is per repository: one repository failure does not hold another back", () => {
    const stateRoot = freshRoot();
    const first = tempDir("dsh-git-core-repo-");
    const second = tempDir("dsh-git-core-repo-");
    recordPushFailure("s1", first, "boom", { stateRoot, now: T0 });
    assert.equal(shouldRetryPush("s1", first, T0, { stateRoot }), false);
    assert.equal(shouldRetryPush("s1", second, T0, { stateRoot }), true);
    assert.equal(recordPushFailure("s1", second, "boom", { stateRoot, now: T0 }).attempts, 1);
  });

  test("the push key is realpath-aware, so two spellings of one repository share a backoff", () => {
    const stateRoot = freshRoot();
    const { raw, real } = tempDirWithRaw("dsh-git-core-repo-");
    recordPushFailure("s1", raw, "boom", { stateRoot, now: T0 });
    assert.equal(shouldRetryPush("s1", real, T0, { stateRoot }), false);
  });

  test("clearPushFailure drops the record; clearing an empty store is a success", () => {
    const stateRoot = freshRoot();
    const repoRoot = tempDir("dsh-git-core-repo-");
    recordPushFailure("s1", repoRoot, "boom", { stateRoot, now: T0 });
    assert.equal(clearPushFailure("s1", repoRoot, { stateRoot }), true);
    assert.equal(shouldRetryPush("s1", repoRoot, T0, { stateRoot }), true);
    // Nothing recorded is the state being asked for.
    assert.equal(clearPushFailure("s1", repoRoot, { stateRoot }), true);
    assert.equal(clearPushFailure("s1", "", { stateRoot }), false);
  });

  test("when the state file cannot be written the schedule is reported but not persisted", async () => {
    const fileAsDir = join(tempDir(), "file-as-directory");
    writeFileSync(fileAsDir, "x");
    const stateRoot = join(fileAsDir, "state");
    const repoRoot = await initCommittedRepo();
    const recorded = recordPushFailure("s1", repoRoot, "boom", { stateRoot, now: T0 });
    assert.equal(recorded.persisted, false);
    assert.equal(recorded.attempts, 1);
    assert.equal(recorded.nextAttemptAt, at(T0, 60));
    // Nothing is on disk, so the next push must not be held back.
    assert.equal(shouldRetryPush("s1", repoRoot, T0, { stateRoot }), true);
  });
});

describe("state locking", () => {
  /** A state root with one session file and an optional fresh lock beside it. */
  function lockedStore(sessionId) {
    const stateRoot = freshRoot();
    const path = statePath(sessionId, { stateRoot });
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify({ sessionId, worktrees: [], pushFailures: {}, updatedAt: null }));
    return { stateRoot, path, lock: path + ".lock" };
  }

  test("a lock held by a live writer blocks the write instead of writing unsynchronised", () => {
    const { stateRoot, path, lock } = lockedStore("s1");
    writeFileSync(lock, "99999\n");
    const repoRoot = tempDir("dsh-git-core-repo-");
    const started = Date.now();
    assert.equal(addWorktree("s1", { repoRoot, path: repoRoot }, { stateRoot }), false);
    const elapsed = Date.now() - started;
    // The wait is bounded by the documented deadline, and the other writer lock
    // is left in place for its owner to remove.
    assert.equal(elapsed >= 1500, true);
    assert.equal(exists(lock), true);
    assert.equal(readSession("s1", { stateRoot }).worktrees.length, 0);
    assert.equal(exists(path), true);
  });

  test("a lock left behind by a killed process is broken and the write succeeds", () => {
    const { stateRoot, lock } = lockedStore("s1");
    writeFileSync(lock, "99999\n");
    const old = new Date(Date.now() - 20_000);
    utimesSync(lock, old, old);
    const repoRoot = tempDir("dsh-git-core-repo-");
    assert.equal(addWorktree("s1", { repoRoot, path: repoRoot }, { stateRoot }), true);
    assert.equal(exists(lock), false);
    assert.equal(readSession("s1", { stateRoot }).worktrees.length, 1);
  });

  test("a failed push under a live lock is reported with persisted:false, not swallowed", () => {
    const { stateRoot, lock } = lockedStore("s2");
    writeFileSync(lock, "99999\n");
    const repoRoot = tempDir("dsh-git-core-repo-");
    const recorded = recordPushFailure("s2", repoRoot, "boom", { stateRoot, now: T0 });
    assert.equal(recorded.persisted, false);
    assert.equal(recorded.attempts, 1);
    assert.equal(recorded.nextAttemptAt, at(T0, 60));
  });
});