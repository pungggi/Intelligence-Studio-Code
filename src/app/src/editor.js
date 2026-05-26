/**
 * CoreCode M8 — Canvas-based Editor Frontend
 *
 * M8 changes:
 * - Extension marketplace (Open VSX) with search, install, uninstall
 * - Activity bar for panel switching (Explorer, Extensions, Settings)
 * - Settings editor UI with live persistence
 * - Multi-directory extension loading with hot-install
 *
 * Carried from M1-M7:
 * - Canvas2D rendering, virtual scrolling, O(1) edit responses
 * - Syntax highlighting, diagnostics, command palette
 * - Undo/redo, selection, clipboard, find/replace
 * - Tabs, file explorer, minimap
 * - LSP: autocomplete, hover, go-to-def, references, code actions, signature help, symbols, formatting
 */

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// ─── Token Colors (Catppuccin Mocha) ─────────────────────────
const TOKEN_COLORS = {
  keyword:     '#cba6f7',
  string:      '#a6e3a1',
  number:      '#fab387',
  comment:     '#585b70',
  function:    '#89b4fa',
  variable:    '#cdd6f4',
  type:        '#f9e2af',
  property:    '#89dceb',
  constant:    '#fab387',
  operator:    '#94e2d5',
  punctuation: '#6c7086',
  tag_name:    '#f38ba8',
  attribute:   '#89dceb',
  heading:     '#cba6f7',
  link:        '#89b4fa',
  plain:       '#cdd6f4',
};

const DIAG_COLORS = {
  error:   '#f38ba8',
  warning: '#fab387',
  info:    '#89b4fa',
  hint:    '#a6e3a1',
};

const BG_COLOR      = '#1e1e2e';
const GUTTER_BG     = '#181825';
const GUTTER_FG     = '#45475a';
const SELECTION_BG   = 'rgba(49, 50, 68, 0.8)';
const CURSOR_COLOR   = '#f5e0dc';
const FIND_BG        = 'rgba(250, 179, 135, 0.3)';
const FIND_BORDER    = 'rgba(250, 179, 135, 0.6)';
const FIND_CUR_BG    = 'rgba(250, 179, 135, 0.6)';
const FIND_CUR_BORDER= '#fab387';

// ─── Multi-buffer State ─────────────────────────────────────

const bufferStates = new Map();
let activeBufferPath = null;

// Current active buffer state
let cursorLine = 0;
let cursorCol = 0;
let filePath = null;
let modified = false;
let diagnostics = [];
let totalLines = 3; // total lines in document

// Cached visible content (from get_visible_content)
let cachedLines = [];      // HighlightedLine[] for cached range
let cachedFirstLine = 0;   // first line index in cache
let cachedLanguage = null;

// Extension decoration state { uri, decoration_type, ranges[], background_color, color, border, border_color, after_text }
let activeDecorations = [];

// Comment thread state — threads for the currently open file.
let commentThreads = [];

// Ghost-text (inline completion) state
let ghostText = null;        // string | null — text to render after cursor
let ghostTextTimer = null;   // debounce timer handle
const GHOST_TEXT_COLOR = 'rgba(205,214,244,0.35)';  // dimmed Catppuccin fg

// Inlay hints state
let inlayHints = new Map();  // lineIdx -> Array<{character, label, kind}>
let inlayHintsUri = null;
let inlayHintsTimer = null;
const INLAY_HINT_COLOR = 'rgba(166,173,200,0.55)';  // dimmed, semi-transparent

// Folding state
let foldingRanges = [];      // Array<{startLine, endLine, kind?}> from WASM/heuristic
let collapsedFolds = new Set(); // Set of startLine values that are collapsed
let foldedLineSet = new Set();  // Set of buffer lines currently hidden (recomputed)

// Document highlights state (registerDocumentHighlightProvider)
let documentHighlights = [];  // Array<{start_line, start_col, end_line, end_col, kind}>
let documentHighlightsUri = null;
let documentHighlightsTimer = null;
const DOC_HIGHLIGHT_READ_BG  = 'rgba(137,220,235,0.15)';  // blue tint (kind=2 read)
const DOC_HIGHLIGHT_WRITE_BG = 'rgba(250,179,135,0.18)';  // orange tint (kind=3 write)
const DOC_HIGHLIGHT_TEXT_BG  = 'rgba(166,173,200,0.12)';  // grey tint (kind=1 text)

// Document link state (registerDocumentLinkProvider)
let documentLinks = []; // Array<{ range: { start: {line,character}, end: {line,character} }, target?: string, tooltip?: string, data?: any }>
let documentLinksUri = null;
let documentLinksToken = 0;
let ctrlHover = false; // Ctrl currently held — show link underlines
const DOC_LINK_COLOR = '#89b4fa';

// Semantic tokens state (registerDocumentSemanticTokensProvider)
// Decoded into per-line spans for O(1) render lookup.
let semanticTokens = new Map(); // lineIdx -> Array<{ startCol, endCol, kind }>
let semanticTokensUri = null;
let semanticTokensResultId = null;
let semanticTokensToken = 0;
// Map LSP standard + common-extension tokenType names to TOKEN_COLORS keys.
const SEMANTIC_TYPE_TO_KIND = {
  // LSP standard
  namespace:     'type',
  type:          'type',
  class:         'type',
  enum:          'type',
  interface:     'type',
  struct:        'type',
  typeParameter: 'type',
  parameter:     'variable',
  variable:      'variable',
  property:      'property',
  enumMember:    'constant',
  event:         'property',
  function:      'function',
  method:        'function',
  macro:         'function',
  keyword:       'keyword',
  modifier:      'keyword',
  comment:       'comment',
  string:        'string',
  number:        'number',
  regexp:        'string',
  operator:      'operator',
  decorator:     'function',
  // Common extensions (rust-analyzer, tsserver, etc.)
  lifetime:        'variable',
  selfKeyword:     'keyword',
  selfTypeKeyword: 'type',
  boolean:         'constant',
  builtinType:     'type',
  builtinAttribute:'attribute',
  punctuation:     'punctuation',
  escapeSequence:  'string',
  formatSpecifier: 'string',
  attribute:       'attribute',
  attributeBracket:'punctuation',
  char:            'string',
  label:           'tag_name',
  generic:         'type',
  derive:          'function',
  deriveHelper:    'function',
  toolModule:      'type',
  union:           'type',
  bracket:         'punctuation',
  brace:           'punctuation',
  parenthesis:     'punctuation',
  semicolon:       'punctuation',
  colon:           'punctuation',
  comma:           'punctuation',
  dot:             'punctuation',
  angle:           'punctuation',
  arithmetic:      'operator',
  logical:         'operator',
  comparison:      'operator',
  bitwise:         'operator',
};

function filePathToUri(p) {
  if (!p) return '';
  if (p.match(/^[a-zA-Z]:\\/)) return 'file:///' + p.replace(/\\/g, '/');
  return 'file://' + p;
}

function detectLanguage(fp) {
  if (!fp) return 'plaintext';
  const ext = fp.split('.').pop()?.toLowerCase() ?? '';
  const map = {
    'rs': 'rust', 'js': 'javascript', 'mjs': 'javascript', 'cjs': 'javascript',
    'jsx': 'javascriptreact', 'ts': 'typescript', 'tsx': 'typescriptreact',
    'py': 'python', 'pyw': 'python', 'json': 'json', 'jsonc': 'json',
    'html': 'html', 'htm': 'html', 'css': 'css', 'scss': 'scss',
    'md': 'markdown', 'toml': 'toml', 'yaml': 'yaml', 'yml': 'yaml',
  };
  return map[ext] ?? 'plaintext';
}

// Rendering state
let cellWidth = 0;     // monospace character width (px)
let lineHeight = 0;    // line height (px)
let fontReady = false;
let cachedFont = '';
let cachedFontSize = 0;
const GUTTER_PADDING_LEFT = 8;
const GUTTER_PADDING_RIGHT = 12;
const EDITOR_PADDING_LEFT = 12;
const BUFFER_LINES = 30;  // extra lines to cache above/below viewport

// Serial edit queue — prevents async keystroke interleaving
let editQueueTail = Promise.resolve();
function queueEdit(fn) {
  editQueueTail = editQueueTail.then(fn).catch(err => {
    console.error('[queueEdit] Edit failed:', err);
    // Do not retry — propagate failure so the queue doesn't hang
    return Promise.reject(err);
  });
  return editQueueTail;
}

// Cursor blink
let cursorVisible = true;
let cursorBlinkTimer = null;

function resetCursorBlink() {
  cursorVisible = true;
  clearInterval(cursorBlinkTimer);
  cursorBlinkTimer = setInterval(() => {
    cursorVisible = !cursorVisible;
    requestRender();
  }, 530);
}

// Palette
let paletteOpen = false;
let paletteSelectedIndex = 0;
let paletteCommands = [];
let paletteFiltered = [];

// Selection
let selAnchorLine = null;
let selAnchorCol = null;
let isDragging = false;

// Selection-range expand/shrink — stack of prior selections so shrink can pop
// back to the previous level. Cleared when the cursor moves without expand,
// when the active buffer changes, or when a newer expand supersedes a
// pending in-flight request.
let selectionRangeStack = []; // Array<{ startLine, startCol, endLine, endCol }>
let selectionRangeAnchor = null; // { line, character } — where expand started
let selectionRangeBuffer = null; // activeBufferPath captured at anchor time
let selectionRangeToken = 0; // increments per expand call; in-flight stale calls bail

// Multi-cursor state
let extraCursors = []; // Array<{ line, col, anchorLine, anchorCol }>
// Ctrl+D state
let ctrlDWord = null;
let ctrlDLastLine = -1;
let ctrlDLastCol = -1;

// Find / Replace
let findOpen = false;
let findMatches = [];
let findCurrentIdx = -1;

// Bottom panel (output + terminal)
let bottomPanelOpen = false;
let bottomPanelActiveTab = 'terminal'; // 'output' or 'terminal'

// Output panel
let outputOpen = false;
let outputAllLines = [];
let outputSelectedChannel = '';

// Terminal
let terminals = new Map(); // terminal_id -> { xterm, fitAddon, container }
let activeTerminalId = null;

// File explorer
let sidebarOpen = false;
let explorerRoot = null;
let expandedDirs = new Set();

// M8b: WebView panels — panel_id → { container, iframe }
const webviewPanelMap = new Map();
let activeWebviewPanelId = null; // null = code editor is active

// ─── DOM References ──────────────────────────────────────────

const editorEl = document.getElementById('editor');
const gutterEl = document.getElementById('gutter');
const editorCanvas = document.getElementById('editor-canvas');
const gutterCanvas = document.getElementById('gutter-canvas');
const scrollSizer = document.getElementById('scroll-sizer');
const fileNameEl = document.getElementById('file-name');
const languageBadgeEl = document.getElementById('language-badge');
const cursorPosEl = document.getElementById('cursor-pos');
const fileInfoEl = document.getElementById('file-info');
const statusEl = document.getElementById('status');
const diagCountEl = document.getElementById('diagnostics-count');
const extHostStatusEl = document.getElementById('ext-host-status');
const paletteEl = document.getElementById('command-palette');
const paletteInputEl = document.getElementById('palette-input');
const paletteListEl = document.getElementById('palette-list');
const paletteBackdropEl = document.getElementById('palette-backdrop');
const extStatusBarEl = document.getElementById('ext-status-bar-items');

// Tab bar
const tabBarEl = document.getElementById('tab-bar');
const tabsEl = document.getElementById('tabs');

// Sidebar
const sidebarEl = document.getElementById('sidebar');
const sidebarCloseBtn = document.getElementById('sidebar-close');
const fileTreeEl = document.getElementById('file-tree');

// Find bar
const findBarEl = document.getElementById('find-bar');
const findInputEl = document.getElementById('find-input');
const findCountEl = document.getElementById('find-count');
const findPrevBtn = document.getElementById('find-prev');
const findNextBtn = document.getElementById('find-next');
const findCaseEl = document.getElementById('find-case');
const findToggleReplaceBtn = document.getElementById('find-toggle-replace');
const findCloseBtn = document.getElementById('find-close');
const replaceRowEl = document.getElementById('replace-row');
const replaceInputEl = document.getElementById('replace-input');
const replaceOneBtn = document.getElementById('replace-one');
const replaceAllBtn = document.getElementById('replace-all');

// Bottom panel
const bottomPanelEl = document.getElementById('bottom-panel');
const bottomPanelTabs = document.querySelectorAll('.bottom-tab');
const bottomPanelCloseBtn = document.getElementById('bottom-panel-close');
const terminalNewBtn = document.getElementById('terminal-new');

// Output sub-panel
const outputPanelEl = document.getElementById('output-panel');
const outputChannelSelect = document.getElementById('output-channel-select');
const outputClearBtn = document.getElementById('output-clear');
const outputContentEl = document.getElementById('output-content');

// Terminal sub-panel
const terminalPanelEl = document.getElementById('terminal-panel');
const terminalTabsEl = document.getElementById('terminal-tabs');
const terminalContainerEl = document.getElementById('terminal-container');

// Editor area and container (used for webview show/hide)
const editorAreaEl = document.getElementById('editor-area');
const editorContainerEl = document.getElementById('editor-container');

// Minimap
const minimapEl = document.getElementById('minimap');
const minimapCanvas = document.getElementById('minimap-canvas');
const minimapViewport = document.getElementById('minimap-viewport');

// ─── Font Measurement ────────────────────────────────────────

function measureFont() {
  const style = getComputedStyle(document.body);
  cachedFont = `${style.fontSize} ${style.fontFamily}`;
  cachedFontSize = parseFloat(style.fontSize);

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = cachedFont;
  const metrics = ctx.measureText('M');
  cellWidth = metrics.width;

  lineHeight = Math.round(cachedFontSize * 1.6);

  fontReady = cellWidth > 0 && lineHeight > 0;
}

window.addEventListener('resize', () => {
  measureFont();
  resizeCanvases();
  requestRender();
});

// ─── Canvas Setup ────────────────────────────────────────────

function resizeCanvases() {
  if (!fontReady) return;
  const dpr = window.devicePixelRatio || 1;

  // Editor canvas fills visible area
  const edW = editorEl.clientWidth;
  const edH = editorEl.clientHeight;
  editorCanvas.style.width = edW + 'px';
  editorCanvas.style.height = edH + 'px';
  editorCanvas.width = Math.round(edW * dpr);
  editorCanvas.height = Math.round(edH * dpr);

  // Gutter canvas
  const gW = gutterEl.clientWidth;
  const gH = editorEl.clientHeight;
  gutterCanvas.style.width = gW + 'px';
  gutterCanvas.style.height = gH + 'px';
  gutterCanvas.width = Math.round(gW * dpr);
  gutterCanvas.height = Math.round(gH * dpr);

  // Update scroll sizer height
  updateScrollSizer();
}

function updateScrollSizer() {
  const totalH = getEffectiveLineCount() * lineHeight;
  // Scroll sizer: total height minus the canvas height (canvas is sticky and in-flow)
  const sizerH = Math.max(0, totalH - editorEl.clientHeight);
  scrollSizer.style.height = sizerH + 'px';
}

// ─── Canvas Rendering ────────────────────────────────────────

let renderScheduled = false;

function requestRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    paintAll();
  });
}

function paintAll() {
  if (!fontReady) return;
  paintEditorCanvas();
  paintGutterCanvas();
  renderMinimap();
}

function getVisibleLineRange() {
  const scrollTop = editorEl.scrollTop;
  const first = Math.floor(scrollTop / lineHeight);
  const count = Math.ceil(editorEl.clientHeight / lineHeight) + 1;
  return { first: Math.max(0, first), count };
}

function paintEditorCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const ctx = editorCanvas.getContext('2d');
  const w = editorCanvas.width;
  const h = editorCanvas.height;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w / dpr, h / dpr);
  ctx.fillStyle = BG_COLOR;
  ctx.fillRect(0, 0, w / dpr, h / dpr);

  if (!fontReady || cachedLines.length === 0) return;

  ctx.font = cachedFont;
  ctx.textBaseline = 'top';

  const { first } = getVisibleLineRange();
  const scrollTop = editorEl.scrollTop;
  const subPixelOffset = -(scrollTop % lineHeight);

  // Draw extension decorations (backgrounds behind everything)
  paintDecorations(ctx, first, subPixelOffset);

  // Draw selection
  paintSelection(ctx, first, subPixelOffset);

  // Draw find highlights
  paintFindHighlights(ctx, first, subPixelOffset);

  // Draw document highlights (symbol occurrences under cursor)
  paintDocumentHighlights(ctx, first, subPixelOffset);

  // Build diagnostic lookup map (O(1) per line instead of O(n))
  const diagMap = new Map();
  for (const d of diagnostics) {
    if (!diagMap.has(d.line)) diagMap.set(d.line, []);
    diagMap.get(d.line).push(d);
  }

  // Draw text lines
  const fontSize = cachedFontSize;
  const visibleCount = Math.ceil((h / dpr) / lineHeight) + 2;
  const hasFolds = foldedLineSet.size > 0;
  for (let vi = 0; vi < visibleCount; vi++) {
    const lineIdx = hasFolds ? displayToBuffer(first + vi) : (first + vi);
    if (lineIdx >= totalLines) break;

    const cacheOffset = lineIdx - cachedFirstLine;
    if (cacheOffset < 0 || cacheOffset >= cachedLines.length) continue;

    const line = cachedLines[cacheOffset];
    const y = vi * lineHeight + subPixelOffset;
    const textY = y + (lineHeight - fontSize) / 2;

    const semTokens = semanticTokens.get(lineIdx);
    if (semTokens && semTokens.length > 0) {
      // LSP semantic tokens take precedence over backend syntactic tokens.
      const tokens = semTokens.map(t => ({ start: t.startCol, end: t.endCol, kind: t.kind }));
      drawTokenizedLine(ctx, line.text, tokens, EDITOR_PADDING_LEFT, textY);
    } else if (line.tokens && line.tokens.length > 0) {
      drawTokenizedLine(ctx, line.text, line.tokens, EDITOR_PADDING_LEFT, textY);
    } else {
      ctx.fillStyle = TOKEN_COLORS.plain;
      ctx.fillText(line.text || '', EDITOR_PADDING_LEFT, textY);
    }

    // Draw diagnostic underlines
    const lineDiags = diagMap.get(lineIdx);
    if (lineDiags) {
      for (const d of lineDiags) {
        drawWavyUnderline(ctx,
          EDITOR_PADDING_LEFT + d.col_start * cellWidth,
          y + lineHeight - 3,
          (d.col_end - d.col_start) * cellWidth,
          DIAG_COLORS[d.severity] || DIAG_COLORS.error
        );
      }
    }

    // Draw inlay hints (overlaid at character position)
    const lineHints = inlayHints.get(lineIdx);
    if (lineHints && lineHints.length > 0) {
      ctx.fillStyle = INLAY_HINT_COLOR;
      const hintFontSize = Math.max(10, fontSize - 2);
      // cachedFont = "14px fontFamily" — strip the size prefix to get just the family
      const fontFamily = cachedFont.replace(/^\d+(\.\d+)?px\s*/, '') || 'monospace';
      ctx.font = `italic ${hintFontSize}px ${fontFamily}`;
      for (const hint of lineHints) {
        const hx = EDITOR_PADDING_LEFT + hint.character * cellWidth;
        const hy = y + (lineHeight - hintFontSize) / 2;
        const pad = hint.paddingLeft ? ' ' : '';
        const padR = hint.paddingRight ? ' ' : '';
        ctx.fillText(`${pad}${hint.label}${padR}:`, hx, hy);
      }
      // Restore main font
      ctx.font = cachedFont;
    }
  }

  // Draw document-link underlines (clickable URL/path regions)
  paintDocumentLinks(ctx, first, subPixelOffset);

  // Draw cursor
  paintCursor(ctx, first, subPixelOffset);
  paintExtraCursors(ctx, first, subPixelOffset);
}

function paintDocumentLinks(ctx, firstVisibleLine, subPixelOffset) {
  if (!ctrlHover || !documentLinks.length) return;
  const visH = editorCanvas.height / (window.devicePixelRatio || 1);
  const visibleCount = Math.ceil(visH / lineHeight) + 2;
  ctx.fillStyle = DOC_LINK_COLOR;
  for (const lnk of documentLinks) {
    const r = lnk.range; if (!r) continue;
    for (let li = r.start.line; li <= r.end.line; li++) {
      if (foldedLineSet.has(li)) continue;
      const displayLi = foldedLineSet.size > 0 ? bufferToDisplay(li) : li;
      const vi = displayLi - firstVisibleLine;
      if (vi < 0 || vi >= visibleCount) continue;
      const y = vi * lineHeight + subPixelOffset;
      const colStart = (li === r.start.line) ? r.start.character : 0;
      const lineText = getLineText(li);
      const colEnd   = (li === r.end.line) ? r.end.character : lineText.length;
      const x = EDITOR_PADDING_LEFT + colStart * cellWidth;
      const w = Math.max(1, (colEnd - colStart)) * cellWidth;
      ctx.fillRect(x, y + lineHeight - 2, w, 1);
    }
  }
}

function drawTokenizedLine(ctx, text, tokens, x, y) {
  if (!text) return;
  let lastEnd = 0;
  for (const token of tokens) {
    // Text before token (plain)
    if (token.start > lastEnd) {
      ctx.fillStyle = TOKEN_COLORS.plain;
      ctx.fillText(text.substring(lastEnd, token.start), x + lastEnd * cellWidth, y);
    }
    // Token text
    ctx.fillStyle = TOKEN_COLORS[token.kind] || TOKEN_COLORS.plain;
    ctx.fillText(text.substring(token.start, token.end), x + token.start * cellWidth, y);
    lastEnd = token.end;
  }
  // Remaining text
  if (lastEnd < text.length) {
    ctx.fillStyle = TOKEN_COLORS.plain;
    ctx.fillText(text.substring(lastEnd), x + lastEnd * cellWidth, y);
  }
}

function paintSelection(ctx, firstVisibleLine, subPixelOffset) {
  const sel = getSelectionRange();
  if (!sel) return;

  ctx.fillStyle = SELECTION_BG;
  const visibleCount = Math.ceil(editorCanvas.height / (window.devicePixelRatio || 1) / lineHeight) + 2;

  const hasFolds = foldedLineSet.size > 0;
  for (let vi = 0; vi < visibleCount; vi++) {
    const lineIdx = hasFolds ? displayToBuffer(firstVisibleLine + vi) : (firstVisibleLine + vi);
    if (lineIdx < sel.startLine || lineIdx > sel.endLine) continue;
    if (lineIdx >= totalLines) break;

    const lineText = getLineText(lineIdx);
    const lineLen = lineText.length;

    const colStart = (lineIdx === sel.startLine) ? sel.startCol : 0;
    let colEnd = (lineIdx === sel.endLine) ? sel.endCol : lineLen;
    if (lineIdx !== sel.endLine) colEnd = Math.max(colEnd, lineLen) + 1;
    if (colStart >= colEnd) continue;

    const y = vi * lineHeight + subPixelOffset;
    const x = EDITOR_PADDING_LEFT + colStart * cellWidth;
    const w = Math.max((colEnd - colStart) * cellWidth, cellWidth * 0.5);
    ctx.fillRect(x, y, w, lineHeight);
  }
}

function paintDecorations(ctx, firstVisibleLine, subPixelOffset) {
  if (!activeDecorations || activeDecorations.length === 0) return;
  const currentUri = filePath ? filePathToUri(filePath) : null;
  const visibleCount = Math.ceil(editorCanvas.height / (window.devicePixelRatio || 1) / lineHeight) + 2;

  for (const dec of activeDecorations) {
    if (dec.uri !== currentUri) continue;
    const bgColor = dec.background_color;
    const fgColor = dec.color;
    const borderColor = dec.border_color;
    const afterText = dec.after_text;

    for (const r of dec.ranges) {
      for (let lineIdx = r.start_line; lineIdx <= r.end_line; lineIdx++) {
        if (foldedLineSet.has(lineIdx)) continue;
        const displayLine = foldedLineSet.size > 0 ? bufferToDisplay(lineIdx) : lineIdx;
        const vi = displayLine - firstVisibleLine;
        if (vi < -1 || vi >= visibleCount) continue;
        const y = vi * lineHeight + subPixelOffset;

        const colStart = (lineIdx === r.start_line) ? r.start_col : 0;
        const colEnd   = (lineIdx === r.end_line)   ? r.end_col   : 999;

        if (bgColor) {
          ctx.fillStyle = bgColor;
          if (colStart === 0 && colEnd === 999) {
            // Full-line decoration
            ctx.fillRect(EDITOR_PADDING_LEFT, y, editorCanvas.width / (window.devicePixelRatio || 1) - EDITOR_PADDING_LEFT, lineHeight);
          } else {
            ctx.fillRect(
              EDITOR_PADDING_LEFT + colStart * cellWidth,
              y,
              Math.max((colEnd - colStart) * cellWidth, cellWidth),
              lineHeight
            );
          }
        }

        if (borderColor) {
          ctx.strokeStyle = borderColor;
          ctx.lineWidth = 1;
          const bx = EDITOR_PADDING_LEFT + colStart * cellWidth;
          const bw = colEnd === 999
            ? (editorCanvas.width / (window.devicePixelRatio || 1) - bx)
            : Math.max((colEnd - colStart) * cellWidth, cellWidth);
          ctx.strokeRect(bx + 0.5, y + 0.5, bw - 1, lineHeight - 1);
        }

        if (afterText && lineIdx === r.end_line) {
          ctx.fillStyle = fgColor ?? 'rgba(150,150,150,0.7)';
          ctx.fillText(afterText, EDITOR_PADDING_LEFT + colEnd * cellWidth + 4, y + (lineHeight - (cachedFontSize || lineHeight * 0.65)) / 2);
        }
      }
    }
  }
}

function paintFindHighlights(ctx, firstVisibleLine, subPixelOffset) {
  if (!findOpen || findMatches.length === 0) return;

  for (let mi = 0; mi < findMatches.length; mi++) {
    const m = findMatches[mi];
    if (foldedLineSet.has(m.line)) continue;
    const displayLine = foldedLineSet.size > 0 ? bufferToDisplay(m.line) : m.line;
    const vi = displayLine - firstVisibleLine;
    if (vi < -1 || vi > Math.ceil(editorCanvas.height / (window.devicePixelRatio || 1) / lineHeight) + 2) continue;

    const y = vi * lineHeight + subPixelOffset;
    const x = EDITOR_PADDING_LEFT + m.col * cellWidth;
    const w = m.length * cellWidth;

    if (mi === findCurrentIdx) {
      ctx.fillStyle = FIND_CUR_BG;
      ctx.fillRect(x, y, w, lineHeight);
      ctx.strokeStyle = FIND_CUR_BORDER;
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, w - 1, lineHeight - 1);
    } else {
      ctx.fillStyle = FIND_BG;
      ctx.fillRect(x, y, w, lineHeight);
      ctx.strokeStyle = FIND_BORDER;
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, w - 1, lineHeight - 1);
    }
  }
}

function paintDocumentHighlights(ctx, firstVisibleLine, subPixelOffset) {
  if (!documentHighlights.length) return;
  const visH = editorCanvas.height / (window.devicePixelRatio || 1);
  const visibleCount = Math.ceil(visH / lineHeight) + 2;
  for (const h of documentHighlights) {
    for (let li = h.start_line; li <= h.end_line; li++) {
      if (foldedLineSet.has(li)) continue;
      const displayLi = foldedLineSet.size > 0 ? bufferToDisplay(li) : li;
      const vi = displayLi - firstVisibleLine;
      if (vi < 0 || vi >= visibleCount) continue;
      const y = vi * lineHeight + subPixelOffset;
      const colStart = (li === h.start_line) ? h.start_col : 0;
      const lineText = getLineText(li);
      const colEnd   = (li === h.end_line) ? h.end_col : lineText.length;
      const x = EDITOR_PADDING_LEFT + colStart * cellWidth;
      const w = Math.max(1, (colEnd - colStart)) * cellWidth;
      ctx.fillStyle = h.kind === 3 ? DOC_HIGHLIGHT_WRITE_BG
                    : h.kind === 2 ? DOC_HIGHLIGHT_READ_BG
                    : DOC_HIGHLIGHT_TEXT_BG;
      ctx.fillRect(x, y, w, lineHeight);
    }
  }
}

function paintCursor(ctx, firstVisibleLine, subPixelOffset) {
  if (!cursorVisible) return;
  const displayCursorLine = foldedLineSet.size > 0 ? bufferToDisplay(cursorLine) : cursorLine;
  if (displayCursorLine < 0) return; // cursor on a folded line
  const vi = displayCursorLine - firstVisibleLine;
  const visH = editorCanvas.height / (window.devicePixelRatio || 1);
  if (vi < 0 || vi * lineHeight + subPixelOffset > visH) return;

  const y = vi * lineHeight + subPixelOffset;
  const x = EDITOR_PADDING_LEFT + cursorCol * cellWidth;

  // Draw ghost text before cursor bar so bar renders on top
  if (ghostText) {
    const fontSize = cachedFontSize;
    const textY = y + (lineHeight - fontSize) / 2;
    ctx.fillStyle = GHOST_TEXT_COLOR;
    ctx.fillText(ghostText, x + 2, textY);
  }

  ctx.fillStyle = CURSOR_COLOR;
  ctx.fillRect(x, y, 2, lineHeight);
}

/**
 * Paint selections and carets for all extra cursors.
 * Called from paintEditorCanvas after the primary cursor is painted.
 */
function paintExtraCursors(ctx, firstVisibleLine, subPixelOffset) {
  if (!isMultiCursor()) return;
  const visH = editorCanvas.height / (window.devicePixelRatio || 1);
  const visibleCount = Math.ceil(visH / lineHeight) + 2;

  // Paint extra selections first (so carets render on top)
  ctx.fillStyle = SELECTION_BG;
  for (const c of extraCursors) {
    if (!cursorHasSelection(c)) continue;
    const sel = normalizeCursorSel(c);
    for (let vi = 0; vi < visibleCount; vi++) {
      const lineIdx = firstVisibleLine + vi;
      if (lineIdx < sel.startLine || lineIdx > sel.endLine) continue;
      if (lineIdx >= totalLines) break;
      const lineText = getLineText(lineIdx);
      const lineLen = lineText.length;
      const colStart = lineIdx === sel.startLine ? sel.startCol : 0;
      let colEnd = lineIdx === sel.endLine ? sel.endCol : lineLen;
      if (lineIdx !== sel.endLine) colEnd = Math.max(colEnd, lineLen) + 1;
      if (colStart >= colEnd) continue;
      const y = vi * lineHeight + subPixelOffset;
      ctx.fillRect(EDITOR_PADDING_LEFT + colStart * cellWidth, y,
        Math.max((colEnd - colStart) * cellWidth, cellWidth * 0.5), lineHeight);
    }
  }

  // Paint extra carets
  for (const c of extraCursors) {
    if (!cursorVisible) continue;
    const vi = c.line - firstVisibleLine;
    if (vi < 0 || vi * lineHeight + subPixelOffset > visH) continue;
    const y = vi * lineHeight + subPixelOffset;
    ctx.fillStyle = CURSOR_COLOR;
    ctx.fillRect(EDITOR_PADDING_LEFT + c.col * cellWidth, y, 2, lineHeight);
  }
}

function drawWavyUnderline(ctx, x, y, width, color) {
  if (width <= 0) return;
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  const amplitude = 2;
  const wavelength = 4;
  const maxSegments = 500;
  const step = Math.max(0.5, width / maxSegments);
  for (let i = 0; i <= width; i += step) {
    const dy = Math.sin((i / wavelength) * Math.PI * 2) * amplitude;
    if (i === 0) ctx.moveTo(x + i, y + dy);
    else ctx.lineTo(x + i, y + dy);
  }
  // Ensure the path reaches the end
  const dyEnd = Math.sin((width / wavelength) * Math.PI * 2) * amplitude;
  ctx.lineTo(x + width, y + dyEnd);
  ctx.stroke();
}

function paintGutterCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const ctx = gutterCanvas.getContext('2d');
  const w = gutterCanvas.width / dpr;
  const h = gutterCanvas.height / dpr;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = GUTTER_BG;
  ctx.fillRect(0, 0, w, h);

  if (!fontReady) return;

  ctx.font = cachedFont;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'right';

  const { first } = getVisibleLineRange();
  const scrollTop = editorEl.scrollTop;
  const subPixelOffset = -(scrollTop % lineHeight);

  // Build diagnostic line set for O(1) lookup
  const diagLineMap = new Map();
  for (const d of diagnostics) {
    if (!diagLineMap.has(d.line)) diagLineMap.set(d.line, d);
  }

  const visibleCount = Math.ceil(h / lineHeight) + 2;
  const gutterTextX = w - GUTTER_PADDING_RIGHT;

  // Build comment thread line map for O(1) lookup
  const commentLineMap = new Map();
  for (const t of commentThreads) {
    if (!commentLineMap.has(t.start_line)) commentLineMap.set(t.start_line, t);
  }

  // Build fold start set for O(1) lookup
  const foldStartSet = new Set(foldingRanges.map(r => r.startLine));

  for (let vi = 0; vi < visibleCount; vi++) {
    // Map display line to buffer line when folding is active
    const lineIdx = foldedLineSet.size > 0 ? displayToBuffer(first + vi) : (first + vi);
    if (lineIdx >= totalLines) break;

    const y = vi * lineHeight + subPixelOffset;
    const textY = y + (lineHeight - cachedFontSize) / 2;

    // Check for diagnostic markers on this line
    const lineDiag = diagLineMap.get(lineIdx);
    if (lineDiag) {
      ctx.fillStyle = DIAG_COLORS[lineDiag.severity] || GUTTER_FG;
    } else {
      ctx.fillStyle = GUTTER_FG;
    }

    ctx.fillText(String(lineIdx + 1), gutterTextX, textY);

    // Fold indicator — ▼ (expanded) or ▶ (collapsed)
    if (foldStartSet.has(lineIdx)) {
      ctx.fillStyle = '#6c7086';
      ctx.font = `${Math.max(8, cachedFontSize - 2)}px ${cachedFont.split('px ').slice(1).join('px ')}`;
      ctx.textAlign = 'center';
      ctx.fillText(collapsedFolds.has(lineIdx) ? '▶' : '▼', w - 4, textY);
      ctx.textAlign = 'right';
      ctx.font = cachedFont;
    }

    // Breakpoint marker (red dot) — drawn on the left side of the gutter
    const bpSet = filePath ? breakpoints.get(filePath) : null;
    if (bpSet && bpSet.has(lineIdx)) {
      ctx.fillStyle = '#f38ba8';
      ctx.beginPath();
      const r = Math.min(5, lineHeight / 2 - 2);
      ctx.arc(r + 2, y + lineHeight / 2, r, 0, Math.PI * 2);
      ctx.fill();
    }

    // Current stopped frame indicator (yellow arrow)
    if (debugStopped && debugCallStack.length > 0) {
      const top = debugCallStack[0];
      if (top && filePath && top.source?.path === filePath && (top.line - 1) === lineIdx) {
        ctx.fillStyle = '#f9e2af';
        ctx.font = `${cachedFontSize}px ${cachedFont.split('px ').slice(1).join('px ')}`;
        ctx.textAlign = 'left';
        ctx.fillText('▶', 2, textY);
        ctx.textAlign = 'right';
        ctx.font = cachedFont;
      }
    }

    // Comment thread indicator — blue bar on right edge of gutter
    if (commentLineMap.has(lineIdx)) {
      ctx.fillStyle = '#89b4fa';
      ctx.fillRect(w - 2, y, 2, lineHeight);
    }
  }
}

// ─── Content Fetching ────────────────────────────────────────

async function fetchVisibleContent() {
  const { first, count } = getVisibleLineRange();
  const displayFirst = Math.max(0, first - BUFFER_LINES);
  const displayCount = count + BUFFER_LINES * 2;

  // When folding is active, map display range to buffer range
  let fetchFirst, fetchCount;
  if (foldedLineSet.size > 0) {
    const bufFirst = displayToBuffer(displayFirst);
    const bufLast = displayToBuffer(Math.min(displayFirst + displayCount - 1, getEffectiveLineCount() - 1));
    fetchFirst = bufFirst;
    fetchCount = Math.max(1, bufLast - bufFirst + 1);
  } else {
    fetchFirst = displayFirst;
    fetchCount = displayCount;
  }

  try {
    const vc = await invoke('get_visible_content', {
      firstLine: fetchFirst,
      lineCount: fetchCount,
    });
    cachedLines = vc.lines;
    cachedFirstLine = vc.first_line;
    totalLines = vc.total_lines;
    filePath = vc.file_path || filePath;
    modified = vc.modified;
    cachedLanguage = vc.language;
    diagnostics = vc.diagnostics || [];
    updateScrollSizer();
  } catch (err) {
    console.error('fetchVisibleContent error:', err);
  }
}

function getLineText(lineIdx) {
  const offset = lineIdx - cachedFirstLine;
  if (offset >= 0 && offset < cachedLines.length) {
    return cachedLines[offset]?.text || '';
  }
  return '';
}

// ─── Update Helpers ──────────────────────────────────────────

/**
 * Called after file open / switch / close (which still return EditorContent).
 * Uses the full content for initial metadata, then fetches visible for canvas.
 */
async function updateFromEditorContent(content) {
  filePath = content.file_path;
  modified = content.modified;
  totalLines = content.line_count;
  diagnostics = content.diagnostics || [];
  cachedLanguage = content.language;
  // Reset inlay hints, document highlights, multi-cursor, comment threads, and folds when file changes
  inlayHints = new Map();
  inlayHintsUri = null;
  documentHighlights = [];
  documentHighlightsUri = null;
  documentLinks = [];
  documentLinksUri = null;
  semanticTokens = new Map();
  semanticTokensUri = null;
  semanticTokensResultId = null;
  extraCursors = [];
  ctrlDWord = null;
  commentThreads = [];
  foldingRanges = [];
  collapsedFolds.clear();
  foldedLineSet.clear();
  closeCommentPopup();

  // Populate cache from full content (for the visible range)
  cachedLines = content.lines || [];
  cachedFirstLine = 0;

  if (filePath) {
    activeBufferPath = filePath;
  }

  updateMetadataUI();
  updateScrollSizer();
  resizeCanvases();
  ensureCursorVisible();
  await fetchVisibleContent();
  requestRender();
  // Fetch folding ranges in background after file loads
  fetchFoldingRanges();
  // Fetch document links + semantic tokens in background
  fetchDocumentLinks();
  fetchSemanticTokens();
}

/**
 * Called after edit commands (which now return EditResult).
 */
async function updateFromEditResult(result) {
  totalLines = result.total_lines;
  modified = result.modified;
  updateMetadataUI();
  updateScrollSizer();
  ensureCursorVisible();
  await fetchVisibleContent();
  requestRender();
}

function updateMetadataUI() {
  if (filePath) {
    const name = filePath.split(/[/\\]/).pop();
    fileNameEl.textContent = (modified ? '● ' : '') + name;
  } else {
    fileNameEl.textContent = 'CoreCode';
  }

  if (cachedLanguage) {
    languageBadgeEl.textContent = cachedLanguage;
    languageBadgeEl.style.display = '';
  } else {
    languageBadgeEl.style.display = 'none';
  }

  fileInfoEl.textContent = `${totalLines} lines`;

  const errorCount = diagnostics.filter(d => d.severity === 'error').length;
  const warnCount = diagnostics.filter(d => d.severity === 'warning').length;
  if (errorCount || warnCount) {
    const parts = [];
    if (errorCount) parts.push(`${errorCount} error${errorCount > 1 ? 's' : ''}`);
    if (warnCount) parts.push(`${warnCount} warning${warnCount > 1 ? 's' : ''}`);
    diagCountEl.textContent = parts.join(', ');
  } else {
    diagCountEl.textContent = '';
  }

  cursorLine = Math.max(0, Math.min(cursorLine, totalLines - 1));
  cursorCol = Math.max(0, Math.min(cursorCol, getLineText(cursorLine).length));
}

function ensureCursorVisible() {
  const displayLine = foldedLineSet.size > 0 ? bufferToDisplay(cursorLine) : cursorLine;
  const effectiveLine = displayLine >= 0 ? displayLine : cursorLine;
  const cursorTop = effectiveLine * lineHeight;
  const cursorBottom = cursorTop + lineHeight;
  if (cursorBottom > editorEl.scrollTop + editorEl.clientHeight) {
    editorEl.scrollTop = cursorBottom - editorEl.clientHeight;
  } else if (cursorTop < editorEl.scrollTop) {
    editorEl.scrollTop = cursorTop;
  }
}

function updateStatusBar() {
  let pos = `Ln ${cursorLine + 1}, Col ${cursorCol + 1}`;
  if (isMultiCursor()) {
    pos += ` [${extraCursors.length + 1} cursors]`;
  } else if (hasSelection()) {
    const sel = getSelectionRange();
    const selLines = sel.endLine - sel.startLine + 1;
    pos += ` (${selLines} line${selLines > 1 ? 's' : ''} selected)`;
  }
  cursorPosEl.textContent = pos;
  a11yAnnounceCursor();
  scheduleGhostText();
  scheduleInlayHints();
  scheduleDocumentHighlights();
}

function scheduleGhostText() {
  if (ghostTextTimer) clearTimeout(ghostTextTimer);
  ghostText = null;
  ghostTextTimer = setTimeout(async () => {
    if (!filePath) return;
    try {
      const uri = filePathToUri(filePath);
      const result = await invoke('lsp_inline_completion', { uri, line: cursorLine, character: cursorCol });
      const items = result?.items ?? [];
      if (items.length > 0) {
        const candidate = items[0].insertText ?? '';
        // Only show the portion after the current cursor position on this line
        const lineText = getLineText(cursorLine);
        const cursorRest = lineText.slice(cursorCol);
        ghostText = candidate.startsWith(cursorRest) ? candidate.slice(cursorRest.length) : candidate;
        requestRender();
      }
    } catch { /* no inline completion provider */ }
  }, 300);
}

function scheduleInlayHints() {
  if (inlayHintsTimer) clearTimeout(inlayHintsTimer);
  inlayHintsTimer = setTimeout(async () => {
    if (!filePath) return;
    const uri = filePathToUri(filePath);
    const dpr = window.devicePixelRatio || 1;
    const visH = editorCanvas.height / dpr;
    const firstLine = Math.max(0, Math.floor(editorEl.scrollTop / lineHeight));
    const endLine = Math.min(totalLines - 1, firstLine + Math.ceil(visH / lineHeight) + 5);
    if (uri === inlayHintsUri && inlayHints.size > 0) {
      // Already have hints for this file, only re-fetch if we scrolled far
      const firstCached = Math.min(...inlayHints.keys());
      const lastCached = Math.max(...inlayHints.keys());
      if (firstLine >= firstCached && endLine <= lastCached + 5) return;
    }
    try {
      const result = await invoke('lsp_inlay_hints', { uri, startLine: firstLine, endLine });
      if (!Array.isArray(result) || result.length === 0) { inlayHints = new Map(); requestRender(); return; }
      const newHints = new Map();
      for (const h of result) {
        const ln = h.line;
        if (!newHints.has(ln)) newHints.set(ln, []);
        newHints.get(ln).push({ character: h.character, label: h.label, kind: h.kind ?? 1, paddingLeft: h.paddingLeft ?? false, paddingRight: h.paddingRight ?? false });
      }
      inlayHints = newHints;
      inlayHintsUri = uri;
      requestRender();
    } catch { /* no inlay hints provider */ }
  }, 600);
}

function scheduleDocumentHighlights() {
  if (documentHighlightsTimer) clearTimeout(documentHighlightsTimer);
  documentHighlightsTimer = setTimeout(async () => {
    if (!filePath || isMultiCursor()) return;
    const uri = filePathToUri(filePath);
    try {
      const result = await invoke('lsp_document_highlights', { uri, line: cursorLine, character: cursorCol });
      if (!Array.isArray(result) || result.length === 0) {
        if (documentHighlights.length > 0) { documentHighlights = []; requestRender(); }
        return;
      }
      documentHighlights = result;
      documentHighlightsUri = uri;
      requestRender();
    } catch { /* no provider */ }
  }, 300);
}

async function fetchDocumentLinks() {
  const uri = getActiveUri();
  if (!uri) return;
  const buf = activeBufferPath;
  const myToken = ++documentLinksToken;
  try {
    const result = await invoke('lsp_document_links', { uri });
    if (myToken !== documentLinksToken || activeBufferPath !== buf) return;
    if (!Array.isArray(result)) { documentLinks = []; return; }
    documentLinks = result;
    documentLinksUri = uri;
    requestRender();
  } catch { documentLinks = []; }
}

async function fetchSemanticTokens() {
  const uri = getActiveUri();
  if (!uri) return;
  const buf = activeBufferPath;
  const myToken = ++semanticTokensToken;
  try {
    const result = await invoke('lsp_semantic_tokens_full', { uri });
    if (myToken !== semanticTokensToken || activeBufferPath !== buf) return;
    if (!result || !Array.isArray(result.data) || result.data.length === 0) {
      semanticTokens = new Map();
      semanticTokensResultId = null;
      return;
    }
    const legend = result.legend || null;
    semanticTokens = decodeSemanticTokens(result.data, legend);
    semanticTokensResultId = result.resultId || null;
    semanticTokensUri = uri;
    requestRender();
  } catch {
    semanticTokens = new Map();
    semanticTokensResultId = null;
  }
}

// Decode LSP semantic tokens delta-encoded flat array into per-line spans.
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

// Look up a document link covering the given (line, col). Returns first match.
function findDocumentLinkAt(line, col) {
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

async function openDocumentLink(link) {
  let lnk = link;
  const buf = activeBufferPath;
  // Resolve if target missing.
  if (!lnk.target) {
    try {
      const resolved = await invoke('lsp_resolve_document_link', { link: lnk });
      if (activeBufferPath !== buf) return; // buffer switched mid-resolve
      if (resolved && resolved.target) lnk = resolved;
    } catch { /* fall through with unresolved link */ }
  }
  const target = lnk.target;
  if (!target) {
    statusEl.textContent = 'Link has no target';
    setTimeout(() => { statusEl.textContent = ''; }, 1500);
    return;
  }
  if (target.startsWith('file://')) {
    let uri = target;
    let frag = null;
    const hashIdx = uri.indexOf('#');
    if (hashIdx >= 0) { frag = uri.substring(hashIdx + 1); uri = uri.substring(0, hashIdx); }
    let line = 0, col = 0;
    if (frag) {
      const m = frag.match(/^L?(\d+)(?:[,:](\d+))?$/);
      if (m) { line = Math.max(0, parseInt(m[1], 10) - 1); col = m[2] ? Math.max(0, parseInt(m[2], 10) - 1) : 0; }
    }
    await navigateToLocation(uri, line, col);
    return;
  }
  if (/^https?:\/\//.test(target)) {
    const opener = window.__TAURI__ && window.__TAURI__.opener;
    if (opener && typeof opener.openUrl === 'function') {
      try {
        await opener.openUrl(target);
        return;
      } catch (err) {
        statusEl.textContent = `Cannot open URL: ${err}`;
        setTimeout(() => { statusEl.textContent = ''; }, 2500);
        return;
      }
    }
    // shell:allow-open capability not granted — surface so user knows.
    statusEl.textContent = `URL link requires 'shell:allow-open' capability: ${target}`;
    setTimeout(() => { statusEl.textContent = ''; }, 3000);
    return;
  }
  statusEl.textContent = `Unsupported link: ${target}`;
  setTimeout(() => { statusEl.textContent = ''; }, 2000);
}

// ─── Buffer State Management ─────────────────────────────────

function saveBufferState() {
  if (!activeBufferPath) return;
  bufferStates.set(activeBufferPath, {
    cursorLine,
    cursorCol,
    selAnchorLine,
    selAnchorCol,
    scrollTop: editorEl.scrollTop,
  });
}

function restoreBufferState(path) {
  const state = bufferStates.get(path);
  if (state) {
    cursorLine = state.cursorLine;
    cursorCol = state.cursorCol;
    selAnchorLine = state.selAnchorLine;
    selAnchorCol = state.selAnchorCol;
  } else {
    cursorLine = 0;
    cursorCol = 0;
    selAnchorLine = null;
    selAnchorCol = null;
  }
}

// ─── Tab Bar ──────────────────────────────────────────────────

async function renderTabs() {
  try {
    const buffers = await invoke('list_open_buffers');
    tabsEl.innerHTML = '';

    if (buffers.length === 0) {
      const hint = document.createElement('div');
      hint.className = 'tab-empty-hint';
      hint.textContent = 'No files open — Ctrl+O to open';
      tabsEl.appendChild(hint);
      return;
    }

    for (const buf of buffers) {
      const tab = document.createElement('div');
      tab.className = 'tab' + (buf.active ? ' active' : '');
      tab.dataset.path = buf.path;

      const name = buf.path.split(/[/\\]/).pop();

      if (buf.modified) {
        const dot = document.createElement('span');
        dot.className = 'tab-modified';
        dot.textContent = '●';
        tab.appendChild(dot);
      }

      const label = document.createElement('span');
      label.className = 'tab-label';
      label.textContent = name;
      label.title = buf.path;
      tab.appendChild(label);

      const close = document.createElement('button');
      close.className = 'tab-close';
      close.textContent = '×';
      close.title = 'Close';
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        closeTab(buf.path);
      });
      tab.appendChild(close);

      tab.addEventListener('click', () => {
        switchTab(buf.path);
        showEditorCanvas();
      });
      tabsEl.appendChild(tab);
    }

    // Append webview panel tabs
    for (const [panelId, panel] of webviewPanelMap) {
      const wvTab = document.createElement('div');
      wvTab.className = 'tab webview-tab' + (panelId === activeWebviewPanelId ? ' active' : '');
      wvTab.dataset.panelId = panelId;

      const wvLabel = document.createElement('span');
      wvLabel.className = 'tab-label';
      wvLabel.textContent = panel.title || 'Preview';
      wvTab.appendChild(wvLabel);

      const wvClose = document.createElement('button');
      wvClose.className = 'tab-close';
      wvClose.textContent = '×';
      wvClose.title = 'Close';
      wvClose.addEventListener('click', (e) => { e.stopPropagation(); closeWebviewTabByUser(panelId); });
      wvTab.appendChild(wvClose);

      wvTab.addEventListener('click', () => revealWebviewTab(panelId));
      tabsEl.appendChild(wvTab);
    }
  } catch (err) {
    console.error('renderTabs error:', err);
  }
}

async function switchTab(path) {
  if (path === activeBufferPath && activeWebviewPanelId === null) return;
  try {
    showEditorCanvas();
    saveBufferState();
    const content = await invoke('switch_buffer', { path });
    activeBufferPath = path;
    restoreBufferState(path);
    await updateFromEditorContent(content);
    renderTabs();
    const scrollState = bufferStates.get(path);
    if (scrollState) editorEl.scrollTop = scrollState.scrollTop;
  } catch (err) {
    console.error('switchTab error:', err);
    statusEl.textContent = `Error: ${err}`;
  }
}

async function closeTab(path) {
  try {
    bufferStates.delete(path);
    const result = await invoke('close_buffer', { path });
    if (result) {
      activeBufferPath = result.file_path;
      restoreBufferState(activeBufferPath);
      await updateFromEditorContent(result);
    } else {
      activeBufferPath = null;
      cursorLine = 0;
      cursorCol = 0;
      clearSelection();
      const content = await invoke('get_content');
      await updateFromEditorContent(content);
    }
    renderTabs();
  } catch (err) {
    console.error('closeTab error:', err);
  }
}

// ─── Selection Helpers ───────────────────────────────────────

function hasSelection() {
  return selAnchorLine !== null && selAnchorCol !== null &&
    (selAnchorLine !== cursorLine || selAnchorCol !== cursorCol);
}

function getSelectionRange() {
  if (!hasSelection()) return null;
  if (selAnchorLine < cursorLine ||
      (selAnchorLine === cursorLine && selAnchorCol <= cursorCol)) {
    return { startLine: selAnchorLine, startCol: selAnchorCol,
             endLine: cursorLine, endCol: cursorCol };
  }
  return { startLine: cursorLine, startCol: cursorCol,
           endLine: selAnchorLine, endCol: selAnchorCol };
}

function clearSelection() {
  selAnchorLine = null;
  selAnchorCol = null;
}

function ensureAnchor() {
  if (selAnchorLine === null) {
    selAnchorLine = cursorLine;
    selAnchorCol = cursorCol;
  }
}

// ─── Multi-Cursor Helpers ─────────────────────────────────────

function isMultiCursor() { return extraCursors.length > 0; }

/** Return all cursors (primary first). */
function getAllCursors() {
  return [
    { line: cursorLine, col: cursorCol, anchorLine: selAnchorLine, anchorCol: selAnchorCol },
    ...extraCursors,
  ];
}

/** Write primary cursor from object. */
function setPrimaryCursor(c) {
  cursorLine = c.line;
  cursorCol = c.col;
  selAnchorLine = c.anchorLine ?? null;
  selAnchorCol = c.anchorCol ?? null;
}

/** Deduplicate a cursor array by (line, col). */
function deduplicateCursors(cursors) {
  const seen = new Set();
  return cursors.filter(c => {
    const key = `${c.line}:${c.col}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Add cursor at position if not already there. */
function addCursorAt(line, col) {
  if (line === cursorLine && col === cursorCol) return;
  if (extraCursors.some(c => c.line === line && c.col === col)) return;
  extraCursors.push({ line, col, anchorLine: null, anchorCol: null });
  resetCursorBlink();
  requestRender();
  updateStatusBar();
}

/** Collapse all extra cursors — back to single-cursor mode. */
function clearExtraCursors() {
  extraCursors = [];
  ctrlDWord = null;
  ctrlDLastLine = -1;
  ctrlDLastCol = -1;
}

/** Normalize a cursor's selection to {startLine, startCol, endLine, endCol}. */
function normalizeCursorSel(cursor) {
  const { line, col, anchorLine, anchorCol } = cursor;
  if (anchorLine === null) return null;
  if (anchorLine < line || (anchorLine === line && anchorCol <= col))
    return { startLine: anchorLine, startCol: anchorCol, endLine: line, endCol: col };
  return { startLine: line, startCol: col, endLine: anchorLine, endCol: anchorCol };
}

/** True if the cursor has a non-empty selection. */
function cursorHasSelection(cursor) {
  return cursor.anchorLine !== null && cursor.anchorCol !== null &&
    (cursor.anchorLine !== cursor.line || cursor.anchorCol !== cursor.col);
}

/**
 * Compute the cursor position after inserting `text` at (startLine, startCol).
 * Used by paste and block-insert edit descriptors.
 */
function insertEndPos(startLine, startCol, text) {
  const lines = text.split('\n');
  if (lines.length === 1) return { line: startLine, col: startCol + text.length };
  return { line: startLine + lines.length - 1, col: lines[lines.length - 1].length };
}

// ─── Edit Descriptor Functions ───────────────────────────────
// Each takes a cursor snapshot and returns { sl, sc, el, ec, text, newLine, newCol }
// or null (no-op). Used by multiCursorEdit().

function typeCharDesc(cursor, ch) {
  if (cursorHasSelection(cursor)) {
    const s = normalizeCursorSel(cursor);
    return { sl: s.startLine, sc: s.startCol, el: s.endLine, ec: s.endCol,
             text: ch, newLine: s.startLine, newCol: s.startCol + 1 };
  }
  return { sl: cursor.line, sc: cursor.col, el: cursor.line, ec: cursor.col,
           text: ch, newLine: cursor.line, newCol: cursor.col + 1 };
}

function backspaceDesc(cursor) {
  if (cursorHasSelection(cursor)) {
    const s = normalizeCursorSel(cursor);
    return { sl: s.startLine, sc: s.startCol, el: s.endLine, ec: s.endCol,
             text: '', newLine: s.startLine, newCol: s.startCol };
  }
  if (cursor.line === 0 && cursor.col === 0) return null;
  if (cursor.col > 0)
    return { sl: cursor.line, sc: cursor.col - 1, el: cursor.line, ec: cursor.col,
             text: '', newLine: cursor.line, newCol: cursor.col - 1 };
  const prevLen = getLineText(cursor.line - 1).length;
  return { sl: cursor.line - 1, sc: prevLen, el: cursor.line, ec: 0,
           text: '', newLine: cursor.line - 1, newCol: prevLen };
}

function deleteDesc(cursor) {
  if (cursorHasSelection(cursor)) {
    const s = normalizeCursorSel(cursor);
    return { sl: s.startLine, sc: s.startCol, el: s.endLine, ec: s.endCol,
             text: '', newLine: s.startLine, newCol: s.startCol };
  }
  const lineLen = getLineText(cursor.line).length;
  if (cursor.col >= lineLen) {
    if (cursor.line >= totalLines - 1) return null;
    return { sl: cursor.line, sc: cursor.col, el: cursor.line + 1, ec: 0,
             text: '', newLine: cursor.line, newCol: cursor.col };
  }
  return { sl: cursor.line, sc: cursor.col, el: cursor.line, ec: cursor.col + 1,
           text: '', newLine: cursor.line, newCol: cursor.col };
}

function enterDesc(cursor) {
  if (cursorHasSelection(cursor)) {
    const s = normalizeCursorSel(cursor);
    return { sl: s.startLine, sc: s.startCol, el: s.endLine, ec: s.endCol,
             text: '\n', newLine: s.startLine + 1, newCol: 0 };
  }
  return { sl: cursor.line, sc: cursor.col, el: cursor.line, ec: cursor.col,
           text: '\n', newLine: cursor.line + 1, newCol: 0 };
}

function tabDesc(cursor) {
  const spaces = '    ';
  if (cursorHasSelection(cursor)) {
    const s = normalizeCursorSel(cursor);
    return { sl: s.startLine, sc: s.startCol, el: s.endLine, ec: s.endCol,
             text: spaces, newLine: s.startLine, newCol: s.startCol + 4 };
  }
  return { sl: cursor.line, sc: cursor.col, el: cursor.line, ec: cursor.col,
           text: spaces, newLine: cursor.line, newCol: cursor.col + 4 };
}

function pasteDesc(cursor, clipText) {
  if (cursorHasSelection(cursor)) {
    const s = normalizeCursorSel(cursor);
    const end = insertEndPos(s.startLine, s.startCol, clipText);
    return { sl: s.startLine, sc: s.startCol, el: s.endLine, ec: s.endCol,
             text: clipText, newLine: end.line, newCol: end.col };
  }
  const end = insertEndPos(cursor.line, cursor.col, clipText);
  return { sl: cursor.line, sc: cursor.col, el: cursor.line, ec: cursor.col,
           text: clipText, newLine: end.line, newCol: end.col };
}

// ─── Core Multi-Cursor Edit Executor ─────────────────────────
/**
 * Apply editFn to every cursor (primary + extras) bottom-to-top.
 * editFn(cursor) → { sl, sc, el, ec, text, newLine, newCol } | null
 * After all edits, adjusts newLine for net line-count changes, then
 * updates cursor positions and calls updateFromEditResult once.
 */
function multiCursorEdit(editFn) {
  ghostText = null;
  queueEdit(async () => {
    const allC = getAllCursors();
    const n = allC.length;

    // Sort bottom-to-top (highest line first), right-to-left within same line
    const order = allC.map((_, i) => i);
    order.sort((a, b) => allC[b].line !== allC[a].line
      ? allC[b].line - allC[a].line
      : allC[b].col - allC[a].col);

    // Compute edit descriptors (sync, uses only pre-edit cursor positions)
    const descs = allC.map(c => editFn(c));

    // Apply edits bottom-to-top, record results and line deltas
    const lineDelta = new Array(n).fill(0);
    let lastResult = null;

    for (const idx of order) {
      const d = descs[idx];
      if (!d) continue;
      const result = await invoke('edit_replace_range', {
        startLine: d.sl, startCol: d.sc,
        endLine: d.el, endCol: d.ec,
        text: d.text,
      });
      lastResult = result;
      lineDelta[idx] = (d.text.split('\n').length - 1) - (d.el - d.sl);
    }

    // Adjust each cursor's newLine for line-count changes from edits at lower lines
    const finalCursors = allC.map((_, i) => {
      const d = descs[i];
      const base = d ? { line: d.newLine, col: d.newCol } : { line: allC[i].line, col: allC[i].col };
      let adj = 0;
      for (let j = 0; j < n; j++) {
        if (j === i || !descs[j]) continue;
        if (descs[j].sl > (d ? d.sl : allC[i].line)) adj += lineDelta[j];
      }
      return { line: base.line + adj, col: base.col, anchorLine: null, anchorCol: null };
    });

    // Deduplicate and write back
    const deduped = deduplicateCursors(finalCursors);
    setPrimaryCursor(deduped[0]);
    extraCursors = deduped.slice(1);

    if (lastResult) await updateFromEditResult(lastResult);
  });
}

// ─── Word boundary helper for Ctrl+D ─────────────────────────
function getWordAt(lineText, col) {
  const isWord = c => /\w/.test(c);
  if (!isWord(lineText[col] ?? '')) return null;
  let start = col, end = col;
  while (start > 0 && isWord(lineText[start - 1])) start--;
  while (end < lineText.length && isWord(lineText[end])) end++;
  return { word: lineText.slice(start, end), start, end };
}

async function selectNextOccurrence() {
  if (!ctrlDWord) {
    // First press: select word under cursor (or use existing selection)
    if (hasSelection()) {
      const sel = getSelectionRange();
      if (sel.startLine !== sel.endLine) return;
      ctrlDWord = getLineText(sel.startLine).slice(sel.startCol, sel.endCol);
      ctrlDLastLine = sel.startLine;
      ctrlDLastCol = sel.startCol;
      // Fall through to find next occurrence
    } else {
      const info = getWordAt(getLineText(cursorLine), cursorCol);
      if (!info) return;
      ctrlDWord = info.word;
      ctrlDLastLine = cursorLine;
      ctrlDLastCol = info.start;
      selAnchorLine = cursorLine;
      selAnchorCol = info.start;
      cursorCol = info.end;
      requestRender();
      updateStatusBar();
      return; // First press just selects
    }
  }

  // Find next occurrence after (ctrlDLastLine, ctrlDLastCol)
  let matches;
  try { matches = await invoke('find_in_file', { query: ctrlDWord, caseSensitive: true }); }
  catch { return; }
  if (!matches || matches.length === 0) return;

  // Filter to exact-length matches (avoid substring matches)
  const exact = matches.filter(m => m.length === ctrlDWord.length);
  if (exact.length === 0) return;

  let next = exact.find(m => m.line > ctrlDLastLine ||
    (m.line === ctrlDLastLine && m.col > ctrlDLastCol));
  if (!next) next = exact[0]; // wrap around
  if (next.line === ctrlDLastLine && next.col === ctrlDLastCol) return; // only one match

  ctrlDLastLine = next.line;
  ctrlDLastCol = next.col;

  // Demote current primary to extras, promote new match to primary
  extraCursors.push({ line: cursorLine, col: cursorCol, anchorLine: selAnchorLine, anchorCol: selAnchorCol });
  cursorLine = next.line;
  cursorCol = next.col + next.length;
  selAnchorLine = next.line;
  selAnchorCol = next.col;

  ensureCursorVisible();
  requestRender();
  updateStatusBar();
}

// ─── Mouse Helpers (O(1) arithmetic) ─────────────────────────

function posFromMouse(e) {
  const rect = editorCanvas.getBoundingClientRect();
  const scrollTop = editorEl.scrollTop;
  const y = e.clientY - rect.top + scrollTop;
  const x = e.clientX - rect.left - EDITOR_PADDING_LEFT + editorEl.scrollLeft;

  const displayLine = Math.max(0, Math.min(Math.floor(y / lineHeight), getEffectiveLineCount() - 1));
  const line = foldedLineSet.size > 0 ? displayToBuffer(displayLine) : displayLine;
  const lineText = getLineText(line);
  const col = Math.max(0, Math.min(Math.round(x / cellWidth), lineText.length));

  return { line, col };
}

// ─── Popup Positioning (arithmetic, no DOM line queries) ─────

function getLineBoundsOnScreen(lineIdx) {
  const rect = editorCanvas.getBoundingClientRect();
  const scrollTop = editorEl.scrollTop;
  const { first } = getVisibleLineRange();
  const subPixelOffset = -(scrollTop % lineHeight);
  const vi = lineIdx - first;
  const top = rect.top + vi * lineHeight + subPixelOffset;
  const bottom = top + lineHeight;
  return { top, bottom, left: rect.left };
}

// ─── Minimap ──────────────────────────────────────────────────

function renderMinimap() {
  if (totalLines < 50) {
    minimapEl.classList.add('minimap-hidden');
    return;
  }
  minimapEl.classList.remove('minimap-hidden');

  const scale = 2;
  const lineH = scale;
  const width = 80;
  const height = Math.min(totalLines * lineH, editorEl.clientHeight);

  const dpr = window.devicePixelRatio || 1;
  minimapCanvas.style.width = width + 'px';
  minimapCanvas.style.height = height + 'px';
  minimapCanvas.width = Math.round(width * dpr);
  minimapCanvas.height = Math.round(height * dpr);
  const ctx = minimapCanvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const ratio = height / (totalLines * lineH);

  // Draw from cached lines
  for (let i = 0; i < cachedLines.length; i++) {
    const lineIdx = cachedFirstLine + i;
    const text = cachedLines[i]?.text || '';
    const y = Math.floor(lineIdx * lineH * ratio);
    if (y >= height) break;

    const indent = text.length - text.trimStart().length;
    const textLen = Math.min(text.trim().length, 60);
    if (textLen > 0) {
      ctx.fillStyle = 'rgba(205, 214, 244, 0.3)';
      ctx.fillRect(indent * 0.8, y, textLen * 0.8, Math.max(lineH * ratio, 1));
    }
  }

  // Viewport indicator
  const totalH = totalLines * lineHeight;
  const vpFraction = editorEl.clientHeight / totalH;
  const vpTop = (editorEl.scrollTop / totalH) * height;
  const vpH = Math.max(vpFraction * height, 10);

  minimapViewport.style.top = `${vpTop}px`;
  minimapViewport.style.height = `${vpH}px`;
}

// ─── Scroll Handler ──────────────────────────────────────────

let scrollFetchPending = false;

editorEl.addEventListener('scroll', () => {
  scheduleInlayHints();
  // Immediate repaint from cache
  requestRender();

  // Fetch new content if scrolled outside cached range
  if (scrollFetchPending) return;
  const { first, count } = getVisibleLineRange();
  if (first < cachedFirstLine || first + count > cachedFirstLine + cachedLines.length) {
    scrollFetchPending = true;
    fetchVisibleContent().then(() => {
      scrollFetchPending = false;
      requestRender();
    });
  }
});

// ─── File Explorer ────────────────────────────────────────────

function toggleSidebar() {
  sidebarOpen = !sidebarOpen;
  if (sidebarOpen) {
    sidebarEl.classList.remove('sidebar-hidden');
    if (!explorerRoot) openFolderDialog();
  } else {
    sidebarEl.classList.add('sidebar-hidden');
  }
  // Resize canvases after sidebar toggle
  setTimeout(() => { resizeCanvases(); requestRender(); }, 50);
}

function closeSidebar() {
  sidebarOpen = false;
  sidebarEl.classList.add('sidebar-hidden');
  setTimeout(() => { resizeCanvases(); requestRender(); }, 50);
}

sidebarCloseBtn.addEventListener('click', closeSidebar);

async function openFolderDialog() {
  try {
    const result = await window.__TAURI__.dialog.open({
      directory: true,
      multiple: false,
      title: 'Open Folder',
    });
    if (result) {
      explorerRoot = result;
      document.getElementById('sidebar-title').textContent = result.split(/[/\\]/).pop() || 'Explorer';
      expandedDirs.clear();
      expandedDirs.add(result);
      await renderFileTree();
      // Notify Tauri and Extension Host of the new workspace root
      try { await invoke('register_workspace', { rootPath: result }); } catch { /* non-critical */ }
    }
  } catch (err) {
    console.error('Open folder error:', err);
  }
}

async function renderFileTree() {
  if (!explorerRoot) return;
  fileTreeEl.innerHTML = '';
  await renderDirContents(explorerRoot, 0, fileTreeEl);
}

async function renderDirContents(dirPath, depth, parentEl) {
  try {
    const entries = await invoke('read_directory', { path: dirPath });
    for (const entry of entries) {
      const item = document.createElement('div');
      item.className = 'tree-item';
      if (entry.path === activeBufferPath) item.classList.add('active');

      if (depth > 0) {
        const indent = document.createElement('span');
        indent.className = 'tree-indent';
        indent.style.width = `${depth * 16}px`;
        item.appendChild(indent);
      }

      const icon = document.createElement('span');
      icon.className = 'tree-icon';

      const name = document.createElement('span');
      name.className = 'tree-name';
      name.textContent = entry.name;

      if (entry.is_dir) {
        const isExpanded = expandedDirs.has(entry.path);
        icon.classList.add('folder');
        icon.textContent = isExpanded ? '▾' : '▸';

        item.appendChild(icon);
        item.appendChild(name);
        item.addEventListener('click', async () => {
          if (expandedDirs.has(entry.path)) {
            expandedDirs.delete(entry.path);
          } else {
            expandedDirs.add(entry.path);
          }
          await renderFileTree();
        });
        parentEl.appendChild(item);

        if (isExpanded) {
          await renderDirContents(entry.path, depth + 1, parentEl);
        }
      } else {
        icon.classList.add('file');
        icon.textContent = getFileIcon(entry.name);
        item.appendChild(icon);
        item.appendChild(name);
        item.addEventListener('click', () => openFileFromExplorer(entry.path));
        parentEl.appendChild(item);
      }
    }
  } catch (err) {
    console.error('renderDirContents error:', err);
  }
}

function getFileIcon(name) {
  const ext = name.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'js': case 'jsx': case 'mjs': return '◆';
    case 'ts': case 'tsx': return '◇';
    case 'rs': return '⚙';
    case 'py': return '⬡';
    case 'json': return '{ }';
    case 'html': case 'htm': return '◈';
    case 'css': case 'scss': return '◉';
    case 'md': return '¶';
    default: return '○';
  }
}

async function openFileFromExplorer(path) {
  try {
    saveBufferState();
    statusEl.textContent = 'Opening...';
    const content = await invoke('open_file', { path });
    activeBufferPath = content.file_path;
    restoreBufferState(activeBufferPath);
    if (!bufferStates.has(activeBufferPath)) {
      cursorLine = 0;
      cursorCol = 0;
      clearSelection();
    }
    findMatches = [];
    findCurrentIdx = -1;
    await updateFromEditorContent(content);
    renderTabs();
    renderFileTree();
    statusEl.textContent = '';
    editorEl.focus();
  } catch (err) {
    console.error('Open file error:', err);
    statusEl.textContent = `Error: ${err}`;
  }
}

// ─── Command Palette ─────────────────────────────────────────

function openPalette() {
  paletteOpen = true;
  paletteEl.classList.remove('palette-hidden');
  paletteInputEl.setAttribute('aria-expanded', 'true');
  paletteInputEl.value = '';
  paletteSelectedIndex = 0;
  invoke('list_commands').then(cmds => {
    paletteCommands = cmds || [];
    filterPalette('');
    paletteInputEl.focus();
  }).catch(err => {
    console.error('Failed to list commands:', err);
    paletteCommands = [];
    filterPalette('');
    paletteInputEl.focus();
  });
}

function closePalette() {
  paletteOpen = false;
  paletteEl.classList.add('palette-hidden');
  paletteInputEl.setAttribute('aria-expanded', 'false');
  editorEl.focus();
}

function filterPalette(query) {
  const q = query.toLowerCase();
  paletteFiltered = q
    ? paletteCommands.filter(c => c.toLowerCase().includes(q))
    : paletteCommands.slice();
  const builtins = [
    { label: 'Open File', command: '__builtin:open' },
    { label: 'Open Folder', command: '__builtin:openFolder' },
    { label: 'New Window', command: '__builtin:newWindow' },
    { label: 'Save File', command: '__builtin:save' },
    { label: 'Toggle Sidebar', command: '__builtin:toggleSidebar' },
    { label: 'Close Tab', command: '__builtin:closeTab' },
    { label: 'Extensions: Open Marketplace', command: '__builtin:extensions' },
    { label: 'Preferences: Open Settings', command: '__builtin:settings' },
    { label: 'Extensions: Check for Updates', command: '__builtin:checkExtUpdates' },
  ].filter(b => !q || b.label.toLowerCase().includes(q));
  renderPaletteList(builtins);
}

function renderPaletteList(builtins) {
  paletteListEl.innerHTML = '';
  for (let i = 0; i < builtins.length; i++) {
    const item = document.createElement('div');
    item.className = 'palette-item' + (i === paletteSelectedIndex ? ' selected' : '');
    const badge = document.createElement('span');
    badge.className = 'palette-label';
    badge.textContent = 'Built-in';
    item.appendChild(badge);
    item.appendChild(document.createTextNode(builtins[i].label));
    const cmd = builtins[i].command;
    item.addEventListener('click', () => executePaletteCommand(cmd));
    paletteListEl.appendChild(item);
  }
  for (let i = 0; i < paletteFiltered.length; i++) {
    const idx = builtins.length + i;
    const item = document.createElement('div');
    item.className = 'palette-item' + (idx === paletteSelectedIndex ? ' selected' : '');
    const badge = document.createElement('span');
    badge.className = 'palette-label';
    badge.textContent = 'Extension';
    item.appendChild(badge);
    item.appendChild(document.createTextNode(paletteFiltered[i]));
    const cmd = paletteFiltered[i];
    item.addEventListener('click', () => executePaletteCommand(cmd));
    paletteListEl.appendChild(item);
  }
  if (!builtins.length && !paletteFiltered.length) {
    const empty = document.createElement('div');
    empty.className = 'palette-item';
    empty.textContent = 'No commands found';
    paletteListEl.appendChild(empty);
  }
}

async function executePaletteCommand(command) {
  closePalette();
  if (command === '__builtin:open') {
    await openFileDialog();
  } else if (command === '__builtin:openFolder') {
    if (!sidebarOpen) toggleSidebar();
    else await openFolderDialog();
  } else if (command === '__builtin:newWindow') {
    try { await invoke('new_window'); } catch (err) { showToast('error', `Failed to open window: ${err}`); }
  } else if (command === '__builtin:save') {
    await saveFile();
  } else if (command === '__builtin:toggleSidebar') {
    toggleSidebar();
  } else if (command === '__builtin:closeTab') {
    if (activeBufferPath) await closeTab(activeBufferPath);
  } else if (command === '__builtin:extensions') {
    switchPanel('extensions');
  } else if (command === '__builtin:settings') {
    switchPanel('settings');
  } else if (command === '__builtin:checkExtUpdates') {
    try {
      const updates = await invoke('check_extension_updates');
      if (updates.length === 0) {
        showToast('info', 'All extensions are up to date');
      } else {
        showToast('info', `${updates.length} extension update(s) available`);
      }
    } catch (err) {
      showToast('error', `Failed to check updates: ${err}`);
    }
  } else {
    await invoke('execute_command', { command });
    setTimeout(refreshDiagnostics, 500);
  }
}

function paletteInputHandler() {
  paletteSelectedIndex = 0;
  filterPalette(paletteInputEl.value);
}

function paletteKeydownHandler(e) {
  const total = paletteListEl.children.length;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    paletteSelectedIndex = Math.min(paletteSelectedIndex + 1, total - 1);
    updatePaletteSelection();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    paletteSelectedIndex = Math.max(paletteSelectedIndex - 1, 0);
    updatePaletteSelection();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const items = paletteListEl.querySelectorAll('.palette-item');
    if (items[paletteSelectedIndex]) items[paletteSelectedIndex].click();
  } else if (e.key === 'Escape') {
    closePalette();
  }
}

paletteInputEl.addEventListener('input', paletteInputHandler);
paletteInputEl.addEventListener('keydown', paletteKeydownHandler);
paletteBackdropEl.addEventListener('click', closePalette);

function updatePaletteSelection() {
  const items = paletteListEl.querySelectorAll('.palette-item');
  items.forEach((el, i) => el.classList.toggle('selected', i === paletteSelectedIndex));
}

// ─── Keyboard Input ──────────────────────────────────────────

document.addEventListener('keydown', (e) => {
  resetCursorBlink();

  // Reset Ctrl+D chain on any key except Ctrl+D itself
  if (!(e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'd')) {
    ctrlDWord = null; ctrlDLastLine = -1; ctrlDLastCol = -1;
  }

  if (e.ctrlKey && e.shiftKey && e.key === 'P') {
    e.preventDefault();
    paletteOpen ? closePalette() : openPalette();
    return;
  }

  if (paletteOpen) return;
  if (symbolsOpen) return;

  // M6: Autocomplete navigation
  if (acOpen) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      acSelectedIdx = Math.min(acSelectedIdx + 1, autocompleteList.children.length - 1);
      updateAcSelection();
      if (acItems[acSelectedIdx]) showAcDetail(acItems[acSelectedIdx]);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      acSelectedIdx = Math.max(acSelectedIdx - 1, 0);
      updateAcSelection();
      if (acItems[acSelectedIdx]) showAcDetail(acItems[acSelectedIdx]);
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      if (acItems[acSelectedIdx]) acceptCompletion(acItems[acSelectedIdx]);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeAutocomplete();
      return;
    }
  }

  // M6: Code actions navigation
  if (codeActionsOpen) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      caSelectedIdx = Math.min(caSelectedIdx + 1, caItems.length - 1);
      const items = codeActionsList.querySelectorAll('.ca-item');
      items.forEach((el, i) => el.classList.toggle('selected', i === caSelectedIdx));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      caSelectedIdx = Math.max(caSelectedIdx - 1, 0);
      const items = codeActionsList.querySelectorAll('.ca-item');
      items.forEach((el, i) => el.classList.toggle('selected', i === caSelectedIdx));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (caItems[caSelectedIdx]) executeCodeAction(caItems[caSelectedIdx]);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeCodeActions();
      return;
    }
  }

  if (e.key === 'Escape' && (hoverOpen || sigHelpOpen || refsOpen)) {
    e.preventDefault();
    closeLspPopups();
    return;
  }

  if (e.ctrlKey && e.shiftKey && e.key === 'O') { e.preventDefault(); openSymbolOutline(); return; }
  if (e.ctrlKey && !e.shiftKey && e.key === 't') { e.preventDefault(); openWorkspaceSymbolSearch(); return; }
  if (e.ctrlKey && e.shiftKey && e.key === 'F') { e.preventDefault(); if (hasSelection()) formatSelection(); else formatDocument(); return; }
  if (e.ctrlKey && e.key === ' ') { e.preventDefault(); triggerAutocomplete(null); return; }
  if (e.key === 'F12' && !e.shiftKey && !e.ctrlKey) { e.preventDefault(); goToDefinition(); return; }
  if (e.key === 'F12' && e.shiftKey && !e.ctrlKey) { e.preventDefault(); findReferences(); return; }
  if (e.key === 'F12' && e.ctrlKey && !e.shiftKey) { e.preventDefault(); goToImplementation(); return; }
  if (e.key === 'F12' && e.ctrlKey && e.shiftKey) { e.preventDefault(); goToTypeDefinition(); return; }
  if (e.altKey && e.shiftKey && e.key === 'ArrowRight') { e.preventDefault(); expandSelection(); return; }
  if (e.altKey && e.shiftKey && e.key === 'ArrowLeft') { e.preventDefault(); shrinkSelection(); return; }
  if (e.ctrlKey && e.key === '.') { e.preventDefault(); requestCodeActions(); return; }
  if (e.ctrlKey && e.shiftKey && e.key === '[') { e.preventDefault(); foldAtCursor(); return; }
  if (e.ctrlKey && e.shiftKey && e.key === ']') { e.preventDefault(); unfoldAtCursor(); return; }

  // Find bar keys
  if (findOpen && (document.activeElement === findInputEl || document.activeElement === replaceInputEl)) {
    if (e.key === 'Escape') { e.preventDefault(); closeFindBar(); return; }
    if (e.key === 'Enter' && document.activeElement === findInputEl) { e.preventDefault(); e.shiftKey ? findPrev() : findNext(); return; }
    if (e.key === 'Enter' && document.activeElement === replaceInputEl) { e.preventDefault(); replaceOne(); return; }
    return;
  }

  // Global shortcuts
  if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'b') { e.preventDefault(); toggleSidebar(); return; }
  if (e.ctrlKey && e.key === 'Tab') { e.preventDefault(); cycleTab(e.shiftKey ? -1 : 1); return; }
  if (e.ctrlKey && e.key.toLowerCase() === 'w') { e.preventDefault(); if (activeBufferPath) closeTab(activeBufferPath); return; }
  if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); openFindBar(false); return; }
  if (e.ctrlKey && e.key.toLowerCase() === 'h') { e.preventDefault(); openFindBar(true); return; }
  if (e.ctrlKey && e.key === '`') { e.preventDefault(); toggleBottomPanel(); return; }
  if (e.key === 'Escape') {
    if (isMultiCursor()) { e.preventDefault(); clearExtraCursors(); clearSelection(); requestRender(); updateStatusBar(); return; }
    if (ghostText) { ghostText = null; requestRender(); return; }
    if (findOpen) { closeFindBar(); return; }
    if (bottomPanelOpen) { closeBottomPanel(); return; }
  }

  // Only handle editor keys when editor is focused
  if (document.activeElement !== editorEl) return;

  // ─── Multi-cursor shortcuts ───────────────────────────────
  // Ctrl+D — select next occurrence
  if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'd') {
    e.preventDefault();
    selectNextOccurrence();
    return;
  }
  // Ctrl+Alt+Up/Down — add cursor above/below
  if (e.ctrlKey && e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault();
    const dir = e.key === 'ArrowUp' ? -1 : 1;
    const targetLine = Math.max(0, Math.min(totalLines - 1, cursorLine + dir));
    if (targetLine !== cursorLine) {
      addCursorAt(targetLine, Math.min(cursorCol, getLineText(targetLine).length));
    }
    return;
  }

  // Undo / Redo
  if (e.ctrlKey && ((e.shiftKey && e.key.toLowerCase() === 'z') || (!e.shiftKey && e.key.toLowerCase() === 'y'))) {
    e.preventDefault();
    clearSelection();
    queueEdit(async () => {
      const result = await invoke('edit_redo');
      await updateFromEditResult(result);
    });
    return;
  }

  if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    clearSelection();
    queueEdit(async () => {
      const result = await invoke('edit_undo');
      await updateFromEditResult(result);
    });
    return;
  }

  // Select All
  if (e.ctrlKey && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    selAnchorLine = 0;
    selAnchorCol = 0;
    cursorLine = totalLines - 1;
    cursorCol = getLineText(cursorLine).length;
    requestRender();
    updateStatusBar();
    return;
  }

  // Clipboard
  if (e.ctrlKey && e.key.toLowerCase() === 'c') {
    e.preventDefault();
    if (hasSelection()) {
      const sel = getSelectionRange();
      queueEdit(async () => {
        const text = await invoke('get_text_range', {
          startLine: sel.startLine, startCol: sel.startCol,
          endLine: sel.endLine, endCol: sel.endCol,
        });
        await navigator.clipboard.writeText(text);
      });
    }
    return;
  }

  if (e.ctrlKey && e.key.toLowerCase() === 'x') {
    e.preventDefault();
    if (hasSelection()) {
      const sel = getSelectionRange();
      clearSelection();
      cursorLine = sel.startLine;
      cursorCol = sel.startCol;
      queueEdit(async () => {
        const text = await invoke('get_text_range', {
          startLine: sel.startLine, startCol: sel.startCol,
          endLine: sel.endLine, endCol: sel.endCol,
        });
        await navigator.clipboard.writeText(text);
        const result = await invoke('edit_replace_range', {
          startLine: sel.startLine, startCol: sel.startCol,
          endLine: sel.endLine, endCol: sel.endCol, text: '',
        });
        await updateFromEditResult(result);
      });
    }
    return;
  }

  if (e.ctrlKey && e.key.toLowerCase() === 'v') {
    e.preventDefault();
    if (isMultiCursor()) {
      queueEdit(async () => {
        try {
          const clipText = await navigator.clipboard.readText();
          if (!clipText) return;
          if (clipText.length > 1024 * 1024) {
            statusEl.textContent = `Paste too large (${(clipText.length / 1024 / 1024).toFixed(1)} MB, max 1 MB)`;
            return;
          }
          const allC = getAllCursors();
          const order = allC.map((_,i)=>i).sort((a,b)=>allC[b].line!==allC[a].line?allC[b].line-allC[a].line:allC[b].col-allC[a].col);
          const descs = allC.map(c => pasteDesc(c, clipText));
          const pastedLineCount = clipText.split('\n').length - 1;
          const lineDelta = descs.map(d => d ? (d.text.split('\n').length-1)-(d.el-d.sl) : 0);
          let lastResult = null;
          for (const idx of order) {
            const d = descs[idx]; if (!d) continue;
            const result = await invoke('edit_replace_range', { startLine:d.sl, startCol:d.sc, endLine:d.el, endCol:d.ec, text:d.text });
            lastResult = result;
          }
          const finalCursors = allC.map((_,i) => {
            const d = descs[i];
            const base = d ? {line:d.newLine,col:d.newCol} : {line:allC[i].line,col:allC[i].col};
            let adj = 0;
            for (let j = 0; j < allC.length; j++) { if (j===i||!descs[j]) continue; if (descs[j].sl > (d?d.sl:allC[i].line)) adj += lineDelta[j]; }
            return {line:base.line+adj, col:base.col, anchorLine:null, anchorCol:null};
          });
          const deduped = deduplicateCursors(finalCursors);
          setPrimaryCursor(deduped[0]); extraCursors = deduped.slice(1);
          if (lastResult) await updateFromEditResult(lastResult);
        } catch (err) {
          console.error('Paste error:', err);
        }
      });
      return;
    }
    const snapLine = cursorLine, snapCol = cursorCol;
    const sel = hasSelection() ? getSelectionRange() : null;
    if (sel) clearSelection();
    queueEdit(async () => {
      try {
        const clipText = await navigator.clipboard.readText();
        if (!clipText) return;
        if (clipText.length > 1024 * 1024) {
          statusEl.textContent = `Paste too large (${(clipText.length / 1024 / 1024).toFixed(1)} MB, max 1 MB)`;
          return;
        }
        if (sel) {
          const result = await invoke('edit_replace_range', {
            startLine: sel.startLine, startCol: sel.startCol,
            endLine: sel.endLine, endCol: sel.endCol, text: clipText,
          });
          setCursorAfterInsert(sel.startLine, sel.startCol, clipText);
          await updateFromEditResult(result);
        } else {
          const result = await invoke('edit_insert', {
            line: snapLine, col: snapCol, text: clipText,
          });
          setCursorAfterInsert(snapLine, snapCol, clipText);
          await updateFromEditResult(result);
        }
      } catch (err) {
        console.error('Paste error:', err);
      }
    });
    return;
  }

  if (e.ctrlKey && e.key.toLowerCase() === 'o') { e.preventDefault(); openFileDialog(); return; }
  if (e.ctrlKey && e.key.toLowerCase() === 's') { e.preventDefault(); saveFile(); return; }

  // Navigation
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (isMultiCursor() && !e.shiftKey) {
      const moved = getAllCursors().map(c => {
        const l = Math.max(0, c.line - 1);
        return { line: l, col: Math.min(c.col, getLineText(l).length), anchorLine: null, anchorCol: null };
      });
      const d = deduplicateCursors(moved); setPrimaryCursor(d[0]); extraCursors = d.slice(1);
      ensureCursorVisible(); requestRender(); updateStatusBar(); return;
    }
    if (e.shiftKey) ensureAnchor(); else if (hasSelection()) clearSelection();
    if (cursorLine > 0) { cursorLine--; cursorCol = Math.min(cursorCol, getLineText(cursorLine).length); }
    if (!e.shiftKey) clearSelection();
    ensureCursorVisible(); requestRender(); updateStatusBar();
    return;
  }

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (isMultiCursor() && !e.shiftKey) {
      const moved = getAllCursors().map(c => {
        const l = Math.min(totalLines - 1, c.line + 1);
        return { line: l, col: Math.min(c.col, getLineText(l).length), anchorLine: null, anchorCol: null };
      });
      const d = deduplicateCursors(moved); setPrimaryCursor(d[0]); extraCursors = d.slice(1);
      ensureCursorVisible(); requestRender(); updateStatusBar(); return;
    }
    if (e.shiftKey) ensureAnchor(); else if (hasSelection()) clearSelection();
    if (cursorLine < totalLines - 1) { cursorLine++; cursorCol = Math.min(cursorCol, getLineText(cursorLine).length); }
    if (!e.shiftKey) clearSelection();
    ensureCursorVisible(); requestRender(); updateStatusBar();
    return;
  }

  if (e.key === 'ArrowLeft') {
    e.preventDefault();
    if (isMultiCursor() && !e.shiftKey) {
      const moved = getAllCursors().map(c => {
        if (cursorHasSelection(c)) { const s = normalizeCursorSel(c); return { line: s.startLine, col: s.startCol, anchorLine: null, anchorCol: null }; }
        const col = c.col > 0 ? c.col - 1 : c.line > 0 ? getLineText(c.line - 1).length : 0;
        const line = c.col > 0 ? c.line : Math.max(0, c.line - 1);
        return { line, col, anchorLine: null, anchorCol: null };
      });
      const d = deduplicateCursors(moved); setPrimaryCursor(d[0]); extraCursors = d.slice(1);
      ensureCursorVisible(); requestRender(); updateStatusBar(); return;
    }
    if (e.shiftKey) {
      ensureAnchor();
      if (cursorCol > 0) cursorCol--;
      else if (cursorLine > 0) { cursorLine--; cursorCol = getLineText(cursorLine).length; }
    } else if (hasSelection()) {
      const sel = getSelectionRange(); cursorLine = sel.startLine; cursorCol = sel.startCol; clearSelection();
    } else {
      if (cursorCol > 0) cursorCol--;
      else if (cursorLine > 0) { cursorLine--; cursorCol = getLineText(cursorLine).length; }
    }
    ensureCursorVisible(); requestRender(); updateStatusBar();
    return;
  }

  if (e.key === 'ArrowRight') {
    e.preventDefault();
    if (isMultiCursor() && !e.shiftKey) {
      const moved = getAllCursors().map(c => {
        if (cursorHasSelection(c)) { const s = normalizeCursorSel(c); return { line: s.endLine, col: s.endCol, anchorLine: null, anchorCol: null }; }
        const len = getLineText(c.line).length;
        const col = c.col < len ? c.col + 1 : c.line < totalLines - 1 ? 0 : c.col;
        const line = c.col < len ? c.line : c.line < totalLines - 1 ? c.line + 1 : c.line;
        return { line, col, anchorLine: null, anchorCol: null };
      });
      const d = deduplicateCursors(moved); setPrimaryCursor(d[0]); extraCursors = d.slice(1);
      ensureCursorVisible(); requestRender(); updateStatusBar(); return;
    }
    if (e.shiftKey) {
      ensureAnchor();
      const lineLen = getLineText(cursorLine).length;
      if (cursorCol < lineLen) cursorCol++;
      else if (cursorLine < totalLines - 1) { cursorLine++; cursorCol = 0; }
    } else if (hasSelection()) {
      const sel = getSelectionRange(); cursorLine = sel.endLine; cursorCol = sel.endCol; clearSelection();
    } else {
      const lineLen = getLineText(cursorLine).length;
      if (cursorCol < lineLen) cursorCol++;
      else if (cursorLine < totalLines - 1) { cursorLine++; cursorCol = 0; }
    }
    ensureCursorVisible(); requestRender(); updateStatusBar();
    return;
  }

  if (e.key === 'Home') {
    e.preventDefault();
    if (isMultiCursor() && !e.shiftKey) {
      const moved = getAllCursors().map(c => ({ line: c.line, col: 0, anchorLine: null, anchorCol: null }));
      const d = deduplicateCursors(moved); setPrimaryCursor(d[0]); extraCursors = d.slice(1);
      ensureCursorVisible(); requestRender(); updateStatusBar(); return;
    }
    if (e.shiftKey) ensureAnchor();
    cursorCol = 0;
    if (!e.shiftKey) clearSelection();
    ensureCursorVisible(); requestRender(); updateStatusBar();
    return;
  }

  if (e.key === 'End') {
    e.preventDefault();
    if (isMultiCursor() && !e.shiftKey) {
      const moved = getAllCursors().map(c => ({ line: c.line, col: getLineText(c.line).length, anchorLine: null, anchorCol: null }));
      const d = deduplicateCursors(moved); setPrimaryCursor(d[0]); extraCursors = d.slice(1);
      ensureCursorVisible(); requestRender(); updateStatusBar(); return;
    }
    if (e.shiftKey) ensureAnchor();
    cursorCol = getLineText(cursorLine).length;
    if (!e.shiftKey) clearSelection();
    ensureCursorVisible(); requestRender(); updateStatusBar();
    return;
  }

  // Editing keys
  if (e.key === 'Enter') {
    e.preventDefault();
    if (isMultiCursor()) { multiCursorEdit(c => enterDesc(c)); return; }
    if (hasSelection()) {
      const sel = getSelectionRange();
      cursorLine = sel.startLine + 1;
      cursorCol = 0;
      clearSelection();
      queueEdit(async () => {
        const result = await invoke('edit_replace_range', {
          startLine: sel.startLine, startCol: sel.startCol,
          endLine: sel.endLine, endCol: sel.endCol, text: '\n',
        });
        await updateFromEditResult(result);
      });
    } else {
      const snapLine = cursorLine, snapCol = cursorCol;
      cursorLine++;
      cursorCol = 0;
      queueEdit(async () => {
        const result = await invoke('edit_newline', { line: snapLine, col: snapCol });
        await updateFromEditResult(result);
      });
    }
    return;
  }

  if (e.key === 'Backspace') {
    e.preventDefault();
    if (isMultiCursor()) { multiCursorEdit(c => backspaceDesc(c)); return; }
    if (hasSelection()) {
      const sel = getSelectionRange();
      cursorLine = sel.startLine;
      cursorCol = sel.startCol;
      clearSelection();
      queueEdit(async () => {
        const result = await invoke('edit_replace_range', {
          startLine: sel.startLine, startCol: sel.startCol,
          endLine: sel.endLine, endCol: sel.endCol, text: '',
        });
        await updateFromEditResult(result);
      });
    } else {
      if (cursorLine === 0 && cursorCol === 0) return;
      const prevLineLen = cursorCol === 0 && cursorLine > 0 ? getLineText(cursorLine - 1).length : 0;
      const snapLine = cursorLine, snapCol = cursorCol;
      if (cursorCol > 0) {
        cursorCol--;
      } else if (cursorLine > 0) {
        cursorLine--;
        cursorCol = prevLineLen;
      }
      queueEdit(async () => {
        const result = await invoke('edit_backspace', { line: snapLine, col: snapCol });
        await updateFromEditResult(result);
      });
    }
    if (acOpen) {
      if (acFilterText.length > 0) { acFilterText = acFilterText.slice(0, -1); renderAutocomplete(); }
      else closeAutocomplete();
    }
    return;
  }

  if (e.key === 'Delete') {
    e.preventDefault();
    if (isMultiCursor()) { multiCursorEdit(c => deleteDesc(c)); return; }
    if (hasSelection()) {
      const sel = getSelectionRange();
      cursorLine = sel.startLine;
      cursorCol = sel.startCol;
      clearSelection();
      queueEdit(async () => {
        const result = await invoke('edit_replace_range', {
          startLine: sel.startLine, startCol: sel.startCol,
          endLine: sel.endLine, endCol: sel.endCol, text: '',
        });
        await updateFromEditResult(result);
      });
    } else {
      const snapLine = cursorLine, snapCol = cursorCol;
      queueEdit(async () => {
        const result = await invoke('edit_delete', { line: snapLine, col: snapCol, len: 1 });
        await updateFromEditResult(result);
      });
    }
    return;
  }

  if (e.key === 'F2' && !e.ctrlKey && !e.shiftKey) {
    e.preventDefault();
    if (!filePath) return;
    const renameUri = filePathToUri(filePath);
    const renameLine = cursorLine, renameChar = cursorCol;
    invoke('lsp_prepare_rename', { uri: renameUri, line: renameLine, character: renameChar })
      .then(prepared => {
        if (!prepared) { showToast('info', 'Nothing to rename here'); return; }
        const lineText = getLineText(renameLine);
        const wordInfo = getWordAt(lineText, renameChar);
        const currentName = wordInfo ? lineText.substring(wordInfo.start, wordInfo.end) : '';
        // Reuse the palette-style input box for the rename prompt
        paletteOpen = true;
        paletteEl.classList.remove('palette-hidden');
        paletteInputEl.setAttribute('aria-expanded', 'true');
        paletteInputEl.value = currentName;
        paletteInputEl.placeholder = 'New name...';
        paletteListEl.innerHTML = '';
        const hint = document.createElement('div');
        hint.className = 'palette-item';
        hint.style.color = 'var(--fg-dim)';
        hint.textContent = `Rename symbol "${currentName}" (Enter to confirm, Escape to cancel)`;
        paletteListEl.appendChild(hint);

        const renAbort = new AbortController();
        paletteInputEl.removeEventListener('input', paletteInputHandler);
        paletteInputEl.removeEventListener('keydown', paletteKeydownHandler);
        paletteBackdropEl.removeEventListener('click', closePalette);

        function closeRenameAndApply(newName) {
          paletteOpen = false;
          paletteEl.classList.add('palette-hidden');
          paletteInputEl.setAttribute('aria-expanded', 'false');
          paletteInputEl.placeholder = 'Type a command...';
          renAbort.abort();
          paletteInputEl.addEventListener('input', paletteInputHandler);
          paletteInputEl.addEventListener('keydown', paletteKeydownHandler);
          paletteBackdropEl.addEventListener('click', closePalette);
          editorEl.focus();
          if (!newName || newName === currentName) return;
          invoke('lang_rename', { uri: renameUri, line: renameLine, character: renameChar, newName })
            .then(async (changes) => {
              if (!changes || changes.length === 0) { showToast('error', 'Rename returned no edits'); return; }
              try {
                await invoke('apply_workspace_edit', { changes });
                await fetchVisibleContent();
                requestRender();
              } catch (err) { showToast('error', String(err)); }
            })
            .catch(err => showToast('error', String(err)));
        }

        paletteInputEl.addEventListener('keydown', e2 => {
          if (e2.key === 'Enter') { e2.preventDefault(); closeRenameAndApply(paletteInputEl.value.trim()); }
          else if (e2.key === 'Escape') closeRenameAndApply(null);
        }, { signal: renAbort.signal });
        paletteBackdropEl.addEventListener('click', () => closeRenameAndApply(null), { signal: renAbort.signal });
        paletteInputEl.focus();
        paletteInputEl.select();
      })
      .catch(() => { /* no rename provider */ });
    return;
  }

  if (e.key === 'Tab') {
    e.preventDefault();
    if (isMultiCursor()) { multiCursorEdit(c => tabDesc(c)); return; }
    // Accept ghost text if present
    if (ghostText && !hasSelection()) {
      const text = ghostText;
      ghostText = null;
      if (ghostTextTimer) { clearTimeout(ghostTextTimer); ghostTextTimer = null; }
      const snapLine = cursorLine, snapCol = cursorCol;
      cursorCol += text.length;
      queueEdit(async () => {
        const result = await invoke('edit_insert', { line: snapLine, col: snapCol, text });
        await updateFromEditResult(result);
      });
      return;
    }
    if (hasSelection()) {
      // Indent all lines in selection
      const sel = getSelectionRange();
      const startL = sel.startLine, endL = sel.endLine;
      cursorCol = sel.startCol + 4;
      queueEdit(async () => {
        // Insert 4 spaces at the beginning of each selected line (reverse order)
        for (let l = endL; l >= startL; l--) {
          const r = await invoke('edit_insert', { line: l, col: 0, text: '    ' });
          if (l === startL) await updateFromEditResult(r);
        }
      });
    } else {
      const snapLine = cursorLine, snapCol = cursorCol;
      cursorCol += 4;
      queueEdit(async () => {
        const result = await invoke('edit_insert', { line: snapLine, col: snapCol, text: '    ' });
        await updateFromEditResult(result);
      });
    }
    return;
  }

  // Regular character input
  if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    const ch = e.key;
    if (isMultiCursor()) {
      multiCursorEdit(c => typeCharDesc(c, ch));
      if (ch === '(' || ch === ',') requestSignatureHelp(ch);
      else if (ch === ')') closeSignatureHelp();
      return;
    }
    if (hasSelection()) {
      const sel = getSelectionRange();
      cursorLine = sel.startLine;
      cursorCol = sel.startCol + 1;
      clearSelection();
      queueEdit(async () => {
        const result = await invoke('edit_replace_range', {
          startLine: sel.startLine, startCol: sel.startCol,
          endLine: sel.endLine, endCol: sel.endCol, text: ch,
        });
        await updateFromEditResult(result);
      });
    } else {
      const snapLine = cursorLine, snapCol = cursorCol;
      cursorCol++;
      queueEdit(async () => {
        const result = await invoke('edit_insert', { line: snapLine, col: snapCol, text: ch });
        await updateFromEditResult(result);
      });
    }

    // M6: LSP triggers (single cursor only)
    if (ch === '(' || ch === ',') requestSignatureHelp(ch);
    else if (ch === ')') closeSignatureHelp();
    if (ch === '.') triggerAutocomplete('.');
    else if (acOpen && /[a-zA-Z0-9_$]/.test(ch)) { acFilterText += ch; renderAutocomplete(); }
    else if (acOpen && ch === ' ') closeAutocomplete();

    return;
  }
});

function setCursorAfterInsert(startLine, startCol, text) {
  const pastedLines = text.split('\n');
  if (pastedLines.length === 1) {
    cursorLine = startLine;
    cursorCol = startCol + text.length;
  } else {
    cursorLine = startLine + pastedLines.length - 1;
    cursorCol = pastedLines[pastedLines.length - 1].length;
  }
}

// ─── Tab Cycling ──────────────────────────────────────────────

async function cycleTab(direction) {
  try {
    const buffers = await invoke('list_open_buffers');
    if (buffers.length < 2) return;
    const currentIdx = buffers.findIndex(b => b.active);
    let nextIdx = (currentIdx + direction + buffers.length) % buffers.length;
    await switchTab(buffers[nextIdx].path);
  } catch (err) {
    console.error('cycleTab error:', err);
  }
}

// ─── Mouse (click + drag selection) ─────────────────────────

editorEl.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  resetCursorBlink();
  const pos = posFromMouse(e);

  if (e.altKey) {
    e.preventDefault();
    addCursorAt(pos.line, pos.col);
    requestRender();
    updateStatusBar();
    editorEl.focus();
    return;
  }

  if (e.shiftKey) {
    ensureAnchor();
    cursorLine = pos.line;
    cursorCol = pos.col;
  } else {
    clearExtraCursors();
    selAnchorLine = pos.line;
    selAnchorCol = pos.col;
    cursorLine = pos.line;
    cursorCol = pos.col;
  }

  isDragging = true;
  requestRender();
  updateStatusBar();
  editorEl.focus();
});

document.addEventListener('mousemove', (e) => {
  if (!isDragging) return;
  const pos = posFromMouse(e);
  cursorLine = pos.line;
  cursorCol = pos.col;
  requestRender();
  updateStatusBar();
});

document.addEventListener('mouseup', () => {
  if (!isDragging) return;
  isDragging = false;
  if (selAnchorLine === cursorLine && selAnchorCol === cursorCol) {
    clearSelection();
    requestRender();
  }
});

// Ctrl-hover: show document-link underlines only while Ctrl is held.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Control' && !ctrlHover && documentLinks.length > 0) {
    ctrlHover = true;
    requestRender();
  }
});
document.addEventListener('keyup', (e) => {
  if (e.key === 'Control' && ctrlHover) {
    ctrlHover = false;
    requestRender();
  }
});
window.addEventListener('blur', () => {
  if (ctrlHover) { ctrlHover = false; requestRender(); }
});

// ─── File Operations ─────────────────────────────────────────

async function openFileDialog() {
  try {
    const result = await window.__TAURI__.dialog.open({
      multiple: false,
      filters: [
        { name: 'Code', extensions: ['js', 'ts', 'rs', 'py', 'jsx', 'tsx', 'json', 'html', 'css', 'md', 'txt', 'scss'] },
        { name: 'All', extensions: ['*'] }
      ]
    });
    if (result) {
      saveBufferState();
      statusEl.textContent = 'Opening...';
      const content = await invoke('open_file', { path: result });
      activeBufferPath = content.file_path;
      if (!bufferStates.has(activeBufferPath)) {
        cursorLine = 0;
        cursorCol = 0;
        clearSelection();
      } else {
        restoreBufferState(activeBufferPath);
      }
      findMatches = [];
      findCurrentIdx = -1;
      await updateFromEditorContent(content);
      renderTabs();
      statusEl.textContent = '';
    }
  } catch (err) {
    console.error('Open file error:', err);
    statusEl.textContent = `Error: ${err}`;
  }
}

async function saveFile() {
  try {
    statusEl.textContent = 'Saving...';
    await invoke('save_file');
    modified = false;
    await fetchVisibleContent();
    updateMetadataUI();
    requestRender();
    renderTabs();
    statusEl.textContent = 'Saved';
    setTimeout(() => { statusEl.textContent = ''; }, 2000);
  } catch (err) {
    console.error('Save error:', err);
    statusEl.textContent = `Error: ${err}`;
  }
}

// ─── Find / Replace ──────────────────────────────────────────

function openFindBar(withReplace) {
  findOpen = true;
  findBarEl.classList.remove('find-hidden');
  if (withReplace) replaceRowEl.classList.remove('find-hidden');

  if (hasSelection()) {
    const sel = getSelectionRange();
    if (sel.startLine === sel.endLine) {
      const lineText = getLineText(sel.startLine);
      findInputEl.value = lineText.substring(sel.startCol, sel.endCol);
    }
  }
  findInputEl.focus();
  findInputEl.select();
  runFind();
}

function closeFindBar() {
  findOpen = false;
  findBarEl.classList.add('find-hidden');
  replaceRowEl.classList.add('find-hidden');
  findMatches = [];
  findCurrentIdx = -1;
  findCountEl.textContent = '';
  requestRender();
  editorEl.focus();
}

async function runFind() {
  const query = findInputEl.value;
  if (!query) {
    findMatches = [];
    findCurrentIdx = -1;
    findCountEl.textContent = '';
    requestRender();
    return;
  }
  const caseSensitive = findCaseEl.checked;
  findMatches = await invoke('find_in_file', { query, caseSensitive });
  if (findMatches.length > 0) {
    findCurrentIdx = 0;
    for (let i = 0; i < findMatches.length; i++) {
      const m = findMatches[i];
      if (m.line > cursorLine || (m.line === cursorLine && m.col >= cursorCol)) {
        findCurrentIdx = i; break;
      }
    }
    findCountEl.textContent = `${findCurrentIdx + 1} of ${findMatches.length}`;
  } else {
    findCurrentIdx = -1;
    findCountEl.textContent = 'No results';
  }
  requestRender();
}

function findNext() {
  if (findMatches.length === 0) return;
  findCurrentIdx = (findCurrentIdx + 1) % findMatches.length;
  scrollToMatch();
}

function findPrev() {
  if (findMatches.length === 0) return;
  findCurrentIdx = (findCurrentIdx - 1 + findMatches.length) % findMatches.length;
  scrollToMatch();
}

function scrollToMatch() {
  if (findCurrentIdx < 0 || findCurrentIdx >= findMatches.length) return;
  const m = findMatches[findCurrentIdx];
  selAnchorLine = m.line;
  selAnchorCol = m.col;
  cursorLine = m.line;
  cursorCol = m.col + m.length;
  findCountEl.textContent = `${findCurrentIdx + 1} of ${findMatches.length}`;
  ensureCursorVisible();
  requestRender();
  updateStatusBar();
}

async function replaceOne() {
  if (findMatches.length === 0 || findCurrentIdx < 0) return;
  const query = findInputEl.value;
  const replacement = replaceInputEl.value;
  const caseSensitive = findCaseEl.checked;
  const result = await invoke('replace_in_file', {
    query, replacement, caseSensitive, replaceAll: false,
  });
  // replace_in_file still returns ReplaceResult with content
  await updateFromEditorContent(result.content);
  await runFind();
}

async function replaceAll() {
  const query = findInputEl.value;
  if (!query) return;
  const replacement = replaceInputEl.value;
  const caseSensitive = findCaseEl.checked;
  const result = await invoke('replace_in_file', {
    query, replacement, caseSensitive, replaceAll: true,
  });
  await updateFromEditorContent(result.content);
  findMatches = [];
  findCurrentIdx = -1;
  findCountEl.textContent = `Replaced ${result.count}`;
  requestRender();
}

findInputEl.addEventListener('input', () => runFind());
findCaseEl.addEventListener('change', () => runFind());
findPrevBtn.addEventListener('click', findPrev);
findNextBtn.addEventListener('click', findNext);
findCloseBtn.addEventListener('click', closeFindBar);
findToggleReplaceBtn.addEventListener('click', () => {
  replaceRowEl.classList.toggle('find-hidden');
});
replaceOneBtn.addEventListener('click', replaceOne);
replaceAllBtn.addEventListener('click', replaceAll);

// ─── M8b: WebView Panel Management ───────────────────────────

function showEditorCanvas() {
  activeWebviewPanelId = null;
  editorContainerEl.style.display = '';
  minimapEl.classList.remove('minimap-hidden-by-webview');
  for (const [, panel] of webviewPanelMap) {
    panel.container.style.display = 'none';
  }
}

function createWebviewTab(panelId, title, _enableScripts) {
  if (webviewPanelMap.has(panelId)) return;

  const container = document.createElement('div');
  container.className = 'webview-container';
  container.dataset.panelId = panelId;
  container.style.display = 'none';
  editorAreaEl.appendChild(container);

  const iframe = document.createElement('iframe');
  iframe.className = 'webview-iframe';
  // allow-same-origin is intentionally omitted: combining it with allow-scripts
  // allows sandbox escapes. acquireVsCodeApi state is stored in a JS closure instead.
  iframe.setAttribute('sandbox', 'allow-scripts allow-forms');
  container.appendChild(iframe);

  webviewPanelMap.set(panelId, { container, iframe, title: title || 'Preview' });
  // revealWebviewTab calls renderTabs() — no need to call it separately here.
  revealWebviewTab(panelId);
}

function setWebviewHtml(panelId, html) {
  const panel = webviewPanelMap.get(panelId);
  if (!panel) return;

  const escapedPanelId = JSON.stringify(panelId);
  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:;">`;
  const apiScript = `<script>
(function(){
  const _panelId=${escapedPanelId};
  let _state=null;
  window.acquireVsCodeApi=function(){
    return {
      postMessage:function(msg){window.parent.postMessage({type:'webview-msg',panelId:_panelId,message:msg},'*');},
      setState:function(s){_state=s;},
      getState:function(){return _state;}
    };
  };
})();
<\/script>`;

  const inject = cspMeta + apiScript;
  // Inject the CSP meta + shim just after the opening <head> or <html> tag, or prepend
  let injected = html;
  if (/<head[^>]*>/i.test(html)) {
    injected = html.replace(/(<head[^>]*>)/i, '$1' + inject);
  } else if (/<html[^>]*>/i.test(html)) {
    injected = html.replace(/(<html[^>]*>)/i, '$1' + inject);
  } else {
    injected = inject + html;
  }

  panel.iframe.srcdoc = injected;
}

function sendWebviewMessage(panelId, message) {
  const panel = webviewPanelMap.get(panelId);
  if (panel?.iframe?.contentWindow) {
    panel.iframe.contentWindow.postMessage(message, '*');
  }
}

function revealWebviewTab(panelId) {
  const panel = webviewPanelMap.get(panelId);
  if (!panel) return;

  activeWebviewPanelId = panelId;

  // Hide code editor
  editorContainerEl.style.display = 'none';
  minimapEl.classList.add('minimap-hidden-by-webview');

  // Show this webview, hide others
  for (const [id, p] of webviewPanelMap) {
    p.container.style.display = id === panelId ? '' : 'none';
  }

  renderTabs();
}

function closeWebviewTab(panelId) {
  const panel = webviewPanelMap.get(panelId);
  if (!panel) return;

  panel.container.remove();
  webviewPanelMap.delete(panelId);

  if (activeWebviewPanelId === panelId) {
    if (webviewPanelMap.size > 0) {
      revealWebviewTab([...webviewPanelMap.keys()].pop());
    } else {
      showEditorCanvas();
    }
  }
  renderTabs();
}

function closeWebviewTabByUser(panelId) {
  invoke('webview_close_by_user', { panelId }).catch(() => {});
  closeWebviewTab(panelId);
}

async function pollWebviewEvents() {
  if (!isPageVisible()) return;
  try {
    const events = await invoke('get_webview_events');
    for (const evt of events) {
      switch (evt.kind) {
        case 'create':   createWebviewTab(evt.panel_id, evt.title, evt.enable_scripts); break;
        case 'setHtml':  setWebviewHtml(evt.panel_id, evt.html); break;
        case 'postMessage': sendWebviewMessage(evt.panel_id, evt.message); break;
        case 'reveal':   revealWebviewTab(evt.panel_id); break;
        case 'close':    closeWebviewTab(evt.panel_id); break;
      }
    }
  } catch (_) { /* ignore */ }
}

// Forward iframe messages to Extension Host
window.addEventListener('message', (event) => {
  if (event.data?.type === 'webview-msg') {
    const { panelId, message } = event.data;
    invoke('webview_post_message', { panelId, message }).catch(() => {});
  }
});

const webviewInterval = setInterval(pollWebviewEvents, 100);

// ─── Accessibility: screen-reader proxy ──────────────────────

const a11yProxy = document.getElementById('a11y-editor-proxy');
const a11yAnnouncer = document.getElementById('a11y-announcer');
let _a11yTimer = null;
let _a11yLastLine = -1;
let _a11yLastCol = -1;

function a11yUpdateProxy() {
  if (!a11yProxy) return;
  const lineOffset = cursorLine - cachedFirstLine;
  const text = (lineOffset >= 0 && lineOffset < cachedLines.length && cachedLines[lineOffset])
    ? (cachedLines[lineOffset].text ?? '')
    : '';
  a11yProxy.value = text;
  try { a11yProxy.setSelectionRange(cursorCol, cursorCol); } catch (_) {}
}

function a11yAnnounce(msg) {
  if (!a11yAnnouncer) return;
  // Toggle text so aria-live always fires even for repeated content
  a11yAnnouncer.textContent = '';
  requestAnimationFrame(() => { a11yAnnouncer.textContent = msg; });
}

function a11yAnnounceCursor() {
  if (_a11yLastLine === cursorLine && _a11yLastCol === cursorCol) return;
  _a11yLastLine = cursorLine;
  _a11yLastCol = cursorCol;
  clearTimeout(_a11yTimer);
  _a11yTimer = setTimeout(() => {
    a11yUpdateProxy();
    const lineText = a11yProxy ? a11yProxy.value : '';
    a11yAnnounce(`Line ${cursorLine + 1}, Column ${cursorCol + 1}: ${lineText || 'empty line'}`);
  }, 150);
}

// ─── Terminal: Extension Host API polling ────────────────────

async function pollTerminalEvents() {
  if (!isPageVisible()) return;
  try {
    const events = await invoke('get_terminal_events');
    for (const evt of events) {
      if (evt.kind === 'create') await handleExtTerminalCreate(evt);
      else if (evt.kind === 'write') handleExtTerminalWrite(evt);
      else if (evt.kind === 'show') handleExtTerminalShow(evt);
      else if (evt.kind === 'close') handleExtTerminalClose(evt);
    }
  } catch (_) { /* ignore */ }
}

async function handleExtTerminalCreate(evt) {
  // evt: { request_id, name, cwd, shell }
  try {
    const terminalId = await invoke('terminal_create', {
      cwd: evt.cwd ?? null,
      shell: evt.shell ?? null,
      cols: 80,
      rows: 24,
    });

    const container = document.createElement('div');
    container.className = 'xterm-instance';
    container.style.width = '100%';
    container.style.height = '100%';
    container.style.display = 'none';
    terminalContainerEl.appendChild(container);

    const xterm = new Terminal({
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace",
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
    });
    const fitAddon = new FitAddon.FitAddon();
    xterm.loadAddon(fitAddon);
    xterm.open(container);
    xterm.onData((data) => {
      invoke('terminal_write', { terminalId, data }).catch(() => {});
    });
    terminals.set(terminalId, { xterm, fitAddon, container });

    openBottomPanel();
    switchBottomTab('terminal');
    switchTerminal(terminalId);
    renderTerminalTabs();
    requestAnimationFrame(() => {
      fitAddon.fit();
      const dims = fitAddon.proposeDimensions();
      if (dims) invoke('terminal_resize', { terminalId, cols: dims.cols, rows: dims.rows }).catch(() => {});
    });

    await invoke('respond_terminal_created', { requestId: evt.request_id, terminalId });
  } catch (err) {
    console.error('[ExtTerminal] Failed to create terminal:', err);
  }
}

function handleExtTerminalWrite(evt) {
  // evt: { terminal_id, data }
  if (!evt.terminal_id || !evt.data) return;
  invoke('terminal_write', { terminalId: evt.terminal_id, data: evt.data }).catch(() => {});
}

function handleExtTerminalShow(evt) {
  openBottomPanel();
  switchBottomTab('terminal');
  if (evt.terminal_id) switchTerminal(evt.terminal_id);
}

function handleExtTerminalClose(evt) {
  if (evt.terminal_id) invoke('terminal_close', { terminalId: evt.terminal_id }).catch(() => {});
}

const terminalEventsInterval = setInterval(pollTerminalEvents, 300);

// ─── Decoration polling ───────────────────────────────────────

async function pollDecorations() {
  if (!isPageVisible() || !filePath) return;
  try {
    const uri = filePathToUri(filePath);
    const decs = await invoke('get_decorations', { uri });
    if (decs && (decs.length !== activeDecorations.length ||
        JSON.stringify(decs) !== JSON.stringify(activeDecorations))) {
      activeDecorations = decs || [];
      requestRender();
    }
  } catch { /* ignore */ }
}

const decorationsInterval = setInterval(pollDecorations, 500);

// ─── Visibility-gated polling ────────────────────────────────
// Skip IPC calls when window is hidden/minimized to save CPU
function isPageVisible() { return document.visibilityState === 'visible'; }

// ─── Status Bar Extension Items ──────────────────────────────

async function pollStatusBarItems() {
  if (!isPageVisible()) return;
  try {
    const [items, wasmItems] = await Promise.all([
      invoke('get_status_bar_items').catch(() => []),
      invoke('get_wasm_status_bar_items').catch(() => []),
    ]);
    const allItems = [...(items || []), ...(wasmItems || [])];
    if (allItems.length === 0) { extStatusBarEl.innerHTML = ''; return; }
    allItems.sort((a, b) => (b.priority || 0) - (a.priority || 0));
    extStatusBarEl.innerHTML = '';
    for (const item of allItems) {
      const span = document.createElement('span');
      span.className = 'ext-sb-item';
      span.textContent = item.text;
      if (item.tooltip) span.title = item.tooltip;
      if (item.command) span.addEventListener('click', () => invoke('execute_command', { command: item.command }));
      extStatusBarEl.appendChild(span);
    }
  } catch (err) { /* Ignore */ }
}

const statusBarInterval = setInterval(pollStatusBarItems, 2000);

// ─── Bottom Panel (Output + Terminal) ────────────────────────

function toggleBottomPanel() {
  bottomPanelOpen ? closeBottomPanel() : openBottomPanel();
}

function openBottomPanel() {
  bottomPanelOpen = true;
  outputOpen = true;
  bottomPanelEl.classList.remove('bottom-panel-hidden');
  switchBottomTab(bottomPanelActiveTab);
  // Auto-create a terminal if none exist and terminal tab is active
  if (bottomPanelActiveTab === 'terminal' && terminals.size === 0) {
    createTerminal();
  }
}

function closeBottomPanel() {
  bottomPanelOpen = false;
  outputOpen = false;
  bottomPanelEl.classList.add('bottom-panel-hidden');
}

function switchBottomTab(tab) {
  bottomPanelActiveTab = tab;
  bottomPanelTabs.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.panel === tab);
  });
  outputPanelEl.classList.toggle('sub-panel-hidden', tab !== 'output');
  terminalPanelEl.classList.toggle('sub-panel-hidden', tab !== 'terminal');
  const dbgConsoleEl = document.getElementById('debug-console-panel');
  if (dbgConsoleEl) dbgConsoleEl.classList.toggle('sub-panel-hidden', tab !== 'debug-console');
  if (tab === 'terminal' && activeTerminalId) {
    const term = terminals.get(activeTerminalId);
    if (term) {
      term.fitAddon.fit();
      term.xterm.focus();
    }
  }
}

// Bottom panel tab switching
bottomPanelTabs.forEach(btn => {
  btn.addEventListener('click', () => switchBottomTab(btn.dataset.panel));
});
bottomPanelCloseBtn.addEventListener('click', closeBottomPanel);

// --- Output sub-panel ---

async function pollOutputLines() {
  if (!isPageVisible() || !bottomPanelOpen) return;
  try {
    // Poll both Node.js extension host and WASM extension output in parallel.
    const [newLines, wasmLines] = await Promise.all([
      invoke('get_output_lines').catch(() => []),
      invoke('get_wasm_output_lines').catch(() => []),
    ]);
    // Convert WASM [channel, message] arrays to {channel, text} objects.
    const wasmConverted = (wasmLines || [])
      .filter(item => Array.isArray(item) && item.length >= 2)
      .map(([channel, text]) => ({ channel, text: text + '\n' }));
    const combined = [...(newLines || []), ...wasmConverted];
    if (combined.length === 0) return;
    outputAllLines.push(...combined);
    if (outputAllLines.length > 10000) outputAllLines.splice(0, outputAllLines.length - 10000);
    const channels = [...new Set(outputAllLines.map(l => l.channel))];
    if (!outputSelectedChannel && channels.length > 0) outputSelectedChannel = channels[0];
    outputChannelSelect.innerHTML = '';
    for (const ch of channels) {
      const opt = document.createElement('option');
      opt.value = ch; opt.textContent = ch; opt.selected = ch === outputSelectedChannel;
      outputChannelSelect.appendChild(opt);
    }
    renderOutputContent();
  } catch (err) { /* Ignore */ }
}

function renderOutputContent() {
  const filtered = outputAllLines.filter(l => l.channel === outputSelectedChannel);
  outputContentEl.textContent = filtered.map(l => l.text).join('');
  outputContentEl.scrollTop = outputContentEl.scrollHeight;
}

outputChannelSelect.addEventListener('change', (e) => { outputSelectedChannel = e.target.value; renderOutputContent(); });
outputClearBtn.addEventListener('click', () => { outputAllLines = outputAllLines.filter(l => l.channel !== outputSelectedChannel); renderOutputContent(); });

const outputInterval = setInterval(pollOutputLines, 1000);

// --- Terminal sub-panel ---

async function createTerminal() {
  try {
    const terminalId = await invoke('terminal_create', { cols: 80, rows: 24 });
    const container = document.createElement('div');
    container.className = 'xterm-instance';
    container.style.width = '100%';
    container.style.height = '100%';
    container.style.display = 'none';
    terminalContainerEl.appendChild(container);

    const xterm = new Terminal({
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace",
      fontSize: 13,
      theme: {
        background: '#1e1e2e',
        foreground: '#cdd6f4',
        cursor: '#f5e0dc',
        cursorAccent: '#1e1e2e',
        selectionBackground: '#31324480',
        black: '#45475a',
        red: '#f38ba8',
        green: '#a6e3a1',
        yellow: '#f9e2af',
        blue: '#89b4fa',
        magenta: '#cba6f7',
        cyan: '#94e2d5',
        white: '#bac2de',
        brightBlack: '#585b70',
        brightRed: '#f38ba8',
        brightGreen: '#a6e3a1',
        brightYellow: '#f9e2af',
        brightBlue: '#89b4fa',
        brightMagenta: '#cba6f7',
        brightCyan: '#94e2d5',
        brightWhite: '#a6adc8',
      },
      cursorBlink: true,
      scrollback: 5000,
    });

    const fitAddon = new FitAddon.FitAddon();
    xterm.loadAddon(fitAddon);
    xterm.open(container);

    // Send keystrokes to the PTY
    xterm.onData((data) => {
      invoke('terminal_write', { terminalId, data }).catch(() => {});
    });

    terminals.set(terminalId, { xterm, fitAddon, container });
    switchTerminal(terminalId);
    renderTerminalTabs();

    // Fit after a frame to get correct dimensions
    requestAnimationFrame(() => {
      fitAddon.fit();
      const dims = fitAddon.proposeDimensions();
      if (dims) {
        invoke('terminal_resize', { terminalId, cols: dims.cols, rows: dims.rows }).catch(() => {});
      }
    });
  } catch (err) {
    console.error('Failed to create terminal:', err);
  }
}

function switchTerminal(terminalId) {
  activeTerminalId = terminalId;
  for (const [id, t] of terminals) {
    t.container.style.display = id === terminalId ? '' : 'none';
  }
  const term = terminals.get(terminalId);
  if (term) {
    term.fitAddon.fit();
    term.xterm.focus();
  }
  renderTerminalTabs();
}

async function closeTerminal(terminalId) {
  const term = terminals.get(terminalId);
  if (term) {
    term.xterm.dispose();
    term.container.remove();
    terminals.delete(terminalId);
  }
  try {
    await invoke('terminal_close', { terminalId });
  } catch (err) { /* Ignore — may already be dead */ }

  if (activeTerminalId === terminalId) {
    const remaining = [...terminals.keys()];
    activeTerminalId = remaining.length > 0 ? remaining[remaining.length - 1] : null;
    if (activeTerminalId) switchTerminal(activeTerminalId);
  }
  renderTerminalTabs();

  // Close bottom panel if no terminals and output is empty
  if (terminals.size === 0 && bottomPanelActiveTab === 'terminal') {
    closeBottomPanel();
  }
}

function renderTerminalTabs() {
  terminalTabsEl.innerHTML = '';
  let idx = 1;
  for (const [id] of terminals) {
    const tab = document.createElement('button');
    tab.className = 'terminal-tab' + (id === activeTerminalId ? ' active' : '');

    const label = document.createElement('span');
    label.textContent = `Terminal ${idx}`;
    tab.appendChild(label);

    const closeBtn = document.createElement('span');
    closeBtn.className = 'term-tab-close';
    closeBtn.textContent = '\u00d7';
    closeBtn.addEventListener('click', (e) => { e.stopPropagation(); closeTerminal(id); });
    tab.appendChild(closeBtn);

    tab.addEventListener('click', () => switchTerminal(id));
    terminalTabsEl.appendChild(tab);
    idx++;
  }
}

// New terminal button
terminalNewBtn.addEventListener('click', () => {
  if (!bottomPanelOpen) openBottomPanel();
  switchBottomTab('terminal');
  createTerminal();
});

// Listen for PTY output from Rust
listen('terminal-data', (event) => {
  const { terminal_id, data } = event.payload;
  const term = terminals.get(terminal_id);
  if (term) term.xterm.write(data);
});

// Listen for PTY exit from Rust
listen('terminal-exit', (event) => {
  const { terminal_id } = event.payload;
  const term = terminals.get(terminal_id);
  if (term) {
    term.xterm.writeln('\r\n\x1b[90m[Process exited]\x1b[0m');
  }
});

// Resize terminals when the bottom panel resizes
const terminalResizeObserver = new ResizeObserver(() => {
  if (!bottomPanelOpen || bottomPanelActiveTab !== 'terminal') return;
  for (const [id, t] of terminals) {
    if (t.container.style.display !== 'none') {
      t.fitAddon.fit();
      const dims = t.fitAddon.proposeDimensions();
      if (dims) {
        invoke('terminal_resize', { terminalId: id, cols: dims.cols, rows: dims.rows }).catch(() => {});
      }
    }
  }
});
terminalResizeObserver.observe(terminalContainerEl);

// ─── Diagnostics Polling ─────────────────────────────────────

async function refreshDiagnostics() {
  if (!isPageVisible()) return;
  try {
    await fetchVisibleContent();
    if (filePath) {
      const uri = filePathToUri(filePath);
      diagnostics = await invoke('lang_diagnostics', { uri }).catch(() => []);
    }
    updateMetadataUI();
    requestRender();
  } catch (err) { /* Ignore */ }
}

const diagnosticsInterval = setInterval(refreshDiagnostics, 2000);

// ─── Extension Host Status Polling ───────────────────────────

async function pollExtHostStatus() {
  if (!isPageVisible()) return;
  try {
    const status = await invoke('get_ext_host_status');
    if (status.running) {
      extHostStatusEl.textContent = `Extension Host: Connected (${status.commands.length} commands)`;
      extHostStatusEl.classList.add('connected');
    } else {
      extHostStatusEl.textContent = 'Extension Host: Disconnected';
      extHostStatusEl.classList.remove('connected');
    }
  } catch (err) {
    extHostStatusEl.textContent = 'Extension Host: Error';
  }
}

const extHostInterval = setInterval(pollExtHostStatus, 3000);

// ─── Notification Toasts ─────────────────────────────────────

async function pollNotifications() {
  if (!isPageVisible()) return;
  try {
    const [notifications, wasmNotifs] = await Promise.all([
      invoke('get_notifications').catch(() => []),
      invoke('get_wasm_notifications').catch(() => []),
    ]);
    for (const n of notifications) showToast(n.type, n.message);
    for (const n of wasmNotifs) showToast(n.type, n.message);
  } catch (err) { /* Ignore */ }
}

let activeToasts = [];

function showToast(type, message) {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  activeToasts.push(toast);
  repositionToasts();
  setTimeout(() => {
    toast.classList.add('toast-fade');
    setTimeout(() => { toast.remove(); activeToasts = activeToasts.filter(t => t !== toast); repositionToasts(); }, 300);
  }, 5000);
}

function repositionToasts() {
  let bottom = 40;
  for (let i = activeToasts.length - 1; i >= 0; i--) {
    activeToasts[i].style.bottom = `${bottom}px`;
    bottom += activeToasts[i].offsetHeight + 8;
  }
}

const notifInterval = setInterval(pollNotifications, 1000);

// ─── QuickPick / InputBox from Extension Host ────────────────

async function pollUiRequests() {
  if (!isPageVisible()) return;
  try {
    const requests = await invoke('get_ui_requests');
    for (const req of requests) {
      if (req.kind === 'showQuickPick') handleQuickPick(req);
      else if (req.kind === 'showInputBox') handleInputBox(req);
    }
  } catch (err) { /* Ignore */ }
}

function handleQuickPick(req) {
  const items = req.params.items || [];
  const title = req.params.title || req.params.placeHolder || 'Select an item';
  paletteOpen = true;
  paletteEl.classList.remove('palette-hidden');
  paletteInputEl.setAttribute('aria-expanded', 'true');
  paletteInputEl.value = '';
  paletteInputEl.placeholder = title;
  paletteSelectedIndex = 0;

  const renderItems = (filter) => {
    const q = (filter || '').toLowerCase();
    const filtered = q ? items.filter(i => (i.label || '').toLowerCase().includes(q) || (i.description || '').toLowerCase().includes(q)) : items;
    paletteListEl.innerHTML = '';
    for (let i = 0; i < filtered.length; i++) {
      const item = document.createElement('div');
      item.className = 'palette-item' + (i === paletteSelectedIndex ? ' selected' : '');
      const labelSpan = document.createElement('span');
      labelSpan.textContent = filtered[i].label || '';
      item.appendChild(labelSpan);
      if (filtered[i].description) {
        const descSpan = document.createElement('span');
        descSpan.style.color = 'var(--fg-dim)';
        descSpan.textContent = ' ' + filtered[i].description;
        item.appendChild(descSpan);
      }
      const idx = i;
      item.addEventListener('click', () => closePaletteAndRespond(req.request_id, filtered[idx].label));
      paletteListEl.appendChild(item);
    }
  };

  renderItems('');

  const qpAbort = new AbortController();
  paletteInputEl.removeEventListener('input', paletteInputHandler);
  paletteInputEl.removeEventListener('keydown', paletteKeydownHandler);
  paletteBackdropEl.removeEventListener('click', closePalette);
  paletteInputEl.addEventListener('input', () => { paletteSelectedIndex = 0; renderItems(paletteInputEl.value); }, { signal: qpAbort.signal });
  paletteInputEl.addEventListener('keydown', (e) => {
    const total = paletteListEl.children.length;
    if (e.key === 'ArrowDown') { e.preventDefault(); paletteSelectedIndex = Math.min(paletteSelectedIndex + 1, total - 1); updatePaletteSelection(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); paletteSelectedIndex = Math.max(paletteSelectedIndex - 1, 0); updatePaletteSelection(); }
    else if (e.key === 'Enter') { e.preventDefault(); const sel = paletteListEl.querySelectorAll('.palette-item')[paletteSelectedIndex]; if (sel) sel.click(); }
    else if (e.key === 'Escape') closePaletteAndRespond(req.request_id, null);
  }, { signal: qpAbort.signal });
  paletteBackdropEl.addEventListener('click', () => closePaletteAndRespond(req.request_id, null), { signal: qpAbort.signal });

  async function closePaletteAndRespond(requestId, value) {
    paletteOpen = false;
    paletteEl.classList.add('palette-hidden');
    paletteInputEl.setAttribute('aria-expanded', 'false');
    paletteInputEl.placeholder = 'Type a command...';
    qpAbort.abort();
    paletteInputEl.addEventListener('input', paletteInputHandler);
    paletteInputEl.addEventListener('keydown', paletteKeydownHandler);
    paletteBackdropEl.addEventListener('click', closePalette);
    editorEl.focus();
    await invoke('respond_ui_request', { requestId, value: value });
  }

  paletteInputEl.focus();
}

function handleInputBox(req) {
  const prompt = req.params.prompt || req.params.title || 'Enter a value';
  const placeholder = req.params.placeHolder || '';
  const defaultValue = req.params.value || '';
  paletteOpen = true;
  paletteEl.classList.remove('palette-hidden');
  paletteInputEl.setAttribute('aria-expanded', 'true');
  paletteInputEl.value = defaultValue;
  paletteInputEl.placeholder = placeholder;
  paletteListEl.innerHTML = '';
  const hint = document.createElement('div');
  hint.className = 'palette-item';
  hint.style.color = 'var(--fg-dim)';
  hint.textContent = prompt + ' (press Enter to confirm, Escape to cancel)';
  paletteListEl.appendChild(hint);

  const ibAbort = new AbortController();
  paletteInputEl.removeEventListener('input', paletteInputHandler);
  paletteInputEl.removeEventListener('keydown', paletteKeydownHandler);
  paletteBackdropEl.removeEventListener('click', closePalette);
  paletteInputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); closeInputAndRespond(req.request_id, paletteInputEl.value); }
    else if (e.key === 'Escape') closeInputAndRespond(req.request_id, null);
  }, { signal: ibAbort.signal });
  paletteBackdropEl.addEventListener('click', () => closeInputAndRespond(req.request_id, null), { signal: ibAbort.signal });

  async function closeInputAndRespond(requestId, value) {
    paletteOpen = false;
    paletteEl.classList.add('palette-hidden');
    paletteInputEl.setAttribute('aria-expanded', 'false');
    paletteInputEl.placeholder = 'Type a command...';
    ibAbort.abort();
    paletteInputEl.addEventListener('input', paletteInputHandler);
    paletteInputEl.addEventListener('keydown', paletteKeydownHandler);
    paletteBackdropEl.addEventListener('click', closePalette);
    editorEl.focus();
    await invoke('respond_ui_request', { requestId, value: value });
  }

  paletteInputEl.focus();
}

const uiReqInterval = setInterval(pollUiRequests, 500);

// ─── M6: LSP Features ────────────────────────────────────────

const autocompletePopup = document.getElementById('autocomplete-popup');
const autocompleteList = document.getElementById('autocomplete-list');
const autocompleteDetail = document.getElementById('autocomplete-detail');
const hoverTooltip = document.getElementById('hover-tooltip');
const hoverContent = document.getElementById('hover-content');
const signatureHelp = document.getElementById('signature-help');
const signatureLabel = document.getElementById('signature-label');
const signatureDocs = document.getElementById('signature-docs');
const codeActionsMenu = document.getElementById('code-actions-menu');
const codeActionsList = document.getElementById('code-actions-list');
const referencesPanel = document.getElementById('references-panel');
const referencesList = document.getElementById('references-list');
const referencesClose = document.getElementById('references-close');
const referencesTitle = document.getElementById('references-title');
const symbolsPalette = document.getElementById('symbols-palette');
const symbolsBackdrop = document.getElementById('symbols-backdrop');
const symbolsPanel = document.getElementById('symbols-panel');
const symbolsInput = document.getElementById('symbols-input');
const symbolsList = document.getElementById('symbols-list');

let acOpen = false;
let acItems = [];
let acSelectedIdx = 0;
let acFilterText = '';
let completionSeq = 0;
let hoverOpen = false;
let hoverTimer = null;
let sigHelpOpen = false;
let codeActionsOpen = false;
let caItems = [];
let caSelectedIdx = 0;
let refsOpen = false;
let symbolsOpen = false;
let symbolItems = [];
let symbolSelectedIdx = 0;

function getActiveUri() {
  if (!activeBufferPath) return null;
  if (activeBufferPath.match(/^[a-zA-Z]:\\/)) return 'file:///' + activeBufferPath.replace(/\\/g, '/');
  return 'file://' + activeBufferPath;
}

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// --- Autocomplete ---

async function triggerAutocomplete(triggerChar) {
  const uri = getActiveUri();
  if (!uri) return;
  const thisSeq = ++completionSeq;
  try {
    // Unified dispatch: single call merges WASM + LSP completions
    const items = await invoke('lang_completions', {
      uri, line: cursorLine, character: cursorCol,
      trigger: triggerChar || null,
    }).catch(() => []);
    // Discard stale response if a newer request was issued while awaiting.
    if (thisSeq !== completionSeq) return;
    // Normalise WASM items to the same shape as LSP items.
    const allItems = (items || []).map(w => ({
      label: w.label, kind: w.kind, detail: w.detail,
      documentation: w.documentation, insertText: w.insert_text ?? w.label,
      filterText: w.filter_text ?? w.label,
    }));
    if (allItems.length === 0) { closeAutocomplete(); return; }
    acItems = allItems;
    acSelectedIdx = 0;
    acFilterText = '';
    acOpen = true;
    renderAutocomplete();
    positionAutocomplete();
  } catch { closeAutocomplete(); }
}

function renderAutocomplete() {
  autocompleteList.innerHTML = '';
  const filtered = acFilterText
    ? acItems.filter(i => (i.filterText || i.label || '').toLowerCase().includes(acFilterText.toLowerCase()))
    : acItems;
  const max = Math.min(filtered.length, 30);
  for (let i = 0; i < max; i++) {
    const item = filtered[i];
    const div = document.createElement('div');
    div.className = 'ac-item' + (i === acSelectedIdx ? ' selected' : '');
    const icon = document.createElement('span');
    icon.className = 'ac-icon ' + acKindClass(item.kind);
    icon.textContent = acKindLetter(item.kind);
    div.appendChild(icon);
    const label = document.createElement('span');
    label.className = 'ac-label';
    label.textContent = item.label || '';
    div.appendChild(label);
    if (item.detail) {
      const detail = document.createElement('span');
      detail.className = 'ac-detail';
      detail.textContent = item.detail;
      div.appendChild(detail);
    }
    div.addEventListener('click', () => acceptCompletion(item));
    div.addEventListener('mouseenter', () => { acSelectedIdx = i; updateAcSelection(); showAcDetail(item); });
    autocompleteList.appendChild(div);
  }
  if (max > 0) showAcDetail(filtered[acSelectedIdx]);
  autocompletePopup.classList.remove('lsp-hidden');
}

function updateAcSelection() {
  const items = autocompleteList.querySelectorAll('.ac-item');
  items.forEach((el, i) => el.classList.toggle('selected', i === acSelectedIdx));
  if (items[acSelectedIdx]) items[acSelectedIdx].scrollIntoView({ block: 'nearest' });
}

function showAcDetail(item) { autocompleteDetail.textContent = item.documentation || item.detail || ''; }

function positionAutocomplete() {
  const bounds = getLineBoundsOnScreen(cursorLine);
  let left = bounds.left + EDITOR_PADDING_LEFT + cursorCol * cellWidth - editorEl.scrollLeft;
  let top = bounds.bottom;
  if (left + 450 > window.innerWidth) left = window.innerWidth - 460;
  if (top + 250 > window.innerHeight) top = bounds.top - 250;
  autocompletePopup.style.left = `${Math.max(0, left)}px`;
  autocompletePopup.style.top = `${Math.max(0, top)}px`;
}

async function acceptCompletion(item) {
  closeAutocomplete();
  const insertText = item.insertText || item.label || '';
  if (!insertText) return;
  if (acFilterText) {
    const result = await invoke('edit_replace_range', {
      startLine: cursorLine, startCol: cursorCol - acFilterText.length,
      endLine: cursorLine, endCol: cursorCol, text: insertText,
    });
    cursorCol = cursorCol - acFilterText.length + insertText.length;
    await updateFromEditResult(result);
  } else {
    const result = await invoke('edit_insert', { line: cursorLine, col: cursorCol, text: insertText });
    cursorCol += insertText.length;
    await updateFromEditResult(result);
  }
}

function closeAutocomplete() { acOpen = false; acItems = []; acFilterText = ''; autocompletePopup.classList.add('lsp-hidden'); autocompleteDetail.textContent = ''; }

function acKindClass(kind) {
  const map = { 1: 'ac-icon-method', 2: 'ac-icon-function', 3: 'ac-icon-function', 4: 'ac-icon-field', 5: 'ac-icon-variable', 6: 'ac-icon-class', 7: 'ac-icon-interface', 8: 'ac-icon-module', 9: 'ac-icon-property', 12: 'ac-icon-enum', 13: 'ac-icon-keyword', 14: 'ac-icon-snippet', 16: 'ac-icon-file', 18: 'ac-icon-folder', 20: 'ac-icon-constant' };
  return map[kind] || 'ac-icon-text';
}

function acKindLetter(kind) {
  const map = { 1: 'M', 2: 'F', 3: 'C', 4: 'F', 5: 'V', 6: 'C', 7: 'I', 8: 'M', 9: 'P', 12: 'E', 13: 'K', 14: 'S', 16: 'F', 18: 'D', 20: 'C' };
  return map[kind] || 'T';
}

// --- Hover ---

function scheduleHover(line, col) { cancelHover(); hoverTimer = setTimeout(() => requestHover(line, col), 500); }
function cancelHover() { if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; } }

async function requestHover(line, col) {
  const uri = getActiveUri();
  if (!uri) return;
  try {
    // Unified dispatch: merges WASM + LSP, WASM priority
    const result = await invoke('lang_hover', { uri, line, character: col }).catch(() => null);
    if (!result || (!result.contents)) { closeHover(); return; }
    hoverContent.textContent = '';
    const text = typeof result.contents === 'string' ? result.contents
      : Array.isArray(result.contents) ? result.contents.map(c => typeof c === 'string' ? c : c.value || '').join('\n')
      : result.contents.value || String(result.contents);
    hoverContent.textContent = text;
    hoverOpen = true;
    hoverTooltip.classList.remove('lsp-hidden');
    positionHover(line);
  } catch { closeHover(); }
}

function positionHover(line) {
  const bounds = getLineBoundsOnScreen(line);
  let left = bounds.left + EDITOR_PADDING_LEFT;
  let top = bounds.top - 10;
  const tooltipHeight = hoverTooltip.offsetHeight || 100;
  if (top - tooltipHeight < 0) top = bounds.bottom + 4;
  else top = top - tooltipHeight;
  hoverTooltip.style.left = `${Math.max(0, left)}px`;
  hoverTooltip.style.top = `${Math.max(0, top)}px`;
}

function closeHover() { hoverOpen = false; hoverTooltip.classList.add('lsp-hidden'); }

editorEl.addEventListener('mousemove', (e) => {
  if (isDragging || acOpen) return;
  const pos = posFromMouse(e);
  if (e.ctrlKey) { cancelHover(); closeHover(); return; }
  scheduleHover(pos.line, pos.col);
});

editorEl.addEventListener('mouseleave', () => {
  cancelHover();
  setTimeout(() => { if (!hoverTooltip.matches(':hover')) closeHover(); }, 200);
});

hoverTooltip.addEventListener('mouseleave', () => closeHover());

// --- Go-to-definition ---

async function goToDefinition() {
  return goToLocationCommand('lang_definition', 'definition');
}

async function goToTypeDefinition() {
  return goToLocationCommand('lsp_type_definition', 'type definition');
}

async function goToImplementation() {
  return goToLocationCommand('lsp_implementation', 'implementation');
}

async function goToLocationCommand(command, label) {
  const uri = getActiveUri();
  if (!uri) return;
  try {
    statusEl.textContent = `Go to ${label}...`;
    const result = await invoke(command, { uri, line: cursorLine, character: cursorCol }).catch(() => null);
    if (!result || (Array.isArray(result) && result.length === 0)) {
      statusEl.textContent = `No ${label} found`;
      setTimeout(() => { statusEl.textContent = ''; }, 2000);
      return;
    }
    const locations = Array.isArray(result) ? result : [result];
    const loc = locations[0];
    if (loc.uri && loc.range) await navigateToLocation(loc.uri, loc.range.start.line, loc.range.start.character);
    statusEl.textContent = '';
  } catch {
    statusEl.textContent = `${label} unavailable`;
    setTimeout(() => { statusEl.textContent = ''; }, 2000);
  }
}

async function navigateToLocation(uri, line, col) {
  let path = uri;
  if (path.startsWith('file:///')) path = path.substring(8);
  else if (path.startsWith('file://')) path = path.substring(7);
  if (path.match(/^\/[a-zA-Z]:\//)) path = path.substring(1);
  const isWindows = navigator.userAgentData?.platform === 'Windows' || /Win/.test(navigator.platform || '');
  if (isWindows) path = path.replace(/\//g, '\\');

  try {
    saveBufferState();
    const content = await invoke('open_file', { path });
    activeBufferPath = content.file_path;
    cursorLine = line;
    cursorCol = col;
    clearSelection();
    await updateFromEditorContent(content);
    renderTabs();
    editorEl.focus();
  } catch (err) {
    statusEl.textContent = `Cannot open: ${err}`;
    setTimeout(() => { statusEl.textContent = ''; }, 2000);
  }
}

editorEl.addEventListener('click', async (e) => {
  if (e.ctrlKey && e.button === 0) {
    e.preventDefault();
    const pos = posFromMouse(e);
    cursorLine = pos.line;
    cursorCol = pos.col;
    const link = findDocumentLinkAt(pos.line, pos.col);
    if (link) { await openDocumentLink(link); return; }
    await goToDefinition();
  }
});

// --- Selection range (expand / shrink) ---

async function expandSelection() {
  const uri = getActiveUri();
  if (!uri) return;
  const buf = activeBufferPath;
  // Anchor at first expand from current cursor — on shrink we walk back to
  // this point. Re-anchor whenever the buffer changes, or whenever the
  // current selection no longer contains the prior anchor (cursor moved).
  const cur = currentSelectionRange();
  if (
    selectionRangeBuffer !== buf ||
    !selectionRangeAnchor ||
    !selectionContains(cur, selectionRangeAnchor)
  ) {
    selectionRangeStack = [];
    selectionRangeAnchor = { line: cursorLine, character: cursorCol };
    selectionRangeBuffer = buf;
  }
  const myToken = ++selectionRangeToken;
  let result;
  try {
    result = await invoke('lsp_selection_ranges', {
      uri,
      positions: [{ line: selectionRangeAnchor.line, character: selectionRangeAnchor.character }],
    });
  } catch {
    return;
  }
  // A newer expand call superseded us, or the buffer changed mid-flight.
  if (myToken !== selectionRangeToken || activeBufferPath !== buf) return;
  if (!Array.isArray(result) || result.length === 0) return;
  // result[0] is a SelectionRange chain (range + parent + ...). Walk to the
  // first range strictly enclosing the current selection.
  let node = result[0];
  while (node) {
    if (rangeStrictlyContains(node.range, cur)) {
      selectionRangeStack.push(cur);
      applySelectionRange(node.range);
      return;
    }
    node = node.parent;
  }
}

function shrinkSelection() {
  // Stack is per-buffer; if the active buffer changed, drop everything.
  if (selectionRangeBuffer !== activeBufferPath) {
    selectionRangeStack = [];
    selectionRangeAnchor = null;
    selectionRangeBuffer = null;
    return;
  }
  if (selectionRangeStack.length === 0) return;
  const prev = selectionRangeStack.pop();
  applySelectionRange({
    start: { line: prev.startLine, character: prev.startCol },
    end:   { line: prev.endLine,   character: prev.endCol },
  });
}

function currentSelectionRange() {
  if (selAnchorLine === null || selAnchorCol === null) {
    return { startLine: cursorLine, startCol: cursorCol, endLine: cursorLine, endCol: cursorCol };
  }
  if (selAnchorLine < cursorLine || (selAnchorLine === cursorLine && selAnchorCol <= cursorCol)) {
    return { startLine: selAnchorLine, startCol: selAnchorCol, endLine: cursorLine, endCol: cursorCol };
  }
  return { startLine: cursorLine, startCol: cursorCol, endLine: selAnchorLine, endCol: selAnchorCol };
}

function applySelectionRange(range) {
  selAnchorLine = range.start.line;
  selAnchorCol = range.start.character;
  cursorLine = range.end.line;
  cursorCol = range.end.character;
  requestRender();
}

function selectionContains(sel, pos) {
  if (pos.line < sel.startLine || pos.line > sel.endLine) return false;
  if (pos.line === sel.startLine && pos.character < sel.startCol) return false;
  if (pos.line === sel.endLine && pos.character > sel.endCol) return false;
  return true;
}

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

// --- Find References ---

async function findReferences() {
  const uri = getActiveUri();
  if (!uri) return;
  try {
    statusEl.textContent = 'Finding references...';
    // Unified dispatch: merges WASM + LSP (union semantics)
    const merged = await invoke('lang_references', { uri, line: cursorLine, character: cursorCol, includeDecl: true }).catch(() => []);
    if (merged.length === 0) {
      statusEl.textContent = 'No references found';
      setTimeout(() => { statusEl.textContent = ''; }, 2000);
      return;
    }
    statusEl.textContent = '';
    showReferencesPanel(merged);
  } catch {
    statusEl.textContent = 'References unavailable';
    setTimeout(() => { statusEl.textContent = ''; }, 2000);
  }
}

function showReferencesPanel(locations) {
  refsOpen = true;
  referencesList.innerHTML = '';
  referencesTitle.textContent = `${locations.length} Reference${locations.length !== 1 ? 's' : ''}`;
  for (const loc of locations) {
    const div = document.createElement('div');
    div.className = 'ref-item';
    let path = loc.uri || '';
    if (path.startsWith('file:///')) path = path.substring(8);
    else if (path.startsWith('file://')) path = path.substring(7);
    const name = path.split(/[/\\]/).pop() || path;
    const fileSpan = document.createElement('span');
    fileSpan.className = 'ref-file';
    fileSpan.textContent = name;
    div.appendChild(fileSpan);
    const locSpan = document.createElement('span');
    locSpan.className = 'ref-location';
    const line = loc.range?.start?.line ?? 0;
    const col = loc.range?.start?.character ?? 0;
    locSpan.textContent = `:${line + 1}:${col + 1}`;
    div.appendChild(locSpan);
    div.addEventListener('click', () => { closeReferences(); navigateToLocation(loc.uri, line, col); });
    referencesList.appendChild(div);
  }
  referencesPanel.classList.remove('lsp-hidden');
}

function closeReferences() { refsOpen = false; referencesPanel.classList.add('lsp-hidden'); }
referencesClose.addEventListener('click', closeReferences);

// --- Code Actions ---

async function requestCodeActions() {
  const uri = getActiveUri();
  if (!uri) return;
  let startLine = cursorLine, startChar = cursorCol, endLine = cursorLine, endChar = cursorCol;
  if (hasSelection()) {
    const sel = getSelectionRange();
    startLine = sel.startLine; startChar = sel.startCol; endLine = sel.endLine; endChar = sel.endCol;
  }
  try {
    const merged = await invoke('lang_code_actions', {
      uri, startLine, startCharacter: startChar, endLine, endCharacter: endChar, diagnostics: [],
    }).catch(() => []);
    if (!merged || merged.length === 0) {
      statusEl.textContent = 'No code actions available';
      setTimeout(() => { statusEl.textContent = ''; }, 2000);
      return;
    }
    caItems = merged;
    caSelectedIdx = 0;
    codeActionsOpen = true;
    renderCodeActions();
    positionCodeActions();
  } catch {
    statusEl.textContent = 'Code actions unavailable';
    setTimeout(() => { statusEl.textContent = ''; }, 2000);
  }
}

function renderCodeActions() {
  codeActionsList.innerHTML = '';
  for (let i = 0; i < caItems.length; i++) {
    const action = caItems[i];
    const div = document.createElement('div');
    div.className = 'ca-item' + (i === caSelectedIdx ? ' selected' : '') + (action.isPreferred ? ' ca-item-preferred' : '');
    div.textContent = action.title || 'Unnamed action';
    div.addEventListener('click', () => executeCodeAction(action));
    codeActionsList.appendChild(div);
  }
  codeActionsMenu.classList.remove('lsp-hidden');
}

function positionCodeActions() {
  const bounds = getLineBoundsOnScreen(cursorLine);
  let left = bounds.left + EDITOR_PADDING_LEFT + cursorCol * cellWidth - editorEl.scrollLeft;
  let top = bounds.bottom + 2;
  codeActionsMenu.style.left = `${Math.max(0, left)}px`;
  codeActionsMenu.style.top = `${Math.max(0, top)}px`;
}

async function executeCodeAction(action) {
  closeCodeActions();
  if (action.command) {
    await invoke('execute_command', { command: action.command.command || action.command });
    setTimeout(refreshDiagnostics, 500);
  }
  if (action.edit) {
    // Build per-file changes map from both `changes` and `documentChanges` (LSP 3.x)
    const fileMap = new Map(); // uri -> TextEdit[]
    if (action.edit.changes) {
      for (const [uri, edits] of Object.entries(action.edit.changes)) {
        if (!fileMap.has(uri)) fileMap.set(uri, []);
        for (const e of edits) fileMap.get(uri).push(e);
      }
    }
    if (action.edit.documentChanges) {
      for (const dc of action.edit.documentChanges) {
        const uri = dc.textDocument?.uri || dc.uri;
        if (!uri) continue;
        if (!fileMap.has(uri)) fileMap.set(uri, []);
        for (const e of (dc.edits || [])) fileMap.get(uri).push(e);
      }
    }
    if (fileMap.size > 0) {
      const changes = [];
      for (const [uri, edits] of fileMap) {
        changes.push({
          uri,
          edits: edits.map(e => ({
            start_line: e.range.start.line,
            start_col: e.range.start.character,
            end_line: e.range.end.line,
            end_col: e.range.end.character,
            new_text: e.newText,
          })),
        });
      }
      await invoke('apply_workspace_edit', { changes });
      await fetchVisibleContent();
      updateMetadataUI();
      requestRender();
    }
  }
}

function closeCodeActions() { codeActionsOpen = false; codeActionsMenu.classList.add('lsp-hidden'); }

// --- Signature Help ---

async function requestSignatureHelp(triggerChar) {
  const uri = getActiveUri();
  if (!uri) return;
  try {
    const result = await invoke('lsp_signature_help', { uri, line: cursorLine, character: cursorCol, triggerCharacter: triggerChar || null });
    if (!result || !result.signatures || result.signatures.length === 0) { closeSignatureHelp(); return; }
    sigHelpOpen = true;
    const sig = result.signatures[result.activeSignature ?? 0];
    signatureLabel.textContent = sig.label;
    if (sig.parameters && sig.parameters.length > 0) {
      const activeParam = sig.parameters[result.activeParameter ?? 0];
      if (activeParam) {
        const paramLabel = typeof activeParam.label === 'string' ? activeParam.label : sig.label.substring(activeParam.label[0], activeParam.label[1]);
        const idx = sig.label.indexOf(paramLabel);
        if (idx !== -1) {
          signatureLabel.textContent = '';
          signatureLabel.appendChild(document.createTextNode(sig.label.substring(0, idx)));
          const span = document.createElement('span');
          span.className = 'sig-active-param';
          span.textContent = paramLabel;
          signatureLabel.appendChild(span);
          signatureLabel.appendChild(document.createTextNode(sig.label.substring(idx + paramLabel.length)));
        }
      }
    }
    signatureDocs.textContent = typeof sig.documentation === 'string' ? sig.documentation : sig.documentation?.value || '';
    signatureHelp.classList.remove('lsp-hidden');
    positionSignatureHelp();
  } catch { closeSignatureHelp(); }
}

function positionSignatureHelp() {
  const bounds = getLineBoundsOnScreen(cursorLine);
  let left = bounds.left + EDITOR_PADDING_LEFT + cursorCol * cellWidth - editorEl.scrollLeft;
  let top = bounds.top - signatureHelp.offsetHeight - 4;
  if (top < 0) top = bounds.bottom + 4;
  signatureHelp.style.left = `${Math.max(0, left)}px`;
  signatureHelp.style.top = `${Math.max(0, top)}px`;
}

function closeSignatureHelp() { sigHelpOpen = false; signatureHelp.classList.add('lsp-hidden'); }

// --- Document Symbols ---

async function openSymbolOutline() {
  const uri = getActiveUri();
  if (!uri) { statusEl.textContent = 'No file open'; return; }
  try {
    statusEl.textContent = 'Loading symbols...';
    const result = await invoke('lsp_document_symbols', { uri });
    statusEl.textContent = '';
    if (!result || (Array.isArray(result) && result.length === 0)) {
      statusEl.textContent = 'No symbols found';
      setTimeout(() => { statusEl.textContent = ''; }, 2000);
      return;
    }
    symbolItems = flattenSymbols(Array.isArray(result) ? result : []);
    symbolSelectedIdx = 0;
    symbolsOpen = true;
    renderSymbolList('');
    symbolsPalette.classList.remove('palette-hidden');
    symbolsInput.value = '';
    symbolsInput.focus();
  } catch {
    statusEl.textContent = 'Symbols unavailable';
    setTimeout(() => { statusEl.textContent = ''; }, 2000);
  }
}

function flattenSymbols(symbols, prefix = '') {
  const result = [];
  for (const sym of symbols) {
    const name = prefix ? `${prefix}.${sym.name}` : sym.name;
    const line = sym.range?.start?.line ?? sym.selectionRange?.start?.line ?? sym.location?.range?.start?.line ?? 0;
    const col = sym.range?.start?.character ?? sym.selectionRange?.start?.character ?? sym.location?.range?.start?.character ?? 0;
    result.push({ name, detail: sym.detail || '', kind: sym.kind, line, col });
    if (sym.children) result.push(...flattenSymbols(sym.children, name));
  }
  return result;
}

function renderSymbolList(query) {
  symbolsList.innerHTML = '';
  const q = query.toLowerCase();
  const filtered = q ? symbolItems.filter(s => s.name.toLowerCase().includes(q)) : symbolItems;
  for (let i = 0; i < Math.min(filtered.length, 50); i++) {
    const sym = filtered[i];
    const div = document.createElement('div');
    div.className = 'symbol-item' + (i === symbolSelectedIdx ? ' selected' : '');
    const icon = document.createElement('span');
    icon.className = 'symbol-icon ' + symbolKindClass(sym.kind);
    icon.textContent = symbolKindLetter(sym.kind);
    div.appendChild(icon);
    const name = document.createElement('span');
    name.className = 'symbol-name';
    name.textContent = sym.name;
    div.appendChild(name);
    if (sym.detail) { const detail = document.createElement('span'); detail.className = 'symbol-detail'; detail.textContent = sym.detail; div.appendChild(detail); }
    div.addEventListener('click', async () => {
      closeSymbolOutline();
      // If the symbol has a uri pointing to a different file, open it first.
      if (sym.uri) {
        let targetPath = sym.uri;
        if (targetPath.startsWith('file:///')) targetPath = targetPath.slice(8);
        else if (targetPath.startsWith('file://')) targetPath = targetPath.slice(7);
        if (targetPath !== activeBufferPath) {
          try { await openFileFromExplorer(targetPath); } catch { /* ignore */ }
        }
      }
      cursorLine = sym.line;
      cursorCol = sym.col;
      clearSelection();
      ensureCursorVisible();
      requestRender();
      updateStatusBar();
    });
    symbolsList.appendChild(div);
  }
}

function symbolKindClass(kind) { const map = { 5: 'symbol-icon-method', 11: 'symbol-icon-function', 4: 'symbol-icon-class', 10: 'symbol-icon-interface', 12: 'symbol-icon-variable', 6: 'symbol-icon-property', 13: 'symbol-icon-constant', 9: 'symbol-icon-enum', 1: 'symbol-icon-module' }; return map[kind] || 'symbol-icon-variable'; }
function symbolKindLetter(kind) { const map = { 5: 'M', 11: 'F', 4: 'C', 10: 'I', 12: 'V', 6: 'P', 13: 'K', 9: 'E', 1: 'M' }; return map[kind] || 'S'; }
function closeSymbolOutline() { symbolsOpen = false; symbolsPalette.classList.add('palette-hidden'); editorEl.focus(); }

symbolsInput.addEventListener('input', () => {
  const val = symbolsInput.value;
  symbolSelectedIdx = 0;
  if (val.startsWith('#')) {
    // Workspace symbol mode — debounce WASM query
    clearTimeout(wsSymbolDebounce);
    wsSymbolDebounce = setTimeout(() => searchWorkspaceSymbols(val.slice(1).trim()), 200);
  } else {
    // Document symbol mode — filter immediately
    renderSymbolList(val);
  }
});
symbolsInput.addEventListener('keydown', (e) => {
  const total = symbolsList.children.length;
  if (e.key === 'ArrowDown') { e.preventDefault(); symbolSelectedIdx = Math.min(symbolSelectedIdx + 1, total - 1); updateSymbolSelection(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); symbolSelectedIdx = Math.max(symbolSelectedIdx - 1, 0); updateSymbolSelection(); }
  else if (e.key === 'Enter') { e.preventDefault(); const items = symbolsList.querySelectorAll('.symbol-item'); if (items[symbolSelectedIdx]) items[symbolSelectedIdx].click(); }
  else if (e.key === 'Escape') closeSymbolOutline();
});
symbolsBackdrop.addEventListener('click', closeSymbolOutline);

function updateSymbolSelection() {
  const items = symbolsList.querySelectorAll('.symbol-item');
  items.forEach((el, i) => el.classList.toggle('selected', i === symbolSelectedIdx));
  if (items[symbolSelectedIdx]) items[symbolSelectedIdx].scrollIntoView({ block: 'nearest' });
}

// --- Workspace Symbols (Ctrl+T) ---

let wsSymbolDebounce = null;

async function openWorkspaceSymbolSearch() {
  symbolItems = [];
  symbolSelectedIdx = 0;
  symbolsOpen = true;
  renderSymbolList('');
  symbolsPalette.classList.remove('palette-hidden');
  symbolsInput.value = '#';
  symbolsInput.focus();
}

async function searchWorkspaceSymbols(query) {
  if (!query) { symbolItems = []; renderSymbolList(''); return; }
  const langHint = detectLanguage(filePath || '');
  try {
    const result = await invoke('lang_workspace_symbols', { query, langHint }).catch(() => []);
    const items = (result || []).map(s => ({
      name: s.container_name ? `${s.container_name}.${s.name}` : (s.containerName ? `${s.containerName}.${s.name}` : s.name),
      detail: s.location?.uri || '',
      kind: s.kind,
      line: s.location?.range?.start?.line ?? 0,
      col: s.location?.range?.start?.character ?? 0,
      uri: s.location?.uri,
    }));
    symbolItems = items;
    symbolSelectedIdx = 0;
    renderSymbolList('');
  } catch { /* ignore */ }
}

// --- Formatting ---

async function formatDocument() {
  const uri = getActiveUri();
  if (!uri) return;
  try {
    statusEl.textContent = 'Formatting...';
    const fullText = await invoke('get_text_range', {
      startLine: 0, startCol: 0, endLine: totalLines, endCol: 0,
    }).catch(() => '');
    const result = await invoke('lang_format_document', {
      uri, content: fullText, tabSize: 2, insertSpaces: true,
    }).catch(() => []);
    if (result && Array.isArray(result) && result.length > 0) {
      const edits = result.slice().sort((a, b) => {
        if (b.range.start.line !== a.range.start.line) return b.range.start.line - a.range.start.line;
        return b.range.start.character - a.range.start.character;
      });
      for (const edit of edits) {
        await invoke('edit_replace_range', {
          startLine: edit.range.start.line, startCol: edit.range.start.character,
          endLine: edit.range.end.line, endCol: edit.range.end.character, text: edit.newText || edit['new-text'] || edit.new_text || '',
        });
      }
      await fetchVisibleContent();
      updateMetadataUI();
      requestRender();
      statusEl.textContent = 'Formatted';
    } else {
      statusEl.textContent = 'No formatting changes';
    }
    setTimeout(() => { statusEl.textContent = ''; }, 2000);
  } catch {
    statusEl.textContent = 'Formatting unavailable';
    setTimeout(() => { statusEl.textContent = ''; }, 2000);
  }
}

// --- Format Selection ---

async function formatSelection() {
  const uri = getActiveUri();
  if (!uri) return;
  const sel = getSelectionRange();
  if (!sel) { formatDocument(); return; } // No selection — fall back to full format
  try {
    statusEl.textContent = 'Formatting selection...';
    const fullText = await invoke('get_text_range', {
      startLine: 0, startCol: 0, endLine: totalLines, endCol: 0,
    }).catch(() => '');
    const result = await invoke('lang_format_range', {
      uri, content: fullText,
      startLine: sel.startLine, startCharacter: sel.startCol,
      endLine: sel.endLine, endCharacter: sel.endCol,
      tabSize: 2, insertSpaces: true,
    }).catch(() => []);
    if (result && Array.isArray(result) && result.length > 0) {
      const edits = result.slice().sort((a, b) => {
        if (b.range.start.line !== a.range.start.line) return b.range.start.line - a.range.start.line;
        return b.range.start.character - a.range.start.character;
      });
      for (const edit of edits) {
        await invoke('edit_replace_range', {
          startLine: edit.range.start.line, startCol: edit.range.start.character,
          endLine: edit.range.end.line, endCol: edit.range.end.character,
          text: edit.newText || edit['new-text'] || edit.new_text || '',
        });
      }
      await fetchVisibleContent();
      updateMetadataUI();
      requestRender();
      statusEl.textContent = 'Selection formatted';
    } else {
      statusEl.textContent = 'No formatting changes';
    }
    setTimeout(() => { statusEl.textContent = ''; }, 2000);
  } catch {
    statusEl.textContent = 'Format selection unavailable';
    setTimeout(() => { statusEl.textContent = ''; }, 2000);
  }
}

// --- Code Folding ---

// Precomputed lookup arrays — rebuilt by recomputeFoldedLines().
// _d2b[displayLine] = bufferLine; _b2d[bufferLine] = displayLine (-1 if folded).
let _d2b = [];
let _b2d = [];

function recomputeFoldedLines() {
  foldedLineSet.clear();
  for (const range of foldingRanges) {
    if (collapsedFolds.has(range.startLine)) {
      for (let l = range.startLine + 1; l <= range.endLine; l++) {
        foldedLineSet.add(l);
      }
    }
  }
  // Rebuild lookup arrays
  _d2b = [];
  _b2d = new Array(totalLines);
  for (let buf = 0; buf < totalLines; buf++) {
    if (foldedLineSet.has(buf)) {
      _b2d[buf] = -1;
    } else {
      _b2d[buf] = _d2b.length;
      _d2b.push(buf);
    }
  }
}

function getEffectiveLineCount() {
  return foldedLineSet.size > 0 ? _d2b.length : totalLines;
}

function displayToBuffer(displayLine) {
  if (_d2b.length === 0) return displayLine;
  if (displayLine < 0) return 0;
  if (displayLine >= _d2b.length) return totalLines - 1;
  return _d2b[displayLine];
}

function bufferToDisplay(bufferLine) {
  if (_b2d.length === 0) return bufferLine;
  if (bufferLine < 0 || bufferLine >= _b2d.length) return -1;
  return _b2d[bufferLine];
}

function getFoldRangeAtLine(line) {
  return foldingRanges.find(r => r.startLine === line) || null;
}

function getFoldRangeContaining(line) {
  return foldingRanges.find(r => r.startLine <= line && r.endLine >= line) || null;
}

function toggleFoldAtLine(line) {
  const range = getFoldRangeAtLine(line);
  if (!range) return;
  if (collapsedFolds.has(line)) {
    collapsedFolds.delete(line);
  } else {
    collapsedFolds.add(line);
  }
  recomputeFoldedLines();
  updateScrollSizer();
  requestRender();
}

function foldAtCursor() {
  const range = getFoldRangeAtLine(cursorLine) || getFoldRangeContaining(cursorLine);
  if (!range) return;
  collapsedFolds.add(range.startLine);
  // Move cursor out of folded region if needed
  if (cursorLine > range.startLine && cursorLine <= range.endLine) {
    cursorLine = range.startLine;
    cursorCol = 0;
  }
  recomputeFoldedLines();
  updateScrollSizer();
  requestRender();
}

function unfoldAtCursor() {
  // If cursor is on a fold start line, unfold it
  if (collapsedFolds.has(cursorLine)) {
    collapsedFolds.delete(cursorLine);
    recomputeFoldedLines();
    updateScrollSizer();
    requestRender();
    return;
  }
  // If cursor is inside a folded range (shouldn't normally happen), unfold containing range
  for (const range of foldingRanges) {
    if (collapsedFolds.has(range.startLine) && cursorLine >= range.startLine && cursorLine <= range.endLine) {
      collapsedFolds.delete(range.startLine);
      recomputeFoldedLines();
      updateScrollSizer();
      requestRender();
      return;
    }
  }
}

async function fetchFoldingRanges() {
  if (!filePath) return;
  const uri = getActiveUri();
  if (!uri) return;
  try {
    const fullText = await invoke('get_text_range', {
      startLine: 0, startCol: 0, endLine: totalLines, endCol: 0,
    }).catch(() => '');
    const result = await invoke('lang_folding_ranges', { uri, content: fullText }).catch(() => []);
    foldingRanges = (result || []).map(r => ({
      startLine: r.start_line ?? r.startLine ?? 0,
      endLine: r.end_line ?? r.endLine ?? 0,
      kind: r.kind ?? null,
    })).filter(r => r.endLine > r.startLine);
    // Prune collapsed folds that no longer have valid ranges
    const validStarts = new Set(foldingRanges.map(r => r.startLine));
    for (const s of collapsedFolds) {
      if (!validStarts.has(s)) collapsedFolds.delete(s);
    }
    recomputeFoldedLines();
    requestRender();
  } catch { /* ignore */ }
}

// --- Global close ---

function closeLspPopups() {
  if (acOpen) closeAutocomplete();
  if (hoverOpen) closeHover();
  if (sigHelpOpen) closeSignatureHelp();
  if (codeActionsOpen) closeCodeActions();
  if (refsOpen) closeReferences();
  if (symbolsOpen) closeSymbolOutline();
}

document.addEventListener('click', (e) => {
  if (acOpen && !autocompletePopup.contains(e.target) && e.target !== editorEl) closeAutocomplete();
  if (codeActionsOpen && !codeActionsMenu.contains(e.target)) closeCodeActions();
});

// ─── M8: Activity Bar & Panel Switching ───────────────────────

let activePanel = 'none'; // 'explorer' | 'scm' | 'extensions' | 'settings' | 'debug' | 'none'
const activityBar = document.getElementById('activity-bar');
const extensionsPanel = document.getElementById('extensions-panel');
const settingsPanel = document.getElementById('settings-panel');
const debugPanel = document.getElementById('debug-panel');
const treeviewsPanel = document.getElementById('treeviews-panel');
const scmPanelEl = document.getElementById('scm-panel');
const treeviewsContainer = document.getElementById('treeviews-container');
const treeviewsEmpty = document.getElementById('treeviews-empty');
const extSearchInput = document.getElementById('ext-search-input');
const extListEl = document.getElementById('ext-list');
const settingsSearchInput = document.getElementById('settings-search-input');
const settingsListEl = document.getElementById('settings-list');

// Activity bar panel switching
function switchPanel(panel) {
  // Hide all panels
  sidebarEl.classList.add('sidebar-hidden');
  scmPanelEl?.classList.add('sidebar-hidden');
  extensionsPanel.classList.add('sidebar-hidden');
  settingsPanel.classList.add('sidebar-hidden');
  debugPanel?.classList.add('sidebar-hidden');
  treeviewsPanel?.classList.add('sidebar-hidden');

  // Update active button
  activityBar.querySelectorAll('.activity-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.panel === panel);
  });

  if (activePanel === panel) {
    // Toggle off
    activePanel = 'none';
    sidebarOpen = false;
  } else {
    activePanel = panel;
    sidebarOpen = true;
    if (panel === 'explorer') {
      sidebarEl.classList.remove('sidebar-hidden');
      if (!explorerRoot) openFolderDialog();
    } else if (panel === 'scm') {
      scmPanelEl?.classList.remove('sidebar-hidden');
      renderScmPanel();
    } else if (panel === 'extensions') {
      extensionsPanel.classList.remove('sidebar-hidden');
      extSearchInput.focus();
      loadInstalledExtensions();
    } else if (panel === 'settings') {
      settingsPanel.classList.remove('sidebar-hidden');
      settingsSearchInput.focus();
      loadSettings();
    } else if (panel === 'debug') {
      debugPanel?.classList.remove('sidebar-hidden');
      renderBreakpointsList();
    } else if (panel === 'treeviews') {
      treeviewsPanel?.classList.remove('sidebar-hidden');
    }
  }

  if (activePanel === 'none') {
    activityBar.querySelectorAll('.activity-btn').forEach(btn => btn.classList.remove('active'));
  }

  setTimeout(() => { resizeCanvases(); requestRender(); }, 50);
}

activityBar.addEventListener('click', (e) => {
  const btn = e.target.closest('.activity-btn');
  if (btn) switchPanel(btn.dataset.panel);
});

// Close buttons for all panels
document.getElementById('scm-panel-close')?.addEventListener('click', () => switchPanel('scm'));
document.getElementById('ext-panel-close')?.addEventListener('click', () => switchPanel('extensions'));
document.getElementById('settings-panel-close')?.addEventListener('click', () => switchPanel('settings'));
document.getElementById('debug-panel-close')?.addEventListener('click', () => switchPanel('debug'));
document.getElementById('treeviews-panel-close')?.addEventListener('click', () => switchPanel('treeviews'));

// Extension tabs (Marketplace / Installed)
let extActiveTab = 'marketplace';
document.getElementById('ext-tabs')?.addEventListener('click', (e) => {
  const tab = e.target.closest('.ext-tab');
  if (!tab) return;
  extActiveTab = tab.dataset.tab;
  document.querySelectorAll('.ext-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === extActiveTab));
  if (extActiveTab === 'marketplace') {
    searchExtensions(extSearchInput.value);
  } else {
    loadInstalledExtensions();
  }
});

// ─── M8: Extension Marketplace ────────────────────────────────

let marketplaceResults = [];
let installedExtensions = [];
let extSearchDebounce = null;

extSearchInput?.addEventListener('input', () => {
  clearTimeout(extSearchDebounce);
  extSearchDebounce = setTimeout(() => {
    if (extActiveTab === 'marketplace') {
      searchExtensions(extSearchInput.value);
    } else {
      filterInstalledExtensions(extSearchInput.value);
    }
  }, 300);
});

async function searchExtensions(query) {
  if (!query || query.length < 2) {
    extListEl.innerHTML = '';
    return;
  }
  try {
    const result = await invoke('marketplace_search', { query, offset: 0, limit: 20 });
    marketplaceResults = result.extensions || [];
    renderExtensionList(marketplaceResults, 'marketplace');
  } catch (err) {
    console.error('Marketplace search error:', err);
    extListEl.textContent = 'Search failed';
  }
}

async function loadInstalledExtensions() {
  try {
    installedExtensions = await invoke('marketplace_list_installed');
    renderExtensionList(installedExtensions, 'installed');
  } catch (err) {
    console.error('Failed to load installed extensions:', err);
  }
}

function filterInstalledExtensions(query) {
  const q = query.toLowerCase();
  const filtered = q
    ? installedExtensions.filter(e =>
        (e.name || '').toLowerCase().includes(q) ||
        (e.display_name || '').toLowerCase().includes(q) ||
        (e.namespace || '').toLowerCase().includes(q)
      )
    : installedExtensions;
  renderExtensionList(filtered, 'installed');
}

function renderExtensionList(extensions, mode) {
  extListEl.innerHTML = '';
  if (extensions.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'padding: 16px 12px; color: var(--fg-dim); font-size: 12px; text-align: center;';
    empty.textContent = mode === 'marketplace' ? 'Type to search extensions...' : 'No extensions installed';
    extListEl.appendChild(empty);
    return;
  }

  const installedIds = new Set(installedExtensions.map(e => e.id));

  for (const ext of extensions) {
    const card = document.createElement('div');
    card.className = 'ext-card';

    const header = document.createElement('div');
    header.className = 'ext-card-header';

    const icon = document.createElement('div');
    icon.className = 'ext-card-icon';
    icon.textContent = (ext.display_name || ext.name || '?')[0].toUpperCase();

    const info = document.createElement('div');
    info.className = 'ext-card-info';

    const name = document.createElement('div');
    name.className = 'ext-card-name';
    name.textContent = ext.display_name || ext.name;

    const publisher = document.createElement('div');
    publisher.className = 'ext-card-publisher';
    publisher.textContent = ext.namespace || ext.publisher_name || '';

    info.appendChild(name);
    info.appendChild(publisher);
    header.appendChild(icon);
    header.appendChild(info);
    card.appendChild(header);

    if (ext.description) {
      const desc = document.createElement('div');
      desc.className = 'ext-card-desc';
      desc.textContent = ext.description;
      card.appendChild(desc);
    }

    const actions = document.createElement('div');
    actions.className = 'ext-card-actions';

    if (mode === 'marketplace') {
      const extId = `${ext.namespace}.${ext.name}`;
      const isInstalled = installedIds.has(extId);

      if (!isInstalled) {
        const installBtn = document.createElement('button');
        installBtn.className = 'ext-install-btn';
        installBtn.textContent = 'Install';
        installBtn.addEventListener('click', async () => {
          installBtn.disabled = true;
          installBtn.textContent = 'Installing...';
          try {
            // Download URL is now derived server-side from the Open VSX API
            await invoke('install_extension', {
              namespace: ext.namespace,
              name: ext.name,
            });
            installBtn.textContent = 'Installed';
            installedExtensions = await invoke('marketplace_list_installed');
          } catch (err) {
            console.error('Install failed:', err);
            installBtn.textContent = 'Failed';
            installBtn.disabled = false;
          }
        });
        actions.appendChild(installBtn);
      } else {
        const installed = document.createElement('span');
        installed.style.cssText = 'font-size: 11px; color: var(--accent);';
        installed.textContent = 'Installed';
        actions.appendChild(installed);
      }

      if (ext.download_count != null) {
        const dl = document.createElement('span');
        dl.className = 'ext-downloads';
        dl.textContent = formatCount(ext.download_count) + ' downloads';
        actions.appendChild(dl);
      }
    } else {
      // Installed mode
      const uninstallBtn = document.createElement('button');
      uninstallBtn.className = 'ext-uninstall-btn';
      uninstallBtn.textContent = 'Uninstall';
      uninstallBtn.addEventListener('click', async () => {
        uninstallBtn.disabled = true;
        uninstallBtn.textContent = 'Removing...';
        try {
          await invoke('uninstall_extension', { extensionId: ext.id });
          installedExtensions = await invoke('marketplace_list_installed');
          renderExtensionList(installedExtensions, 'installed');
        } catch (err) {
          console.error('Uninstall failed:', err);
          uninstallBtn.textContent = 'Failed';
          uninstallBtn.disabled = false;
        }
      });
      actions.appendChild(uninstallBtn);

      const version = document.createElement('span');
      version.className = 'ext-downloads';
      version.textContent = 'v' + (ext.version || '?');
      actions.appendChild(version);
    }

    card.appendChild(actions);
    extListEl.appendChild(card);
  }
}

function formatCount(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

// ─── M8: Settings UI ──────────────────────────────────────────

let allSettings = {};
let settingDefinitions = [];

async function loadSettings() {
  try {
    allSettings = await invoke('get_settings');
    renderSettings();
  } catch (err) {
    console.error('Failed to load settings:', err);
  }
}

function getNestedValue(obj, dottedKey) {
  const parts = dottedKey.split('.');
  let current = obj;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = current[part];
  }
  return current;
}

function renderSettings() {
  settingsListEl.innerHTML = '';
  const filter = (settingsSearchInput?.value || '').toLowerCase();

  // Flatten settings object for display
  const entries = flattenSettings(allSettings);

  for (const [key, value] of entries) {
    if (filter && !key.toLowerCase().includes(filter)) continue;

    const item = document.createElement('div');
    item.className = 'setting-item';

    const keyEl = document.createElement('div');
    keyEl.className = 'setting-key';
    keyEl.textContent = key;
    item.appendChild(keyEl);

    const control = document.createElement('div');
    control.className = 'setting-control';

    if (typeof value === 'boolean') {
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = value;
      checkbox.addEventListener('change', () => {
        updateSetting(key, checkbox.checked);
      });
      control.appendChild(checkbox);
      const label = document.createElement('span');
      label.textContent = value ? 'Enabled' : 'Disabled';
      label.style.cssText = 'font-size: 12px; color: var(--fg-dim);';
      control.appendChild(label);
    } else if (typeof value === 'number') {
      const input = document.createElement('input');
      input.type = 'number';
      input.value = value;
      input.addEventListener('change', () => {
        updateSetting(key, Number(input.value));
      });
      control.appendChild(input);
    } else if (typeof value === 'string') {
      const input = document.createElement('input');
      input.type = 'text';
      input.value = value;
      input.addEventListener('change', () => {
        updateSetting(key, input.value);
      });
      control.appendChild(input);
    } else {
      const display = document.createElement('span');
      display.style.cssText = 'font-size: 12px; color: var(--fg-dim);';
      display.textContent = JSON.stringify(value);
      control.appendChild(display);
    }

    item.appendChild(control);
    settingsListEl.appendChild(item);
  }

  if (settingsListEl.children.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'padding: 16px 12px; color: var(--fg-dim); font-size: 12px; text-align: center;';
    empty.textContent = 'No settings configured yet';
    settingsListEl.appendChild(empty);
  }
}

function flattenSettings(obj, prefix = '') {
  const entries = [];
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value != null && typeof value === 'object' && !Array.isArray(value)) {
      entries.push(...flattenSettings(value, fullKey));
    } else {
      entries.push([fullKey, value]);
    }
  }
  return entries;
}

async function updateSetting(key, value) {
  try {
    await invoke('update_setting', { key, value });
    // Update local cache
    const parts = key.split('.');
    let current = allSettings;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!current[parts[i]] || typeof current[parts[i]] !== 'object') {
        current[parts[i]] = {};
      }
      current = current[parts[i]];
    }
    current[parts[parts.length - 1]] = value;
  } catch (err) {
    console.error('Failed to update setting:', err);
  }
}

settingsSearchInput?.addEventListener('input', () => {
  renderSettings();
});

// ─── M8: Updated Sidebar Toggle ───────────────────────────────

// Override the original toggleSidebar to use the activity bar
toggleSidebar = function() {
  if (activePanel === 'explorer') {
    switchPanel('explorer'); // toggle off
  } else {
    switchPanel('explorer');
  }
};

// ─── DAP Debug UI ────────────────────────────────────────────

// Breakpoints: Map<filePath, Set<lineNumber (0-based)>>
const breakpoints = new Map();

// Current debug session state
let debugSessionId = null;
let debugStopped = false;
let debugCallStack = [];
let debugConsoleLines = [];

const debugCallStackEl = document.getElementById('debug-callstack');
const debugVariablesEl = document.getElementById('debug-variables');
const debugBpListEl = document.getElementById('debug-breakpoints-list');
const debugConsoleContentEl = document.getElementById('debug-console-content');

// Toggle a breakpoint on a given file + line (0-based)
function toggleBreakpoint(fp, line) {
  if (!fp) return;
  if (!breakpoints.has(fp)) breakpoints.set(fp, new Set());
  const set = breakpoints.get(fp);
  if (set.has(line)) {
    set.delete(line);
  } else {
    set.add(line);
  }
  requestRender(); // repaint gutter markers
  renderBreakpointsList();
}

function renderBreakpointsList() {
  if (!debugBpListEl) return;
  const items = [];
  for (const [fp, lines] of breakpoints) {
    for (const ln of lines) {
      items.push({ fp, ln });
    }
  }
  if (items.length === 0) {
    debugBpListEl.textContent = '';
    return;
  }
  for (const { fp, ln } of items) {
    const short = fp.split(/[\\/]/).pop();
    const entry = document.createElement('div');
    entry.className = 'debug-bp-entry';
    entry.dataset.file = fp;
    entry.dataset.line = ln;
    const bullet = document.createElement('span');
    bullet.style.color = '#f38ba8';
    bullet.textContent = '●';
    entry.appendChild(bullet);
    entry.appendChild(document.createTextNode(` ${short}:${ln + 1}`));
    entry.addEventListener('click', () => toggleBreakpoint(fp, ln));
    debugBpListEl.appendChild(entry);
  }
}

function appendDebugConsole(text, category) {
  debugConsoleLines.push({ text, category });
  if (!debugConsoleContentEl) return;
  const line = document.createElement('div');
  line.className = `debug-console-line ${category || 'info'}`;
  line.textContent = text;
  debugConsoleContentEl.appendChild(line);
  // Auto-scroll
  debugConsoleContentEl.scrollTop = debugConsoleContentEl.scrollHeight;
}

function renderCallStack(frames) {
  if (!debugCallStackEl) return;
  if (!frames || frames.length === 0) {
    debugCallStackEl.textContent = '';
    return;
  }
  debugCallStackEl.innerHTML = frames.map((f, i) => `
    <div class="debug-frame ${i === 0 ? 'active-frame' : ''}" data-idx="${i}">
      ${escapeHtml(f.name || '(anonymous)')}
      <div class="frame-file">${escapeHtml((f.source?.path || f.source?.name || '').split(/[\\/]/).pop())}:${f.line ?? ''}</div>
    </div>
  `).join('');
}

function updateDebugToolbar(running) {
  const btnStart = document.getElementById('debug-btn-start');
  const btnContinue = document.getElementById('debug-btn-continue');
  const btnPause = document.getElementById('debug-btn-pause');
  const btnStepOver = document.getElementById('debug-btn-stepover');
  const btnStepIn = document.getElementById('debug-btn-stepin');
  const btnStepOut = document.getElementById('debug-btn-stepout');
  const btnRestart = document.getElementById('debug-btn-restart');
  const btnStop = document.getElementById('debug-btn-stop');

  if (running) {
    btnStart && btnStart.classList.add('debug-btn-hidden');
    btnStop && btnStop.classList.remove('debug-btn-hidden');
    btnRestart && btnRestart.classList.remove('debug-btn-hidden');
    if (debugStopped) {
      btnContinue && btnContinue.classList.remove('debug-btn-hidden');
      btnPause && btnPause.classList.add('debug-btn-hidden');
      btnStepOver && btnStepOver.classList.remove('debug-btn-hidden');
      btnStepIn && btnStepIn.classList.remove('debug-btn-hidden');
      btnStepOut && btnStepOut.classList.remove('debug-btn-hidden');
    } else {
      btnContinue && btnContinue.classList.add('debug-btn-hidden');
      btnPause && btnPause.classList.remove('debug-btn-hidden');
      btnStepOver && btnStepOver.classList.add('debug-btn-hidden');
      btnStepIn && btnStepIn.classList.add('debug-btn-hidden');
      btnStepOut && btnStepOut.classList.add('debug-btn-hidden');
    }
  } else {
    btnStart && btnStart.classList.remove('debug-btn-hidden');
    btnContinue && btnContinue.classList.add('debug-btn-hidden');
    btnPause && btnPause.classList.add('debug-btn-hidden');
    btnStepOver && btnStepOver.classList.add('debug-btn-hidden');
    btnStepIn && btnStepIn.classList.add('debug-btn-hidden');
    btnStepOut && btnStepOut.classList.add('debug-btn-hidden');
    btnRestart && btnRestart.classList.add('debug-btn-hidden');
    btnStop && btnStop.classList.add('debug-btn-hidden');
  }
}

// Process a batch of DAP events from the adapter
async function processDebugEvents(events) {
  for (const evt of events) {
    if (evt.type === 'event') {
      switch (evt.event) {
        case 'initialized':
          // Adapter is ready — send all breakpoints then configurationDone
          appendDebugConsole('[Debug] Adapter initialized', 'info');
          await sendBreakpointsToAdapter();
          await invoke('debug_send', { sessionId: debugSessionId, command: 'configurationDone', args: {} }).catch(() => {});
          break;
        case 'stopped': {
          debugStopped = true;
          updateDebugToolbar(true);
          appendDebugConsole(`[Debug] Stopped: ${evt.body?.reason || ''}`, 'info');
          // Fetch call stack
          try {
            const threadId = evt.body?.threadId ?? 1;
            await invoke('debug_send', { sessionId: debugSessionId, command: 'stackTrace', args: { threadId, startFrame: 0, levels: 20 } });
          } catch {}
          break;
        }
        case 'continued':
          debugStopped = false;
          debugCallStack = [];
          renderCallStack([]);
          updateDebugToolbar(true);
          break;
        case 'terminated':
        case 'exited':
          appendDebugConsole('[Debug] Session terminated', 'info');
          await invoke('debug_stop', { sessionId: debugSessionId }).catch(() => {});
          debugSessionId = null;
          debugStopped = false;
          debugCallStack = [];
          renderCallStack([]);
          if (debugVariablesEl) debugVariablesEl.textContent = '';
          updateDebugToolbar(false);
          requestRender();
          break;
        case 'output':
          if (evt.body?.output) {
            const category = evt.body.category === 'stderr' ? 'stderr' : (evt.body.category === 'stdout' ? 'stdout' : 'info');
            appendDebugConsole(evt.body.output.replace(/\n$/, ''), category);
          }
          break;
        default:
          break;
      }
    } else if (evt.type === 'response') {
      if (evt.command === 'stackTrace' && evt.success && evt.body?.stackFrames) {
        debugCallStack = evt.body.stackFrames;
        renderCallStack(debugCallStack);
        requestRender(); // repaint to show current line marker
        // Fetch scopes for first frame
        if (debugCallStack.length > 0) {
          await invoke('debug_send', { sessionId: debugSessionId, command: 'scopes', args: { frameId: debugCallStack[0].id } }).catch(() => {});
        }
      } else if (evt.command === 'scopes' && evt.success && evt.body?.scopes) {
        if (!debugVariablesEl) continue;
        // Fetch variables for first scope
        const firstScope = evt.body.scopes[0];
        if (firstScope) {
          await invoke('debug_send', { sessionId: debugSessionId, command: 'variables', args: { variablesReference: firstScope.variablesReference } }).catch(() => {});
        }
      } else if (evt.command === 'variables' && evt.success && evt.body?.variables) {
        if (!debugVariablesEl) continue;
        const vars = evt.body.variables.slice(0, 50);
        debugVariablesEl.innerHTML = vars.map(v =>
          `<div class="debug-var-entry"><span style="color:var(--accent)">${escapeHtml(v.name)}</span>: ${escapeHtml(String(v.value ?? ''))}</div>`
        ).join('');
      }
    }
  }
}

async function sendBreakpointsToAdapter() {
  if (!debugSessionId) return;
  // Group breakpoints by source file
  const fileGroups = new Map();
  for (const [fp, lines] of breakpoints) {
    fileGroups.set(fp, [...lines].map(ln => ({ line: ln + 1 })));
  }
  for (const [fp, bpLines] of fileGroups) {
    await invoke('debug_send', {
      sessionId: debugSessionId,
      command: 'setBreakpoints',
      args: { source: { path: fp }, breakpoints: bpLines },
    }).catch(() => {});
  }
}

// Start a new debug session (called when a debug/startSession request is received)
async function startDebugSession(req) {
  if (debugSessionId) {
    await invoke('debug_stop', { sessionId: debugSessionId }).catch(() => {});
  }
  debugSessionId = req.session_id;
  debugConsoleLines = [];
  if (debugConsoleContentEl) debugConsoleContentEl.innerHTML = '';
  debugStopped = false;
  debugCallStack = [];
  renderCallStack([]);
  updateDebugToolbar(true);

  try {
    await invoke('debug_start', {
      sessionId: req.session_id,
      adapterCmd: req.adapter_cmd,
      adapterArgs: req.adapter_args,
    });
  } catch (err) {
    appendDebugConsole(`[Debug] Failed to start adapter: ${err}`, 'stderr');
    debugSessionId = null;
    updateDebugToolbar(false);
    return;
  }

  appendDebugConsole(`[Debug] Adapter started: ${req.adapter_cmd}`, 'info');

  // Send initialize request
  await invoke('debug_send', {
    sessionId: debugSessionId,
    command: 'initialize',
    args: {
      clientID: 'corecode',
      clientName: 'CoreCode',
      adapterID: req.launch_config?.type ?? 'unknown',
      pathFormat: 'path',
      linesStartAt1: true,
      columnsStartAt1: true,
      supportsRunInTerminalRequest: false,
    },
  }).catch(err => appendDebugConsole(`[Debug] initialize error: ${err}`, 'stderr'));

  // Send launch or attach
  const request = String(req.launch_config?.request ?? 'launch');
  await invoke('debug_send', {
    sessionId: debugSessionId,
    command: request,
    args: req.launch_config ?? {},
  }).catch(err => appendDebugConsole(`[Debug] ${request} error: ${err}`, 'stderr'));
}

// Poll debug start requests and events
async function pollDebugStartRequests() {
  try {
    const requests = await invoke('get_debug_start_requests');
    for (const req of requests) {
      await startDebugSession(req);
    }
  } catch {}
}

async function pollDebugEvents() {
  if (!debugSessionId) return;
  try {
    const events = await invoke('debug_poll_events', { sessionId: debugSessionId });
    if (events && events.length > 0) {
      await processDebugEvents(events);
    }
  } catch {}
}

const debugStartInterval = setInterval(pollDebugStartRequests, 1000);
const debugEventsInterval = setInterval(pollDebugEvents, 200);

// ─── workspace.applyEdit polling ─────────────────────────────

async function pollWorkspaceEdits() {
  try {
    const requests = await invoke('get_workspace_edit_requests');
    for (const req of requests) {
      try {
        await invoke('apply_workspace_edit', { changes: req.changes });
        // Refresh visible content in case the active file was edited
        await fetchVisibleContent();
        requestRender();
      } catch (err) {
        console.error('[applyEdit] Failed:', err);
      }
    }
  } catch {}
}

const workspaceEditInterval = setInterval(pollWorkspaceEdits, 300);

// ─── window.showTextDocument ──────────────────────────────────

async function pollShowTextDocumentRequests() {
  try {
    const requests = await invoke('get_show_text_document_requests');
    for (const req of requests) {
      try {
        const uri = req.uri;
        // Convert URI to file path
        let filePath2 = uri;
        if (filePath2.startsWith('file:///')) filePath2 = filePath2.slice(8).replace(/\//g, '\\');
        else if (filePath2.startsWith('file://')) filePath2 = filePath2.slice(7);
        filePath2 = decodeURIComponent(filePath2);
        // On Windows, lowercase the drive letter
        if (filePath2.match(/^[a-zA-Z]:\\/)) filePath2 = filePath2[0].toUpperCase() + filePath2.slice(1);
        saveBufferState();
        const content = await invoke('open_file', { path: filePath2 });
        activeBufferPath = content.file_path;
        if (!bufferStates.has(activeBufferPath)) {
          cursorLine = 0;
          cursorCol = 0;
          clearSelection();
        } else {
          restoreBufferState(activeBufferPath);
        }
        // Jump to selection if provided
        if (req.selection) {
          cursorLine = req.selection.start_line;
          cursorCol = req.selection.start_character;
          selAnchorLine = req.selection.start_line;
          selAnchorCol = req.selection.start_character;
          // Extend selection to end pos if not same point
          if (req.selection.start_line !== req.selection.end_line || req.selection.start_character !== req.selection.end_character) {
            cursorLine = req.selection.end_line;
            cursorCol = req.selection.end_character;
          }
        }
        await updateFromEditorContent(content);
        renderTabs();
        ensureCursorVisible();
        requestRender();
      } catch (err) {
        console.error('[showTextDocument] Failed to open:', err);
      }
    }
  } catch {}
}

const showTextDocumentInterval = setInterval(pollShowTextDocumentRequests, 300);

// ─── Extension Tree Views ─────────────────────────────────────

const registeredTreeViews = new Map(); // viewId -> { collapsed: bool }
const treeViewExpandedItems = new Map(); // viewId -> Set<itemId>

function renderTreeView(viewId, items, parentEl, depth = 0) {
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'tv-item';
    row.style.paddingLeft = `${6 + depth * 14}px`;

    const toggleEl = document.createElement('span');
    toggleEl.className = 'tv-toggle';
    const canExpand = item.collapsible_state === 1 || item.collapsible_state === 2;
    const expanded = treeViewExpandedItems.get(viewId)?.has(item.id);
    toggleEl.textContent = canExpand ? (expanded ? '▾' : '▸') : ' ';
    row.appendChild(toggleEl);

    const labelEl = document.createElement('span');
    labelEl.className = 'tv-label';
    labelEl.textContent = item.label;
    row.appendChild(labelEl);

    if (item.description) {
      const descEl = document.createElement('span');
      descEl.className = 'tv-description';
      descEl.textContent = item.description;
      row.appendChild(descEl);
    }

    const childrenEl = document.createElement('div');
    childrenEl.className = 'tv-children';

    row.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (canExpand) {
        const expSet = treeViewExpandedItems.get(viewId) ?? new Set();
        treeViewExpandedItems.set(viewId, expSet);
        if (expSet.has(item.id)) {
          expSet.delete(item.id);
          childrenEl.innerHTML = '';
          toggleEl.textContent = '▸';
        } else {
          expSet.add(item.id);
          toggleEl.textContent = '▾';
          try {
            const children = await invoke('tree_view_get_children', { viewId, itemId: item.id });
            childrenEl.innerHTML = '';
            if (Array.isArray(children) && children.length > 0) {
              renderTreeView(viewId, children, childrenEl, depth + 1);
            }
          } catch (err) { console.error('[TreeView] getChildren error:', err); }
        }
      }
      if (item.command) {
        invoke('execute_command', { command: item.command.command, args: item.command.args ?? [] }).catch(() => {});
      }
    });

    parentEl.appendChild(row);
    if (canExpand && expanded) parentEl.appendChild(childrenEl);
    else if (canExpand) parentEl.appendChild(childrenEl);
  }
}

async function loadTreeView(viewId) {
  const viewEl = document.getElementById(`tv-view-${CSS.escape(viewId)}`);
  if (!viewEl) return;
  const body = viewEl.querySelector('.tv-view-body');
  if (!body) return;
  try {
    const items = await invoke('tree_view_get_children', { viewId, itemId: null });
    body.innerHTML = '';
    if (Array.isArray(items) && items.length > 0) {
      renderTreeView(viewId, items, body, 0);
    } else {
      body.innerHTML = '<div style="padding:4px 8px;color:#888;font-size:12px;">No items.</div>';
    }
  } catch (err) { console.error('[TreeView] loadTreeView error:', err); }
}

function registerTreeViewUI(viewId) {
  if (document.getElementById(`tv-view-${CSS.escape(viewId)}`)) return; // already exists
  treeviewsEmpty.style.display = 'none';
  const viewEl = document.createElement('div');
  viewEl.className = 'tv-view';
  viewEl.id = `tv-view-${CSS.escape(viewId)}`;
  const headerEl = document.createElement('div');
  headerEl.className = 'tv-view-header';
  headerEl.innerHTML = `<span>▾</span><span>${escapeHtml(viewId)}</span>`;
  const bodyEl = document.createElement('div');
  bodyEl.className = 'tv-view-body';
  bodyEl.innerHTML = '<div style="padding:4px 8px;color:#888;font-size:12px;">Loading...</div>';
  headerEl.addEventListener('click', () => {
    const collapsed = registeredTreeViews.get(viewId)?.collapsed ?? false;
    registeredTreeViews.set(viewId, { collapsed: !collapsed });
    bodyEl.style.display = collapsed ? '' : 'none';
    headerEl.querySelector('span').textContent = collapsed ? '▾' : '▸';
  });
  viewEl.appendChild(headerEl);
  viewEl.appendChild(bodyEl);
  treeviewsContainer.appendChild(viewEl);
  registeredTreeViews.set(viewId, { collapsed: false });
  loadTreeView(viewId);
}

async function pollTreeViewEvents() {
  if (!isPageVisible()) return;
  try {
    const events = await invoke('get_tree_view_events');
    for (const evt of events) {
      if (evt.event_type === 'register') {
        registerTreeViewUI(evt.view_id);
      } else if (evt.event_type === 'update') {
        // Clear cached elements and reload
        treeViewExpandedItems.delete(evt.view_id);
        loadTreeView(evt.view_id);
      } else if (evt.event_type === 'unregister') {
        const viewEl = document.getElementById(`tv-view-${CSS.escape(evt.view_id)}`);
        if (viewEl) viewEl.remove();
        registeredTreeViews.delete(evt.view_id);
        if (registeredTreeViews.size === 0) treeviewsEmpty.style.display = '';
      }
    }
  } catch {}
}

const treeViewEventsInterval = setInterval(pollTreeViewEvents, 500);

// Gutter click — toggle breakpoint, or show comment thread when clicking the indicator bar
document.getElementById('gutter')?.addEventListener('click', (e) => {
  if (!filePath) return;
  const rect = gutterCanvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const { first } = getVisibleLineRange();
  const scrollTop = editorEl.scrollTop;
  const subPixelOffset = -(scrollTop % lineHeight);
  const displayLine = first + Math.floor((y - subPixelOffset) / lineHeight);
  const lineIdx = foldedLineSet.size > 0 ? displayToBuffer(displayLine) : displayLine;
  if (lineIdx >= 0 && lineIdx < totalLines) {
    // Right 10px of gutter = fold indicator / comment zone
    if (x >= rect.width - 10) {
      // Check fold toggle first
      if (getFoldRangeAtLine(lineIdx)) { toggleFoldAtLine(lineIdx); return; }
      const thread = commentThreads.find(t => t.start_line === lineIdx);
      if (thread) { showCommentPopup(thread, e.clientX, e.clientY); return; }
    }
    toggleBreakpoint(filePath, lineIdx);
  }
});

// Debug toolbar button handlers
document.getElementById('debug-btn-start')?.addEventListener('click', () => {
  invoke('execute_command', { command: 'workbench.action.debug.start', args: [] }).catch(() => {});
});
document.getElementById('debug-btn-continue')?.addEventListener('click', async () => {
  if (debugSessionId) await invoke('debug_send', { sessionId: debugSessionId, command: 'continue', args: { threadId: 1 } }).catch(() => {});
});
document.getElementById('debug-btn-pause')?.addEventListener('click', async () => {
  if (debugSessionId) await invoke('debug_send', { sessionId: debugSessionId, command: 'pause', args: { threadId: 1 } }).catch(() => {});
});
document.getElementById('debug-btn-stepover')?.addEventListener('click', async () => {
  if (debugSessionId) await invoke('debug_send', { sessionId: debugSessionId, command: 'next', args: { threadId: 1 } }).catch(() => {});
});
document.getElementById('debug-btn-stepin')?.addEventListener('click', async () => {
  if (debugSessionId) await invoke('debug_send', { sessionId: debugSessionId, command: 'stepIn', args: { threadId: 1 } }).catch(() => {});
});
document.getElementById('debug-btn-stepout')?.addEventListener('click', async () => {
  if (debugSessionId) await invoke('debug_send', { sessionId: debugSessionId, command: 'stepOut', args: { threadId: 1 } }).catch(() => {});
});
document.getElementById('debug-btn-stop')?.addEventListener('click', async () => {
  if (debugSessionId) {
    await invoke('debug_send', { sessionId: debugSessionId, command: 'terminate', args: {} }).catch(() => {});
    setTimeout(async () => {
      await invoke('debug_stop', { sessionId: debugSessionId }).catch(() => {});
      debugSessionId = null;
      updateDebugToolbar(false);
      requestRender();
    }, 500);
  }
});
document.getElementById('debug-btn-restart')?.addEventListener('click', async () => {
  if (debugSessionId) await invoke('debug_send', { sessionId: debugSessionId, command: 'restart', args: {} }).catch(() => {});
});

// Debug console bottom tab — handled by switchBottomTab via the bottomPanelTabs forEach listener.

// ─── M8: Keyboard Shortcuts ───────────────────────────────────

// Add Ctrl+Shift+X for extensions, Ctrl+, for settings, debug shortcuts
const _origKeydown = document.onkeydown;
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'g') {
    e.preventDefault();
    switchPanel('scm');
    return;
  }
  if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'x') {
    e.preventDefault();
    switchPanel('extensions');
    return;
  }
  if (e.ctrlKey && !e.shiftKey && e.key === ',') {
    e.preventDefault();
    switchPanel('settings');
    return;
  }
  if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'd') {
    e.preventDefault();
    switchPanel('debug');
    return;
  }
  // F5 — Start or Continue
  if (e.key === 'F5' && !e.ctrlKey && !e.shiftKey) {
    e.preventDefault();
    if (debugSessionId && debugStopped) {
      invoke('debug_send', { sessionId: debugSessionId, command: 'continue', args: { threadId: 1 } }).catch(() => {});
    } else if (!debugSessionId) {
      invoke('execute_command', { command: 'workbench.action.debug.start', args: [] }).catch(() => {});
    }
    return;
  }
  // Shift+F5 — Stop
  if (e.key === 'F5' && e.shiftKey) {
    e.preventDefault();
    if (debugSessionId) {
      invoke('debug_send', { sessionId: debugSessionId, command: 'terminate', args: {} }).catch(() => {});
    }
    return;
  }
  // F9 — Toggle breakpoint on current line
  if (e.key === 'F9') {
    e.preventDefault();
    if (filePath !== null) toggleBreakpoint(filePath, cursorLine);
    return;
  }
  // F10 — Step over
  if (e.key === 'F10') {
    e.preventDefault();
    if (debugSessionId && debugStopped) {
      invoke('debug_send', { sessionId: debugSessionId, command: 'next', args: { threadId: 1 } }).catch(() => {});
    }
    return;
  }
  // F11 — Step into (Shift+F11 = step out)
  if (e.key === 'F11') {
    e.preventDefault();
    if (debugSessionId && debugStopped) {
      const cmd = e.shiftKey ? 'stepOut' : 'stepIn';
      invoke('debug_send', { sessionId: debugSessionId, command: cmd, args: { threadId: 1 } }).catch(() => {});
    }
    return;
  }
}, true); // capture phase to intercept before other handlers

// ─── SCM Panel & Diff Viewer ──────────────────────────────────

const scmGroupsEl = document.getElementById('scm-groups');
const scmCommitInput = document.getElementById('scm-commit-input');
const scmCommitBtn = document.getElementById('scm-commit-btn');
const diffViewerEl = document.getElementById('diff-viewer');
const diffContentEl = document.getElementById('diff-content');
const diffViewerTitle = document.getElementById('diff-viewer-title');
const diffStageBtn = document.getElementById('diff-stage-btn');
const diffUnstageBtn = document.getElementById('diff-unstage-btn');
const diffDiscardBtn = document.getElementById('diff-discard-btn');
const diffViewerClose = document.getElementById('diff-viewer-close');

// ─── Comment Threads ──────────────────────────────────────────

const commentPopupEl = document.getElementById('comment-thread-popup');
const commentPopupLabelEl = document.getElementById('comment-thread-popup-label');
const commentPopupBodyEl = document.getElementById('comment-thread-popup-body');

function showCommentPopup(thread, clientX, clientY) {
  if (!commentPopupEl) return;
  commentPopupLabelEl.textContent = thread.label ?? `${thread.comments.length} comment${thread.comments.length !== 1 ? 's' : ''}`;
  commentPopupBodyEl.innerHTML = '';
  for (const c of thread.comments) {
    const item = document.createElement('div');
    item.className = 'comment-popup-item';
    const author = document.createElement('div');
    author.className = 'comment-popup-author';
    author.textContent = c.author?.name ?? 'Unknown';
    const body = document.createElement('div');
    body.className = 'comment-popup-body';
    body.textContent = c.body ?? '';
    item.appendChild(author);
    item.appendChild(body);
    commentPopupBodyEl.appendChild(item);
  }
  // Position near click, keeping within viewport
  const pw = 340, ph = 300;
  const vw = window.innerWidth, vh = window.innerHeight;
  const left = Math.min(clientX + 8, vw - pw - 8);
  const top = Math.min(clientY, vh - ph - 8);
  commentPopupEl.style.left = left + 'px';
  commentPopupEl.style.top = top + 'px';
  commentPopupEl.classList.remove('comment-popup-hidden');
}

function closeCommentPopup() {
  commentPopupEl?.classList.add('comment-popup-hidden');
}

document.getElementById('comment-thread-popup-close')?.addEventListener('click', closeCommentPopup);

document.addEventListener('mousedown', (e) => {
  if (!commentPopupEl?.classList.contains('comment-popup-hidden') &&
      !commentPopupEl?.contains(e.target)) {
    closeCommentPopup();
  }
});

async function pollCommentThreads() {
  if (!filePath) { commentThreads = []; return; }
  try {
    const uri = filePathToUri(filePath);
    const threads = await invoke('get_comment_threads', { uri });
    const changed = JSON.stringify(threads) !== JSON.stringify(commentThreads);
    commentThreads = threads;
    if (changed) requestRender();
  } catch {}
}

const commentThreadsInterval = setInterval(pollCommentThreads, 3000);

// Current diff context (for action buttons)
let diffCurrentFile = null; // { path, staged }
let scmStatus = []; // last git status result

async function renderScmPanel() {
  const root = explorerRoot;
  if (!root) {
    if (scmGroupsEl) scmGroupsEl.innerHTML = '<div style="padding:12px;color:#888;font-size:12px;">Open a folder to use Source Control.</div>';
    return;
  }
  try {
    scmStatus = await invoke('git_status', { workspacePath: root });
  } catch (e) {
    if (scmGroupsEl) scmGroupsEl.innerHTML = `<div style="padding:12px;color:#888;font-size:12px;">Not a git repository.</div>`;
    return;
  }
  if (!scmGroupsEl) return;

  const staged = scmStatus.filter(e => e.index_status !== ' ' && e.index_status !== '?');
  const changed = scmStatus.filter(e => e.worktree_status !== ' ' && e.worktree_status !== '?' && (e.index_status === ' ' || e.index_status === '?'));
  const untracked = scmStatus.filter(e => e.index_status === '?' && e.worktree_status === '?');

  scmGroupsEl.innerHTML = '';
  renderScmGroup('Staged Changes', staged, true);
  renderScmGroup('Changes', changed, false);
  renderScmGroup('Untracked Files', untracked, false, true);

  // Also merge any extension-provided SCM state
  try {
    const extScm = await invoke('get_scm_state');
    for (const sc of Object.values(extScm)) {
      for (const group of sc.resource_groups) {
        if (group.resources.length === 0) continue;
        const groupEl = document.createElement('div');
        groupEl.className = 'scm-group';
        groupEl.innerHTML = `<div class="scm-group-header"><span><span class="scm-group-toggle">▾</span>${escapeHtml(sc.label)}: ${escapeHtml(group.label)}</span><span class="scm-group-count">${group.resources.length}</span></div><div class="scm-group-items"></div>`;
        const itemsEl = groupEl.querySelector('.scm-group-items');
        for (const res of group.resources) {
          const item = document.createElement('div');
          item.className = 'scm-item';
          const letter = res.decoration_letter || 'M';
          item.innerHTML = `<span class="scm-item-letter ${escapeHtml(letter)}" title="${escapeHtml(res.decoration_tooltip || '')}">${escapeHtml(letter)}</span><span class="scm-item-path">${escapeHtml(res.uri)}</span>`;
          itemsEl.appendChild(item);
        }
        scmGroupsEl.appendChild(groupEl);
      }
    }
  } catch { /* extensions may not be connected */ }
}

function renderScmGroup(label, entries, isStaged, isUntracked = false) {
  if (!entries.length) return;
  const groupEl = document.createElement('div');
  groupEl.className = 'scm-group';

  const header = document.createElement('div');
  header.className = 'scm-group-header';
  header.innerHTML = `<span><span class="scm-group-toggle">▾</span>${escapeHtml(label)}</span><span class="scm-group-count">${entries.length}</span>`;
  groupEl.appendChild(header);

  const itemsEl = document.createElement('div');
  itemsEl.className = 'scm-group-items';

  for (const entry of entries) {
    const statusChar = isStaged ? entry.index_status : (isUntracked ? 'U' : entry.worktree_status);
    const letterClass = statusChar === 'M' ? 'M' : statusChar === 'A' ? 'A' : statusChar === 'D' ? 'D' : statusChar === 'R' ? 'R' : 'U';
    const item = document.createElement('div');
    item.className = 'scm-item';
    item.setAttribute('tabindex', '0');
    item.setAttribute('role', 'button');
    item.setAttribute('aria-label', `${label}: ${entry.path}`);

    const actionsHtml = isStaged
      ? `<span class="scm-item-actions"><button title="Unstage" aria-label="Unstage ${escapeHtml(entry.path)}">−</button></span>`
      : isUntracked
        ? `<span class="scm-item-actions"><button title="Stage" aria-label="Stage ${escapeHtml(entry.path)}">+</button></span>`
        : `<span class="scm-item-actions"><button title="Stage" aria-label="Stage ${escapeHtml(entry.path)}">+</button><button title="Discard" aria-label="Discard ${escapeHtml(entry.path)}">↩</button></span>`;

    item.innerHTML = `<span class="scm-item-letter ${letterClass}">${letterClass}</span><span class="scm-item-path" title="${escapeHtml(entry.path)}">${escapeHtml(entry.path.split('/').pop() || entry.path)}</span>${actionsHtml}`;

    // Click on item → open diff viewer
    item.addEventListener('click', (e) => {
      const btn = e.target.closest('.scm-item-actions button');
      if (btn) {
        e.stopPropagation();
        const title = btn.title;
        if (title === 'Stage' || title === 'Unstage') {
          scmActionStageToggle(entry.path, title === 'Unstage');
        } else if (title === 'Discard') {
          scmActionDiscard(entry.path);
        }
        return;
      }
      openDiffViewer(entry.path, isStaged, isUntracked);
    });
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDiffViewer(entry.path, isStaged, isUntracked); }
    });
    itemsEl.appendChild(item);
  }

  // Collapse/expand group
  header.addEventListener('click', () => {
    const toggle = header.querySelector('.scm-group-toggle');
    const collapsed = itemsEl.style.display === 'none';
    itemsEl.style.display = collapsed ? '' : 'none';
    toggle.textContent = collapsed ? '▾' : '▸';
  });

  groupEl.appendChild(itemsEl);
  scmGroupsEl.appendChild(groupEl);
}

async function openDiffViewer(filePath, isStaged, isUntracked) {
  if (!explorerRoot || !diffViewerEl) return;
  diffCurrentFile = { path: filePath, staged: isStaged };
  diffViewerTitle.textContent = filePath;
  diffViewerEl.classList.remove('diff-viewer-hidden');

  // Show/hide stage/unstage button
  if (diffStageBtn) diffStageBtn.style.display = isStaged ? 'none' : '';
  if (diffUnstageBtn) diffUnstageBtn.style.display = isStaged ? '' : 'none';
  if (diffDiscardBtn) diffDiscardBtn.style.display = isUntracked ? 'none' : '';

  diffContentEl.innerHTML = '<div style="padding:16px;color:#888;">Loading diff...</div>';
  try {
    const diff = await invoke('git_diff_file', {
      workspacePath: explorerRoot,
      filePath,
      staged: isStaged,
    });
    renderDiff(diff);
  } catch (e) {
    diffContentEl.innerHTML = `<div style="padding:16px;color:#f14c4c;">Error loading diff: ${escapeHtml(String(e))}</div>`;
  }
}

function renderDiff(diffText) {
  if (!diffContentEl) return;
  if (!diffText.trim()) {
    diffContentEl.innerHTML = '<div style="padding:16px;color:#888;">No changes.</div>';
    return;
  }
  const lines = diffText.split('\n');
  const frag = document.createDocumentFragment();
  let lineNum = 0;
  for (const raw of lines) {
    const row = document.createElement('div');
    row.className = 'diff-line';
    const numEl = document.createElement('span');
    numEl.className = 'diff-line-num';
    const contentEl = document.createElement('span');
    contentEl.className = 'diff-line-content';

    if (raw.startsWith('+++') || raw.startsWith('---')) {
      row.classList.add('file-header');
      numEl.textContent = '';
      contentEl.textContent = raw;
    } else if (raw.startsWith('@@')) {
      row.classList.add('meta');
      numEl.textContent = '';
      contentEl.textContent = raw;
      // Parse new start line from @@ -a,b +c,d @@
      const m = raw.match(/@@ [^+]*\+(\d+)/);
      lineNum = m ? parseInt(m[1], 10) - 1 : 0;
    } else if (raw.startsWith('+')) {
      row.classList.add('added');
      lineNum++;
      numEl.textContent = lineNum;
      contentEl.textContent = raw;
    } else if (raw.startsWith('-')) {
      row.classList.add('removed');
      numEl.textContent = '';
      contentEl.textContent = raw;
    } else {
      lineNum++;
      numEl.textContent = lineNum;
      contentEl.textContent = raw;
    }
    row.appendChild(numEl);
    row.appendChild(contentEl);
    frag.appendChild(row);
  }
  diffContentEl.innerHTML = '';
  diffContentEl.appendChild(frag);
}

function closeDiffViewer() {
  if (diffViewerEl) diffViewerEl.classList.add('diff-viewer-hidden');
  diffCurrentFile = null;
}

async function scmActionStageToggle(filePath, isUnstage) {
  if (!explorerRoot) return;
  try {
    if (isUnstage) {
      await invoke('git_unstage', { workspacePath: explorerRoot, filePath });
    } else {
      await invoke('git_stage', { workspacePath: explorerRoot, filePath });
    }
    await renderScmPanel();
  } catch (e) {
    console.error('SCM stage/unstage error:', e);
  }
}

async function scmActionDiscard(filePath) {
  if (!explorerRoot) return;
  // Use Tauri dialog instead of browser confirm() which may be blocked in WebView
  let confirmed = false;
  try {
    confirmed = await window.__TAURI__.dialog.confirm(
      `Discard changes to "${filePath}"? This cannot be undone.`,
      { title: 'Discard Changes', kind: 'warning' }
    );
  } catch {
    // Fallback if dialog API unavailable
    confirmed = window.confirm(`Discard changes to "${filePath}"? This cannot be undone.`);
  }
  if (!confirmed) return;
  try {
    await invoke('git_discard', { workspacePath: explorerRoot, filePath });
    await renderScmPanel();
  } catch (e) {
    console.error('SCM discard error:', e);
  }
}

diffViewerClose?.addEventListener('click', closeDiffViewer);

diffStageBtn?.addEventListener('click', async () => {
  if (diffCurrentFile && explorerRoot) {
    await scmActionStageToggle(diffCurrentFile.path, false);
    closeDiffViewer();
  }
});
diffUnstageBtn?.addEventListener('click', async () => {
  if (diffCurrentFile && explorerRoot) {
    await scmActionStageToggle(diffCurrentFile.path, true);
    closeDiffViewer();
  }
});
diffDiscardBtn?.addEventListener('click', async () => {
  if (diffCurrentFile && explorerRoot) {
    await scmActionDiscard(diffCurrentFile.path);
    closeDiffViewer();
  }
});

// Close diff viewer on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && diffViewerEl && !diffViewerEl.classList.contains('diff-viewer-hidden')) {
    e.stopPropagation();
    closeDiffViewer();
  }
}, true);

// Commit button
scmCommitBtn?.addEventListener('click', async () => {
  const msg = scmCommitInput?.value.trim();
  if (!msg) { scmCommitInput?.focus(); return; }
  if (!explorerRoot) return;
  try {
    await invoke('git_commit', { workspacePath: explorerRoot, message: msg });
    scmCommitInput.value = '';
    await renderScmPanel();
  } catch (e) {
    alert('Commit failed: ' + String(e));
  }
});

// Ctrl+Enter to commit from textarea
scmCommitInput?.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === 'Enter') {
    e.preventDefault();
    scmCommitBtn?.click();
  }
});

// Poll SCM status every 5s when the panel is visible
const scmPollInterval = setInterval(async () => {
  if (activePanel === 'scm' && explorerRoot) {
    await renderScmPanel();
  }
}, 5000);

// ─── Cleanup ─────────────────────────────────────────────────

const _ccIntervals = [statusBarInterval, outputInterval, diagnosticsInterval, extHostInterval, notifInterval, uiReqInterval, webviewInterval, terminalEventsInterval, decorationsInterval, debugStartInterval, debugEventsInterval, workspaceEditInterval, treeViewEventsInterval, showTextDocumentInterval, scmPollInterval, commentThreadsInterval];

window.addEventListener('beforeunload', () => {
  _ccIntervals.forEach(id => clearInterval(id));
});

// ─── Init ────────────────────────────────────────────────────

async function init() {
  if (window._ccPrevIntervals) {
    window._ccPrevIntervals.forEach(id => clearInterval(id));
  }
  window._ccPrevIntervals = _ccIntervals;

  try {
    measureFont();
    resizeCanvases();
    resetCursorBlink();

    const content = await invoke('get_content');
    await updateFromEditorContent(content);
    renderTabs();
    editorEl.focus();
    statusEl.textContent = 'Ready — Ctrl+O open, Ctrl+B explorer, Ctrl+` terminal, Ctrl+Space autocomplete';
    pollExtHostStatus();
    pollStatusBarItems();
  } catch (err) {
    console.error('Init error:', err);
    statusEl.textContent = `Error: ${err}`;
  }
}

if (window.__TAURI__) {
  init();
} else {
  window.addEventListener('DOMContentLoaded', () => {
    setTimeout(init, 100);
  });
}
