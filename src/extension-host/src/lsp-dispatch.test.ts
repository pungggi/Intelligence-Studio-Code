/**
 * Tests for the new LSP dispatch cases added to vscode-api-shim.ts:
 *   - textDocument/rangeFormatting
 *   - workspace/symbol
 *   - textDocument/foldingRange
 *
 * The node --experimental-strip-types test runner cannot process the
 * `constructor parameter property` and `import type` constructs in
 * vscode-api-shim.ts, so each test below uses a self-contained dispatcher
 * that mirrors the production code block it exercises. Each block is kept
 * as a verbatim copy of the case body in vscode-api-shim.ts so that drift
 * is easy to spot in code review.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Minimal shared shapes ────────────────────────────────────────────────────

type Position = { line: number; character: number };
type Range = { start: Position; end: Position };
type TextEdit = { range: Range; newText: string };
type FoldingRange = { start: number; end: number; kind?: number | string };
type SymbolInformation = {
  name: string;
  kind: number;
  containerName?: string;
  location?: { uri: { toString(): string } | string; range: Range };
};

type ProviderEntry<P> = { selector: { language: string }; provider: P };

const nullToken = {};

function serializeRange(range: Range): Range {
  return {
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character },
  };
}

function serializeTextEdits(edits: TextEdit[]): unknown[] {
  return edits.map(e => ({ range: serializeRange(e.range), newText: e.newText }));
}

function serializeSymbols(result: unknown): unknown[] {
  if (!result) return [];
  const items = result as unknown[];
  return items.map((sym: unknown) => {
    const si = sym as SymbolInformation;
    return {
      name: si.name,
      kind: si.kind,
      containerName: si.containerName,
      location: si.location
        ? {
            uri: typeof si.location.uri === "string"
              ? si.location.uri
              : si.location.uri.toString(),
            range: serializeRange(si.location.range),
          }
        : undefined,
    };
  });
}

function matchesSelector(selector: { language: string }, doc: { languageId: string }): boolean {
  return selector.language === doc.languageId || selector.language === "*";
}

// ── textDocument/rangeFormatting ─────────────────────────────────────────────

async function dispatchRangeFormatting(
  providers: ProviderEntry<{
    provideDocumentRangeFormattingEdits: (
      doc: { languageId: string },
      range: Range,
      options: unknown,
      token: unknown,
    ) => unknown;
  }>[],
  doc: { languageId: string } | undefined,
  params: {
    startLine: number;
    startCharacter: number;
    endLine: number;
    endCharacter: number;
    tabSize?: number;
    insertSpaces?: boolean;
  },
): Promise<unknown> {
  if (!doc) return null;
  const options = {
    tabSize: params.tabSize ?? 2,
    insertSpaces: params.insertSpaces ?? true,
  };
  const range: Range = {
    start: { line: params.startLine, character: params.startCharacter },
    end: { line: params.endLine, character: params.endCharacter },
  };
  for (const entry of providers) {
    if (matchesSelector(entry.selector, doc)) {
      const result = await entry.provider.provideDocumentRangeFormattingEdits(doc, range, options, nullToken);
      if (result) return serializeTextEdits(result as TextEdit[]);
    }
  }
  return null;
}

describe("dispatch: textDocument/rangeFormatting", () => {
  it("invokes provider with the supplied range and serializes edits", async () => {
    let captured: Range | null = null;
    const provider = {
      provideDocumentRangeFormattingEdits: (_doc: unknown, range: Range): TextEdit[] => {
        captured = range;
        return [
          { range: { start: { line: 3, character: 0 }, end: { line: 3, character: 8 } }, newText: "  reformatted" },
        ];
      },
    };
    const out = await dispatchRangeFormatting(
      [{ selector: { language: "rust" }, provider }],
      { languageId: "rust" },
      { startLine: 3, startCharacter: 0, endLine: 5, endCharacter: 2 },
    );
    assert.deepEqual(captured, {
      start: { line: 3, character: 0 },
      end: { line: 5, character: 2 },
    });
    const arr = out as Array<{ range: Range; newText: string }>;
    assert.equal(arr.length, 1);
    assert.equal(arr[0].newText, "  reformatted");
    assert.equal(arr[0].range.start.line, 3);
  });

  it("returns null when the document is missing", async () => {
    const provider = { provideDocumentRangeFormattingEdits: () => [{ range: {} as Range, newText: "x" }] };
    const out = await dispatchRangeFormatting(
      [{ selector: { language: "rust" }, provider }],
      undefined,
      { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 0 },
    );
    assert.equal(out, null);
  });

  it("skips providers whose selector does not match the document language", async () => {
    let called = false;
    const provider = {
      provideDocumentRangeFormattingEdits: () => {
        called = true;
        return [];
      },
    };
    const out = await dispatchRangeFormatting(
      [{ selector: { language: "python" }, provider }],
      { languageId: "rust" },
      { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 0 },
    );
    assert.equal(called, false);
    assert.equal(out, null);
  });

  it("returns null when provider yields no edits", async () => {
    const provider = { provideDocumentRangeFormattingEdits: () => null };
    const out = await dispatchRangeFormatting(
      [{ selector: { language: "rust" }, provider }],
      { languageId: "rust" },
      { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 0 },
    );
    assert.equal(out, null);
  });
});

// ── workspace/symbol ─────────────────────────────────────────────────────────

async function dispatchWorkspaceSymbol(
  providers: Array<{
    provider: { provideWorkspaceSymbols: (query: string, token: unknown) => unknown };
  }>,
  params: { query?: string },
): Promise<unknown[]> {
  const query = params.query ?? "";
  const all: unknown[] = [];
  for (const entry of providers) {
    const result = await entry.provider.provideWorkspaceSymbols(query, nullToken);
    if (result) {
      const serialized = serializeSymbols(result);
      if (Array.isArray(serialized)) all.push(...serialized);
    }
  }
  return all;
}

describe("dispatch: workspace/symbol", () => {
  it("merges symbols from every registered provider", async () => {
    const provA = {
      provideWorkspaceSymbols: (q: string): SymbolInformation[] => [
        { name: `a-${q}`, kind: 5, location: { uri: "file:///a.rs", range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } } } },
      ],
    };
    const provB = {
      provideWorkspaceSymbols: (q: string): SymbolInformation[] => [
        { name: `b-${q}`, kind: 12, location: { uri: "file:///b.py", range: { start: { line: 2, character: 0 }, end: { line: 2, character: 4 } } } },
      ],
    };
    const out = await dispatchWorkspaceSymbol(
      [{ provider: provA }, { provider: provB }],
      { query: "x" },
    );
    assert.equal(out.length, 2);
    const names = (out as Array<{ name: string }>).map(s => s.name).sort();
    assert.deepEqual(names, ["a-x", "b-x"]);
  });

  it("passes through the query string verbatim", async () => {
    let received: string | null = null;
    const provider = {
      provideWorkspaceSymbols: (q: string) => {
        received = q;
        return [];
      },
    };
    await dispatchWorkspaceSymbol([{ provider }], { query: "needle::path" });
    assert.equal(received, "needle::path");
  });

  it("treats missing query as empty string", async () => {
    let received: string | null = null;
    const provider = {
      provideWorkspaceSymbols: (q: string) => {
        received = q;
        return [];
      },
    };
    await dispatchWorkspaceSymbol([{ provider }], {});
    assert.equal(received, "");
  });

  it("returns empty array when no providers are registered", async () => {
    const out = await dispatchWorkspaceSymbol([], { query: "x" });
    assert.deepEqual(out, []);
  });

  it("skips a provider that returns null", async () => {
    const out = await dispatchWorkspaceSymbol(
      [
        { provider: { provideWorkspaceSymbols: () => null } },
        {
          provider: {
            provideWorkspaceSymbols: (): SymbolInformation[] => [
              { name: "ok", kind: 1, location: { uri: "file:///x", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } } },
            ],
          },
        },
      ],
      { query: "x" },
    );
    assert.equal(out.length, 1);
    assert.equal((out[0] as { name: string }).name, "ok");
  });
});

// ── textDocument/foldingRange ────────────────────────────────────────────────

async function dispatchFoldingRange(
  providers: ProviderEntry<{
    provideFoldingRanges: (doc: { languageId: string }, ctx: unknown, token: unknown) => unknown;
  }>[],
  doc: { languageId: string } | undefined,
): Promise<unknown> {
  if (!doc) return [];
  for (const entry of providers) {
    if (matchesSelector(entry.selector, doc)) {
      const result = await entry.provider.provideFoldingRanges(doc, {}, nullToken);
      if (result && Array.isArray(result)) {
        return result.map((r: unknown) => {
          const fr = r as FoldingRange;
          return {
            startLine: fr.start,
            endLine: fr.end,
            kind: typeof fr.kind === "number"
              ? (fr.kind === 1 ? "comment" : fr.kind === 2 ? "imports" : fr.kind === 3 ? "region" : null)
              : (fr.kind ?? null),
          };
        });
      }
    }
  }
  return [];
}

describe("dispatch: textDocument/foldingRange", () => {
  it("serializes ranges to { startLine, endLine, kind } shape", async () => {
    const provider = {
      provideFoldingRanges: (): FoldingRange[] => [
        { start: 5, end: 10 },
        { start: 12, end: 20, kind: "region" },
      ],
    };
    const out = await dispatchFoldingRange(
      [{ selector: { language: "rust" }, provider }],
      { languageId: "rust" },
    );
    const arr = out as Array<{ startLine: number; endLine: number; kind: string | null }>;
    assert.equal(arr.length, 2);
    assert.deepEqual(arr[0], { startLine: 5, endLine: 10, kind: null });
    assert.deepEqual(arr[1], { startLine: 12, endLine: 20, kind: "region" });
  });

  it("maps FoldingRangeKind numeric enum to LSP string kinds", async () => {
    const provider = {
      provideFoldingRanges: (): FoldingRange[] => [
        { start: 0, end: 1, kind: 1 }, // Comment
        { start: 2, end: 3, kind: 2 }, // Imports
        { start: 4, end: 5, kind: 3 }, // Region
        { start: 6, end: 7, kind: 99 }, // Unknown -> null
      ],
    };
    const out = await dispatchFoldingRange(
      [{ selector: { language: "rust" }, provider }],
      { languageId: "rust" },
    );
    const kinds = (out as Array<{ kind: string | null }>).map(r => r.kind);
    assert.deepEqual(kinds, ["comment", "imports", "region", null]);
  });

  it("returns empty array when doc is missing", async () => {
    const provider = { provideFoldingRanges: (): FoldingRange[] => [{ start: 0, end: 1 }] };
    const out = await dispatchFoldingRange(
      [{ selector: { language: "rust" }, provider }],
      undefined,
    );
    assert.deepEqual(out, []);
  });

  it("skips providers whose selector does not match", async () => {
    let called = false;
    const provider = {
      provideFoldingRanges: () => {
        called = true;
        return [{ start: 0, end: 1 }];
      },
    };
    const out = await dispatchFoldingRange(
      [{ selector: { language: "python" }, provider }],
      { languageId: "rust" },
    );
    assert.equal(called, false);
    assert.deepEqual(out, []);
  });

  it("returns empty array when provider returns non-array", async () => {
    const provider = { provideFoldingRanges: () => null };
    const out = await dispatchFoldingRange(
      [{ selector: { language: "rust" }, provider }],
      { languageId: "rust" },
    );
    assert.deepEqual(out, []);
  });
});
