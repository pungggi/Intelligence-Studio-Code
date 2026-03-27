/**
 * CoreCode M7 — Canvas-based Editor Frontend
 *
 * M7 changes:
 * - DOM-based line rendering replaced with Canvas2D
 * - Virtual scrolling: only visible lines fetched/rendered
 * - Edit commands return lightweight EditResult (no line data)
 * - O(1) mouse position mapping (arithmetic, no DOM queries)
 * - Token-colored text drawn directly on canvas
 *
 * Carried from M1-M6:
 * - Syntax highlighting, diagnostics, command palette
 * - Undo/redo, selection, clipboard, find/replace
 * - Tabs, file explorer, minimap
 * - LSP: autocomplete, hover, go-to-def, references, code actions, signature help, symbols, formatting
 */

const { invoke } = window.__TAURI__.core;

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
  editQueueTail = editQueueTail.then(fn, fn);
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

// Find / Replace
let findOpen = false;
let findMatches = [];
let findCurrentIdx = -1;

// Output panel
let outputOpen = false;
let outputAllLines = [];
let outputSelectedChannel = '';

// File explorer
let sidebarOpen = false;
let explorerRoot = null;
let expandedDirs = new Set();

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

// Output panel
const outputPanelEl = document.getElementById('output-panel');
const outputChannelSelect = document.getElementById('output-channel-select');
const outputClearBtn = document.getElementById('output-clear');
const outputCloseBtn = document.getElementById('output-close');
const outputContentEl = document.getElementById('output-content');

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
  const totalH = totalLines * lineHeight;
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

  // Draw selection
  paintSelection(ctx, first, subPixelOffset);

  // Draw find highlights
  paintFindHighlights(ctx, first, subPixelOffset);

  // Build diagnostic lookup map (O(1) per line instead of O(n))
  const diagMap = new Map();
  for (const d of diagnostics) {
    if (!diagMap.has(d.line)) diagMap.set(d.line, []);
    diagMap.get(d.line).push(d);
  }

  // Draw text lines
  const fontSize = parseFloat(style.fontSize);
  const visibleCount = Math.ceil((h / dpr) / lineHeight) + 2;
  for (let vi = 0; vi < visibleCount; vi++) {
    const lineIdx = first + vi;
    if (lineIdx >= totalLines) break;

    const cacheOffset = lineIdx - cachedFirstLine;
    if (cacheOffset < 0 || cacheOffset >= cachedLines.length) continue;

    const line = cachedLines[cacheOffset];
    const y = vi * lineHeight + subPixelOffset;
    const textY = y + (lineHeight - fontSize) / 2;

    if (line.tokens && line.tokens.length > 0) {
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
  }

  // Draw cursor
  paintCursor(ctx, first, subPixelOffset);
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

  for (let vi = 0; vi < visibleCount; vi++) {
    const lineIdx = firstVisibleLine + vi;
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

function paintFindHighlights(ctx, firstVisibleLine, subPixelOffset) {
  if (!findOpen || findMatches.length === 0) return;

  for (let mi = 0; mi < findMatches.length; mi++) {
    const m = findMatches[mi];
    const vi = m.line - firstVisibleLine;
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

function paintCursor(ctx, firstVisibleLine, subPixelOffset) {
  if (!cursorVisible) return;
  const vi = cursorLine - firstVisibleLine;
  const visH = editorCanvas.height / (window.devicePixelRatio || 1);
  if (vi < 0 || vi * lineHeight + subPixelOffset > visH) return;

  const y = vi * lineHeight + subPixelOffset;
  const x = EDITOR_PADDING_LEFT + cursorCol * cellWidth;

  ctx.fillStyle = CURSOR_COLOR;
  ctx.fillRect(x, y, 2, lineHeight);
}

function drawWavyUnderline(ctx, x, y, width, color) {
  if (width <= 0) return;
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  const amplitude = 2;
  const wavelength = 4;
  for (let i = 0; i <= width; i += 0.5) {
    const dy = Math.sin((i / wavelength) * Math.PI * 2) * amplitude;
    if (i === 0) ctx.moveTo(x + i, y + dy);
    else ctx.lineTo(x + i, y + dy);
  }
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

  for (let vi = 0; vi < visibleCount; vi++) {
    const lineIdx = first + vi;
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
  }
}

// ─── Content Fetching ────────────────────────────────────────

async function fetchVisibleContent() {
  const { first, count } = getVisibleLineRange();
  const fetchFirst = Math.max(0, first - BUFFER_LINES);
  const fetchCount = count + BUFFER_LINES * 2;

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
  const cursorTop = cursorLine * lineHeight;
  const cursorBottom = cursorTop + lineHeight;
  if (cursorBottom > editorEl.scrollTop + editorEl.clientHeight) {
    editorEl.scrollTop = cursorBottom - editorEl.clientHeight;
  } else if (cursorTop < editorEl.scrollTop) {
    editorEl.scrollTop = cursorTop;
  }
}

function updateStatusBar() {
  let pos = `Ln ${cursorLine + 1}, Col ${cursorCol + 1}`;
  if (hasSelection()) {
    const sel = getSelectionRange();
    const selLines = sel.endLine - sel.startLine + 1;
    pos += ` (${selLines} line${selLines > 1 ? 's' : ''} selected)`;
  }
  cursorPosEl.textContent = pos;
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

      tab.addEventListener('click', () => switchTab(buf.path));
      tabsEl.appendChild(tab);
    }
  } catch (err) {
    console.error('renderTabs error:', err);
  }
}

async function switchTab(path) {
  if (path === activeBufferPath) return;
  try {
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

// ─── Mouse Helpers (O(1) arithmetic) ─────────────────────────

function posFromMouse(e) {
  const rect = editorCanvas.getBoundingClientRect();
  const scrollTop = editorEl.scrollTop;
  const y = e.clientY - rect.top + scrollTop;
  const x = e.clientX - rect.left - EDITOR_PADDING_LEFT + editorEl.scrollLeft;

  const line = Math.max(0, Math.min(Math.floor(y / lineHeight), totalLines - 1));
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
    { label: 'Save File', command: '__builtin:save' },
    { label: 'Toggle Sidebar', command: '__builtin:toggleSidebar' },
    { label: 'Close Tab', command: '__builtin:closeTab' },
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
  } else if (command === '__builtin:save') {
    await saveFile();
  } else if (command === '__builtin:toggleSidebar') {
    toggleSidebar();
  } else if (command === '__builtin:closeTab') {
    if (activeBufferPath) await closeTab(activeBufferPath);
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
  if (e.ctrlKey && e.shiftKey && e.key === 'F') { e.preventDefault(); formatDocument(); return; }
  if (e.ctrlKey && e.key === ' ') { e.preventDefault(); triggerAutocomplete(null); return; }
  if (e.key === 'F12' && !e.shiftKey && !e.ctrlKey) { e.preventDefault(); goToDefinition(); return; }
  if (e.key === 'F12' && e.shiftKey && !e.ctrlKey) { e.preventDefault(); findReferences(); return; }
  if (e.ctrlKey && e.key === '.') { e.preventDefault(); requestCodeActions(); return; }

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
  if (e.ctrlKey && e.key === '`') { e.preventDefault(); toggleOutputPanel(); return; }
  if (e.key === 'Escape') {
    if (findOpen) { closeFindBar(); return; }
    if (outputOpen) { closeOutputPanel(); return; }
  }

  // Only handle editor keys when editor is focused
  if (document.activeElement !== editorEl) return;

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
    if (e.shiftKey) ensureAnchor(); else if (hasSelection()) clearSelection();
    if (cursorLine > 0) {
      cursorLine--;
      cursorCol = Math.min(cursorCol, getLineText(cursorLine).length);
    }
    if (!e.shiftKey) clearSelection();
    ensureCursorVisible(); requestRender(); updateStatusBar();
    return;
  }

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (e.shiftKey) ensureAnchor(); else if (hasSelection()) clearSelection();
    if (cursorLine < totalLines - 1) {
      cursorLine++;
      cursorCol = Math.min(cursorCol, getLineText(cursorLine).length);
    }
    if (!e.shiftKey) clearSelection();
    ensureCursorVisible(); requestRender(); updateStatusBar();
    return;
  }

  if (e.key === 'ArrowLeft') {
    e.preventDefault();
    if (e.shiftKey) {
      ensureAnchor();
      if (cursorCol > 0) cursorCol--;
      else if (cursorLine > 0) { cursorLine--; cursorCol = getLineText(cursorLine).length; }
    } else if (hasSelection()) {
      const sel = getSelectionRange();
      cursorLine = sel.startLine; cursorCol = sel.startCol;
      clearSelection();
    } else {
      if (cursorCol > 0) cursorCol--;
      else if (cursorLine > 0) { cursorLine--; cursorCol = getLineText(cursorLine).length; }
    }
    ensureCursorVisible(); requestRender(); updateStatusBar();
    return;
  }

  if (e.key === 'ArrowRight') {
    e.preventDefault();
    if (e.shiftKey) {
      ensureAnchor();
      const lineLen = getLineText(cursorLine).length;
      if (cursorCol < lineLen) cursorCol++;
      else if (cursorLine < totalLines - 1) { cursorLine++; cursorCol = 0; }
    } else if (hasSelection()) {
      const sel = getSelectionRange();
      cursorLine = sel.endLine; cursorCol = sel.endCol;
      clearSelection();
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
    if (e.shiftKey) ensureAnchor();
    cursorCol = 0;
    if (!e.shiftKey) clearSelection();
    ensureCursorVisible(); requestRender(); updateStatusBar();
    return;
  }

  if (e.key === 'End') {
    e.preventDefault();
    if (e.shiftKey) ensureAnchor();
    cursorCol = getLineText(cursorLine).length;
    if (!e.shiftKey) clearSelection();
    ensureCursorVisible(); requestRender(); updateStatusBar();
    return;
  }

  // Editing keys
  if (e.key === 'Enter') {
    e.preventDefault();
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

  if (e.key === 'Tab') {
    e.preventDefault();
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

    // M6: LSP triggers
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

  if (e.shiftKey) {
    ensureAnchor();
    cursorLine = pos.line;
    cursorCol = pos.col;
  } else {
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

// ─── Visibility-gated polling ────────────────────────────────
// Skip IPC calls when window is hidden/minimized to save CPU
function isPageVisible() { return document.visibilityState === 'visible'; }

// ─── Status Bar Extension Items ──────────────────────────────

async function pollStatusBarItems() {
  if (!isPageVisible()) return;
  try {
    const items = await invoke('get_status_bar_items');
    if (!items || items.length === 0) { extStatusBarEl.innerHTML = ''; return; }
    items.sort((a, b) => (b.priority || 0) - (a.priority || 0));
    extStatusBarEl.innerHTML = '';
    for (const item of items) {
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

// ─── Output Panel ────────────────────────────────────────────

function toggleOutputPanel() { outputOpen ? closeOutputPanel() : openOutputPanel(); }
function openOutputPanel() { outputOpen = true; outputPanelEl.classList.remove('output-hidden'); }
function closeOutputPanel() { outputOpen = false; outputPanelEl.classList.add('output-hidden'); }

async function pollOutputLines() {
  if (!isPageVisible() || !outputOpen) return;
  try {
    const newLines = await invoke('get_output_lines');
    if (!newLines || newLines.length === 0) return;
    outputAllLines.push(...newLines);
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
outputCloseBtn.addEventListener('click', closeOutputPanel);

const outputInterval = setInterval(pollOutputLines, 1000);

// ─── Diagnostics Polling ─────────────────────────────────────

async function refreshDiagnostics() {
  if (!isPageVisible()) return;
  try {
    await fetchVisibleContent();
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
    const notifications = await invoke('get_notifications');
    for (const n of notifications) showToast(n.type, n.message);
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

  function closePaletteAndRespond(requestId, value) {
    paletteOpen = false;
    paletteEl.classList.add('palette-hidden');
    paletteInputEl.placeholder = 'Type a command...';
    qpAbort.abort();
    paletteInputEl.addEventListener('input', paletteInputHandler);
    paletteInputEl.addEventListener('keydown', paletteKeydownHandler);
    paletteBackdropEl.addEventListener('click', closePalette);
    editorEl.focus();
    invoke('respond_ui_request', { requestId, value: value });
  }

  paletteInputEl.focus();
}

function handleInputBox(req) {
  const prompt = req.params.prompt || req.params.title || 'Enter a value';
  const placeholder = req.params.placeHolder || '';
  const defaultValue = req.params.value || '';
  paletteOpen = true;
  paletteEl.classList.remove('palette-hidden');
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

  function closeInputAndRespond(requestId, value) {
    paletteOpen = false;
    paletteEl.classList.add('palette-hidden');
    paletteInputEl.placeholder = 'Type a command...';
    ibAbort.abort();
    paletteInputEl.addEventListener('input', paletteInputHandler);
    paletteInputEl.addEventListener('keydown', paletteKeydownHandler);
    paletteBackdropEl.addEventListener('click', closePalette);
    editorEl.focus();
    invoke('respond_ui_request', { requestId, value: value });
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
  try {
    const result = await invoke('lsp_completion', {
      uri, line: cursorLine, character: cursorCol,
      triggerKind: triggerChar ? 2 : 1, triggerCharacter: triggerChar || null,
    });
    if (!result || !result.items || result.items.length === 0) { closeAutocomplete(); return; }
    acItems = result.items;
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
    const result = await invoke('lsp_hover', { uri, line, character: col });
    if (!result || !result.contents) { closeHover(); return; }
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
  const uri = getActiveUri();
  if (!uri) return;
  try {
    statusEl.textContent = 'Go to definition...';
    const result = await invoke('lsp_definition', { uri, line: cursorLine, character: cursorCol });
    if (!result || (Array.isArray(result) && result.length === 0)) {
      statusEl.textContent = 'No definition found';
      setTimeout(() => { statusEl.textContent = ''; }, 2000);
      return;
    }
    const locations = Array.isArray(result) ? result : [result];
    const loc = locations[0];
    if (loc.uri && loc.range) await navigateToLocation(loc.uri, loc.range.start.line, loc.range.start.character);
    statusEl.textContent = '';
  } catch {
    statusEl.textContent = 'Definition unavailable';
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
    await goToDefinition();
  }
});

// --- Find References ---

async function findReferences() {
  const uri = getActiveUri();
  if (!uri) return;
  try {
    statusEl.textContent = 'Finding references...';
    const result = await invoke('lsp_references', { uri, line: cursorLine, character: cursorCol });
    if (!result || (Array.isArray(result) && result.length === 0)) {
      statusEl.textContent = 'No references found';
      setTimeout(() => { statusEl.textContent = ''; }, 2000);
      return;
    }
    statusEl.textContent = '';
    showReferencesPanel(result);
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
    const result = await invoke('lsp_code_action', { uri, startLine, startCharacter: startChar, endLine, endCharacter: endChar });
    if (!result || (Array.isArray(result) && result.length === 0)) {
      statusEl.textContent = 'No code actions available';
      setTimeout(() => { statusEl.textContent = ''; }, 2000);
      return;
    }
    caItems = Array.isArray(result) ? result : [];
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
    // Support both `changes` and `documentChanges` (LSP 3.x)
    let allEdits = [];
    if (action.edit.changes) {
      for (const [uri, edits] of Object.entries(action.edit.changes)) {
        for (const edit of edits) allEdits.push(edit);
      }
    }
    if (action.edit.documentChanges) {
      for (const dc of action.edit.documentChanges) {
        if (dc.edits) {
          for (const edit of dc.edits) allEdits.push(edit);
        }
      }
    }
    // Apply in reverse order to preserve positions
    allEdits.sort((a, b) => {
      if (b.range.start.line !== a.range.start.line) return b.range.start.line - a.range.start.line;
      return b.range.start.character - a.range.start.character;
    });
    for (const edit of allEdits) {
      const r = edit.range;
      await invoke('edit_replace_range', {
        startLine: r.start.line, startCol: r.start.character,
        endLine: r.end.line, endCol: r.end.character, text: edit.newText,
      });
    }
    await fetchVisibleContent();
    updateMetadataUI();
    requestRender();
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
    div.addEventListener('click', () => {
      closeSymbolOutline();
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

symbolsInput.addEventListener('input', () => { symbolSelectedIdx = 0; renderSymbolList(symbolsInput.value); });
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

// --- Formatting ---

async function formatDocument() {
  const uri = getActiveUri();
  if (!uri) return;
  try {
    statusEl.textContent = 'Formatting...';
    const result = await invoke('lsp_format', { uri, tabSize: 2, insertSpaces: true });
    if (result && Array.isArray(result) && result.length > 0) {
      const edits = result.slice().sort((a, b) => {
        if (b.range.start.line !== a.range.start.line) return b.range.start.line - a.range.start.line;
        return b.range.start.character - a.range.start.character;
      });
      for (const edit of edits) {
        await invoke('edit_replace_range', {
          startLine: edit.range.start.line, startCol: edit.range.start.character,
          endLine: edit.range.end.line, endCol: edit.range.end.character, text: edit.newText,
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

// ─── Cleanup ─────────────────────────────────────────────────

const _ccIntervals = [statusBarInterval, outputInterval, diagnosticsInterval, extHostInterval, notifInterval, uiReqInterval];

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
    statusEl.textContent = 'Ready — Ctrl+O open, Ctrl+B explorer, Ctrl+Space autocomplete, F12 go-to-def';
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
