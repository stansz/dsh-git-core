/**
 * lib/merge-proof.mjs - the proof a branch work landed.
 *
 * The module is pure, so these are table-driven unit tests over the exact
 * question a deletion rests on: does a MERGED pull request head point at the
 * very commit the branch points at NOW? A matching name is not an answer.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  describeProof,
  isCommitId,
  normalizePull,
  normalizePulls,
  proveMergedPull,
} from "../lib/merge-proof.mjs";

const TIP = "a".repeat(40);
const MOVED = "b".repeat(40);
const MERGE_COMMIT = "c".repeat(40);
const SHA256_TIP = "d".repeat(64);
const URL = "https://github.com/stansz/example/pull/7";

/** A realistic GitHub pull-request payload (the shape the API returns). */
function rawPull({
  number = 7,
  branch = "task-branch",
  sha = TIP,
  base = "main",
  mergedAt = "2025-01-01T00:00:00Z",
  mergeCommitSha = MERGE_COMMIT,
  url = URL,
} = {}) {
  return {
    number,
    html_url: url,
    state: "closed",
    title: "a title the verdict must ignore",
    head: { ref: branch, sha, label: "stansz:" + branch },
    base: { ref: base, sha: "e".repeat(40) },
    merged_at: mergedAt,
    merge_commit_sha: mergeCommitSha,
    user: { login: "stansz" },
  };
}

/** Normalize one payload the way proveMergedPull expects it. */
function pull(options = {}) {
  return normalizePull(rawPull(options));
}

describe("isCommitId()", () => {
  test("accepts a 40-hex SHA-1 and a 64-hex SHA-256 object id", () => {
    assert.equal(isCommitId(TIP), true);
    assert.equal(isCommitId(SHA256_TIP), true);
    assert.equal(isCommitId("0123456789abcdef0123456789abcdef01234567"), true);
  });

  test("trims surrounding whitespace before deciding", () => {
    assert.equal(isCommitId("  " + TIP + "  "), true);
  });

  test("refuses anything that is not exactly a lowercase object id", () => {
    const rejected = [
      TIP.slice(0, 39),
      TIP + "a",
      SHA256_TIP.slice(0, 63),
      SHA256_TIP + "d",
      TIP.slice(0, 39) + "A",
      TIP.toUpperCase(),
      "not-a-sha",
      "",
      "   ",
      undefined,
      null,
      42,
      ["a".repeat(40)],
    ];
    for (const value of rejected) assert.equal(isCommitId(value), false);
  });
});

describe("normalizePull() and normalizePulls()", () => {
  test("reduces a payload to exactly the fields a verdict may rest on", () => {
    const normalized = pull();
    assert.deepEqual(normalized, {
      number: 7,
      url: URL,
      head: "task-branch",
      headSha: TIP,
      base: "main",
      mergedAt: "2025-01-01T00:00:00Z",
      mergeCommitSha: MERGE_COMMIT,
    });
    // Everything else in the payload is discarded on purpose.
    assert.deepEqual(Object.keys(normalized).sort(), [
      "base", "head", "headSha", "mergeCommitSha", "mergedAt", "number", "url",
    ]);
  });

  test("drops what cannot be read and keeps the fields that are optional", () => {
    assert.equal(normalizePull(null), undefined);
    assert.equal(normalizePull("a pull request"), undefined);
    assert.equal(normalizePull(42), undefined);
    assert.equal(normalizePull({ number: 1, html_url: URL }), undefined);
    assert.equal(normalizePull({ number: 1, head: {} }), undefined);
    assert.equal(normalizePull({ number: 1, head: { ref: "   " } }), undefined);

    const minimal = normalizePull({ head: { ref: "branch" } });
    assert.deepEqual(minimal, {
      number: undefined,
      url: undefined,
      head: "branch",
      headSha: undefined,
      base: undefined,
      mergedAt: undefined,
      mergeCommitSha: undefined,
    });
    // A non-integer number and null merged_at are absent, not trusted.
    assert.equal(normalizePull({ number: 1.5, head: { ref: "b" }, merged_at: null }).number, undefined);
    assert.equal(normalizePull({ head: { ref: "b" }, merged_at: null }).mergedAt, undefined);
  });

  test("normalizePulls filters unreadable entries and preserves the API order", () => {
    const normalized = normalizePulls([
      rawPull({ number: 3, mergedAt: null }),
      null,
      rawPull({ number: 2, sha: MOVED }),
      "nonsense",
      rawPull({ number: 1 }),
    ]);
    assert.deepEqual(normalized.map((entry) => entry.number), [3, 2, 1]);
    assert.deepEqual(normalizePulls(null), []);
    assert.deepEqual(normalizePulls({}), []);
    assert.deepEqual(normalizePulls(undefined), []);
  });
});

describe("proveMergedPull()", () => {
  test("no branch name is a refusal, never a pass", () => {
    const verdict = proveMergedPull([pull()], { tip: TIP });
    assert.deepEqual(verdict, { proven: false, reason: "no-branch" });
  });

  test("a missing or unreadable tip cannot be covered by anything", () => {
    for (const tip of [undefined, "", "not-a-sha", TIP.toUpperCase()]) {
      const verdict = proveMergedPull([pull()], { branch: "task-branch", tip });
      assert.equal(verdict.proven, false);
      assert.equal(verdict.reason, "no-tip");
      assert.equal(verdict.branch, "task-branch");
    }
  });

  test("no pull request from this branch is no-pull", () => {
    const verdict = proveMergedPull([pull({ branch: "some-other-task" })], { branch: "task-branch", tip: TIP });
    assert.deepEqual(verdict, { proven: false, reason: "no-pull", branch: "task-branch" });
    assert.deepEqual(proveMergedPull(undefined, { branch: "task-branch", tip: TIP }), {
      proven: false, reason: "no-pull", branch: "task-branch",
    });
  });

  test("a pull request from this branch that never merged is not-merged", () => {
    const verdict = proveMergedPull([pull({ mergedAt: null })], { branch: "task-branch", tip: TIP });
    assert.deepEqual(verdict, { proven: false, reason: "not-merged", branch: "task-branch" });
  });

  test("a merged pull request whose head is this exact commit is the proof", () => {
    const verdict = proveMergedPull([pull()], { branch: "task-branch", tip: TIP });
    assert.deepEqual(verdict, {
      proven: true,
      number: 7,
      url: URL,
      headSha: TIP,
      mergeCommitSha: MERGE_COMMIT,
      base: "main",
    });
  });

  test("a base branch is optional: without one, any merged exact head proves", () => {
    assert.equal(proveMergedPull([pull({ base: "release" })], { branch: "task-branch", tip: TIP }).proven, true);
  });

  test("a merged pull request that landed in a different base is base-mismatch, and says where", () => {
    const verdict = proveMergedPull([pull({ base: "develop" })], { branch: "task-branch", tip: TIP, base: "main" });
    assert.equal(verdict.proven, false);
    assert.equal(verdict.reason, "base-mismatch");
    assert.equal(verdict.seenBase, "develop");
    assert.equal(verdict.number, 7);
  });

  test("a merged pull request whose head moved on is tip-moved and reports what merged", () => {
    const verdict = proveMergedPull([pull({ sha: MOVED })], { branch: "task-branch", tip: TIP });
    assert.equal(verdict.proven, false);
    assert.equal(verdict.reason, "tip-moved");
    assert.equal(verdict.headSha, MOVED);
    assert.equal(verdict.number, 7);
    assert.equal(verdict.url, URL);
  });

  test("a reopened task reusing the branch name does not inherit the old merge", () => {
    // The normal flow: the same slug is used twice. The second branch tip is a
    // new commit, so the first pull request must not prove the second branch
    // disposable - this is the bug the whole module exists to prevent.
    const oldMerge = pull({ number: 3, sha: MOVED, mergedAt: "2025-01-01T00:00:00Z" });
    const newTask = pull({ number: 9, sha: TIP, mergedAt: null });
    const verdict = proveMergedPull([newTask, oldMerge], { branch: "task-branch", tip: TIP });
    assert.equal(verdict.proven, false);
    assert.equal(verdict.reason, "tip-moved");
    assert.equal(verdict.headSha, MOVED);
  });

  test("with several merged pull requests, one covering this commit is enough", () => {
    const verdict = proveMergedPull([
      pull({ number: 9, sha: MOVED, base: "main" }),
      pull({ number: 8, sha: TIP, base: "main" }),
    ], { branch: "task-branch", tip: TIP, base: "main" });
    assert.equal(verdict.proven, true);
    assert.equal(verdict.number, 8);
  });

  test("a SHA-256 object format tip proves the same way", () => {
    const verdict = proveMergedPull([pull({ sha: SHA256_TIP })], { branch: "task-branch", tip: SHA256_TIP });
    assert.equal(verdict.proven, true);
  });

  test("the branch name is trimmed but the tip is compared exactly", () => {
    assert.equal(proveMergedPull([pull()], { branch: "  task-branch  ", tip: TIP }).proven, true);
    assert.equal(proveMergedPull([pull()], { branch: "task-branch", tip: " " + TIP }).proven, true);
  });

  test("a realistic API response normalized in one step feeds the verdict", () => {
    const response = [rawPull({ number: 12, mergedAt: "2025-02-02T00:00:00Z" })];
    const verdict = proveMergedPull(normalizePulls(response), { branch: "task-branch", tip: TIP, base: "main" });
    assert.equal(verdict.proven, true);
    assert.equal(verdict.number, 12);
    assert.equal(proveMergedPull(normalizePulls(response), { branch: "task-branch", tip: MOVED }).proven, false);
  });
});

describe("describeProof()", () => {
  test("a proven verdict says a merged pull request covers the commit", () => {
    assert.equal(
      describeProof({ proven: true, number: 7 }),
      "a merged pull request covers this commit (pull request #7)",
    );
    assert.equal(describeProof({ proven: true }), "a merged pull request covers this commit");
  });

  test("tip-moved explains that the older commit is covered and the newer one is not", () => {
    const sentence = describeProof({ proven: false, reason: "tip-moved", number: 7, headSha: MOVED });
    assert.match(sentence, /a merged pull request exists for this branch \(pull request #7\)/);
    assert.match(sentence, new RegExp(MOVED.slice(0, 12)));
    assert.match(sentence, /not covered/);
  });

  test("base-mismatch names the base it did land in", () => {
    const sentence = describeProof({ proven: false, reason: "base-mismatch", number: 4, seenBase: "develop" });
    assert.match(sentence, /pull request #4/);
    assert.match(sentence, /landed in develop/);
  });

  test("each remaining reason has its own sentence", () => {
    assert.equal(
      describeProof({ proven: false, reason: "not-merged" }),
      "a pull request from this branch exists but was not merged",
    );
    assert.equal(describeProof({ proven: false, reason: "no-pull" }), "no pull request from this branch was found");
    assert.equal(
      describeProof({ proven: false, reason: "no-tip" }),
      "the commit this branch points at could not be read, so nothing can be proven about it",
    );
    assert.equal(describeProof({ proven: false, reason: "no-branch" }), "no branch name was given");
  });

  test("anything unrecognisable is reported as not proven", () => {
    assert.equal(describeProof(undefined), "not proven");
    assert.equal(describeProof(null), "not proven");
    assert.equal(describeProof({}), "not proven");
    assert.equal(describeProof({ proven: false, reason: "unknown-reason" }), "not proven");
  });
});
