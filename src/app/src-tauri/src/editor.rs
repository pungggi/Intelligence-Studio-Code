//! Editor State — Multi-document workspace with Rope text buffers + Tree-sitter + Undo/Redo.
//!
//! M5: Refactored from single-file EditorState to WorkspaceState holding
//! multiple DocumentBuffers in a HashMap. Each buffer has its own rope,
//! syntax tree, undo stack, and modification state.

use crate::highlighting;
use crate::ipc_bridge::IpcHandle;
use crate::{EditorContent, HighlightedLine};
use anyhow::{Context, Result};
use ropey::Rope;
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};

/// Maximum file size that can be opened (50 MB).
const MAX_FILE_SIZE: u64 = 50 * 1024 * 1024;

/// Maximum undo history depth per buffer.
const MAX_UNDO_HISTORY: usize = 10_000;

// --- Undo/Redo ---

#[derive(Debug, Clone)]
enum EditOp {
    Insert { char_idx: usize, text: String },
    Delete { char_idx: usize, text: String },
    /// A group of operations that should be undone/redone as a single unit.
    Group(Vec<EditOp>),
}

/// In-memory undo/redo manager for a single document buffer.
///
/// # Persistence limitation
/// The undo and redo stacks are held **entirely in memory** and are not written
/// to disk at any point.  If the application exits (cleanly or via crash) the
/// undo history for all open documents is permanently lost.  The file contents
/// themselves are saved by the user explicitly; only the edit history is lost.
///
/// Future work: serialise the undo stacks to a per-session directory
/// (e.g. `~/.config/corecode/session/<buffer_hash>.undo`) so that history
/// survives restarts.  Tracked as a known limitation in STATUS.md.
struct UndoManager {
    undo_stack: VecDeque<EditOp>,
    redo_stack: Vec<EditOp>,
}

#[allow(dead_code)]
impl UndoManager {
    fn new() -> Self {
        Self {
            undo_stack: VecDeque::new(),
            redo_stack: Vec::new(),
        }
    }

    fn push(&mut self, op: EditOp) {
        self.undo_stack.push_back(op);
        self.redo_stack.clear();
        if self.undo_stack.len() > MAX_UNDO_HISTORY {
            self.undo_stack.pop_front(); // O(1) instead of Vec::remove(0) which is O(n)
        }
    }

    fn pop_undo(&mut self) -> Option<EditOp> {
        self.undo_stack.pop_back()
    }

    fn push_redo(&mut self, op: EditOp) {
        self.redo_stack.push(op);
    }

    fn pop_redo(&mut self) -> Option<EditOp> {
        self.redo_stack.pop()
    }

    fn push_undo_no_clear(&mut self, op: EditOp) {
        self.undo_stack.push_back(op);
    }

    fn clear(&mut self) {
        self.undo_stack.clear();
        self.redo_stack.clear();
    }
}

// --- Find matches ---

#[derive(Debug, Clone, serde::Serialize)]
pub struct FindMatch {
    pub line: usize,
    pub col: usize,
    pub length: usize,
}

// --- Per-document buffer ---

/// A single open document with its own rope, syntax tree, and undo history.
pub struct DocumentBuffer {
    rope: Rope,
    file_path: PathBuf,
    language: Option<String>,
    modified: bool,
    tree: Option<tree_sitter::Tree>,
    version: u32,
    undo_mgr: UndoManager,
}

#[allow(dead_code)]
impl DocumentBuffer {
    fn new(path: PathBuf, content: &str, language: Option<String>, tree: Option<tree_sitter::Tree>) -> Self {
        Self {
            rope: Rope::from_str(content),
            file_path: path,
            language,
            modified: false,
            tree,
            version: 1,
            undo_mgr: UndoManager::new(),
        }
    }

    // --- Raw edit operations (no undo recording) ---

    fn raw_insert_at_char(&mut self, char_idx: usize, text: &str) {
        let byte_idx = self.rope.char_to_byte(char_idx);
        let line = self.rope.char_to_line(char_idx);
        let line_byte_start = self.rope.line_to_byte(line);
        let col_bytes = byte_idx - line_byte_start;

        self.rope.insert(char_idx, text);
        self.modified = true;
        self.version = self.version.wrapping_add(1);

        if let Some(tree) = &mut self.tree {
            let new_end_byte = byte_idx + text.len();
            let new_end_line = self.rope.byte_to_line(new_end_byte);
            let new_end_col = new_end_byte - self.rope.line_to_byte(new_end_line);

            tree.edit(&tree_sitter::InputEdit {
                start_byte: byte_idx,
                old_end_byte: byte_idx,
                new_end_byte,
                start_position: tree_sitter::Point { row: line, column: col_bytes },
                old_end_position: tree_sitter::Point { row: line, column: col_bytes },
                new_end_position: tree_sitter::Point {
                    row: new_end_line,
                    column: new_end_col,
                },
            });
        }
    }

    /// Delete `len` chars starting at `char_idx`. Returns the deleted text.
    fn raw_delete_at_char(&mut self, char_idx: usize, len: usize) -> String {
        let end_idx = (char_idx + len).min(self.rope.len_chars());
        if char_idx >= end_idx {
            return String::new();
        }

        let deleted: String = self.rope.slice(char_idx..end_idx).to_string();

        let start_byte = self.rope.char_to_byte(char_idx);
        let end_byte = self.rope.char_to_byte(end_idx);
        let start_line = self.rope.char_to_line(char_idx);
        let start_col_bytes = start_byte - self.rope.line_to_byte(start_line);

        // Compute old_end_position BEFORE removing (uses original rope state)
        let old_end_line = self.rope.char_to_line(end_idx);
        let old_end_col_bytes = end_byte - self.rope.line_to_byte(old_end_line);

        self.rope.remove(char_idx..end_idx);
        self.modified = true;
        self.version = self.version.wrapping_add(1);

        if let Some(tree) = &mut self.tree {
            tree.edit(&tree_sitter::InputEdit {
                start_byte,
                old_end_byte: end_byte,
                new_end_byte: start_byte,
                start_position: tree_sitter::Point { row: start_line, column: start_col_bytes },
                old_end_position: tree_sitter::Point {
                    row: old_end_line,
                    column: old_end_col_bytes,
                },
                new_end_position: tree_sitter::Point {
                    row: start_line,
                    column: start_col_bytes,
                },
            });
        }

        deleted
    }

    // --- Public edit operations (with undo recording) ---

    pub fn insert(&mut self, line: usize, col: usize, text: &str) -> Result<()> {
        let line = line.min(self.rope.len_lines().saturating_sub(1));
        let line_start = self.rope.line_to_char(line);
        let line_len = self.rope.line(line).len_chars();
        let col = col.min(line_len);
        let char_idx = line_start + col;

        self.raw_insert_at_char(char_idx, text);
        self.undo_mgr.push(EditOp::Insert {
            char_idx,
            text: text.to_string(),
        });

        Ok(())
    }

    pub fn delete(&mut self, line: usize, col: usize, len: usize) -> Result<()> {
        let line = line.min(self.rope.len_lines().saturating_sub(1));
        let line_start = self.rope.line_to_char(line);
        let line_len = self.rope.line(line).len_chars();
        let col = col.min(line_len);
        let char_idx = line_start + col;

        let deleted = self.raw_delete_at_char(char_idx, len);
        if !deleted.is_empty() {
            self.undo_mgr.push(EditOp::Delete {
                char_idx,
                text: deleted,
            });
        }

        Ok(())
    }

    pub fn backspace(&mut self, line: usize, col: usize) -> Result<()> {
        if line == 0 && col == 0 {
            return Ok(());
        }

        if col == 0 {
            let total_lines = self.rope.len_lines();
            let line = line.min(total_lines.saturating_sub(1));
            if line == 0 { return Ok(()); }
            let prev_line = line - 1;
            let prev_line_len = self.rope.line(prev_line).len_chars();
            let nl_pos = self.rope.line_to_char(prev_line) + prev_line_len - 1;
            let deleted = self.raw_delete_at_char(nl_pos, 1);
            if !deleted.is_empty() {
                self.undo_mgr.push(EditOp::Delete {
                    char_idx: nl_pos,
                    text: deleted,
                });
            }
        } else {
            let line_clamped = line.min(self.rope.len_lines().saturating_sub(1));
            let line_start = self.rope.line_to_char(line_clamped);
            let char_idx = line_start + col - 1;
            let deleted = self.raw_delete_at_char(char_idx, 1);
            if !deleted.is_empty() {
                self.undo_mgr.push(EditOp::Delete {
                    char_idx,
                    text: deleted,
                });
            }
        }

        Ok(())
    }

    /// Replace a range of text (for selection replacement, find/replace).
    pub fn replace_range(
        &mut self,
        start_line: usize,
        start_col: usize,
        end_line: usize,
        end_col: usize,
        new_text: &str,
    ) -> Result<String> {
        let start_char = self.line_col_to_char(start_line, start_col);
        let end_char = self.line_col_to_char(end_line, end_col);

        let (start, end) = if start_char <= end_char {
            (start_char, end_char)
        } else {
            (end_char, start_char)
        };

        let mut ops = Vec::new();

        let deleted = if end > start {
            let d = self.raw_delete_at_char(start, end - start);
            ops.push(EditOp::Delete {
                char_idx: start,
                text: d.clone(),
            });
            d
        } else {
            String::new()
        };

        if !new_text.is_empty() {
            self.raw_insert_at_char(start, new_text);
            ops.push(EditOp::Insert {
                char_idx: start,
                text: new_text.to_string(),
            });
        }

        if ops.len() == 1 {
            self.undo_mgr.push(ops.remove(0));
        } else if ops.len() > 1 {
            self.undo_mgr.push(EditOp::Group(ops));
        }

        Ok(deleted)
    }

    /// Get text in a range (for copy).
    pub fn get_text_range(
        &self,
        start_line: usize,
        start_col: usize,
        end_line: usize,
        end_col: usize,
    ) -> String {
        let start_char = self.line_col_to_char(start_line, start_col);
        let end_char = self.line_col_to_char(end_line, end_col);

        let (start, end) = if start_char <= end_char {
            (start_char, end_char)
        } else {
            (end_char, start_char)
        };

        let end = end.min(self.rope.len_chars());
        if start >= end {
            return String::new();
        }

        self.rope.slice(start..end).to_string()
    }

    fn line_col_to_char(&self, line: usize, col: usize) -> usize {
        let line = line.min(self.rope.len_lines().saturating_sub(1));
        let line_start = self.rope.line_to_char(line);
        let line_len = self.rope.line(line).len_chars();
        let col = col.min(line_len);
        line_start + col
    }

    // --- Undo/Redo ---

    pub fn undo(&mut self) -> bool {
        let op = match self.undo_mgr.pop_undo() {
            Some(op) => op,
            None => return false,
        };

        let reverse = self.apply_reverse(&op);
        self.undo_mgr.push_redo(reverse);
        self.modified = true; // Buffer content changed; save-point tracking is future work
        true
    }

    pub fn redo(&mut self) -> bool {
        let op = match self.undo_mgr.pop_redo() {
            Some(op) => op,
            None => return false,
        };

        let reverse = self.apply_forward(&op);
        self.undo_mgr.push_undo_no_clear(reverse);
        self.modified = true; // Buffer content changed; save-point tracking is future work
        true
    }

    fn apply_reverse(&mut self, op: &EditOp) -> EditOp {
        match op {
            EditOp::Insert { char_idx, text } => {
                let deleted = self.raw_delete_at_char(*char_idx, text.chars().count());
                EditOp::Insert {
                    char_idx: *char_idx,
                    text: deleted,
                }
            }
            EditOp::Delete { char_idx, text } => {
                self.raw_insert_at_char(*char_idx, text);
                EditOp::Delete {
                    char_idx: *char_idx,
                    text: text.clone(),
                }
            }
            EditOp::Group(ops) => {
                debug_assert!(
                    ops.iter().all(|op| !matches!(op, EditOp::Group(_))),
                    "Nested Group EditOps are not supported"
                );
                let mut reverse_ops = Vec::new();
                for op in ops.iter().rev() {
                    reverse_ops.push(self.apply_reverse(op));
                }
                reverse_ops.reverse();
                EditOp::Group(reverse_ops)
            }
        }
    }

    fn apply_forward(&mut self, op: &EditOp) -> EditOp {
        match op {
            EditOp::Insert { char_idx, text } => {
                self.raw_insert_at_char(*char_idx, text);
                EditOp::Insert {
                    char_idx: *char_idx,
                    text: text.clone(),
                }
            }
            EditOp::Delete { char_idx, text } => {
                let deleted = self.raw_delete_at_char(*char_idx, text.chars().count());
                EditOp::Delete {
                    char_idx: *char_idx,
                    text: deleted,
                }
            }
            EditOp::Group(ops) => {
                debug_assert!(
                    ops.iter().all(|op| !matches!(op, EditOp::Group(_))),
                    "Nested Group EditOps are not supported"
                );
                let mut forward_ops = Vec::new();
                for op in ops {
                    forward_ops.push(self.apply_forward(op));
                }
                EditOp::Group(forward_ops)
            }
        }
    }

    // --- Find ---

    /// Search for all occurrences of `query` in the buffer.
    ///
    /// # Performance note
    /// `rope.to_string()` materialises the entire document into a single heap
    /// allocation.  For files larger than a few MB this is the dominant cost.
    /// A future optimisation is to iterate `Rope::chunks()` and implement a
    /// cross-chunk Boyer-Moore search to avoid the allocation entirely.
    pub fn find_all(&self, query: &str, case_sensitive: bool) -> Vec<FindMatch> {
        if query.is_empty() {
            return vec![];
        }

        let mut matches = Vec::new();
        let text = self.rope.to_string();

        let (search_text, search_query) = if case_sensitive {
            (std::borrow::Cow::Borrowed(text.as_str()), std::borrow::Cow::Borrowed(query))
        } else {
            (std::borrow::Cow::Owned(text.to_lowercase()), std::borrow::Cow::Owned(query.to_lowercase()))
        };

        let query_char_len = query.chars().count();
        let mut start = 0;
        let mut char_offset_at_start: usize = 0;
        while let Some(pos) = search_text[start..].find(&*search_query) {
            let byte_pos = start + pos;
            // Count chars only in the segment since last position (incremental, not O(n))
            char_offset_at_start += text[start..byte_pos].chars().count();
            let char_pos = char_offset_at_start;
            let line = self.rope.char_to_line(char_pos);
            let line_start = self.rope.line_to_char(line);
            let col = char_pos - line_start;

            matches.push(FindMatch {
                line,
                col,
                length: query_char_len,
            });

            let next_start = byte_pos + search_query.len();
            char_offset_at_start += text[byte_pos..next_start].chars().count();
            start = next_start;
        }

        matches
    }

    // --- Accessors ---

    #[allow(dead_code)]
    pub fn get_full_text(&self) -> String {
        self.rope.to_string()
    }

    pub fn file_path(&self) -> &Path {
        &self.file_path
    }

    pub fn file_path_str(&self) -> String {
        self.file_path.display().to_string()
    }

    pub fn language(&self) -> Option<String> {
        self.language.clone()
    }

    pub fn version(&self) -> u32 {
        self.version
    }

    pub fn modified(&self) -> bool {
        self.modified
    }

    pub fn line_count(&self) -> usize {
        self.rope.len_lines()
    }

    pub fn set_modified(&mut self, val: bool) {
        self.modified = val;
    }

    /// Generate only the visible line range for the frontend (virtualized).
    pub fn get_visible_content(&self, first_line: usize, line_count: usize, ipc: &IpcHandle) -> crate::VisibleContent {
        let total = self.rope.len_lines();
        let start = first_line.min(total);
        let end = (first_line + line_count).min(total);

        let lines: Vec<HighlightedLine> = (start..end)
            .map(|i| {
                let line_text = self.rope.line(i).to_string();
                let line_text_trimmed = line_text.trim_end_matches('\n').to_string();
                let tokens = if let Some(tree) = &self.tree {
                    highlighting::highlight_line(tree, &self.rope, i)
                } else {
                    vec![]
                };
                HighlightedLine { text: line_text_trimmed, tokens }
            })
            .collect();

        let uri = crate::path_to_uri(&self.file_path.display().to_string());
        let diagnostics = ipc.get_diagnostics_for_uri(&uri)
            .into_iter()
            .filter(|d| d.line >= start && d.line < end)
            .collect();

        crate::VisibleContent {
            lines,
            first_line: start,
            total_lines: total,
            file_path: Some(self.file_path.display().to_string()),
            language: self.language.clone(),
            modified: self.modified,
            diagnostics,
        }
    }

    /// Generate EditorContent for the frontend.
    pub fn get_content(&self, ipc: &IpcHandle) -> EditorContent {
        let lines: Vec<HighlightedLine> = (0..self.rope.len_lines())
            .map(|i| {
                let line_text = self.rope.line(i).to_string();
                let line_text_trimmed = line_text.trim_end_matches('\n').to_string();

                let tokens = if let Some(tree) = &self.tree {
                    highlighting::highlight_line(tree, &self.rope, i)
                } else {
                    vec![]
                };

                HighlightedLine {
                    text: line_text_trimmed,
                    tokens,
                }
            })
            .collect();

        let uri = crate::path_to_uri(&self.file_path.display().to_string());
        let diagnostics = ipc.get_diagnostics_for_uri(&uri);

        EditorContent {
            line_count: lines.len(),
            lines,
            file_path: Some(self.file_path.display().to_string()),
            language: self.language.clone(),
            modified: self.modified,
            diagnostics,
        }
    }
}

// --- Workspace State ---

/// Holds all open document buffers and a shared parser.
pub struct WorkspaceState {
    buffers: HashMap<PathBuf, DocumentBuffer>,
    active_path: Option<PathBuf>,
    parser: tree_sitter::Parser,
}

#[allow(dead_code)]
impl WorkspaceState {
    pub fn new() -> Self {
        let mut parser = tree_sitter::Parser::new();
        let _ = parser.set_language(&tree_sitter_javascript::LANGUAGE.into());

        Self {
            buffers: HashMap::new(),
            active_path: None,
            parser,
        }
    }

    /// Open a file into a new buffer (or switch to it if already open).
    /// Returns true if the buffer was newly created.
    pub fn open_file(&mut self, path: &str) -> Result<bool> {
        let canonical = PathBuf::from(path);

        if self.buffers.contains_key(&canonical) {
            // Already open — just switch to it
            self.active_path = Some(canonical);
            return Ok(false);
        }

        let metadata = fs::metadata(path).context("Failed to stat file")?;
        if metadata.len() > MAX_FILE_SIZE {
            anyhow::bail!(
                "File too large ({:.1} MB, max {:.0} MB)",
                metadata.len() as f64 / (1024.0 * 1024.0),
                MAX_FILE_SIZE as f64 / (1024.0 * 1024.0)
            );
        }

        let content = fs::read_to_string(path).context("Failed to read file")?;

        let ext = canonical
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_string();

        self.set_language_from_ext(&ext);
        let tree = self.parser.parse(&content, None);
        if tree.is_none() {
            log::warn!("Tree-sitter parse returned None for {}", path);
        }

        let language = Some(ext.clone());
        let buffer = DocumentBuffer::new(canonical.clone(), &content, language, tree);

        log::info!(
            "Opened {} ({} lines, language: {})",
            path,
            buffer.line_count(),
            ext
        );

        self.buffers.insert(canonical.clone(), buffer);
        self.active_path = Some(canonical);
        Ok(true)
    }

    /// Close a buffer. Returns the path of the new active buffer (if any).
    pub fn close_buffer(&mut self, path: &Path) -> Option<PathBuf> {
        self.buffers.remove(path);

        if self.active_path.as_deref() == Some(path) {
            // Switch to another open buffer (pick the first one)
            self.active_path = self.buffers.keys().next().cloned();
        }

        self.active_path.clone()
    }

    /// Switch active buffer. Returns false if path not found in open buffers.
    pub fn switch_buffer(&mut self, path: &Path) -> bool {
        if self.buffers.contains_key(path) {
            self.active_path = Some(path.to_path_buf());
            true
        } else {
            false
        }
    }

    /// Save the active buffer to disk.
    pub fn save_active(&mut self) -> Result<()> {
        let path = self
            .active_path
            .as_ref()
            .context("No active buffer")?
            .clone();
        let buf = self
            .buffers
            .get_mut(&path)
            .context("Active buffer not found")?;
        fs::write(&buf.file_path, buf.rope.to_string()).context("Failed to write file")?;
        buf.modified = false;
        log::info!("Saved {}", buf.file_path.display());
        Ok(())
    }

    /// Get a reference to the active buffer.
    pub fn active(&self) -> Option<&DocumentBuffer> {
        self.active_path.as_ref().and_then(|p| self.buffers.get(p))
    }

    /// Get a mutable reference to the active buffer.
    pub fn active_mut(&mut self) -> Option<&mut DocumentBuffer> {
        // Work around borrow checker
        let path = self.active_path.clone();
        path.and_then(move |p| self.buffers.get_mut(&p))
    }

    /// Get a mutable reference to a buffer by path (any open buffer, not just active).
    pub fn get_buffer_mut_by_path(&mut self, path: &Path) -> Option<&mut DocumentBuffer> {
        self.buffers.get_mut(path)
    }

    /// Check if a buffer is open for the given path.
    pub fn has_buffer(&self, path: &Path) -> bool {
        self.buffers.contains_key(path)
    }

    /// Return the active buffer's filesystem path as a string, if any.
    pub fn active_path(&self) -> Option<&PathBuf> {
        self.active_path.as_ref()
    }

    /// Reparse the active buffer using the shared parser.
    pub fn reparse_active(&mut self) {
        let path = match &self.active_path {
            Some(p) => p.clone(),
            None => return,
        };

        // Set the correct language first (needs &mut self for parser)
        let lang = self.buffers.get(&path).and_then(|b| b.language.clone());
        if let Some(lang) = &lang {
            self.set_language_from_ext(lang);
        }

        // Now borrow the buffer mutably for reparsing
        let buf = match self.buffers.get_mut(&path) {
            Some(b) => b,
            None => return,
        };

        let rope = &buf.rope;
        let new_tree = self.parser.parse_with(
            &mut |byte_offset, _position| {
                if byte_offset >= rope.len_bytes() {
                    return "";
                }
                let (chunk, chunk_start, _, _) = rope.chunk_at_byte(byte_offset);
                &chunk[byte_offset - chunk_start..]
            },
            buf.tree.as_ref(),
        );
        if new_tree.is_none() {
            log::warn!("Tree-sitter incremental parse returned None");
        }
        buf.tree = new_tree;
    }

    /// List all open buffers.
    pub fn list_open_buffers(&self) -> Vec<BufferInfo> {
        self.buffers
            .values()
            .map(|buf| BufferInfo {
                path: buf.file_path.display().to_string(),
                modified: buf.modified,
                language: buf.language.clone(),
                active: self.active_path.as_ref() == Some(&buf.file_path),
            })
            .collect()
    }

    /// Check if active path is set.
    pub fn has_active(&self) -> bool {
        self.active_path.is_some() && self.active().is_some()
    }

    /// Get active path as string.
    pub fn active_path_str(&self) -> Option<String> {
        self.active_path.as_ref().map(|p| p.display().to_string())
    }

    fn set_language_from_ext(&mut self, ext: &str) {
        match ext {
            "js" | "jsx" | "mjs" | "cjs" => {
                let _ = self.parser.set_language(&tree_sitter_javascript::LANGUAGE.into());
            }
            "ts" => {
                let _ = self.parser.set_language(&tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into());
            }
            "tsx" => {
                let _ = self.parser.set_language(&tree_sitter_typescript::LANGUAGE_TSX.into());
            }
            "rs" => {
                let _ = self.parser.set_language(&tree_sitter_rust::LANGUAGE.into());
            }
            "py" | "pyw" => {
                let _ = self.parser.set_language(&tree_sitter_python::LANGUAGE.into());
            }
            "json" | "jsonc" => {
                let _ = self.parser.set_language(&tree_sitter_json::LANGUAGE.into());
            }
            "html" | "htm" => {
                let _ = self.parser.set_language(&tree_sitter_html::LANGUAGE.into());
            }
            "css" | "scss" => {
                let _ = self.parser.set_language(&tree_sitter_css::LANGUAGE.into());
            }
            "md" | "markdown" => {
                let _ = self.parser.set_language(&tree_sitter_md::LANGUAGE.into());
            }
            _ => {
                // Unknown language — no tree-sitter support
            }
        }
    }
}

// --- Buffer info for frontend ---

#[derive(Debug, Clone, serde::Serialize)]
pub struct BufferInfo {
    pub path: String,
    pub modified: bool,
    pub language: Option<String>,
    pub active: bool,
}

// --- Directory reading for file explorer ---

#[derive(Debug, Clone, serde::Serialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

pub fn read_directory(path: &str) -> Result<Vec<DirEntry>> {
    let mut entries = Vec::new();
    let dir = fs::read_dir(path).context("Failed to read directory")?;

    for entry in dir {
        let entry = entry.context("Failed to read directory entry")?;
        let metadata = entry.metadata().context("Failed to stat entry")?;
        let name = entry.file_name().to_string_lossy().to_string();

        // Skip hidden files/dirs (starting with .)
        if name.starts_with('.') {
            continue;
        }
        // Skip common non-essential directories
        if metadata.is_dir() && matches!(name.as_str(), "node_modules" | "target" | ".git" | "__pycache__" | "dist" | ".next") {
            continue;
        }

        entries.push(DirEntry {
            name,
            path: entry.path().display().to_string(),
            is_dir: metadata.is_dir(),
        });
    }

    // Sort: directories first, then alphabetically
    entries.sort_by(|a, b| {
        b.is_dir.cmp(&a.is_dir).then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
}
