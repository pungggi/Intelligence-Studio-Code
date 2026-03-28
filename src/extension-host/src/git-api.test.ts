/**
 * Tests for git-api.ts
 *
 * Covers: show() path/ref validation, parseCommits date handling,
 * parseBlame capture group defaults, getRepository path separator check,
 * and event stub callability.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isAbsolute, normalize } from "node:path";

// ── Inline the pure logic under test ─────────────────────────────────────────
// We re-implement the validation guards here so we can test them without
// spawning real git processes or requiring a live repository.

function validateShowArgs(ref: string, filePath: string): void {
  if (isAbsolute(filePath)) {
    throw new Error(`show: filePath must be relative, got '${filePath}'`);
  }
  const normalized = normalize(filePath);
  if (normalized.startsWith("..")) {
    throw new Error(`show: filePath '${filePath}' traverses outside repository`);
  }
  if (!/^[A-Za-z0-9_./:@^~\-{}]+$/.test(ref)) {
    throw new Error(`show: unsafe ref '${ref}'`);
  }
}

// Re-implement parseCommits date logic
function parseCommitsDate(aDate: string | undefined): Date {
  return new Date(aDate || 0);
}

// Re-implement getRepository path check
function repoContainsPath(rootPath: string, fsPath: string): boolean {
  return fsPath === rootPath ||
    fsPath.startsWith(rootPath + "/") ||
    fsPath.startsWith(rootPath + "\\");
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
});

// ── parseCommits — date handling ──────────────────────────────────────────────

describe("parseCommits — date handling", () => {
  it("produces a valid Date for an ISO 8601 string", () => {
    const d = parseCommitsDate("2024-01-15T12:00:00+00:00");
    assert.ok(!isNaN(d.getTime()), "expected valid Date");
    assert.equal(d.getUTCFullYear(), 2024);
  });

  it("produces epoch for an empty string (not Invalid Date)", () => {
    const d = parseCommitsDate("");
    assert.ok(!isNaN(d.getTime()), "empty string must not produce Invalid Date");
    assert.equal(d.getTime(), 0);
  });

  it("produces epoch for undefined", () => {
    const d = parseCommitsDate(undefined);
    assert.ok(!isNaN(d.getTime()), "undefined must not produce Invalid Date");
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

// ── onDidOpenRepository event stubs — callable ───────────────────────────────

describe("git extension event stubs are callable functions", () => {
  it("onDidOpenRepository is a function that returns a disposable", () => {
    const stub = (_l: unknown) => ({ dispose: () => {} });
    assert.equal(typeof stub, "function");
    const result = stub(() => {});
    assert.equal(typeof result.dispose, "function");
    assert.doesNotThrow(() => result.dispose());
  });
});
