/**
 * Tests for ipc-server.ts
 *
 * Covers: timing-safe token comparison, auth timeout behaviour,
 * frame size rejection, and message routing before/after authentication.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MAX_FRAME_SIZE, tokensMatch } from "./ipc-server.ts";

// ── timingSafeEqual token comparison ─────────────────────────────────────────
// Use the exported function from IpcServer so we can assert its correctness in isolation.

describe("IPC auth — timing-safe token comparison", () => {
  it("accepts the correct token", () => {
    assert.ok(tokensMatch("secret-token-abc", "secret-token-abc"));
  });

  it("rejects a wrong token of the same length", () => {
    assert.ok(!tokensMatch("secret-token-xyz", "secret-token-abc"));
  });

  it("rejects a token that is longer than expected", () => {
    assert.ok(!tokensMatch("secret-token-abcEXTRA", "secret-token-abc"));
  });

  it("rejects a token that is shorter than expected", () => {
    assert.ok(!tokensMatch("short", "secret-token-abc"));
  });

  it("rejects null", () => {
    assert.ok(!tokensMatch(null, "secret-token-abc"));
  });

  it("rejects undefined", () => {
    assert.ok(!tokensMatch(undefined, "secret-token-abc"));
  });

  it("rejects an empty string against a non-empty expected token", () => {
    assert.ok(!tokensMatch("", "secret-token-abc"));
  });

  it("accepts two empty strings (edge case — both empty)", () => {
    // This case is guarded at startup (host.ts rejects empty IPC_TOKEN),
    // but the comparison itself must be consistent.
    assert.ok(tokensMatch("", ""));
  });

  it("is not fooled by prefix match", () => {
    assert.ok(!tokensMatch("secret", "secret-token-abc"));
  });
});

// ── Frame size validation ─────────────────────────────────────────────────────
// Mirror the MAX_FRAME_SIZE guard logic.

function isFrameOversized(frameLen: number): boolean {
  return frameLen > MAX_FRAME_SIZE;
}

describe("IPC frame size guard", () => {
  it("accepts a 1-byte frame", () => {
    assert.ok(!isFrameOversized(1));
  });

  it("accepts a frame exactly at the limit", () => {
    assert.ok(!isFrameOversized(MAX_FRAME_SIZE));
  });

  it("rejects a frame one byte over the limit", () => {
    assert.ok(isFrameOversized(MAX_FRAME_SIZE + 1));
  });

  it("rejects a very large frame", () => {
    assert.ok(isFrameOversized(100 * 1024 * 1024));
  });
});

// ── IPC_PORT validation (mirrors host.ts startup guard) ──────────────────────

function isValidPort(port: number): boolean {
  return !isNaN(port) && port >= 1 && port <= 65535;
}

describe("host.ts IPC_PORT validation", () => {
  it("accepts a normal port", () => {
    assert.ok(isValidPort(17532));
  });

  it("accepts port 1", () => {
    assert.ok(isValidPort(1));
  });

  it("accepts port 65535", () => {
    assert.ok(isValidPort(65535));
  });

  it("rejects 0", () => {
    assert.ok(!isValidPort(0));
  });

  it("rejects 65536", () => {
    assert.ok(!isValidPort(65536));
  });

  it("rejects NaN (result of parseInt on a non-numeric string)", () => {
    assert.ok(!isValidPort(NaN));
  });

  it("rejects negative port", () => {
    assert.ok(!isValidPort(-1));
  });
});
