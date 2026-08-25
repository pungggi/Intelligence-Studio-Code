// Pure helpers extracted from editor.js so they can be unit-tested under
// `node --test`. Loaded as a plain <script> before editor.js (attaches to
// window.EditorHelpers) and also importable via require() from Node tests.

(function (root) {
  'use strict';

  // Map LSP standard + common-extension tokenType names to TOKEN_COLORS keys
  // used by the renderer. Unknown names fall through to 'plain'.
  const SEMANTIC_TYPE_TO_KIND = {
    // LSP standard
    namespace: 'type', type: 'type', class: 'type', enum: 'type',
    interface: 'type', struct: 'type', typeParameter: 'type',
    parameter: 'variable', variable: 'variable', property: 'property',
    enumMember: 'constant', event: 'property',
    function: 'function', method: 'function', macro: 'function',
    keyword: 'keyword', modifier: 'keyword', comment: 'comment',
    string: 'string', number: 'number', regexp: 'string',
    operator: 'operator', decorator: 'function',
    // Common extensions (rust-analyzer, tsserver, etc.)
    lifetime: 'variable', selfKeyword: 'keyword', selfTypeKeyword: 'type',
    boolean: 'constant', builtinType: 'type', builtinAttribute: 'attribute',
    punctuation: 'punctuation', escapeSequence: 'string',
    formatSpecifier: 'string', attribute: 'attribute',
    attributeBracket: 'punctuation', char: 'string', label: 'tag_name',
    generic: 'type', derive: 'function', deriveHelper: 'function',
    toolModule: 'type', union: 'type',
    bracket: 'punctuation', brace: 'punctuation', parenthesis: 'punctuation',
    semicolon: 'punctuation', colon: 'punctuation', comma: 'punctuation',
    dot: 'punctuation', angle: 'punctuation',
    arithmetic: 'operator', logical: 'operator',
    comparison: 'operator', bitwise: 'operator',
  };

  // Decode LSP semantic-tokens delta-encoded flat array into per-line spans.
  // Wire format: [deltaLine, deltaStartChar, length, tokenType, tokenModifiers] × N.
  function decodeSemanticTokens(data, legend) {
    const out = new Map();
    if (!Array.isArray(data) || data.length % 5 !== 0) return out;
    const types = (legend && Array.isArray(legend.tokenTypes)) ? legend.tokenTypes : [];
    let line = 0;
    let col = 0;
    for (let i = 0; i < data.length; i += 5) {
      const dLine = data[i];
      const dStart = data[i + 1];
      const len = data[i + 2];
      const tType = data[i + 3];
      if (dLine !== 0) {
        line += dLine;
        col = dStart;
      } else {
        col += dStart;
      }
      const typeName = types[tType];
      const kind = (typeName && SEMANTIC_TYPE_TO_KIND[typeName]) || 'plain';
      if (!out.has(line)) out.set(line, []);
      out.get(line).push({ startCol: col, endCol: col + len, kind });
    }
    return out;
  }

  // Apply a SemanticTokensEdits response. Each edit is { start, deleteCount, data? }
  // where indices reference the prior data array. LSP guarantees ascending,
  // non-overlapping; applying highest-start-first keeps earlier indices valid
  // as the array mutates.
  function applySemanticTokensEdits(prevData, edits) {
    const next = prevData.slice();
    const sorted = edits.slice().sort((a, b) => b.start - a.start);
    for (const e of sorted) {
      const start = Number.isInteger(e.start) ? e.start : 0;
      const del = Number.isInteger(e.deleteCount) ? e.deleteCount : 0;
      const insert = Array.isArray(e.data) ? e.data : [];
      if (start < 0 || start > next.length) continue;
      next.splice(start, del, ...insert);
    }
    return next;
  }

  // Find a document link whose range covers (line, col). Returns first match
  // or null. Half-open at the end (col === end.character is OUTSIDE).
  function findDocumentLinkAt(documentLinks, line, col) {
    if (!Array.isArray(documentLinks)) return null;
    for (const lnk of documentLinks) {
      const r = lnk.range;
      if (!r) continue;
      const sL = r.start.line, sC = r.start.character;
      const eL = r.end.line,   eC = r.end.character;
      if (line < sL || line > eL) continue;
      if (line === sL && col < sC) continue;
      if (line === eL && col >= eC) continue;
      return lnk;
    }
    return null;
  }

  // True iff (pos.line, pos.character) lies inside [sel.start..sel.end] inclusive.
  function selectionContains(sel, pos) {
    if (pos.line < sel.startLine || pos.line > sel.endLine) return false;
    if (pos.line === sel.startLine && pos.character < sel.startCol) return false;
    if (pos.line === sel.endLine && pos.character > sel.endCol) return false;
    return true;
  }

  // True iff `range` (LSP-shaped { start, end }) strictly encloses `sel`
  // (editor-shaped { startLine, startCol, endLine, endCol }) — i.e. contains
  // it but is not exactly equal.
  function rangeStrictlyContains(range, sel) {
    const posLE = (a, b) => a.line < b.line || (a.line === b.line && a.character <= b.character);
    const selStart = { line: sel.startLine, character: sel.startCol };
    const selEnd = { line: sel.endLine, character: sel.endCol };
    if (!posLE(range.start, selStart)) return false;
    if (!posLE(selEnd, range.end)) return false;
    const startsEq = range.start.line === selStart.line && range.start.character === selStart.character;
    const endsEq = range.end.line === selEnd.line && range.end.character === selEnd.character;
    return !(startsEq && endsEq);
  }

  const api = {
    SEMANTIC_TYPE_TO_KIND,
    decodeSemanticTokens,
    applySemanticTokensEdits,
    findDocumentLinkAt,
    selectionContains,
    rangeStrictlyContains,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.EditorHelpers = api;
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
