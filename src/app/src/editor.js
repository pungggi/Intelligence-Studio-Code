/**
 * CoreCode M2 — Editor Frontend
 *
 * Features:
 * - Text editing with syntax highlighting
 * - Diagnostics display (underlines + gutter markers)
 * - Command palette (Ctrl+Shift+P)
 * - Extension Host status
 */

const { invoke } = window.__TAURI__.core;

// --- State ---
let cursorLine = 0;
let cursorCol = 0;
let lines = [];
let filePath = null;
let modified = false;
let diagnostics = [];
let paletteOpen = false;
let paletteSelectedIndex = 0;
let paletteCommands = [];
let paletteFiltered = [];

// --- DOM ---
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

// --- Rendering ---

function renderContent(content) {
  lines = content.lines || [];
  filePath = content.file_path;
  modified = content.modified;
  diagnostics = content.diagnostics || [];

  // Title
  if (filePath) {
    const name = filePath.split('/').pop();
    fileNameEl.textContent = (modified ? '● ' : '') + name;
  } else {
    fileNameEl.textContent = 'CoreCode';
  }

  // Language badge
  if (content.language) {
    languageBadgeEl.textContent = content.language;
    languageBadgeEl.style.display = '';
  } else {
    languageBadgeEl.style.display = 'none';
  }

  // File info
  fileInfoEl.textContent = `${content.line_count} lines`;

  // Diagnostics count
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

  // Build a map of diagnostics per line
  const diagsByLine = new Map();
  for (const d of diagnostics) {
    if (!diagsByLine.has(d.line)) diagsByLine.set(d.line, []);
    diagsByLine.get(d.line).push(d);
  }

  // Editor lines
  editorEl.innerHTML = '';
  gutterEl.innerHTML = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineDiags = diagsByLine.get(i) || [];

    // Gutter line number
    const gutterLine = document.createElement('div');
    gutterLine.className = 'line';
    if (lineDiags.some(d => d.severity === 'error')) {
      gutterLine.classList.add('gutter-error');
    } else if (lineDiags.some(d => d.severity === 'warning')) {
      gutterLine.classList.add('gutter-warning');
    }
    gutterLine.textContent = String(i + 1);
    gutterEl.appendChild(gutterLine);

    // Editor line with syntax highlighting + diagnostics
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
  updateStatusBar();
}

function applyTokensAndDiags(text, tokens, diags) {
  if (!text) return '';

  // First apply tokens, then wrap diagnostic ranges
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
    if (d.col_start < end && d.col_end > start) {
      return `diag-${d.severity}`;
    }
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
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
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

  // Scroll cursor into view
  const cursorTop = lineEl.offsetTop;
  const cursorBottom = cursorTop + lineHeight;
  if (cursorBottom > editorEl.scrollTop + editorEl.clientHeight) {
    editorEl.scrollTop = cursorBottom - editorEl.clientHeight;
  } else if (cursorTop < editorEl.scrollTop) {
    editorEl.scrollTop = cursorTop;
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

function updateStatusBar() {
  cursorPosEl.textContent = `Ln ${cursorLine + 1}, Col ${cursorCol + 1}`;
}

// --- Command Palette ---

function openPalette() {
  paletteOpen = true;
  paletteEl.classList.remove('palette-hidden');
  paletteInputEl.value = '';
  paletteSelectedIndex = 0;

  // Fetch commands from backend
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

  // Always add built-in commands
  const builtins = [
    { label: 'Open File', command: '__builtin:open' },
    { label: 'Save File', command: '__builtin:save' },
  ].filter(b => !q || b.label.toLowerCase().includes(q));

  renderPaletteList(builtins);
}

function renderPaletteList(builtins) {
  paletteListEl.innerHTML = '';

  // Built-in commands first
  for (let i = 0; i < builtins.length; i++) {
    const item = document.createElement('div');
    item.className = 'palette-item' + (i === paletteSelectedIndex ? ' selected' : '');
    item.innerHTML = `<span class="palette-label">Built-in</span>${escapeHtml(builtins[i].label)}`;
    const cmd = builtins[i].command;
    item.addEventListener('click', () => executePaletteCommand(cmd));
    paletteListEl.appendChild(item);
  }

  // Extension commands
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
    // Refresh diagnostics after command execution
    setTimeout(refreshDiagnostics, 500);
  }
}

paletteInputEl.addEventListener('input', () => {
  paletteSelectedIndex = 0;
  filterPalette(paletteInputEl.value);
});

paletteInputEl.addEventListener('keydown', (e) => {
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
    if (items[paletteSelectedIndex]) {
      items[paletteSelectedIndex].click();
    }
  } else if (e.key === 'Escape') {
    closePalette();
  }
});

paletteBackdropEl.addEventListener('click', closePalette);

function updatePaletteSelection() {
  const items = paletteListEl.querySelectorAll('.palette-item');
  items.forEach((el, i) => {
    el.classList.toggle('selected', i === paletteSelectedIndex);
  });
}

// --- Keyboard Input ---

document.addEventListener('keydown', async (e) => {
  // Ctrl+Shift+P: Command Palette
  if (e.ctrlKey && e.shiftKey && e.key === 'P') {
    e.preventDefault();
    if (paletteOpen) {
      closePalette();
    } else {
      openPalette();
    }
    return;
  }

  // Don't handle editor keys when palette is open
  if (paletteOpen) return;

  // Only handle editor keys when editor is focused
  if (document.activeElement !== editorEl) return;

  // Navigation
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (cursorLine > 0) {
      cursorLine--;
      cursorCol = Math.min(cursorCol, (lines[cursorLine]?.text || '').length);
    }
    renderCursor();
    updateStatusBar();
    return;
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (cursorLine < lines.length - 1) {
      cursorLine++;
      cursorCol = Math.min(cursorCol, (lines[cursorLine]?.text || '').length);
    }
    renderCursor();
    updateStatusBar();
    return;
  }
  if (e.key === 'ArrowLeft') {
    e.preventDefault();
    if (cursorCol > 0) {
      cursorCol--;
    } else if (cursorLine > 0) {
      cursorLine--;
      cursorCol = (lines[cursorLine]?.text || '').length;
    }
    renderCursor();
    updateStatusBar();
    return;
  }
  if (e.key === 'ArrowRight') {
    e.preventDefault();
    const lineLen = (lines[cursorLine]?.text || '').length;
    if (cursorCol < lineLen) {
      cursorCol++;
    } else if (cursorLine < lines.length - 1) {
      cursorLine++;
      cursorCol = 0;
    }
    renderCursor();
    updateStatusBar();
    return;
  }
  if (e.key === 'Home') {
    e.preventDefault();
    cursorCol = 0;
    renderCursor();
    updateStatusBar();
    return;
  }
  if (e.key === 'End') {
    e.preventDefault();
    cursorCol = (lines[cursorLine]?.text || '').length;
    renderCursor();
    updateStatusBar();
    return;
  }

  // Ctrl+O: Open file
  if (e.ctrlKey && e.key === 'o') {
    e.preventDefault();
    await openFileDialog();
    return;
  }

  // Ctrl+S: Save
  if (e.ctrlKey && e.key === 's') {
    e.preventDefault();
    await saveFile();
    return;
  }

  // Enter
  if (e.key === 'Enter') {
    e.preventDefault();
    const content = await invoke('edit_newline', { line: cursorLine, col: cursorCol });
    cursorLine++;
    cursorCol = 0;
    renderContent(content);
    return;
  }

  // Backspace
  if (e.key === 'Backspace') {
    e.preventDefault();
    if (cursorLine === 0 && cursorCol === 0) return;
    const content = await invoke('edit_backspace', { line: cursorLine, col: cursorCol });
    if (cursorCol > 0) {
      cursorCol--;
    } else if (cursorLine > 0) {
      cursorLine--;
      cursorCol = (content.lines[cursorLine]?.text || '').length;
    }
    renderContent(content);
    return;
  }

  // Delete
  if (e.key === 'Delete') {
    e.preventDefault();
    const content = await invoke('edit_delete', { line: cursorLine, col: cursorCol, len: 1 });
    renderContent(content);
    return;
  }

  // Tab
  if (e.key === 'Tab') {
    e.preventDefault();
    const content = await invoke('edit_insert', { line: cursorLine, col: cursorCol, text: '    ' });
    cursorCol += 4;
    renderContent(content);
    return;
  }

  // Regular character input
  if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    const content = await invoke('edit_insert', { line: cursorLine, col: cursorCol, text: e.key });
    cursorCol++;
    renderContent(content);
    return;
  }
});

// --- Click to position cursor ---

editorEl.addEventListener('click', (e) => {
  const lineEls = editorEl.querySelectorAll('.line');
  const charWidth = measureCharWidth();
  const editorRect = editorEl.getBoundingClientRect();

  for (let i = 0; i < lineEls.length; i++) {
    const rect = lineEls[i].getBoundingClientRect();
    if (e.clientY >= rect.top && e.clientY < rect.bottom) {
      cursorLine = i;
      const relativeX = e.clientX - editorRect.left - 12 + editorEl.scrollLeft;
      cursorCol = Math.max(0, Math.min(
        Math.round(relativeX / charWidth),
        (lines[i]?.text || '').length
      ));
      renderCursor();
      updateStatusBar();
      break;
    }
  }

  editorEl.focus();
});

// --- File Operations ---

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

// --- Diagnostics polling ---

async function refreshDiagnostics() {
  try {
    const content = await invoke('get_content');
    renderContent(content);
  } catch (err) {
    // Ignore
  }
}

// Poll diagnostics every 2 seconds (Extension Host may push new ones)
setInterval(refreshDiagnostics, 2000);

// --- Extension Host status polling ---

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

setInterval(pollExtHostStatus, 3000);

// --- Init ---

async function init() {
  try {
    const content = await invoke('get_content');
    renderContent(content);
    editorEl.focus();
    statusEl.textContent = 'Ready — Ctrl+O to open, Ctrl+Shift+P for commands';
    pollExtHostStatus();
  } catch (err) {
    console.error('Init error:', err);
    statusEl.textContent = `Error: ${err}`;
  }
}

// Wait for Tauri to be ready
if (window.__TAURI__) {
  init();
} else {
  window.addEventListener('DOMContentLoaded', () => {
    setTimeout(init, 100);
  });
}
