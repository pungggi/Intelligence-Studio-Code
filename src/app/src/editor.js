/**
 * CoreCode M1 — Editor Frontend
 *
 * Lightweight editor UI that communicates with the Tauri/Rust backend
 * for text editing and syntax highlighting.
 */

const { invoke } = window.__TAURI__.core;

// --- State ---
let cursorLine = 0;
let cursorCol = 0;
let lines = [];
let filePath = null;
let modified = false;

// --- DOM ---
const editorEl = document.getElementById('editor');
const gutterEl = document.getElementById('gutter');
const fileNameEl = document.getElementById('file-name');
const languageBadgeEl = document.getElementById('language-badge');
const cursorPosEl = document.getElementById('cursor-pos');
const fileInfoEl = document.getElementById('file-info');
const statusEl = document.getElementById('status');

// --- Rendering ---

function renderContent(content) {
  lines = content.lines || [];
  filePath = content.file_path;
  modified = content.modified;

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

  // Editor lines
  editorEl.innerHTML = '';
  gutterEl.innerHTML = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Gutter line number
    const gutterLine = document.createElement('div');
    gutterLine.className = 'line';
    gutterLine.textContent = String(i + 1);
    gutterEl.appendChild(gutterLine);

    // Editor line with syntax highlighting
    const editorLine = document.createElement('div');
    editorLine.className = 'line';
    editorLine.dataset.line = i;

    if (line.tokens && line.tokens.length > 0) {
      editorLine.innerHTML = applyTokens(line.text, line.tokens);
    } else {
      editorLine.textContent = line.text || '';
    }

    editorEl.appendChild(editorLine);
  }

  // Render cursor
  renderCursor();
  updateStatusBar();
}

function applyTokens(text, tokens) {
  if (!text) return '';

  let html = '';
  let lastEnd = 0;

  for (const token of tokens) {
    // Gap before this token
    if (token.start > lastEnd) {
      html += escapeHtml(text.substring(lastEnd, token.start));
    }

    const tokenText = text.substring(token.start, token.end);
    html += `<span class="tok-${token.kind}">${escapeHtml(tokenText)}</span>`;
    lastEnd = token.end;
  }

  // Remaining text
  if (lastEnd < text.length) {
    html += escapeHtml(text.substring(lastEnd));
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
  // Remove existing cursor
  const existing = document.querySelector('.cursor');
  if (existing) existing.remove();

  const lineEls = editorEl.querySelectorAll('.line');
  if (cursorLine >= lineEls.length) return;

  const lineEl = lineEls[cursorLine];
  const lineRect = lineEl.getBoundingClientRect();
  const editorRect = editorEl.getBoundingClientRect();

  // Approximate character width (monospace)
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

// --- Keyboard Input ---

editorEl.addEventListener('keydown', async (e) => {
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

// --- Init ---

async function init() {
  try {
    const content = await invoke('get_content');
    renderContent(content);
    editorEl.focus();
    statusEl.textContent = 'Ready — Ctrl+O to open a file';
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
    // Retry after a short delay if Tauri isn't ready
    setTimeout(init, 100);
  });
}
