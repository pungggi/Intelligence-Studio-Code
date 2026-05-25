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

// ── textDocument/typeDefinition ──────────────────────────────────────────────

function serializeLocations(result: unknown): unknown {
  if (!result) return [];
  const items = Array.isArray(result) ? result : [result];
  return items.map((loc: unknown) => {
    const l = loc as { uri: string | { toString(): string }; range?: Range };
    return {
      uri: typeof l.uri === "string" ? l.uri : l.uri.toString(),
      range: l.range ? serializeRange(l.range) : { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    };
  });
}

async function dispatchTypeDefinition(
  providers: ProviderEntry<{
    provideTypeDefinition: (doc: { languageId: string }, position: Position, token: unknown) => unknown;
  }>[],
  doc: { languageId: string } | undefined,
  params: { position?: Position; line?: number; character?: number },
): Promise<unknown> {
  if (!doc) return null;
  const position: Position = {
    line: params.position?.line ?? params.line ?? 0,
    character: params.position?.character ?? params.character ?? 0,
  };
  for (const entry of providers) {
    if (matchesSelector(entry.selector, doc)) {
      const result = await entry.provider.provideTypeDefinition(doc, position, nullToken);
      if (result) return serializeLocations(result);
    }
  }
  return null;
}

describe("dispatch: textDocument/typeDefinition", () => {
  it("invokes provider with position and serializes locations", async () => {
    let captured: Position | null = null;
    const provider = {
      provideTypeDefinition: (_doc: unknown, position: Position) => {
        captured = position;
        return { uri: "file:///foo.ts", range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } } };
      },
    };
    const out = await dispatchTypeDefinition(
      [{ selector: { language: "ts" }, provider }],
      { languageId: "ts" },
      { position: { line: 4, character: 2 } },
    );
    assert.deepEqual(captured, { line: 4, character: 2 });
    assert.deepEqual(out, [{ uri: "file:///foo.ts", range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } } }]);
  });

  it("returns null when no provider matches", async () => {
    const provider = { provideTypeDefinition: () => ({ uri: "x", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } }) };
    const out = await dispatchTypeDefinition(
      [{ selector: { language: "py" }, provider }],
      { languageId: "ts" },
      { line: 0, character: 0 },
    );
    assert.equal(out, null);
  });

  it("falls back to flat params.line/character when position omitted", async () => {
    let captured: Position | null = null;
    const provider = {
      provideTypeDefinition: (_doc: unknown, position: Position) => {
        captured = position;
        return null;
      },
    };
    await dispatchTypeDefinition(
      [{ selector: { language: "ts" }, provider }],
      { languageId: "ts" },
      { line: 7, character: 3 },
    );
    assert.deepEqual(captured, { line: 7, character: 3 });
  });
});

// ── textDocument/implementation ──────────────────────────────────────────────

async function dispatchImplementation(
  providers: ProviderEntry<{
    provideImplementation: (doc: { languageId: string }, position: Position, token: unknown) => unknown;
  }>[],
  doc: { languageId: string } | undefined,
  params: { position?: Position; line?: number; character?: number },
): Promise<unknown> {
  if (!doc) return null;
  const position: Position = {
    line: params.position?.line ?? params.line ?? 0,
    character: params.position?.character ?? params.character ?? 0,
  };
  for (const entry of providers) {
    if (matchesSelector(entry.selector, doc)) {
      const result = await entry.provider.provideImplementation(doc, position, nullToken);
      if (result) return serializeLocations(result);
    }
  }
  return null;
}

describe("dispatch: textDocument/implementation", () => {
  it("serializes Location array result", async () => {
    const provider = {
      provideImplementation: () => [
        { uri: "file:///a.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
        { uri: "file:///b.ts", range: { start: { line: 1, character: 0 }, end: { line: 1, character: 2 } } },
      ],
    };
    const out = await dispatchImplementation(
      [{ selector: { language: "ts" }, provider }],
      { languageId: "ts" },
      { position: { line: 0, character: 0 } },
    );
    assert.ok(Array.isArray(out));
    assert.equal((out as unknown[]).length, 2);
  });

  it("returns null when no provider returns a result", async () => {
    const provider = { provideImplementation: () => null };
    const out = await dispatchImplementation(
      [{ selector: { language: "ts" }, provider }],
      { languageId: "ts" },
      { line: 0, character: 0 },
    );
    assert.equal(out, null);
  });
});

// ── textDocument/selectionRange ──────────────────────────────────────────────

type SelectionRange = { range: Range; parent?: SelectionRange };

function serializeSelectionRange(sr: unknown): unknown {
  if (!sr) return null;
  const s = sr as SelectionRange;
  return {
    range: serializeRange(s.range),
    parent: s.parent ? serializeSelectionRange(s.parent) : undefined,
  };
}

async function dispatchSelectionRange(
  providers: ProviderEntry<{
    provideSelectionRanges: (doc: { languageId: string }, positions: Position[], token: unknown) => unknown;
  }>[],
  doc: { languageId: string } | undefined,
  params: { positions?: Position[] },
): Promise<unknown> {
  if (!doc) return null;
  const positions = (params.positions ?? []).map(p => ({ line: p.line, character: p.character }));
  for (const entry of providers) {
    if (matchesSelector(entry.selector, doc)) {
      const result = await entry.provider.provideSelectionRanges(doc, positions, nullToken);
      if (result && Array.isArray(result)) {
        return result.map((sr: unknown) => serializeSelectionRange(sr));
      }
    }
  }
  return null;
}

describe("dispatch: textDocument/selectionRange", () => {
  it("passes positions array and serializes nested parents", async () => {
    let captured: Position[] | null = null;
    const provider = {
      provideSelectionRanges: (_doc: unknown, positions: Position[]) => {
        captured = positions;
        const inner: SelectionRange = {
          range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } },
        };
        const outer: SelectionRange = {
          range: { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } },
          parent: undefined,
        };
        inner.parent = outer;
        return [inner];
      },
    };
    const out = await dispatchSelectionRange(
      [{ selector: { language: "rust" }, provider }],
      { languageId: "rust" },
      { positions: [{ line: 1, character: 2 }] },
    );
    assert.deepEqual(captured, [{ line: 1, character: 2 }]);
    const arr = out as Array<{ range: Range; parent?: { range: Range } }>;
    assert.equal(arr.length, 1);
    assert.deepEqual(arr[0].range, { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } });
    assert.deepEqual(arr[0].parent?.range, { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } });
  });

  it("returns null when provider returns non-array", async () => {
    const provider = { provideSelectionRanges: () => null };
    const out = await dispatchSelectionRange(
      [{ selector: { language: "rust" }, provider }],
      { languageId: "rust" },
      { positions: [{ line: 0, character: 0 }] },
    );
    assert.equal(out, null);
  });
});

// ── textDocument/documentLink + documentLink/resolve ─────────────────────────

type DocumentLink = { range: Range; target?: string; tooltip?: string; data?: unknown };

function serializeDocumentLink(link: unknown): unknown {
  const l = link as DocumentLink;
  return {
    range: serializeRange(l.range),
    target: l.target,
    tooltip: l.tooltip,
    data: l.data,
  };
}

async function dispatchDocumentLink(
  providers: ProviderEntry<{
    provideDocumentLinks: (doc: { languageId: string }, token: unknown) => unknown;
  }>[],
  doc: { languageId: string } | undefined,
): Promise<unknown> {
  if (!doc) return null;
  for (const entry of providers) {
    if (matchesSelector(entry.selector, doc)) {
      const result = await entry.provider.provideDocumentLinks(doc, nullToken);
      if (result && Array.isArray(result)) {
        return result.map((l: unknown) => serializeDocumentLink(l));
      }
    }
  }
  return null;
}

async function dispatchDocumentLinkResolve(
  providers: Array<{
    provider: {
      resolveDocumentLink?: (link: DocumentLink, token: unknown) => unknown;
    };
  }>,
  link: DocumentLink,
): Promise<unknown> {
  for (const entry of providers) {
    if (entry.provider.resolveDocumentLink) {
      const result = await entry.provider.resolveDocumentLink(link, nullToken);
      if (result) return serializeDocumentLink(result);
    }
  }
  return link;
}

describe("dispatch: textDocument/documentLink", () => {
  it("serializes link array result", async () => {
    const provider = {
      provideDocumentLinks: () => [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
          target: "https://example.com",
          tooltip: "Open",
        },
      ],
    };
    const out = await dispatchDocumentLink(
      [{ selector: { language: "md" }, provider }],
      { languageId: "md" },
    );
    assert.deepEqual(out, [{
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
      target: "https://example.com",
      tooltip: "Open",
      data: undefined,
    }]);
  });

  it("returns null when no provider matches", async () => {
    const provider = { provideDocumentLinks: () => [] };
    const out = await dispatchDocumentLink(
      [{ selector: { language: "py" }, provider }],
      { languageId: "md" },
    );
    assert.equal(out, null);
  });
});

describe("dispatch: documentLink/resolve", () => {
  it("invokes resolveDocumentLink and returns enriched link", async () => {
    const provider = {
      resolveDocumentLink: (link: DocumentLink) => ({
        ...link,
        target: "https://resolved.example.com",
        tooltip: "Resolved",
      }),
    };
    const stubLink: DocumentLink = {
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      data: { id: 42 },
    };
    const out = await dispatchDocumentLinkResolve([{ provider }], stubLink);
    assert.equal((out as DocumentLink).target, "https://resolved.example.com");
    assert.equal((out as DocumentLink).tooltip, "Resolved");
  });

  it("returns input link when no resolver is provided", async () => {
    const provider = {};
    const link: DocumentLink = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } };
    const out = await dispatchDocumentLinkResolve([{ provider }], link);
    assert.equal(out, link);
  });
});

// ── textDocument/semanticTokens/full ─────────────────────────────────────────

function serializeSemanticTokens(
  result: unknown,
  legend: { tokenTypes: string[]; tokenModifiers: string[] } | undefined,
): unknown {
  const r = result as { data?: Uint32Array | number[]; resultId?: string };
  const data = r.data instanceof Uint32Array ? Array.from(r.data) : (r.data ?? []);
  return {
    data,
    resultId: r.resultId,
    legend: legend ? { tokenTypes: legend.tokenTypes, tokenModifiers: legend.tokenModifiers } : undefined,
  };
}

async function dispatchSemanticTokensFull(
  providers: ProviderEntry<{
    provideDocumentSemanticTokens: (doc: { languageId: string }, token: unknown) => unknown;
    legend?: { tokenTypes: string[]; tokenModifiers: string[] };
  }>[],
  doc: { languageId: string } | undefined,
): Promise<unknown> {
  if (!doc) return null;
  for (const entry of providers) {
    if (matchesSelector(entry.selector, doc)) {
      const result = await entry.provider.provideDocumentSemanticTokens(doc, nullToken);
      if (result) return serializeSemanticTokens(result, entry.provider.legend);
    }
  }
  return null;
}

describe("dispatch: textDocument/semanticTokens/full", () => {
  it("returns data + resultId + legend when provider returns SemanticTokens", async () => {
    const provider = {
      provideDocumentSemanticTokens: () => ({
        data: new Uint32Array([0, 0, 5, 0, 0]),
        resultId: "r1",
      }),
      legend: { tokenTypes: ["keyword"], tokenModifiers: ["readonly"] },
    };
    const out = await dispatchSemanticTokensFull(
      [{ selector: { language: "rust" }, provider }],
      { languageId: "rust" },
    );
    assert.deepEqual(out, {
      data: [0, 0, 5, 0, 0],
      resultId: "r1",
      legend: { tokenTypes: ["keyword"], tokenModifiers: ["readonly"] },
    });
  });

  it("accepts plain number[] data", async () => {
    const provider = {
      provideDocumentSemanticTokens: () => ({ data: [1, 2, 3, 0, 0] }),
      legend: { tokenTypes: ["variable"], tokenModifiers: [] },
    };
    const out = await dispatchSemanticTokensFull(
      [{ selector: { language: "rust" }, provider }],
      { languageId: "rust" },
    );
    assert.deepEqual((out as { data: number[] }).data, [1, 2, 3, 0, 0]);
  });

  it("returns null when no provider matches", async () => {
    const provider = {
      provideDocumentSemanticTokens: () => ({ data: [1] }),
      legend: undefined,
    };
    const out = await dispatchSemanticTokensFull(
      [{ selector: { language: "py" }, provider }],
      { languageId: "rust" },
    );
    assert.equal(out, null);
  });
});

// ── textDocument/semanticTokens/range ────────────────────────────────────────

async function dispatchSemanticTokensRange(
  providers: ProviderEntry<{
    provideDocumentRangeSemanticTokens: (doc: { languageId: string }, range: Range, token: unknown) => unknown;
    legend?: { tokenTypes: string[]; tokenModifiers: string[] };
  }>[],
  doc: { languageId: string } | undefined,
  params: { range?: Range; startLine?: number; startCharacter?: number; endLine?: number; endCharacter?: number },
): Promise<unknown> {
  if (!doc) return null;
  const range: Range = {
    start: {
      line: params.range?.start?.line ?? params.startLine ?? 0,
      character: params.range?.start?.character ?? params.startCharacter ?? 0,
    },
    end: {
      line: params.range?.end?.line ?? params.endLine ?? 0,
      character: params.range?.end?.character ?? params.endCharacter ?? 0,
    },
  };
  for (const entry of providers) {
    if (matchesSelector(entry.selector, doc)) {
      const result = await entry.provider.provideDocumentRangeSemanticTokens(doc, range, nullToken);
      if (result) return serializeSemanticTokens(result, entry.provider.legend);
    }
  }
  return null;
}

describe("dispatch: textDocument/semanticTokens/range", () => {
  it("passes range derived from params.range and returns serialized tokens", async () => {
    let captured: Range | null = null;
    const provider = {
      provideDocumentRangeSemanticTokens: (_doc: unknown, range: Range) => {
        captured = range;
        return { data: [0, 0, 4, 0, 0] };
      },
      legend: { tokenTypes: ["string"], tokenModifiers: [] },
    };
    const out = await dispatchSemanticTokensRange(
      [{ selector: { language: "ts" }, provider }],
      { languageId: "ts" },
      { range: { start: { line: 3, character: 0 }, end: { line: 5, character: 10 } } },
    );
    assert.deepEqual(captured, { start: { line: 3, character: 0 }, end: { line: 5, character: 10 } });
    assert.deepEqual((out as { data: number[] }).data, [0, 0, 4, 0, 0]);
  });

  it("falls back to flat startLine/startCharacter/endLine/endCharacter params", async () => {
    let captured: Range | null = null;
    const provider = {
      provideDocumentRangeSemanticTokens: (_doc: unknown, range: Range) => {
        captured = range;
        return { data: [] };
      },
      legend: undefined,
    };
    await dispatchSemanticTokensRange(
      [{ selector: { language: "ts" }, provider }],
      { languageId: "ts" },
      { startLine: 1, startCharacter: 2, endLine: 1, endCharacter: 8 },
    );
    assert.deepEqual(captured, { start: { line: 1, character: 2 }, end: { line: 1, character: 8 } });
  });
});
