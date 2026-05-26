'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  decodeSemanticTokens,
  applySemanticTokensEdits,
  findDocumentLinkAt,
  selectionContains,
  rangeStrictlyContains,
} = require('./editor-helpers.js');

// ─── decodeSemanticTokens ─────────────────────────────────────

test('decode: empty data → empty map', () => {
  assert.equal(decodeSemanticTokens([], { tokenTypes: [] }).size, 0);
});

test('decode: non-multiple-of-5 length → empty map (malformed wire)', () => {
  const out = decodeSemanticTokens([0, 0, 3, 0], { tokenTypes: ['keyword'] });
  assert.equal(out.size, 0);
});

test('decode: single token at origin', () => {
  const legend = { tokenTypes: ['keyword'] };
  const out = decodeSemanticTokens([0, 5, 3, 0, 0], legend);
  assert.deepEqual([...out.entries()], [[0, [{ startCol: 5, endCol: 8, kind: 'keyword' }]]]);
});

test('decode: two tokens on same line use deltaStart relative to prev', () => {
  const legend = { tokenTypes: ['keyword', 'variable'] };
  // first: line 0, col 0, len 3, type 0 (keyword)
  // second: deltaLine 0, deltaStart 4 (so col = 0 + 4 = 4? No — delta is relative
  // to PREV start, not prev end. col becomes 0 + 4 = 4), len 5, type 1
  const out = decodeSemanticTokens([0, 0, 3, 0, 0, 0, 4, 5, 1, 0], legend);
  assert.deepEqual(out.get(0), [
    { startCol: 0, endCol: 3, kind: 'keyword' },
    { startCol: 4, endCol: 9, kind: 'variable' },
  ]);
});

test('decode: deltaLine > 0 resets col to absolute deltaStart', () => {
  const legend = { tokenTypes: ['comment'] };
  // first at line 0 col 10; second at line 2 (delta 2) col 5 (absolute)
  const out = decodeSemanticTokens([0, 10, 2, 0, 0, 2, 5, 3, 0, 0], legend);
  assert.deepEqual(out.get(0), [{ startCol: 10, endCol: 12, kind: 'comment' }]);
  assert.deepEqual(out.get(2), [{ startCol: 5, endCol: 8, kind: 'comment' }]);
});

test('decode: unknown tokenType index → kind "plain"', () => {
  const legend = { tokenTypes: ['keyword'] };
  // type 99 is OOB
  const out = decodeSemanticTokens([0, 0, 3, 99, 0], legend);
  assert.equal(out.get(0)[0].kind, 'plain');
});

test('decode: unmapped tokenType name → "plain"', () => {
  const legend = { tokenTypes: ['somethingExotic'] };
  const out = decodeSemanticTokens([0, 0, 3, 0, 0], legend);
  assert.equal(out.get(0)[0].kind, 'plain');
});

test('decode: rust-analyzer-style extension types map correctly', () => {
  const legend = { tokenTypes: ['lifetime', 'selfKeyword', 'bracket'] };
  const out = decodeSemanticTokens(
    [0, 0, 2, 0, 0, 1, 0, 4, 1, 0, 1, 0, 1, 2, 0],
    legend,
  );
  assert.equal(out.get(0)[0].kind, 'variable');
  assert.equal(out.get(1)[0].kind, 'keyword');
  assert.equal(out.get(2)[0].kind, 'punctuation');
});

test('decode: missing legend → all tokens "plain"', () => {
  const out = decodeSemanticTokens([0, 0, 3, 0, 0], null);
  assert.equal(out.get(0)[0].kind, 'plain');
});

// ─── applySemanticTokensEdits ──────────────────────────────────

test('apply edits: empty edits → unchanged copy', () => {
  const prev = [1, 2, 3, 4, 5];
  const out = applySemanticTokensEdits(prev, []);
  assert.deepEqual(out, prev);
  assert.notEqual(out, prev); // distinct array
});

test('apply edits: pure insert at end', () => {
  const out = applySemanticTokensEdits([1, 2, 3], [{ start: 3, deleteCount: 0, data: [4, 5] }]);
  assert.deepEqual(out, [1, 2, 3, 4, 5]);
});

test('apply edits: pure delete', () => {
  const out = applySemanticTokensEdits([1, 2, 3, 4, 5], [{ start: 1, deleteCount: 2 }]);
  assert.deepEqual(out, [1, 4, 5]);
});

test('apply edits: replace (delete + insert)', () => {
  const out = applySemanticTokensEdits([1, 2, 3, 4, 5], [{ start: 1, deleteCount: 2, data: [9, 9, 9] }]);
  assert.deepEqual(out, [1, 9, 9, 9, 4, 5]);
});

test('apply edits: multiple edits, ascending-by-spec, applied highest-first', () => {
  // prev: indices 0..9 = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]
  // edits (LSP sends ascending): replace [2..4) with [99] AND replace [6..8) with [88]
  const prev = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
  const edits = [
    { start: 2, deleteCount: 2, data: [99] },
    { start: 6, deleteCount: 2, data: [88] },
  ];
  const out = applySemanticTokensEdits(prev, edits);
  // After applying highest-first: [10,11,12,13,14,15,88,18,19] then [10,11,99,14,15,88,18,19]
  assert.deepEqual(out, [10, 11, 99, 14, 15, 88, 18, 19]);
});

test('apply edits: out-of-range start skipped, not corrupted', () => {
  const out = applySemanticTokensEdits([1, 2, 3], [
    { start: -1, deleteCount: 1, data: [99] },
    { start: 100, deleteCount: 0, data: [88] },
    { start: 1, deleteCount: 0, data: [42] },
  ]);
  assert.deepEqual(out, [1, 42, 2, 3]);
});

test('apply edits: malformed start/deleteCount (non-int) → defaulted', () => {
  // start undefined → 0, deleteCount undefined → 0, data must still insert
  const out = applySemanticTokensEdits([1, 2, 3], [{ data: [77] }]);
  assert.deepEqual(out, [77, 1, 2, 3]);
});

test('apply edits: missing data field treated as pure delete', () => {
  const out = applySemanticTokensEdits([1, 2, 3, 4], [{ start: 1, deleteCount: 2 }]);
  assert.deepEqual(out, [1, 4]);
});

test('apply edits: original array not mutated', () => {
  const prev = [1, 2, 3];
  const snapshot = prev.slice();
  applySemanticTokensEdits(prev, [{ start: 0, deleteCount: 3, data: [9, 9, 9] }]);
  assert.deepEqual(prev, snapshot);
});

// ─── findDocumentLinkAt ────────────────────────────────────────

const mkLink = (sL, sC, eL, eC, target) => ({
  range: { start: { line: sL, character: sC }, end: { line: eL, character: eC } },
  target,
});

test('findDocumentLinkAt: empty list → null', () => {
  assert.equal(findDocumentLinkAt([], 0, 0), null);
});

test('findDocumentLinkAt: non-array input → null', () => {
  assert.equal(findDocumentLinkAt(null, 0, 0), null);
  assert.equal(findDocumentLinkAt(undefined, 0, 0), null);
});

test('findDocumentLinkAt: link with no range skipped', () => {
  const links = [{ target: 'http://x' }, mkLink(0, 0, 0, 5, 'http://y')];
  assert.equal(findDocumentLinkAt(links, 0, 2).target, 'http://y');
});

test('findDocumentLinkAt: hit at start boundary (inclusive)', () => {
  const links = [mkLink(2, 5, 2, 10, 'http://x')];
  assert.equal(findDocumentLinkAt(links, 2, 5).target, 'http://x');
});

test('findDocumentLinkAt: miss just before start', () => {
  const links = [mkLink(2, 5, 2, 10, 'http://x')];
  assert.equal(findDocumentLinkAt(links, 2, 4), null);
});

test('findDocumentLinkAt: end is exclusive (col === end.character is OUTSIDE)', () => {
  const links = [mkLink(2, 5, 2, 10, 'http://x')];
  assert.equal(findDocumentLinkAt(links, 2, 9).target, 'http://x');
  assert.equal(findDocumentLinkAt(links, 2, 10), null);
});

test('findDocumentLinkAt: multi-line range, hit on middle line ignores cols', () => {
  const links = [mkLink(1, 5, 3, 2, 'http://x')];
  assert.equal(findDocumentLinkAt(links, 2, 0).target, 'http://x');
  assert.equal(findDocumentLinkAt(links, 2, 9999).target, 'http://x');
});

test('findDocumentLinkAt: returns first match when overlapping', () => {
  const a = mkLink(0, 0, 0, 10, 'http://a');
  const b = mkLink(0, 0, 0, 10, 'http://b');
  assert.equal(findDocumentLinkAt([a, b], 0, 5).target, 'http://a');
});

// ─── selectionContains ─────────────────────────────────────────

const sel = (sL, sC, eL, eC) => ({ startLine: sL, startCol: sC, endLine: eL, endCol: eC });
const pos = (line, character) => ({ line, character });

test('selectionContains: pos inside single-line sel', () => {
  assert.equal(selectionContains(sel(0, 2, 0, 8), pos(0, 5)), true);
});

test('selectionContains: pos at exact start (inclusive)', () => {
  assert.equal(selectionContains(sel(0, 2, 0, 8), pos(0, 2)), true);
});

test('selectionContains: pos at exact end (inclusive)', () => {
  assert.equal(selectionContains(sel(0, 2, 0, 8), pos(0, 8)), true);
});

test('selectionContains: pos before start', () => {
  assert.equal(selectionContains(sel(0, 2, 0, 8), pos(0, 1)), false);
});

test('selectionContains: pos after end', () => {
  assert.equal(selectionContains(sel(0, 2, 0, 8), pos(0, 9)), false);
});

test('selectionContains: pos on wrong line', () => {
  assert.equal(selectionContains(sel(2, 0, 2, 100), pos(1, 50)), false);
  assert.equal(selectionContains(sel(2, 0, 2, 100), pos(3, 50)), false);
});

test('selectionContains: multi-line sel, pos in middle line', () => {
  assert.equal(selectionContains(sel(1, 5, 3, 2), pos(2, 0)), true);
});

test('selectionContains: multi-line sel, pos at first line before startCol', () => {
  assert.equal(selectionContains(sel(1, 5, 3, 2), pos(1, 4)), false);
});

test('selectionContains: multi-line sel, pos at last line after endCol', () => {
  assert.equal(selectionContains(sel(1, 5, 3, 2), pos(3, 3)), false);
});

// ─── rangeStrictlyContains ─────────────────────────────────────

const range = (sL, sC, eL, eC) => ({ start: { line: sL, character: sC }, end: { line: eL, character: eC } });

test('rangeStrictlyContains: range strictly larger → true', () => {
  assert.equal(rangeStrictlyContains(range(0, 0, 0, 100), sel(0, 10, 0, 20)), true);
});

test('rangeStrictlyContains: range exactly equal → false (not STRICT)', () => {
  assert.equal(rangeStrictlyContains(range(0, 0, 0, 10), sel(0, 0, 0, 10)), false);
});

test('rangeStrictlyContains: range only-start-equal (end larger) → true', () => {
  assert.equal(rangeStrictlyContains(range(0, 0, 0, 20), sel(0, 0, 0, 10)), true);
});

test('rangeStrictlyContains: range only-end-equal (start smaller) → true', () => {
  assert.equal(rangeStrictlyContains(range(0, 0, 0, 20), sel(0, 5, 0, 20)), true);
});

test('rangeStrictlyContains: sel starts before range → false', () => {
  assert.equal(rangeStrictlyContains(range(0, 5, 0, 20), sel(0, 0, 0, 10)), false);
});

test('rangeStrictlyContains: sel ends after range → false', () => {
  assert.equal(rangeStrictlyContains(range(0, 0, 0, 20), sel(0, 5, 0, 25)), false);
});

test('rangeStrictlyContains: multi-line, sel inside on different lines', () => {
  assert.equal(rangeStrictlyContains(range(0, 0, 5, 0), sel(2, 3, 3, 7)), true);
});

test('rangeStrictlyContains: multi-line, sel starts on range start line earlier col', () => {
  assert.equal(rangeStrictlyContains(range(0, 5, 5, 0), sel(0, 3, 4, 0)), false);
});
