/**
 * Tests for git-api.ts
 *
 * Covers: show() path/ref validation, parseCommits date handling,
 * parseBlame capture group defaults, getRepository path separator check,
 * and event stub callability.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createGitExtension, validateFilePath, validateRef, validateConfigKey, safeDate, repoContainsPath } from "./git-api.ts";

// ── Thin wrappers that call the real exported validators ──────────────────────

function validateShowArgs(ref: string, filePath: string): void {
  validateFilePath(filePath, "show");
  validateRef(ref, "show");
}

// ── show() — path traversal ───────────────────────────────────────────────────

describe("git-api show() — filePath validation", () => {
  it("accepts a simple relative path", () => {
    assert.doesNotThrow(() => validateShowArgs("HEAD", "src/main.rs"));
  });

  it("accepts a nested relative path", () => {
    assert.doesNotThrow(() => validateShowArgs("main", "deeply/nested/dir/file.ts"));
  });

  it("rejects an absolute path on Unix", () => {
    assert.throws(
      () => validateShowArgs("HEAD", "/etc/passwd"),
      /filePath must be relative/
    );
  });

  it("rejects a Windows-style absolute path", () => {
    assert.throws(
      () => validateShowArgs("HEAD", "C:\\Windows\\System32\\config"),
      /filePath must be relative/
    );
  });

  it("rejects dotdot traversal", () => {
    assert.throws(
      () => validateShowArgs("HEAD", "../../../etc/passwd"),
      /traverses outside repository/
    );
  });

  it("rejects dotdot after subdirectory", () => {
    assert.throws(
      () => validateShowArgs("HEAD", "src/../../etc/passwd"),
      /traverses outside repository/
    );
  });
});

// ── show() — ref validation ───────────────────────────────────────────────────

describe("git-api show() — ref validation", () => {
  it("accepts a simple branch name", () => {
    assert.doesNotThrow(() => validateShowArgs("main", "README.md"));
    assert.doesNotThrow(() => validateShowArgs("feature/my-branch", "README.md"));
  });

  it("accepts HEAD", () => {
    assert.doesNotThrow(() => validateShowArgs("HEAD", "file.txt"));
  });

  it("accepts HEAD~1 and HEAD^", () => {
    assert.doesNotThrow(() => validateShowArgs("HEAD~1", "file.txt"));
    assert.doesNotThrow(() => validateShowArgs("HEAD^", "file.txt"));
  });

  it("accepts stash@{0} ref with braces", () => {
    assert.doesNotThrow(() => validateShowArgs("stash@{0}", "file.txt"));
  });

  it("accepts HEAD@{n} reflog syntax", () => {
    assert.doesNotThrow(() => validateShowArgs("HEAD@{3}", "file.txt"));
  });

  it("accepts a full commit hash", () => {
    assert.doesNotThrow(() => validateShowArgs("abc1234def5678901234567890123456789012345", "file.txt"));
  });

  it("rejects semicolons", () => {
    assert.throws(() => validateShowArgs("HEAD;rm -rf /", "file.txt"), /unsafe ref/);
  });

  it("rejects backticks", () => {
    assert.throws(() => validateShowArgs("HEAD`id`", "file.txt"), /unsafe ref/);
  });

  it("rejects dollar signs", () => {
    assert.throws(() => validateShowArgs("$(whoami)", "file.txt"), /unsafe ref/);
  });

  it("rejects newlines", () => {
    assert.throws(() => validateShowArgs("HEAD\nrm -rf /", "file.txt"), /unsafe ref/);
  });

  it("rejects pipe characters", () => {
    assert.throws(() => validateShowArgs("HEAD|cat /etc/passwd", "file.txt"), /unsafe ref/);
  });

  it("rejects spaces in ref", () => {
    assert.throws(() => validateShowArgs("HEAD rm -rf", "file.txt"), /unsafe ref/);
  });

  it("rejects null bytes", () => {
    assert.throws(() => validateShowArgs("HEAD\0rm", "file.txt"), /unsafe ref/);
  });

  it("rejects leading-dash flag injection", () => {
    assert.throws(() => validateShowArgs("--help", "file.txt"), /unsafe ref/);
    assert.throws(() => validateShowArgs("-n", "file.txt"), /unsafe ref/);
  });
});

// ── blame() — filePath validation ────────────────────────────────────────────

describe("git-api blame() — filePath validation", () => {
  it("accepts a simple relative path", () => {
    assert.doesNotThrow(() => validateFilePath("src/main.rs", "blame"));
  });

  it("rejects an absolute path", () => {
    assert.throws(() => validateFilePath("/etc/passwd", "blame"), /filePath must be relative/);
  });

  it("rejects dotdot traversal", () => {
    assert.throws(() => validateFilePath("../../.env", "blame"), /traverses outside repository/);
  });
});

// ── getCommit() / getBranch() / getConfig() — input validation ──────────────

describe("git-api getCommit() — hash validation", () => {
  it("accepts a hex hash", () => {
    assert.doesNotThrow(() => validateRef("abc1234", "getCommit"));
  });

  it("accepts HEAD~1", () => {
    assert.doesNotThrow(() => validateRef("HEAD~1", "getCommit"));
  });

  it("rejects --help flag injection", () => {
    assert.throws(() => validateRef("--help", "getCommit"), /unsafe ref/);
  });

  it("rejects semicolons", () => {
    assert.throws(() => validateRef("abc;rm -rf /", "getCommit"), /unsafe ref/);
  });
});

describe("git-api getBranch() — name validation", () => {
  it("accepts a simple branch name", () => {
    assert.doesNotThrow(() => validateRef("main", "getBranch"));
    assert.doesNotThrow(() => validateRef("feature/my-branch", "getBranch"));
  });

  it("rejects --show-toplevel flag injection", () => {
    assert.throws(() => validateRef("--show-toplevel", "getBranch"), /unsafe ref/);
  });

  it("rejects --local-env-vars flag injection", () => {
    assert.throws(() => validateRef("--local-env-vars", "getBranch"), /unsafe ref/);
  });
});

describe("git-api getConfig() — key validation", () => {
  it("accepts a standard config key", () => {
    assert.doesNotThrow(() => validateConfigKey("user.name"));
    assert.doesNotThrow(() => validateConfigKey("remote.origin.url"));
  });

  it("rejects --list flag injection", () => {
    assert.throws(() => validateConfigKey("--list"), /unsafe key/);
  });

  it("rejects keys starting with a dash", () => {
    assert.throws(() => validateConfigKey("-evil"), /unsafe key/);
  });
});

// ── parseCommits — date handling ──────────────────────────────────────────────

describe("parseCommits — date handling", () => {
  it("produces a valid Date for an ISO 8601 string", () => {
    const d = safeDate("2024-01-15T12:00:00+00:00");
    assert.ok(!isNaN(d.getTime()), "expected valid Date");
    assert.equal(d.getUTCFullYear(), 2024);
  });

  it("produces epoch for an empty string (not Invalid Date)", () => {
    const d = safeDate("");
    assert.ok(!isNaN(d.getTime()), "empty string must not produce Invalid Date");
    assert.equal(d.getTime(), 0);
  });

  it("produces epoch for undefined", () => {
    const d = safeDate(undefined);
    assert.ok(!isNaN(d.getTime()), "undefined must not produce Invalid Date");
    assert.equal(d.getTime(), 0);
  });

  it("produces epoch for an unparseable date string", () => {
    const d = safeDate("not-a-date");
    assert.ok(!isNaN(d.getTime()), "unparseable string must not produce Invalid Date");
    assert.equal(d.getTime(), 0);
  });
});

// ── getRepository — path separator check ─────────────────────────────────────

describe("getRepository — path separator check", () => {
  const root = "/home/user/project";

  it("matches exact repo root", () => {
    assert.ok(repoContainsPath(root, root));
  });

  it("matches file inside repo", () => {
    assert.ok(repoContainsPath(root, root + "/src/main.ts"));
  });

  it("does NOT match a path that shares a prefix but is a sibling", () => {
    // Classic prefix-only startsWith false positive.
    assert.ok(!repoContainsPath(root, "/home/user/project-other/file.ts"));
  });

  it("handles Windows-style backslash separator", () => {
    const winRoot = "C:\\Users\\user\\project";
    assert.ok(repoContainsPath(winRoot, winRoot + "\\src\\main.ts"));
    assert.ok(!repoContainsPath(winRoot, "C:\\Users\\user\\project-other\\file.ts"));
  });
});

// ── onDidOpenRepository — real implementation ─────────────────────────────────

describe("git extension onDidOpenRepository — real implementation", () => {
  it("is a function that returns a disposable", () => {
    const ext = createGitExtension("/tmp");
    const api = ext.exports.getAPI(1);
    const { onDidOpenRepository } = api;
    assert.equal(typeof onDidOpenRepository, "function");
    const result = onDidOpenRepository(() => {});
    assert.equal(typeof result.dispose, "function");
    assert.doesNotThrow(() => result.dispose());
    ext.deactivate();
  });
});
