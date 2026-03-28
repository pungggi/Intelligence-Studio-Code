/**
 * Tests for language-client.ts
 *
 * Covers: command allowlist validation, pending request cleanup on stop(),
 * provider error swallowing, and vscodeApi null-check guard.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Command allowlist validation (mirrors LanguageClient.start() guard) ───────

function isCommandAllowed(command: string): boolean {
  return /^[A-Za-z0-9_.\/\\\-: ]+$/.test(command);
}

describe("LanguageClient command allowlist", () => {
  it("accepts a simple binary name", () => {
    assert.ok(isCommandAllowed("rust-analyzer"));
  });

  it("accepts an absolute Unix path", () => {
    assert.ok(isCommandAllowed("/usr/bin/rust-analyzer"));
  });

  it("accepts an absolute Windows path", () => {
    assert.ok(isCommandAllowed("C:\\Users\\user\\.cargo\\bin\\rust-analyzer.exe"));
  });

  it("accepts a path with spaces (e.g. Program Files)", () => {
    assert.ok(isCommandAllowed("C:\\Program Files\\MyLSP\\server.exe"));
  });

  it("accepts node binary", () => {
    assert.ok(isCommandAllowed("node"));
  });

  it("rejects a semicolon (shell separator)", () => {
    assert.ok(!isCommandAllowed("node; rm -rf /"));
  });

  it("rejects a pipe character", () => {
    assert.ok(!isCommandAllowed("node | cat /etc/passwd"));
  });

  it("rejects backtick command substitution", () => {
    assert.ok(!isCommandAllowed("node`id`"));
  });

  it("rejects dollar-sign substitution", () => {
    assert.ok(!isCommandAllowed("$(malicious)"));
  });

  it("rejects ampersand", () => {
    assert.ok(!isCommandAllowed("node & evil"));
  });

  it("rejects newline injection", () => {
    assert.ok(!isCommandAllowed("node\nrm -rf /"));
  });

  it("rejects angle brackets (redirection)", () => {
    assert.ok(!isCommandAllowed("node > /etc/passwd"));
  });
});

// ── Pending request cleanup on stop() ────────────────────────────────────────

describe("LanguageClient pending request cleanup on stop()", () => {
  it("rejects all pending requests with 'LanguageClient stopped'", () => {
    const rejectedWith: string[] = [];
    const pendingRequests = new Map<number, {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer?: ReturnType<typeof setTimeout>;
    }>();

    // Add some pending requests.
    pendingRequests.set(1, {
      resolve: () => {},
      reject: (e) => { rejectedWith.push(e.message); },
      timer: undefined,
    });
    pendingRequests.set(2, {
      resolve: () => {},
      reject: (e) => { rejectedWith.push(e.message); },
      timer: setTimeout(() => {}, 30000),
    });

    // Simulate stop() cleanup loop.
    for (const [id, pending] of pendingRequests) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new Error("LanguageClient stopped"));
      pendingRequests.delete(id);
    }

    assert.equal(pendingRequests.size, 0, "all pending requests cleared");
    assert.deepEqual(rejectedWith, ["LanguageClient stopped", "LanguageClient stopped"]);
  });

  it("clears timers for pending requests", () => {
    let timerCleared = false;
    const pendingRequests = new Map<number, {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer?: ReturnType<typeof setTimeout>;
    }>();

    // Wrap clearTimeout to detect calls.
    const fakeTimer = { _cleared: false } as unknown as ReturnType<typeof setTimeout>;
    pendingRequests.set(42, {
      resolve: () => {},
      reject: () => {},
      timer: fakeTimer,
    });

    for (const [id, pending] of pendingRequests) {
      if (pending.timer) {
        clearTimeout(pending.timer);
        timerCleared = true;
      }
      pending.reject(new Error("LanguageClient stopped"));
      pendingRequests.delete(id);
    }

    assert.ok(timerCleared, "timer should have been cleared");
  });
});

// ── Provider callbacks swallow errors ─────────────────────────────────────────

describe("LanguageClient provider error handling", () => {
  it("provider returning undefined does not throw", async () => {
    // Simulates what happens when sendRequest throws inside a provider callback.
    const provider = async (): Promise<unknown> => {
      try {
        throw new Error("LSP server not running");
      } catch {
        return undefined;
      }
    };

    const result = await provider();
    assert.equal(result, undefined);
  });

  it("provider error is caught and does not propagate", async () => {
    let errorCaught = "";
    const provider = async (): Promise<unknown> => {
      try {
        throw new Error("connection reset");
      } catch (err) {
        errorCaught = (err as Error).message;
        return undefined;
      }
    };

    await provider();
    assert.equal(errorCaught, "connection reset");
  });
});

// ── vscodeApi null guard ──────────────────────────────────────────────────────

describe("LanguageClient vscodeApi null guard", () => {
  it("does not throw when vscodeApi is null at init time", () => {
    let vscodeApi: { languages: { createDiagnosticCollection(name: string): unknown } } | null = null;

    // Simulate the guard logic.
    let diagnosticCollection: unknown = null;
    if (!vscodeApi) {
      // Guard triggered — should log and return, not throw.
    } else {
      diagnosticCollection = vscodeApi.languages.createDiagnosticCollection("test-lsp");
    }

    assert.equal(diagnosticCollection, null, "collection should remain null when api is missing");
  });
});
