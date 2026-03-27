/**
 * CoreCode M4 — Editor Frontend (Complete)
 *
 * Features:
 * - Text editing with syntax highlighting
 * - Diagnostics display (underlines + gutter markers)
 * - Command palette (Ctrl+Shift+P)
 * - Extension Host status
 * - Undo/Redo (Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y)
 * - Selection (Shift+Arrow, Ctrl+A, click-drag, Shift+click)
 * - Clipboard (Ctrl+C / Ctrl+X / Ctrl+V)
 * - Find/Replace (Ctrl+F / Ctrl+H)
 * - Extension status bar items
 * - Output panel (Ctrl+`)
 */

const { invoke } = window.__TAURI__.core;

// ─── State ───────────────────────────────────────────────────

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

  editorEl.innerHTML = '';
  gutterEl.innerHTML = '';

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
    gutterEl.appendChild(gutterLine);

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

    editorEl.appendChild(editorLine);
  }

  renderCursor();
  renderSelection();
  renderFindHighlights();
  updateStatusBar();
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

    // For intermediate lines, extend past EOL to visualize the newline
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
    { label: 'Save File', command: '__builtin:save' },
  ].filter(b => !q || b.label.toLowerCase().includes(q));
  renderPaletteList(builtins);
}

function renderPaletteList(builtins) {
  paletteListEl.innerHTML = '';
  for (let i = 0; i < builtins.length; i++) {
    const item = document.createElement('div');
    item.className = 'palette-item' + (i === paletteSelectedIndex ? ' selected' : '');
    item.innerHTML = `<span class="palette-label">Built-in</span>${escapeHtml(builtins[i].label)}`;
    const cmd = builtins[i].command;
    item.addEventListener('click', () => executePaletteCommand(cmd));
    paletteListEl.appendChild(item);
  }
  for (let i = 0; i < paletteFiltered.length; i++) {
    const idx = builtins.length + i;
    const item = document.createElement('div');
    item.className = 'palette-item' + (idx === paletteSelectedIndex ? ' selected' : '');
    item.innerHTML = `<span class="palette-label">Extension</span>${escapeHtml(paletteFiltered[i])}`;
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
  } else if (command === '__builtin:save') {
    await saveFile();
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
    return; // let find inputs handle their own typing
  }

  // ── Global shortcuts (work regardless of editor focus) ──

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
        { name: 'Code', extensions: ['js', 'ts', 'rs', 'py', 'jsx', 'tsx', 'json', 'html', 'css', 'md', 'txt'] },
        { name: 'All', extensions: ['*'] }
      ]
    });
    if (result) {
      statusEl.textContent = 'Opening...';
      const content = await invoke('open_file', { path: result });
      cursorLine = 0;
      cursorCol = 0;
      clearSelection();
      findMatches = [];
      findCurrentIdx = -1;
      renderContent(content);
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

  // Pre-fill from selection if single-line
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
    // Find match closest to (or after) cursor
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
  // Select the match
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

// Find bar event listeners
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
      let html = escapeHtml(filtered[i].label || '');
      if (filtered[i].description) {
        html += ` <span style="color: var(--fg-dim)">${escapeHtml(filtered[i].description)}</span>`;
      }
      item.innerHTML = html;
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

  paletteInputEl.removeEventListener('input', paletteInputHandler);
  paletteInputEl.removeEventListener('keydown', paletteKeydownHandler);
  paletteBackdropEl.removeEventListener('click', closePalette);
  paletteInputEl.addEventListener('input', onQuickPickInput);
  paletteInputEl.addEventListener('keydown', onQuickPickKeydown);
  paletteBackdropEl.addEventListener('click', onQuickPickBackdropClick);

  function closePaletteAndRespond(requestId, value) {
    paletteOpen = false;
    paletteEl.classList.add('palette-hidden');
    paletteInputEl.placeholder = 'Type a command...';
    paletteInputEl.removeEventListener('input', onQuickPickInput);
    paletteInputEl.removeEventListener('keydown', onQuickPickKeydown);
    paletteBackdropEl.removeEventListener('click', onQuickPickBackdropClick);
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

  paletteInputEl.removeEventListener('input', paletteInputHandler);
  paletteInputEl.removeEventListener('keydown', paletteKeydownHandler);
  paletteBackdropEl.removeEventListener('click', closePalette);
  paletteInputEl.addEventListener('keydown', onInputBoxKeydown);
  paletteBackdropEl.addEventListener('click', onInputBoxBackdropClick);

  function closeInputAndRespond(requestId, value) {
    paletteOpen = false;
    paletteEl.classList.add('palette-hidden');
    paletteInputEl.placeholder = 'Type a command...';
    paletteInputEl.removeEventListener('keydown', onInputBoxKeydown);
    paletteBackdropEl.removeEventListener('click', onInputBoxBackdropClick);
    paletteInputEl.addEventListener('input', paletteInputHandler);
    paletteInputEl.addEventListener('keydown', paletteKeydownHandler);
    paletteBackdropEl.addEventListener('click', closePalette);
    editorEl.focus();
    invoke('respond_ui_request', { requestId, value: value });
  }

  paletteInputEl.focus();
}

const uiReqInterval = setInterval(pollUiRequests, 500);

// ─── Cleanup ─────────────────────────────────────────────────

window.addEventListener('beforeunload', () => {
  clearInterval(diagnosticsInterval);
  clearInterval(extHostInterval);
  clearInterval(notifInterval);
  clearInterval(uiReqInterval);
  clearInterval(statusBarInterval);
  clearInterval(outputInterval);
});

// ─── Init ────────────────────────────────────────────────────

async function init() {
  try {
    const content = await invoke('get_content');
    renderContent(content);
    editorEl.focus();
    statusEl.textContent = 'Ready — Ctrl+O to open, Ctrl+Shift+P for commands';
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
