/**
 * CoreCode M5 — Multi-file Editor Frontend
 *
 * Features carried from M4:
 * - Text editing with syntax highlighting
 * - Diagnostics display (underlines + gutter markers)
 * - Command palette (Ctrl+Shift+P)
 * - Undo/Redo, Selection, Clipboard, Find/Replace
 * - Extension status bar items, Output panel
 *
 * New in M5:
 * - Tab bar with open/close/switch, modified indicator, Ctrl+Tab cycling
 * - File explorer sidebar (Ctrl+B toggle)
 * - Multi-document state (per-buffer cursor, selection)
 * - Minimap (scrollbar-side overview)
 */

const { invoke } = window.__TAURI__.core;

// ─── Multi-buffer State ─────────────────────────────────────

/**
 * Per-buffer state stored in the frontend.
 * Keys are canonical file paths (strings).
 * @type {Map<string, {cursorLine: number, cursorCol: number, selAnchorLine: number|null, selAnchorCol: number|null, scrollTop: number}>}
 */
const bufferStates = new Map();
let activeBufferPath = null;

// Current active buffer's state (synced with bufferStates on switch)
let cursorLine = 0;
let cursorCol = 0;
let lines = [];
let filePath = null;
let modified = false;
let diagnostics = [];

// Palette
let paletteOpen = false;
let paletteSelectedIndex = 0;
let paletteCommands = [];
let paletteFiltered = [];

// Selection (anchor = where selection started; cursor = moving end)
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
    // scrollTop restored after render
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
    renderContent(content);
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
      renderContent(result);
    } else {
      activeBufferPath = null;
      cursorLine = 0;
      cursorCol = 0;
      clearSelection();
      const content = await invoke('get_content');
      renderContent(content);
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

// ─── Mouse Helpers ───────────────────────────────────────────

function posFromMouse(e) {
  const lineEls = editorEl.querySelectorAll('.line');
  const charWidth = measureCharWidth();
  const editorRect = editorEl.getBoundingClientRect();

  let line = lines.length - 1;
  for (let i = 0; i < lineEls.length; i++) {
    const rect = lineEls[i].getBoundingClientRect();
    if (i === 0 && e.clientY < rect.top) { line = 0; break; }
    if (e.clientY >= rect.top && e.clientY < rect.bottom) { line = i; break; }
  }
  line = Math.max(0, Math.min(line, lines.length - 1));

  const relativeX = e.clientX - editorRect.left - 12 + editorEl.scrollLeft;
  const col = Math.max(0, Math.min(
    Math.round(relativeX / charWidth),
    (lines[line]?.text || '').length
  ));

  return { line, col };
}

// ─── Rendering ───────────────────────────────────────────────

function renderContent(content) {
  lines = content.lines || [];
  filePath = content.file_path;
  modified = content.modified;
  diagnostics = content.diagnostics || [];

  if (filePath) {
    activeBufferPath = filePath;
    const name = filePath.split(/[/\\]/).pop();
    fileNameEl.textContent = (modified ? '● ' : '') + name;
  } else {
    fileNameEl.textContent = 'CoreCode';
  }

  if (content.language) {
    languageBadgeEl.textContent = content.language;
    languageBadgeEl.style.display = '';
  } else {
    languageBadgeEl.style.display = 'none';
  }

  fileInfoEl.textContent = `${content.line_count} lines`;

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

  if (lines.length > 0) {
    cursorLine = Math.max(0, Math.min(cursorLine, lines.length - 1));
    cursorCol = Math.max(0, Math.min(cursorCol, (lines[cursorLine]?.text || '').length));
  }

  const diagsByLine = new Map();
  for (const d of diagnostics) {
    if (!diagsByLine.has(d.line)) diagsByLine.set(d.line, []);
    diagsByLine.get(d.line).push(d);
  }

  // Build DOM in fragments for a single reflow instead of N reflows
  const editorFrag = document.createDocumentFragment();
  const gutterFrag = document.createDocumentFragment();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineDiags = diagsByLine.get(i) || [];

    const gutterLine = document.createElement('div');
    gutterLine.className = 'line';
    if (lineDiags.some(d => d.severity === 'error')) {
      gutterLine.classList.add('gutter-error');
    } else if (lineDiags.some(d => d.severity === 'warning')) {
      gutterLine.classList.add('gutter-warning');
    }
    gutterLine.textContent = String(i + 1);
    gutterFrag.appendChild(gutterLine);

    const editorLine = document.createElement('div');
    editorLine.className = 'line';
    editorLine.dataset.line = i;

    if (line.tokens && line.tokens.length > 0) {
      editorLine.innerHTML = applyTokensAndDiags(line.text, line.tokens, lineDiags);
    } else if (lineDiags.length > 0) {
      editorLine.innerHTML = applyDiags(line.text || '', lineDiags);
    } else {
      editorLine.textContent = line.text || '';
    }

    editorFrag.appendChild(editorLine);
  }

  editorEl.innerHTML = '';
  gutterEl.innerHTML = '';
  editorEl.appendChild(editorFrag);
  gutterEl.appendChild(gutterFrag);

  renderCursor();
  renderSelection();
  renderFindHighlights();
  updateStatusBar();
  renderMinimap();
}

function applyTokensAndDiags(text, tokens, diags) {
  if (!text) return '';
  let html = '';
  let lastEnd = 0;
  for (const token of tokens) {
    if (token.start > lastEnd) {
      html += wrapDiagSpans(escapeHtml(text.substring(lastEnd, token.start)), lastEnd, token.start, diags);
    }
    const tokenText = text.substring(token.start, token.end);
    const diagClass = getDiagClass(token.start, token.end, diags);
    html += `<span class="tok-${token.kind}${diagClass ? ' ' + diagClass : ''}">${escapeHtml(tokenText)}</span>`;
    lastEnd = token.end;
  }
  if (lastEnd < text.length) {
    html += wrapDiagSpans(escapeHtml(text.substring(lastEnd)), lastEnd, text.length, diags);
  }
  return html;
}

function applyDiags(text, diags) {
  if (!diags.length) return escapeHtml(text);
  return wrapDiagSpans(escapeHtml(text), 0, text.length, diags);
}

function getDiagClass(start, end, diags) {
  for (const d of diags) {
    if (d.col_start < end && d.col_end > start) return `diag-${d.severity}`;
  }
  return '';
}

function wrapDiagSpans(html, textStart, textEnd, diags) {
  for (const d of diags) {
    if (d.col_start < textEnd && d.col_end > textStart) {
      return `<span class="diag-${d.severity}">${html}</span>`;
    }
  }
  return html;
}

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderCursor() {
  const existing = document.querySelector('.cursor');
  if (existing) existing.remove();

  const lineEls = editorEl.querySelectorAll('.line');
  if (cursorLine >= lineEls.length) return;

  const lineEl = lineEls[cursorLine];
  const lineRect = lineEl.getBoundingClientRect();
  const charWidth = measureCharWidth();
  const lineHeight = lineRect.height;

  const cursor = document.createElement('div');
  cursor.className = 'cursor';
  cursor.style.left = `${12 + cursorCol * charWidth}px`;
  cursor.style.top = `${lineEl.offsetTop}px`;
  cursor.style.height = `${lineHeight}px`;
  editorEl.appendChild(cursor);

  const cursorTop = lineEl.offsetTop;
  const cursorBottom = cursorTop + lineHeight;
  if (cursorBottom > editorEl.scrollTop + editorEl.clientHeight) {
    editorEl.scrollTop = cursorBottom - editorEl.clientHeight;
  } else if (cursorTop < editorEl.scrollTop) {
    editorEl.scrollTop = cursorTop;
  }
}

function renderSelection() {
  editorEl.querySelectorAll('.selection-highlight').forEach(el => el.remove());
  const sel = getSelectionRange();
  if (!sel) return;

  const charWidth = measureCharWidth();
  const lineEls = editorEl.querySelectorAll('.line');

  for (let i = sel.startLine; i <= sel.endLine && i < lineEls.length; i++) {
    const lineEl = lineEls[i];
    const lineText = lines[i]?.text || '';
    const lineLen = lineText.length;

    const colStart = (i === sel.startLine) ? sel.startCol : 0;
    let colEnd = (i === sel.endLine) ? sel.endCol : lineLen;

    if (i !== sel.endLine) colEnd = Math.max(colEnd, lineLen) + 1;

    if (colStart >= colEnd) continue;

    const overlay = document.createElement('div');
    overlay.className = 'selection-highlight';
    overlay.style.left = `${12 + colStart * charWidth}px`;
    overlay.style.top = `${lineEl.offsetTop}px`;
    overlay.style.width = `${Math.max((colEnd - colStart) * charWidth, charWidth * 0.5)}px`;
    overlay.style.height = `${lineEl.offsetHeight}px`;
    editorEl.appendChild(overlay);
  }
}

function renderFindHighlights() {
  editorEl.querySelectorAll('.find-match-overlay').forEach(el => el.remove());
  if (!findOpen || findMatches.length === 0) return;

  const charWidth = measureCharWidth();
  const lineEls = editorEl.querySelectorAll('.line');

  for (let mi = 0; mi < findMatches.length; mi++) {
    const m = findMatches[mi];
    if (m.line >= lineEls.length) continue;
    const lineEl = lineEls[m.line];

    const overlay = document.createElement('div');
    overlay.className = 'find-match-overlay';
    overlay.style.position = 'absolute';
    overlay.style.left = `${12 + m.col * charWidth}px`;
    overlay.style.top = `${lineEl.offsetTop}px`;
    overlay.style.width = `${m.length * charWidth}px`;
    overlay.style.height = `${lineEl.offsetHeight}px`;
    overlay.style.pointerEvents = 'none';
    overlay.style.zIndex = '4';
    overlay.style.borderRadius = '2px';

    if (mi === findCurrentIdx) {
      overlay.style.background = 'rgba(250, 179, 135, 0.6)';
      overlay.style.border = '1px solid #fab387';
    } else {
      overlay.style.background = 'rgba(250, 179, 135, 0.3)';
      overlay.style.border = '1px solid rgba(250, 179, 135, 0.6)';
    }
    editorEl.appendChild(overlay);
  }
}

let _charWidth = null;
function measureCharWidth() {
  if (_charWidth) return _charWidth;
  const span = document.createElement('span');
  span.style.fontFamily = getComputedStyle(editorEl).fontFamily;
  span.style.fontSize = getComputedStyle(editorEl).fontSize;
  span.style.position = 'absolute';
  span.style.visibility = 'hidden';
  span.textContent = 'M';
  document.body.appendChild(span);
  _charWidth = span.getBoundingClientRect().width;
  document.body.removeChild(span);
  return _charWidth;
}

window.addEventListener('resize', () => { _charWidth = null; });

function updateStatusBar() {
  let pos = `Ln ${cursorLine + 1}, Col ${cursorCol + 1}`;
  if (hasSelection()) {
    const sel = getSelectionRange();
    const selLines = sel.endLine - sel.startLine + 1;
    pos += ` (${selLines} line${selLines > 1 ? 's' : ''} selected)`;
  }
  cursorPosEl.textContent = pos;
}

// ─── Minimap ──────────────────────────────────────────────────

function renderMinimap() {
  if (lines.length < 50) {
    minimapEl.classList.add('minimap-hidden');
    return;
  }
  minimapEl.classList.remove('minimap-hidden');

  const scale = 2;
  const lineH = scale;
  const width = 80;
  const height = Math.min(lines.length * lineH, editorEl.clientHeight);

  minimapCanvas.width = width;
  minimapCanvas.height = height;
  const ctx = minimapCanvas.getContext('2d');
  ctx.clearRect(0, 0, width, height);

  const ratio = height / (lines.length * lineH);

  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]?.text || '';
    const y = Math.floor(i * lineH * ratio);
    if (y >= height) break;

    // Draw a thin representation of text
    const indent = text.length - text.trimStart().length;
    const textLen = Math.min(text.trim().length, 60);
    if (textLen > 0) {
      ctx.fillStyle = 'rgba(205, 214, 244, 0.3)';
      ctx.fillRect(indent * 0.8, y, textLen * 0.8, Math.max(lineH * ratio, 1));
    }
  }

  // Viewport indicator
  const computedLH = parseFloat(getComputedStyle(editorEl).lineHeight);
  const lineHeightPx = Number.isNaN(computedLH)
    ? parseFloat(getComputedStyle(editorEl).fontSize) * 1.5
    : computedLH;
  const totalH = lines.length * lineHeightPx;
  const vpFraction = editorEl.clientHeight / totalH;
  const vpTop = (editorEl.scrollTop / totalH) * height;
  const vpH = Math.max(vpFraction * height, 10);

  minimapViewport.style.top = `${vpTop}px`;
  minimapViewport.style.height = `${vpH}px`;
}

editorEl.addEventListener('scroll', () => {
  renderMinimap();
});

// ─── File Explorer ────────────────────────────────────────────

function toggleSidebar() {
  sidebarOpen = !sidebarOpen;
  if (sidebarOpen) {
    sidebarEl.classList.remove('sidebar-hidden');
    if (!explorerRoot) {
      // Ask user to open a folder
      openFolderDialog();
    }
  } else {
    sidebarEl.classList.add('sidebar-hidden');
  }
}

function closeSidebar() {
  sidebarOpen = false;
  sidebarEl.classList.add('sidebar-hidden');
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

      // Indent
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
    renderContent(content);
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

document.addEventListener('keydown', async (e) => {
  // Ctrl+Shift+P: Command Palette
  if (e.ctrlKey && e.shiftKey && e.key === 'P') {
    e.preventDefault();
    paletteOpen ? closePalette() : openPalette();
    return;
  }

  // Don't handle editor keys when palette is open
  if (paletteOpen) return;

  // M6: Don't handle editor keys when symbols palette is open
  if (symbolsOpen) return;

  // M6: Autocomplete navigation when popup is open
  if (acOpen) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      acSelectedIdx = Math.min(acSelectedIdx + 1, autocompleteList.children.length - 1);
      updateAcSelection();
      const items = autocompleteList.querySelectorAll('.ac-item');
      if (items[acSelectedIdx]) showAcDetail(acItems[acSelectedIdx]);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      acSelectedIdx = Math.max(acSelectedIdx - 1, 0);
      updateAcSelection();
      const items = autocompleteList.querySelectorAll('.ac-item');
      if (items[acSelectedIdx]) showAcDetail(acItems[acSelectedIdx]);
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
    // Let other keys fall through to typing (will update filter)
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

  // M6: Escape closes LSP popups
  if (e.key === 'Escape' && (hoverOpen || sigHelpOpen || refsOpen)) {
    e.preventDefault();
    closeLspPopups();
    return;
  }

  // M6: Ctrl+Shift+O — Document symbols
  if (e.ctrlKey && e.shiftKey && e.key === 'O') {
    e.preventDefault();
    openSymbolOutline();
    return;
  }

  // M6: Ctrl+Shift+F — Format document
  if (e.ctrlKey && e.shiftKey && e.key === 'F') {
    e.preventDefault();
    formatDocument();
    return;
  }

  // M6: Ctrl+Space — Trigger autocomplete
  if (e.ctrlKey && e.key === ' ') {
    e.preventDefault();
    triggerAutocomplete(null);
    return;
  }

  // M6: F12 — Go to definition
  if (e.key === 'F12' && !e.shiftKey && !e.ctrlKey) {
    e.preventDefault();
    goToDefinition();
    return;
  }

  // M6: Shift+F12 — Find references
  if (e.key === 'F12' && e.shiftKey && !e.ctrlKey) {
    e.preventDefault();
    findReferences();
    return;
  }

  // M6: Ctrl+. — Code actions
  if (e.ctrlKey && e.key === '.') {
    e.preventDefault();
    requestCodeActions();
    return;
  }

  // ── Find bar keys (when find inputs are focused) ──
  if (findOpen && (document.activeElement === findInputEl || document.activeElement === replaceInputEl)) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeFindBar();
      return;
    }
    if (e.key === 'Enter' && document.activeElement === findInputEl) {
      e.preventDefault();
      e.shiftKey ? findPrev() : findNext();
      return;
    }
    if (e.key === 'Enter' && document.activeElement === replaceInputEl) {
      e.preventDefault();
      replaceOne();
      return;
    }
    return;
  }

  // ── Global shortcuts ──

  // Ctrl+B: Toggle sidebar
  if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'b') {
    e.preventDefault();
    toggleSidebar();
    return;
  }

  // Ctrl+Tab / Ctrl+Shift+Tab: Cycle tabs
  if (e.ctrlKey && e.key === 'Tab') {
    e.preventDefault();
    await cycleTab(e.shiftKey ? -1 : 1);
    return;
  }

  // Ctrl+W: Close current tab
  if (e.ctrlKey && e.key.toLowerCase() === 'w') {
    e.preventDefault();
    if (activeBufferPath) await closeTab(activeBufferPath);
    return;
  }

  if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    openFindBar(false);
    return;
  }

  if (e.ctrlKey && e.key.toLowerCase() === 'h') {
    e.preventDefault();
    openFindBar(true);
    return;
  }

  if (e.ctrlKey && e.key === '`') {
    e.preventDefault();
    toggleOutputPanel();
    return;
  }

  if (e.key === 'Escape') {
    if (findOpen) { closeFindBar(); return; }
    if (outputOpen) { closeOutputPanel(); return; }
  }

  // Only handle editor keys when editor is focused
  if (document.activeElement !== editorEl) return;

  // ── Undo / Redo ──

  if (e.ctrlKey && ((e.shiftKey && e.key.toLowerCase() === 'z') || (!e.shiftKey && e.key.toLowerCase() === 'y'))) {
    e.preventDefault();
    clearSelection();
    const content = await invoke('edit_redo');
    renderContent(content);
    return;
  }

  if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    clearSelection();
    const content = await invoke('edit_undo');
    renderContent(content);
    return;
  }

  // ── Select All ──

  if (e.ctrlKey && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    selAnchorLine = 0;
    selAnchorCol = 0;
    cursorLine = lines.length - 1;
    cursorCol = (lines[cursorLine]?.text || '').length;
    renderCursor();
    renderSelection();
    updateStatusBar();
    return;
  }

  // ── Clipboard ──

  if (e.ctrlKey && e.key.toLowerCase() === 'c') {
    e.preventDefault();
    if (hasSelection()) {
      const sel = getSelectionRange();
      const text = await invoke('get_text_range', {
        startLine: sel.startLine, startCol: sel.startCol,
        endLine: sel.endLine, endCol: sel.endCol,
      });
      await navigator.clipboard.writeText(text);
    }
    return;
  }

  if (e.ctrlKey && e.key.toLowerCase() === 'x') {
    e.preventDefault();
    if (hasSelection()) {
      const sel = getSelectionRange();
      const text = await invoke('get_text_range', {
        startLine: sel.startLine, startCol: sel.startCol,
        endLine: sel.endLine, endCol: sel.endCol,
      });
      await navigator.clipboard.writeText(text);
      const content = await invoke('edit_replace_range', {
        startLine: sel.startLine, startCol: sel.startCol,
        endLine: sel.endLine, endCol: sel.endCol,
        text: '',
      });
      cursorLine = sel.startLine;
      cursorCol = sel.startCol;
      clearSelection();
      renderContent(content);
    }
    return;
  }

  if (e.ctrlKey && e.key.toLowerCase() === 'v') {
    e.preventDefault();
    try {
      const clipText = await navigator.clipboard.readText();
      if (!clipText) return;
      const MAX_PASTE_SIZE = 1024 * 1024; // 1 MB, matches backend MAX_INSERT_SIZE
      if (clipText.length > MAX_PASTE_SIZE) {
        statusEl.textContent = `Paste too large (${(clipText.length / 1024 / 1024).toFixed(1)} MB, max 1 MB)`;
        return;
      }

      let startLine, startCol;
      if (hasSelection()) {
        const sel = getSelectionRange();
        startLine = sel.startLine;
        startCol = sel.startCol;
        const content = await invoke('edit_replace_range', {
          startLine: sel.startLine, startCol: sel.startCol,
          endLine: sel.endLine, endCol: sel.endCol,
          text: clipText,
        });
        clearSelection();
        setCursorAfterInsert(startLine, startCol, clipText);
        renderContent(content);
      } else {
        startLine = cursorLine;
        startCol = cursorCol;
        const content = await invoke('edit_insert', {
          line: cursorLine, col: cursorCol, text: clipText,
        });
        setCursorAfterInsert(startLine, startCol, clipText);
        renderContent(content);
      }
    } catch (err) {
      console.error('Paste error:', err);
    }
    return;
  }

  // ── Ctrl+O: Open file ──
  if (e.ctrlKey && e.key.toLowerCase() === 'o') {
    e.preventDefault();
    await openFileDialog();
    return;
  }

  // ── Ctrl+S: Save ──
  if (e.ctrlKey && e.key.toLowerCase() === 's') {
    e.preventDefault();
    await saveFile();
    return;
  }

  // ── Navigation (Shift = extend selection) ──

  if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (e.shiftKey) ensureAnchor();
    else if (hasSelection()) clearSelection();
    if (cursorLine > 0) {
      cursorLine--;
      cursorCol = Math.min(cursorCol, (lines[cursorLine]?.text || '').length);
    }
    if (!e.shiftKey) clearSelection();
    renderCursor(); renderSelection(); updateStatusBar();
    return;
  }

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (e.shiftKey) ensureAnchor();
    else if (hasSelection()) clearSelection();
    if (cursorLine < lines.length - 1) {
      cursorLine++;
      cursorCol = Math.min(cursorCol, (lines[cursorLine]?.text || '').length);
    }
    if (!e.shiftKey) clearSelection();
    renderCursor(); renderSelection(); updateStatusBar();
    return;
  }

  if (e.key === 'ArrowLeft') {
    e.preventDefault();
    if (e.shiftKey) {
      ensureAnchor();
      if (cursorCol > 0) cursorCol--;
      else if (cursorLine > 0) { cursorLine--; cursorCol = (lines[cursorLine]?.text || '').length; }
    } else if (hasSelection()) {
      const sel = getSelectionRange();
      cursorLine = sel.startLine;
      cursorCol = sel.startCol;
      clearSelection();
    } else {
      if (cursorCol > 0) cursorCol--;
      else if (cursorLine > 0) { cursorLine--; cursorCol = (lines[cursorLine]?.text || '').length; }
    }
    renderCursor(); renderSelection(); updateStatusBar();
    return;
  }

  if (e.key === 'ArrowRight') {
    e.preventDefault();
    if (e.shiftKey) {
      ensureAnchor();
      const lineLen = (lines[cursorLine]?.text || '').length;
      if (cursorCol < lineLen) cursorCol++;
      else if (cursorLine < lines.length - 1) { cursorLine++; cursorCol = 0; }
    } else if (hasSelection()) {
      const sel = getSelectionRange();
      cursorLine = sel.endLine;
      cursorCol = sel.endCol;
      clearSelection();
    } else {
      const lineLen = (lines[cursorLine]?.text || '').length;
      if (cursorCol < lineLen) cursorCol++;
      else if (cursorLine < lines.length - 1) { cursorLine++; cursorCol = 0; }
    }
    renderCursor(); renderSelection(); updateStatusBar();
    return;
  }

  if (e.key === 'Home') {
    e.preventDefault();
    if (e.shiftKey) ensureAnchor();
    cursorCol = 0;
    if (!e.shiftKey) clearSelection();
    renderCursor(); renderSelection(); updateStatusBar();
    return;
  }

  if (e.key === 'End') {
    e.preventDefault();
    if (e.shiftKey) ensureAnchor();
    cursorCol = (lines[cursorLine]?.text || '').length;
    if (!e.shiftKey) clearSelection();
    renderCursor(); renderSelection(); updateStatusBar();
    return;
  }

  // ── Editing keys ──

  if (e.key === 'Enter') {
    e.preventDefault();
    if (hasSelection()) {
      const sel = getSelectionRange();
      const content = await invoke('edit_replace_range', {
        startLine: sel.startLine, startCol: sel.startCol,
        endLine: sel.endLine, endCol: sel.endCol, text: '\n',
      });
      cursorLine = sel.startLine + 1;
      cursorCol = 0;
      clearSelection();
      renderContent(content);
    } else {
      const content = await invoke('edit_newline', { line: cursorLine, col: cursorCol });
      cursorLine++;
      cursorCol = 0;
      renderContent(content);
    }
    return;
  }

  if (e.key === 'Backspace') {
    e.preventDefault();
    if (hasSelection()) {
      const sel = getSelectionRange();
      const content = await invoke('edit_replace_range', {
        startLine: sel.startLine, startCol: sel.startCol,
        endLine: sel.endLine, endCol: sel.endCol, text: '',
      });
      cursorLine = sel.startLine;
      cursorCol = sel.startCol;
      clearSelection();
      renderContent(content);
    } else {
      if (cursorLine === 0 && cursorCol === 0) return;
      const content = await invoke('edit_backspace', { line: cursorLine, col: cursorCol });
      if (cursorCol > 0) {
        cursorCol--;
      } else if (cursorLine > 0) {
        cursorLine--;
        cursorCol = (content.lines[cursorLine]?.text || '').length;
      }
      renderContent(content);
    }
    // M6: Update autocomplete filter on backspace
    if (acOpen) {
      if (acFilterText.length > 0) {
        acFilterText = acFilterText.slice(0, -1);
        renderAutocomplete();
      } else {
        closeAutocomplete();
      }
    }
    return;
  }

  if (e.key === 'Delete') {
    e.preventDefault();
    if (hasSelection()) {
      const sel = getSelectionRange();
      const content = await invoke('edit_replace_range', {
        startLine: sel.startLine, startCol: sel.startCol,
        endLine: sel.endLine, endCol: sel.endCol, text: '',
      });
      cursorLine = sel.startLine;
      cursorCol = sel.startCol;
      clearSelection();
      renderContent(content);
    } else {
      const content = await invoke('edit_delete', { line: cursorLine, col: cursorCol, len: 1 });
      renderContent(content);
    }
    return;
  }

  if (e.key === 'Tab') {
    e.preventDefault();
    if (hasSelection()) {
      const sel = getSelectionRange();
      const content = await invoke('edit_replace_range', {
        startLine: sel.startLine, startCol: sel.startCol,
        endLine: sel.endLine, endCol: sel.endCol, text: '    ',
      });
      cursorLine = sel.startLine;
      cursorCol = sel.startCol + 4;
      clearSelection();
      renderContent(content);
    } else {
      const content = await invoke('edit_insert', { line: cursorLine, col: cursorCol, text: '    ' });
      cursorCol += 4;
      renderContent(content);
    }
    return;
  }

  // Regular character input
  if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    if (hasSelection()) {
      const sel = getSelectionRange();
      const content = await invoke('edit_replace_range', {
        startLine: sel.startLine, startCol: sel.startCol,
        endLine: sel.endLine, endCol: sel.endCol, text: e.key,
      });
      cursorLine = sel.startLine;
      cursorCol = sel.startCol + 1;
      clearSelection();
      renderContent(content);
    } else {
      const content = await invoke('edit_insert', { line: cursorLine, col: cursorCol, text: e.key });
      cursorCol++;
      renderContent(content);
    }

    // M6: Trigger signature help on ( and ,
    if (e.key === '(' || e.key === ',') {
      requestSignatureHelp(e.key);
    } else if (e.key === ')') {
      closeSignatureHelp();
    }

    // M6: Trigger/update autocomplete on . and word characters
    if (e.key === '.') {
      triggerAutocomplete('.');
    } else if (acOpen && /[a-zA-Z0-9_$]/.test(e.key)) {
      acFilterText += e.key;
      renderAutocomplete();
    } else if (acOpen && e.key === ' ') {
      closeAutocomplete();
    }

    return;
  }
});

// Helper: position cursor at end of inserted text
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
  renderCursor();
  renderSelection();
  updateStatusBar();
  editorEl.focus();
});

document.addEventListener('mousemove', (e) => {
  if (!isDragging) return;
  const pos = posFromMouse(e);
  cursorLine = pos.line;
  cursorCol = pos.col;
  renderCursor();
  renderSelection();
  updateStatusBar();
});

document.addEventListener('mouseup', () => {
  if (!isDragging) return;
  isDragging = false;
  if (selAnchorLine === cursorLine && selAnchorCol === cursorCol) {
    clearSelection();
    renderSelection();
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
      renderContent(content);
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
    const content = await invoke('get_content');
    renderContent(content);
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
      const lineText = lines[sel.startLine]?.text || '';
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
  renderFindHighlights();
  editorEl.focus();
}

async function runFind() {
  const query = findInputEl.value;
  if (!query) {
    findMatches = [];
    findCurrentIdx = -1;
    findCountEl.textContent = '';
    renderFindHighlights();
    return;
  }
  const caseSensitive = findCaseEl.checked;
  findMatches = await invoke('find_in_file', { query, caseSensitive });
  if (findMatches.length > 0) {
    findCurrentIdx = 0;
    for (let i = 0; i < findMatches.length; i++) {
      const m = findMatches[i];
      if (m.line > cursorLine || (m.line === cursorLine && m.col >= cursorCol)) {
        findCurrentIdx = i;
        break;
      }
    }
    findCountEl.textContent = `${findCurrentIdx + 1} of ${findMatches.length}`;
  } else {
    findCurrentIdx = -1;
    findCountEl.textContent = 'No results';
  }
  renderFindHighlights();
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
  renderCursor();
  renderSelection();
  renderFindHighlights();
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
  renderContent(result.content);
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
  renderContent(result.content);
  findMatches = [];
  findCurrentIdx = -1;
  findCountEl.textContent = `Replaced ${result.count}`;
  renderFindHighlights();
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

// ─── Status Bar Extension Items ──────────────────────────────

async function pollStatusBarItems() {
  try {
    const items = await invoke('get_status_bar_items');
    if (!items || items.length === 0) {
      extStatusBarEl.innerHTML = '';
      return;
    }
    items.sort((a, b) => (b.priority || 0) - (a.priority || 0));
    extStatusBarEl.innerHTML = '';
    for (const item of items) {
      const span = document.createElement('span');
      span.className = 'ext-sb-item';
      span.textContent = item.text;
      if (item.tooltip) span.title = item.tooltip;
      if (item.command) {
        span.addEventListener('click', () => {
          invoke('execute_command', { command: item.command });
        });
      }
      extStatusBarEl.appendChild(span);
    }
  } catch (err) {
    // Ignore
  }
}

const statusBarInterval = setInterval(pollStatusBarItems, 2000);

// ─── Output Panel ────────────────────────────────────────────

function toggleOutputPanel() {
  outputOpen ? closeOutputPanel() : openOutputPanel();
}

function openOutputPanel() {
  outputOpen = true;
  outputPanelEl.classList.remove('output-hidden');
}

function closeOutputPanel() {
  outputOpen = false;
  outputPanelEl.classList.add('output-hidden');
}

async function pollOutputLines() {
  if (!outputOpen) return;
  try {
    const newLines = await invoke('get_output_lines');
    if (!newLines || newLines.length === 0) return;
    outputAllLines.push(...newLines);

    const channels = [...new Set(outputAllLines.map(l => l.channel))];
    if (!outputSelectedChannel && channels.length > 0) {
      outputSelectedChannel = channels[0];
    }

    outputChannelSelect.innerHTML = '';
    for (const ch of channels) {
      const opt = document.createElement('option');
      opt.value = ch;
      opt.textContent = ch;
      opt.selected = ch === outputSelectedChannel;
      outputChannelSelect.appendChild(opt);
    }

    renderOutputContent();
  } catch (err) {
    // Ignore
  }
}

function renderOutputContent() {
  const filtered = outputAllLines.filter(l => l.channel === outputSelectedChannel);
  outputContentEl.textContent = filtered.map(l => l.text).join('');
  outputContentEl.scrollTop = outputContentEl.scrollHeight;
}

outputChannelSelect.addEventListener('change', (e) => {
  outputSelectedChannel = e.target.value;
  renderOutputContent();
});

outputClearBtn.addEventListener('click', () => {
  outputAllLines = outputAllLines.filter(l => l.channel !== outputSelectedChannel);
  renderOutputContent();
});

outputCloseBtn.addEventListener('click', closeOutputPanel);

const outputInterval = setInterval(pollOutputLines, 1000);

// ─── Diagnostics Polling ─────────────────────────────────────

async function refreshDiagnostics() {
  try {
    const content = await invoke('get_content');
    renderContent(content);
  } catch (err) {
    // Ignore
  }
}

const diagnosticsInterval = setInterval(refreshDiagnostics, 2000);

// ─── Extension Host Status Polling ───────────────────────────

async function pollExtHostStatus() {
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
  try {
    const notifications = await invoke('get_notifications');
    for (const n of notifications) showToast(n.type, n.message);
  } catch (err) {
    // Ignore
  }
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
    setTimeout(() => {
      toast.remove();
      activeToasts = activeToasts.filter(t => t !== toast);
      repositionToasts();
    }, 300);
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
  try {
    const requests = await invoke('get_ui_requests');
    for (const req of requests) {
      if (req.kind === 'showQuickPick') handleQuickPick(req);
      else if (req.kind === 'showInputBox') handleInputBox(req);
    }
  } catch (err) {
    // Ignore
  }
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
    const filtered = q
      ? items.filter(i => (i.label || '').toLowerCase().includes(q) || (i.description || '').toLowerCase().includes(q))
      : items;

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
      item.addEventListener('click', () => {
        closePaletteAndRespond(req.request_id, filtered[idx].label);
      });
      paletteListEl.appendChild(item);
    }
  };

  renderItems('');

  function onQuickPickInput() {
    paletteSelectedIndex = 0;
    renderItems(paletteInputEl.value);
  }

  function onQuickPickKeydown(e) {
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
      const selected = paletteListEl.querySelectorAll('.palette-item')[paletteSelectedIndex];
      if (selected) selected.click();
    } else if (e.key === 'Escape') {
      closePaletteAndRespond(req.request_id, null);
    }
  }

  function onQuickPickBackdropClick() {
    closePaletteAndRespond(req.request_id, null);
  }

  // Use AbortController to cleanly remove all temporary listeners at once
  const qpAbort = new AbortController();
  paletteInputEl.removeEventListener('input', paletteInputHandler);
  paletteInputEl.removeEventListener('keydown', paletteKeydownHandler);
  paletteBackdropEl.removeEventListener('click', closePalette);
  paletteInputEl.addEventListener('input', onQuickPickInput, { signal: qpAbort.signal });
  paletteInputEl.addEventListener('keydown', onQuickPickKeydown, { signal: qpAbort.signal });
  paletteBackdropEl.addEventListener('click', onQuickPickBackdropClick, { signal: qpAbort.signal });

  function closePaletteAndRespond(requestId, value) {
    paletteOpen = false;
    paletteEl.classList.add('palette-hidden');
    paletteInputEl.placeholder = 'Type a command...';
    qpAbort.abort(); // Remove all temporary listeners at once
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

  function onInputBoxKeydown(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      closeInputAndRespond(req.request_id, paletteInputEl.value);
    } else if (e.key === 'Escape') {
      closeInputAndRespond(req.request_id, null);
    }
  }

  function onInputBoxBackdropClick() {
    closeInputAndRespond(req.request_id, null);
  }

  // Use AbortController to cleanly remove all temporary listeners at once
  const ibAbort = new AbortController();
  paletteInputEl.removeEventListener('input', paletteInputHandler);
  paletteInputEl.removeEventListener('keydown', paletteKeydownHandler);
  paletteBackdropEl.removeEventListener('click', closePalette);
  paletteInputEl.addEventListener('keydown', onInputBoxKeydown, { signal: ibAbort.signal });
  paletteBackdropEl.addEventListener('click', onInputBoxBackdropClick, { signal: ibAbort.signal });

  function closeInputAndRespond(requestId, value) {
    paletteOpen = false;
    paletteEl.classList.add('palette-hidden');
    paletteInputEl.placeholder = 'Type a command...';
    ibAbort.abort(); // Remove all temporary listeners at once
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

// --- M6: DOM References ---
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

// --- M6: State ---
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
  // Windows path → file URI
  if (activeBufferPath.match(/^[a-zA-Z]:\\/)) {
    return 'file:///' + activeBufferPath.replace(/\\/g, '/');
  }
  return 'file://' + activeBufferPath;
}

// --- M6: Autocomplete ---

async function triggerAutocomplete(triggerChar) {
  const uri = getActiveUri();
  if (!uri) return;
  try {
    const result = await invoke('lsp_completion', {
      uri,
      line: cursorLine,
      character: cursorCol,
      triggerKind: triggerChar ? 2 : 1,
      triggerCharacter: triggerChar || null,
    });
    if (!result || !result.items || result.items.length === 0) {
      closeAutocomplete();
      return;
    }
    acItems = result.items;
    acSelectedIdx = 0;
    acFilterText = '';
    acOpen = true;
    renderAutocomplete();
    positionAutocomplete();
  } catch (err) {
    // No provider or timeout — silently close
    closeAutocomplete();
  }
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
    div.addEventListener('mouseenter', () => {
      acSelectedIdx = i;
      updateAcSelection();
      showAcDetail(item);
    });
    autocompleteList.appendChild(div);
  }
  if (max > 0) showAcDetail(filtered[acSelectedIdx]);
  autocompletePopup.classList.remove('lsp-hidden');
}

function updateAcSelection() {
  const items = autocompleteList.querySelectorAll('.ac-item');
  items.forEach((el, i) => el.classList.toggle('selected', i === acSelectedIdx));
  if (items[acSelectedIdx]) {
    items[acSelectedIdx].scrollIntoView({ block: 'nearest' });
  }
}

function showAcDetail(item) {
  autocompleteDetail.textContent = item.documentation || item.detail || '';
}

function positionAutocomplete() {
  const charWidth = measureCharWidth();
  const lineEls = editorEl.querySelectorAll('.line');
  if (cursorLine >= lineEls.length) return;
  const lineEl = lineEls[cursorLine];
  const editorRect = editorEl.getBoundingClientRect();
  const lineRect = lineEl.getBoundingClientRect();

  let left = editorRect.left + 12 + cursorCol * charWidth - editorEl.scrollLeft;
  let top = lineRect.bottom;

  // Ensure popup stays in viewport
  if (left + 450 > window.innerWidth) left = window.innerWidth - 460;
  if (top + 250 > window.innerHeight) top = lineRect.top - 250;

  autocompletePopup.style.left = `${Math.max(0, left)}px`;
  autocompletePopup.style.top = `${Math.max(0, top)}px`;
}

async function acceptCompletion(item) {
  closeAutocomplete();
  const insertText = item.insertText || item.label || '';
  if (!insertText) return;

  // Delete any filter text already typed
  if (acFilterText) {
    const content = await invoke('edit_replace_range', {
      startLine: cursorLine, startCol: cursorCol - acFilterText.length,
      endLine: cursorLine, endCol: cursorCol,
      text: insertText,
    });
    cursorCol = cursorCol - acFilterText.length + insertText.length;
    renderContent(content);
  } else {
    const content = await invoke('edit_insert', { line: cursorLine, col: cursorCol, text: insertText });
    cursorCol += insertText.length;
    renderContent(content);
  }
}

function closeAutocomplete() {
  acOpen = false;
  acItems = [];
  acFilterText = '';
  autocompletePopup.classList.add('lsp-hidden');
  autocompleteDetail.textContent = '';
}

function acKindClass(kind) {
  const map = { 1: 'ac-icon-method', 2: 'ac-icon-function', 3: 'ac-icon-function',
    4: 'ac-icon-field', 5: 'ac-icon-variable', 6: 'ac-icon-class',
    7: 'ac-icon-interface', 8: 'ac-icon-module', 9: 'ac-icon-property',
    12: 'ac-icon-enum', 13: 'ac-icon-keyword', 14: 'ac-icon-snippet',
    16: 'ac-icon-file', 18: 'ac-icon-folder', 20: 'ac-icon-constant' };
  return map[kind] || 'ac-icon-text';
}

function acKindLetter(kind) {
  const map = { 1: 'M', 2: 'F', 3: 'C', 4: 'F', 5: 'V', 6: 'C', 7: 'I', 8: 'M',
    9: 'P', 12: 'E', 13: 'K', 14: 'S', 16: '📄', 18: '📁', 20: 'C' };
  return map[kind] || 'T';
}

// --- M6: Hover ---

function scheduleHover(line, col) {
  cancelHover();
  hoverTimer = setTimeout(() => requestHover(line, col), 500);
}

function cancelHover() {
  if (hoverTimer) {
    clearTimeout(hoverTimer);
    hoverTimer = null;
  }
}

async function requestHover(line, col) {
  const uri = getActiveUri();
  if (!uri) return;
  try {
    const result = await invoke('lsp_hover', { uri, line, character: col });
    if (!result || !result.contents) {
      closeHover();
      return;
    }
    hoverContent.textContent = '';
    const text = typeof result.contents === 'string' ? result.contents
      : Array.isArray(result.contents) ? result.contents.map(c => typeof c === 'string' ? c : c.value || '').join('\n')
      : result.contents.value || String(result.contents);
    hoverContent.textContent = text;
    hoverOpen = true;
    hoverTooltip.classList.remove('lsp-hidden');
    positionHover(line);
  } catch {
    closeHover();
  }
}

function positionHover(line) {
  const charWidth = measureCharWidth();
  const lineEls = editorEl.querySelectorAll('.line');
  if (line >= lineEls.length) return;
  const lineEl = lineEls[line];
  const editorRect = editorEl.getBoundingClientRect();
  const lineRect = lineEl.getBoundingClientRect();

  let left = editorRect.left + 12;
  let top = lineRect.top - 10;

  // Show above the line
  const tooltipHeight = hoverTooltip.offsetHeight || 100;
  if (top - tooltipHeight < 0) top = lineRect.bottom + 4;
  else top = top - tooltipHeight;

  hoverTooltip.style.left = `${Math.max(0, left)}px`;
  hoverTooltip.style.top = `${Math.max(0, top)}px`;
}

function closeHover() {
  hoverOpen = false;
  hoverTooltip.classList.add('lsp-hidden');
}

// Mouse hover on editor lines
editorEl.addEventListener('mousemove', (e) => {
  if (isDragging || acOpen) return;
  const pos = posFromMouse(e);
  if (e.ctrlKey) {
    // Ctrl+hover: show link underline
    cancelHover();
    closeHover();
    return;
  }
  scheduleHover(pos.line, pos.col);
});

editorEl.addEventListener('mouseleave', () => {
  cancelHover();
  setTimeout(() => {
    if (!hoverTooltip.matches(':hover')) closeHover();
  }, 200);
});

hoverTooltip.addEventListener('mouseleave', () => {
  closeHover();
});

// --- M6: Go-to-definition (Ctrl+Click / F12) ---

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
    if (loc.uri && loc.range) {
      await navigateToLocation(loc.uri, loc.range.start.line, loc.range.start.character);
    }
    statusEl.textContent = '';
  } catch (err) {
    statusEl.textContent = 'Definition unavailable';
    setTimeout(() => { statusEl.textContent = ''; }, 2000);
  }
}

async function navigateToLocation(uri, line, col) {
  // Convert URI to file path
  let path = uri;
  if (path.startsWith('file:///')) path = path.substring(8);
  else if (path.startsWith('file://')) path = path.substring(7);
  // On Windows, handle /C:/... → C:\...
  if (path.match(/^\/[a-zA-Z]:\//)) path = path.substring(1);
  // Only convert to backslashes on Windows
  if (navigator.platform.startsWith('Win')) path = path.replace(/\//g, '\\');

  try {
    saveBufferState();
    const content = await invoke('open_file', { path });
    activeBufferPath = content.file_path;
    cursorLine = line;
    cursorCol = col;
    clearSelection();
    renderContent(content);
    renderTabs();
    editorEl.focus();
  } catch (err) {
    statusEl.textContent = `Cannot open: ${err}`;
    setTimeout(() => { statusEl.textContent = ''; }, 2000);
  }
}

// Ctrl+Click handler
editorEl.addEventListener('click', async (e) => {
  if (e.ctrlKey && e.button === 0) {
    e.preventDefault();
    const pos = posFromMouse(e);
    cursorLine = pos.line;
    cursorCol = pos.col;
    await goToDefinition();
  }
});

// --- M6: Find References (Shift+F12) ---

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
  } catch (err) {
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

    div.addEventListener('click', () => {
      closeReferences();
      navigateToLocation(loc.uri, line, col);
    });
    referencesList.appendChild(div);
  }
  referencesPanel.classList.remove('lsp-hidden');
}

function closeReferences() {
  refsOpen = false;
  referencesPanel.classList.add('lsp-hidden');
}

referencesClose.addEventListener('click', closeReferences);

// --- M6: Code Actions (Ctrl+.) ---

async function requestCodeActions() {
  const uri = getActiveUri();
  if (!uri) return;

  let startLine = cursorLine, startChar = cursorCol, endLine = cursorLine, endChar = cursorCol;
  if (hasSelection()) {
    const sel = getSelectionRange();
    startLine = sel.startLine;
    startChar = sel.startCol;
    endLine = sel.endLine;
    endChar = sel.endCol;
  }

  try {
    const result = await invoke('lsp_code_action', {
      uri, startLine, startCharacter: startChar, endLine, endCharacter: endChar,
    });
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
    div.className = 'ca-item' + (i === caSelectedIdx ? ' selected' : '') +
      (action.isPreferred ? ' ca-item-preferred' : '');
    div.textContent = action.title || 'Unnamed action';
    div.addEventListener('click', () => executeCodeAction(action));
    codeActionsList.appendChild(div);
  }
  codeActionsMenu.classList.remove('lsp-hidden');
}

function positionCodeActions() {
  const charWidth = measureCharWidth();
  const lineEls = editorEl.querySelectorAll('.line');
  if (cursorLine >= lineEls.length) return;
  const lineEl = lineEls[cursorLine];
  const editorRect = editorEl.getBoundingClientRect();
  const lineRect = lineEl.getBoundingClientRect();

  let left = editorRect.left + 12 + cursorCol * charWidth - editorEl.scrollLeft;
  let top = lineRect.bottom + 2;

  codeActionsMenu.style.left = `${Math.max(0, left)}px`;
  codeActionsMenu.style.top = `${Math.max(0, top)}px`;
}

async function executeCodeAction(action) {
  closeCodeActions();
  if (action.command) {
    await invoke('execute_command', { command: action.command.command || action.command });
    setTimeout(refreshDiagnostics, 500);
  }
  if (action.edit && action.edit.changes) {
    // Apply workspace edits — sort end-to-start to preserve positions
    for (const [uri, edits] of Object.entries(action.edit.changes)) {
      const sorted = edits.slice().sort((a, b) => {
        if (b.range.start.line !== a.range.start.line) return b.range.start.line - a.range.start.line;
        return b.range.start.character - a.range.start.character;
      });
      for (const edit of sorted) {
        const r = edit.range;
        await invoke('edit_replace_range', {
          startLine: r.start.line, startCol: r.start.character,
          endLine: r.end.line, endCol: r.end.character,
          text: edit.newText,
        });
      }
    }
    const content = await invoke('get_content');
    renderContent(content);
  }
}

function closeCodeActions() {
  codeActionsOpen = false;
  codeActionsMenu.classList.add('lsp-hidden');
}

// --- M6: Signature Help ---

async function requestSignatureHelp(triggerChar) {
  const uri = getActiveUri();
  if (!uri) return;
  try {
    const result = await invoke('lsp_signature_help', {
      uri, line: cursorLine, character: cursorCol, triggerCharacter: triggerChar || null,
    });
    if (!result || !result.signatures || result.signatures.length === 0) {
      closeSignatureHelp();
      return;
    }
    sigHelpOpen = true;
    const sig = result.signatures[result.activeSignature ?? 0];
    signatureLabel.innerHTML = escapeHtml(sig.label);

    // Highlight active parameter
    if (sig.parameters && sig.parameters.length > 0) {
      const activeParam = sig.parameters[result.activeParameter ?? 0];
      if (activeParam) {
        const paramLabel = typeof activeParam.label === 'string' ? activeParam.label : sig.label.substring(activeParam.label[0], activeParam.label[1]);
        const idx = sig.label.indexOf(paramLabel);
        if (idx !== -1) {
          signatureLabel.innerHTML =
            escapeHtml(sig.label.substring(0, idx)) +
            '<span class="sig-active-param">' + escapeHtml(paramLabel) + '</span>' +
            escapeHtml(sig.label.substring(idx + paramLabel.length));
        }
      }
    }

    const docText = typeof sig.documentation === 'string' ? sig.documentation :
      sig.documentation?.value || '';
    signatureDocs.textContent = docText;

    signatureHelp.classList.remove('lsp-hidden');
    positionSignatureHelp();
  } catch {
    closeSignatureHelp();
  }
}

function positionSignatureHelp() {
  const charWidth = measureCharWidth();
  const lineEls = editorEl.querySelectorAll('.line');
  if (cursorLine >= lineEls.length) return;
  const lineEl = lineEls[cursorLine];
  const editorRect = editorEl.getBoundingClientRect();
  const lineRect = lineEl.getBoundingClientRect();

  let left = editorRect.left + 12 + cursorCol * charWidth - editorEl.scrollLeft;
  let top = lineRect.top - signatureHelp.offsetHeight - 4;
  if (top < 0) top = lineRect.bottom + 4;

  signatureHelp.style.left = `${Math.max(0, left)}px`;
  signatureHelp.style.top = `${Math.max(0, top)}px`;
}

function closeSignatureHelp() {
  sigHelpOpen = false;
  signatureHelp.classList.add('lsp-hidden');
}

// --- M6: Document Symbols (Ctrl+Shift+O) ---

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
  } catch (err) {
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
    if (sym.children) {
      result.push(...flattenSymbols(sym.children, name));
    }
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

    if (sym.detail) {
      const detail = document.createElement('span');
      detail.className = 'symbol-detail';
      detail.textContent = sym.detail;
      div.appendChild(detail);
    }

    div.addEventListener('click', () => {
      closeSymbolOutline();
      cursorLine = sym.line;
      cursorCol = sym.col;
      clearSelection();
      renderCursor();
      updateStatusBar();
    });
    symbolsList.appendChild(div);
  }
}

function symbolKindClass(kind) {
  const map = { 5: 'symbol-icon-method', 11: 'symbol-icon-function', 4: 'symbol-icon-class',
    10: 'symbol-icon-interface', 12: 'symbol-icon-variable', 6: 'symbol-icon-property',
    13: 'symbol-icon-constant', 9: 'symbol-icon-enum', 1: 'symbol-icon-module' };
  return map[kind] || 'symbol-icon-variable';
}

function symbolKindLetter(kind) {
  const map = { 5: 'M', 11: 'F', 4: 'C', 10: 'I', 12: 'V', 6: 'P', 13: 'K', 9: 'E', 1: 'M' };
  return map[kind] || 'S';
}

function closeSymbolOutline() {
  symbolsOpen = false;
  symbolsPalette.classList.add('palette-hidden');
  editorEl.focus();
}

symbolsInput.addEventListener('input', () => {
  symbolSelectedIdx = 0;
  renderSymbolList(symbolsInput.value);
});

symbolsInput.addEventListener('keydown', (e) => {
  const total = symbolsList.children.length;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    symbolSelectedIdx = Math.min(symbolSelectedIdx + 1, total - 1);
    updateSymbolSelection();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    symbolSelectedIdx = Math.max(symbolSelectedIdx - 1, 0);
    updateSymbolSelection();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const items = symbolsList.querySelectorAll('.symbol-item');
    if (items[symbolSelectedIdx]) items[symbolSelectedIdx].click();
  } else if (e.key === 'Escape') {
    closeSymbolOutline();
  }
});

symbolsBackdrop.addEventListener('click', closeSymbolOutline);

function updateSymbolSelection() {
  const items = symbolsList.querySelectorAll('.symbol-item');
  items.forEach((el, i) => el.classList.toggle('selected', i === symbolSelectedIdx));
  if (items[symbolSelectedIdx]) items[symbolSelectedIdx].scrollIntoView({ block: 'nearest' });
}

// --- M6: Formatting (Ctrl+Shift+F) ---

async function formatDocument() {
  const uri = getActiveUri();
  if (!uri) return;
  try {
    statusEl.textContent = 'Formatting...';
    const result = await invoke('lsp_format', { uri, tabSize: 2, insertSpaces: true });
    if (result && Array.isArray(result) && result.length > 0) {
      // Apply edits from end to start to preserve positions
      const edits = result.slice().sort((a, b) => {
        if (b.range.start.line !== a.range.start.line) return b.range.start.line - a.range.start.line;
        return b.range.start.character - a.range.start.character;
      });
      for (const edit of edits) {
        await invoke('edit_replace_range', {
          startLine: edit.range.start.line, startCol: edit.range.start.character,
          endLine: edit.range.end.line, endCol: edit.range.end.character,
          text: edit.newText,
        });
      }
      const content = await invoke('get_content');
      renderContent(content);
      statusEl.textContent = 'Formatted';
    } else {
      statusEl.textContent = 'No formatting changes';
    }
    setTimeout(() => { statusEl.textContent = ''; }, 2000);
  } catch (err) {
    statusEl.textContent = 'Formatting unavailable';
    setTimeout(() => { statusEl.textContent = ''; }, 2000);
  }
}

// --- M6: Global close on Escape ---

function closeLspPopups() {
  if (acOpen) closeAutocomplete();
  if (hoverOpen) closeHover();
  if (sigHelpOpen) closeSignatureHelp();
  if (codeActionsOpen) closeCodeActions();
  if (refsOpen) closeReferences();
  if (symbolsOpen) closeSymbolOutline();
}

// Close popups when clicking outside
document.addEventListener('click', (e) => {
  if (acOpen && !autocompletePopup.contains(e.target) && e.target !== editorEl) closeAutocomplete();
  if (codeActionsOpen && !codeActionsMenu.contains(e.target)) closeCodeActions();
});

// ─── Cleanup ─────────────────────────────────────────────────

// Track all polling intervals so they can be cleaned up on reload
const _ccIntervals = [statusBarInterval, outputInterval, diagnosticsInterval, extHostInterval, notifInterval, uiReqInterval];

window.addEventListener('beforeunload', () => {
  _ccIntervals.forEach(id => clearInterval(id));
});

// ─── Init ────────────────────────────────────────────────────

async function init() {
  // Clear stale intervals from previous hot-reload (beforeunload may not fire in Tauri)
  if (window._ccPrevIntervals) {
    window._ccPrevIntervals.forEach(id => clearInterval(id));
  }
  window._ccPrevIntervals = _ccIntervals;

  try {
    const content = await invoke('get_content');
    renderContent(content);
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
