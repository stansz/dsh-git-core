/**
 * lib/session-files.mjs - which files this session touched, by repository.
 *
 * The store decides what the automatic commit may touch, so the tests pin the
 * two properties that matter: a row is never forged by a filename, and the
 * newest rows survive the size cap (the work a turn end still has to commit).
 */

import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { cleanupTempDirs, tempDir } from "./helpers.mjs";

import {
  forgetRepo,
  indexPath,
  pathsOf,
  record,
  registerSessionFiles,
  reposOf,
  safeSessionId,
  targetPath,
} from "../lib/session-files.mjs";

after(cleanupTempDirs);

/** A fresh store root for one test: <tempdir>/state. */
function freshRoot() {
  return join(tempDir("dsh-git-core-touched-"), "state");
}

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

describe("safeSessionId() and indexPath()", () => {
  test("a session id becomes one filename with no separators", () => {
    assert.equal(safeSessionId("session-1_abc"), "session-1_abc");
    assert.equal(safeSessionId("a/b c"), "a_b_c");
    // Every character outside the safe set becomes one underscore.
    assert.equal(safeSessionId("a\\b:c*d"), "a_b_c_d");
    assert.equal(safeSessionId(""), "unknown");
    assert.equal(safeSessionId(undefined), "unknown");
    assert.equal(safeSessionId(42), "unknown");
  });

  test("the index path lives at <stateRoot>/dsh-git/touched/<safe id>.log", () => {
    const stateRoot = freshRoot();
    assert.equal(indexPath("s1", { stateRoot }), join(stateRoot, "dsh-git", "touched", "s1.log"));
    assert.equal(indexPath("a/b", { stateRoot }), join(stateRoot, "dsh-git", "touched", "a_b.log"));
  });

  test("the default root follows $DSH_HOME and then $DSH_PROFILE_DIR", () => {
    const home = tempDir("dsh-git-core-home-");
    withEnv({ DSH_HOME: home, DSH_PROFILE_DIR: undefined }, () => {
      assert.equal(indexPath("s1"), join(home, "state", "dsh-git", "touched", "s1.log"));
    });
    withEnv({ DSH_HOME: undefined, DSH_PROFILE_DIR: join(home, "profiles", "desk") }, () => {
      assert.equal(indexPath("s1"), join(home, "state", "dsh-git", "touched", "s1.log"));
    });
  });
});

describe("record()", () => {
  test("appends one JSON row per touched file and reports success", () => {
    const stateRoot = freshRoot();
    const repoRoot = tempDir("dsh-git-core-repo-");
    assert.equal(record("s1", repoRoot, repoRoot + "/a.mjs", { stateRoot }), true);
    assert.equal(record("s1", repoRoot, repoRoot + "/b.mjs", { stateRoot }), true);
    const lines = readFileSync(indexPath("s1", { stateRoot }), "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[0]), { repoRoot, path: repoRoot + "/a.mjs" });
    assert.deepEqual(JSON.parse(lines[1]), { repoRoot, path: repoRoot + "/b.mjs" });
  });

  test("the store is created private to this user", () => {
    const stateRoot = freshRoot();
    const repoRoot = tempDir("dsh-git-core-repo-");
    record("s1", repoRoot, repoRoot + "/a.mjs", { stateRoot });
    assert.equal(statSync(join(stateRoot, "dsh-git")).mode & 0o077, 0);
    assert.equal(statSync(join(stateRoot, "dsh-git", "touched")).mode & 0o077, 0);
    assert.equal(statSync(indexPath("s1", { stateRoot })).mode & 0o077, 0);
  });

  test("an unusable argument records nothing", () => {
    const stateRoot = freshRoot();
    const repoRoot = tempDir("dsh-git-core-repo-");
    for (const args of [
      ["", repoRoot, repoRoot + "/a.mjs"],
      ["s1", "", repoRoot + "/a.mjs"],
      ["s1", repoRoot, ""],
      [undefined, repoRoot, repoRoot + "/a.mjs"],
      ["s1", undefined, repoRoot + "/a.mjs"],
      ["s1", repoRoot, undefined],
    ]) {
      assert.equal(record(...args, { stateRoot }), false);
    }
    assert.equal(existsSync(indexPath("s1", { stateRoot })), false);
  });

  test("a path containing a newline cannot forge a second row", () => {
    const stateRoot = freshRoot();
    const repoRoot = tempDir("dsh-git-core-repo-");
    const nasty = repoRoot + "/line\nbreak.mjs";
    assert.equal(record("s1", repoRoot, nasty, { stateRoot }), true);
    const text = readFileSync(indexPath("s1", { stateRoot }), "utf8");
    assert.equal(text.trim().split("\n").length, 1);
    assert.deepEqual(pathsOf("s1", repoRoot, { stateRoot }), [nasty]);
  });

  test("an unwritable store is a false, not a throw", () => {
    const fileAsDir = join(tempDir(), "file-as-directory");
    writeFileSync(fileAsDir, "x");
    assert.equal(record("s1", "/repo", "/repo/a", { stateRoot: join(fileAsDir, "state") }), false);
  });
});

describe("reposOf() and pathsOf()", () => {
  test("distinct repositories come back most-recently-touched first", () => {
    const stateRoot = freshRoot();
    const first = tempDir("dsh-git-core-repo-");
    const second = tempDir("dsh-git-core-repo-");
    record("s1", first, first + "/a", { stateRoot });
    record("s1", second, second + "/b", { stateRoot });
    record("s1", first, first + "/c", { stateRoot });
    assert.deepEqual(reposOf("s1", { stateRoot }), [first, second]);
  });

  test("files of one repository come back most-recent first, deduplicated", () => {
    const stateRoot = freshRoot();
    const repoRoot = tempDir("dsh-git-core-repo-");
    const other = tempDir("dsh-git-core-repo-");
    record("s1", repoRoot, repoRoot + "/a", { stateRoot });
    record("s1", repoRoot, repoRoot + "/b", { stateRoot });
    record("s1", other, other + "/elsewhere", { stateRoot });
    record("s1", repoRoot, repoRoot + "/a", { stateRoot });
    assert.deepEqual(pathsOf("s1", repoRoot, { stateRoot }), [repoRoot + "/a", repoRoot + "/b"]);
    assert.deepEqual(pathsOf("s1", other, { stateRoot }), [other + "/elsewhere"]);
  });

  test("a session that never recorded anything has no repositories and no files", () => {
    const stateRoot = freshRoot();
    assert.deepEqual(reposOf("nobody", { stateRoot }), []);
    assert.deepEqual(pathsOf("nobody", "/repo", { stateRoot }), []);
  });

  test("a torn final line and garbage lines are skipped, never fatal", () => {
    const stateRoot = freshRoot();
    const repoRoot = tempDir("dsh-git-core-repo-");
    const file = indexPath("torn", { stateRoot });
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, [
      "garbage",
      JSON.stringify({ repoRoot, path: repoRoot + "/good" }),
      "{\"repoRoot\":",
      "",
    ].join("\n"));
    assert.deepEqual(reposOf("torn", { stateRoot }), [repoRoot]);
    assert.deepEqual(pathsOf("torn", repoRoot, { stateRoot }), [repoRoot + "/good"]);
  });
});

describe("the size cap", () => {
  test("an oversized store is trimmed to its newest rows instead of being emptied", () => {
    const stateRoot = freshRoot();
    const repoRoots = [0, 1, 2, 3, 4].map(() => tempDir("dsh-git-core-repo-"));
    const file = indexPath("cap", { stateRoot });
    mkdirSync(join(file, ".."), { recursive: true });
    const rows = [];
    for (let index = 0; index < 2200; index += 1) {
      rows.push(JSON.stringify({
        repoRoot: repoRoots[index % repoRoots.length],
        path: "/file-" + index + "-" + "x".repeat(420),
      }));
    }
    writeFileSync(file, rows.join("\n") + "\n");
    const before = statSync(file).size;
    assert.equal(before > 1_000_000, true);

    const repos = reposOf("cap", { stateRoot });
    // The newest row is index 2199: repoRoots[2199 % 5] = repoRoots[4].
    assert.equal(repos[0], repoRoots[4]);
    const after = statSync(file).size;
    assert.equal(after <= 1_000_000, true);
    assert.equal(after > 0, true);
    // The rows a turn end still has to commit are the ones that were kept.
    assert.equal(pathsOf("cap", repos[0], { stateRoot }).length > 0, true);
  });

  test("a single row larger than the cap is kept: a record just written is never dropped", () => {
    const stateRoot = freshRoot();
    const repoRoot = tempDir("dsh-git-core-repo-");
    const file = indexPath("huge", { stateRoot });
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, JSON.stringify({ repoRoot, path: "/huge-" + "y".repeat(1_100_000) }) + "\n");
    assert.deepEqual(reposOf("huge", { stateRoot }), [repoRoot]);
  });
});

describe("forgetRepo()", () => {
  test("removes one repository rows and leaves every other repository alone", () => {
    const stateRoot = freshRoot();
    const first = tempDir("dsh-git-core-repo-");
    const second = tempDir("dsh-git-core-repo-");
    record("s1", first, first + "/a", { stateRoot });
    record("s1", second, second + "/b", { stateRoot });
    record("s1", first, first + "/c", { stateRoot });
    assert.equal(forgetRepo("s1", first, { stateRoot }), true);
    assert.deepEqual(reposOf("s1", { stateRoot }), [second]);
    assert.deepEqual(pathsOf("s1", first, { stateRoot }), []);
    // Forgetting again is the same state being asked for, and does not rewrite
    // the file (so it cannot race an append that landed after the read).
    const before = readFileSync(indexPath("s1", { stateRoot }), "utf8");
    assert.equal(forgetRepo("s1", first, { stateRoot }), true);
    assert.equal(readFileSync(indexPath("s1", { stateRoot }), "utf8"), before);
  });

  test("no store yet is already the state being asked for", () => {
    const stateRoot = freshRoot();
    assert.equal(forgetRepo("never", "/repo", { stateRoot }), true);
    assert.equal(existsSync(indexPath("never", { stateRoot })), false);
  });

  test("invalid arguments are refused", () => {
    const stateRoot = freshRoot();
    assert.equal(forgetRepo("", "/repo", { stateRoot }), false);
    assert.equal(forgetRepo("s1", "", { stateRoot }), false);
  });

  test("a store that cannot be rewritten reports failure", () => {
    const stateRoot = freshRoot();
    const repoRoot = tempDir("dsh-git-core-repo-");
    record("s1", repoRoot, repoRoot + "/a", { stateRoot });
    chmodSync(indexPath("s1", { stateRoot }), 0o400);
    assert.equal(forgetRepo("s1", repoRoot, { stateRoot }), false);
  });
});

describe("targetPath()", () => {
  const cases = [
    [{ name: "write", arguments: { file_path: "/a" } }, "/a"],
    [{ name: "edit", arguments: { path: "/b" } }, "/b"],
    [{ name: "str_replace_editor", arguments: { filePath: "/c" } }, "/c"],
    [{ name: "notebook_edit", arguments: { notebook_path: "/d" } }, "/d"],
    [{ name: "apply_patch", arguments: { target_file: "/e" } }, "/e"],
    // An empty argument falls through to the next path argument name.
    [{ name: "write", arguments: { file_path: "", path: "/fallback" } }, "/fallback"],
    [{ name: "write", arguments: { file_path: 42 } }, undefined],
    [{ name: "read", arguments: { file_path: "/f" } }, undefined],
    [{ name: "bash", arguments: { command: "ls" } }, undefined],
    [{ name: "write", arguments: null }, undefined],
    [{ name: "write" }, undefined],
    [{}, undefined],
    [null, undefined],
  ];

  for (const [exec, expected] of cases) {
    test("targetPath(" + JSON.stringify(exec) + ") is " + JSON.stringify(expected), () => {
      assert.equal(targetPath(exec), expected);
    });
  }
});

describe("registerSessionFiles()", () => {
  /** A fake Cordis context that captures the one listener registered on it. */
  function fakeContext() {
    const listeners = new Map();
    return {
      listeners,
      ctx: {
        on(event, listener) {
          listeners.set(event, listener);
        },
      },
    };
  }

  test("registers one tools/pre-execute listener that records the resolved file", async () => {
    const stateRoot = freshRoot();
    const repoRoot = tempDir("dsh-git-core-repo-");
    const { listeners, ctx } = fakeContext();
    const calls = [];
    registerSessionFiles(ctx, { stateRoot }, async (path, info) => {
      calls.push({ path, info });
      return { repoRoot, path: repoRoot + "/resolved.mjs" };
    });
    assert.deepEqual([...listeners.keys()], ["tools/pre-execute"]);

    const next = async () => "next-result";
    const agent = { id: "session-7" };
    const result = await listeners.get("tools/pre-execute")({
      name: "write",
      arguments: { file_path: "/raw/path.mjs" },
      agent,
    }, next);
    assert.equal(result, "next-result");
    // The resolver was asked with the session working directory information.
    assert.deepEqual(calls, [{ path: "/raw/path.mjs", info: { agent, sessionId: "session-7" } }]);
    // The record names the resolved path, not the raw argument.
    assert.deepEqual(pathsOf("session-7", repoRoot, { stateRoot }), [repoRoot + "/resolved.mjs"]);
  });

  test("a non-mutating tool passes through without resolving or recording anything", async () => {
    const stateRoot = freshRoot();
    const { listeners, ctx } = fakeContext();
    let resolverCalls = 0;
    registerSessionFiles(ctx, { stateRoot }, async () => {
      resolverCalls += 1;
      return { repoRoot: "/repo", path: "/repo/x" };
    });
    let nextCalls = 0;
    await listeners.get("tools/pre-execute")({ name: "read", arguments: { file_path: "/a" }, agent: { id: "s" } }, async () => {
      nextCalls += 1;
    });
    assert.equal(resolverCalls, 0);
    assert.equal(nextCalls, 1);
  });

  test("a call with no session id passes through unrecorded", async () => {
    const stateRoot = freshRoot();
    const { listeners, ctx } = fakeContext();
    registerSessionFiles(ctx, { stateRoot }, async () => ({ repoRoot: "/repo", path: "/repo/x" }));
    let nextCalls = 0;
    await listeners.get("tools/pre-execute")({ name: "write", arguments: { file_path: "/a" } }, async () => {
      nextCalls += 1;
    });
    assert.equal(nextCalls, 1);
    // Nothing was recorded because there is no session to record it under.
    assert.deepEqual(reposOf("", { stateRoot }), []);
  });

  test("a resolver that throws never blocks the edit and records nothing", async () => {
    const stateRoot = freshRoot();
    const { listeners, ctx } = fakeContext();
    registerSessionFiles(ctx, { stateRoot }, async () => {
      throw new Error("repository lookup failed");
    });
    let nextCalls = 0;
    const result = await listeners.get("tools/pre-execute")({
      name: "write", arguments: { file_path: "/a" }, agent: { session: "session-9" },
    }, async () => {
      nextCalls += 1;
      return "ok";
    });
    assert.equal(nextCalls, 1);
    assert.equal(result, "ok");
    assert.deepEqual(reposOf("session-9", { stateRoot }), []);
  });

  test("an unresolved repository is not recorded", async () => {
    const stateRoot = freshRoot();
    const { listeners, ctx } = fakeContext();
    registerSessionFiles(ctx, { stateRoot }, async () => ({ repoRoot: undefined, path: "/r" }));
    let nextCalls = 0;
    await listeners.get("tools/pre-execute")({
      name: "write", arguments: { file_path: "/a" }, agent: { id: "session-10" },
    }, async () => {
      nextCalls += 1;
    });
    assert.equal(nextCalls, 1);
    assert.deepEqual(reposOf("session-10", { stateRoot }), []);
  });

  test("without a resolver the recorder degrades to a pass-through", async () => {
    const stateRoot = freshRoot();
    const { listeners, ctx } = fakeContext();
    registerSessionFiles(ctx, { stateRoot }, undefined);
    let nextCalls = 0;
    await listeners.get("tools/pre-execute")({
      name: "write", arguments: { file_path: "/a" }, agent: { id: "session-11" },
    }, async () => {
      nextCalls += 1;
      return "passed";
    });
    assert.equal(nextCalls, 1);
  });
});