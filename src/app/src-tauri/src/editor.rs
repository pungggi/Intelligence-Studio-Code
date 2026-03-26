//! Editor State — Rope text buffer + Tree-sitter syntax highlighting + Undo/Redo.
//!
//! This is the core editor engine. It owns the text buffer and provides
//! edit operations that keep the syntax tree in sync incrementally.
//! M4 adds: undo/redo, selection operations, find/replace, more grammars.

use crate::highlighting;
use crate::ipc_bridge::IpcHandle;
use crate::{EditorContent, HighlightedLine};
use anyhow::{Context, Result};
use ropey::Rope;
use std::fs;
use std::path::PathBuf;

/// Maximum file size that can be opened (50 MB).
const MAX_FILE_SIZE: u64 = 50 * 1024 * 1024;

/// Maximum undo history depth.
const MAX_UNDO_HISTORY: usize = 10_000;

// --- Undo/Redo ---

#[derive(Debug, Clone)]
enum EditOp {
    Insert { char_idx: usize, text: String },
    Delete { char_idx: usize, text: String },
    /// A group of operations that should be undone/redone as a single unit.
    Group(Vec<EditOp>),
}

struct UndoManager {
    undo_stack: Vec<EditOp>,
    redo_stack: Vec<EditOp>,
}

impl UndoManager {
    fn new() -> Self {
        Self {
            undo_stack: Vec::new(),
            redo_stack: Vec::new(),
        }
    }

    fn push(&mut self, op: EditOp) {
        self.undo_stack.push(op);
        self.redo_stack.clear();
        if self.undo_stack.len() > MAX_UNDO_HISTORY {
            self.undo_stack.remove(0);
        }
    }

    fn pop_undo(&mut self) -> Option<EditOp> {
        self.undo_stack.pop()
    }

    fn push_redo(&mut self, op: EditOp) {
        self.redo_stack.push(op);
    }

    fn pop_redo(&mut self) -> Option<EditOp> {
        self.redo_stack.pop()
    }

    fn push_undo_no_clear(&mut self, op: EditOp) {
        self.undo_stack.push(op);
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

// --- Editor State ---

pub struct EditorState {
    rope: Rope,
    file_path: Option<PathBuf>,
    language: Option<String>,
    modified: bool,
    parser: tree_sitter::Parser,
    tree: Option<tree_sitter::Tree>,
    version: u32,
    undo_mgr: UndoManager,
}

impl EditorState {
    pub fn new() -> Self {
        let mut parser = tree_sitter::Parser::new();
        let _ = parser.set_language(&tree_sitter_javascript::LANGUAGE.into());

        let rope = Rope::from_str("// Welcome to CoreCode\n// Open a file to begin editing\n");
        let tree = parser.parse(&rope.to_string(), None);

        Self {
            rope,
            file_path: None,
            language: Some("javascript".to_string()),
            modified: false,
            parser,
            tree,
            version: 0,
            undo_mgr: UndoManager::new(),
        }
    }

    pub fn open_file(&mut self, path: &str) -> Result<()> {
        let metadata = fs::metadata(path).context("Failed to stat file")?;
        if metadata.len() > MAX_FILE_SIZE {
            anyhow::bail!(
                "File too large ({:.1} MB, max {:.0} MB)",
                metadata.len() as f64 / (1024.0 * 1024.0),
                MAX_FILE_SIZE as f64 / (1024.0 * 1024.0)
            );
        }

        let content = fs::read_to_string(path).context("Failed to read file")?;
        self.rope = Rope::from_str(&content);
        self.file_path = Some(PathBuf::from(path));
        self.modified = false;
        self.undo_mgr.clear();

        let ext = PathBuf::from(path)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_string();

        self.language = Some(ext.clone());
        self.set_language_from_ext(&ext);

        let source = self.rope.to_string();
        self.tree = self.parser.parse(&source, None);

        if self.tree.is_none() {
            log::warn!("Tree-sitter parse returned None for {}", path);
        }

        log::info!(
            "Opened {} ({} lines, language: {})",
            path,
            self.rope.len_lines(),
            ext
        );

        Ok(())
    }

    pub fn save_file(&mut self) -> Result<()> {
        let path = self
            .file_path
            .as_ref()
            .context("No file path set")?;
        fs::write(path, self.rope.to_string()).context("Failed to write file")?;
        self.modified = false;
        log::info!("Saved {}", path.display());
        Ok(())
    }

    // --- Raw edit operations (no undo recording) ---

    fn raw_insert_at_char(&mut self, char_idx: usize, text: &str) {
        let byte_idx = self.rope.char_to_byte(char_idx);
        let line = self.rope.char_to_line(char_idx);
        let col = char_idx - self.rope.line_to_char(line);

        self.rope.insert(char_idx, text);
        self.modified = true;
        self.version += 1;

        if let Some(tree) = &mut self.tree {
            let new_end_byte = byte_idx + text.len();
            let new_end_line = self.rope.byte_to_line(new_end_byte);
            let new_end_col = new_end_byte - self.rope.line_to_byte(new_end_line);

            tree.edit(&tree_sitter::InputEdit {
                start_byte: byte_idx,
                old_end_byte: byte_idx,
                new_end_byte,
                start_position: tree_sitter::Point { row: line, column: col },
                old_end_position: tree_sitter::Point { row: line, column: col },
                new_end_position: tree_sitter::Point {
                    row: new_end_line,
                    column: new_end_col,
                },
            });

            self.reparse();
        }
    }

    /// Delete `len` chars starting at `char_idx`. Returns the deleted text.
    fn raw_delete_at_char(&mut self, char_idx: usize, len: usize) -> String {
        let end_idx = (char_idx + len).min(self.rope.len_chars());
        if char_idx >= end_idx {
            return String::new();
        }

        // Capture deleted text before removing
        let deleted: String = self.rope.slice(char_idx..end_idx).to_string();

        let start_byte = self.rope.char_to_byte(char_idx);
        let end_byte = self.rope.char_to_byte(end_idx);
        let start_line = self.rope.char_to_line(char_idx);
        let start_col = char_idx - self.rope.line_to_char(start_line);

        self.rope.remove(char_idx..end_idx);
        self.modified = true;
        self.version += 1;

        if let Some(tree) = &mut self.tree {
            let safe_byte = start_byte.min(self.rope.len_bytes().saturating_sub(1));
            let new_line = if self.rope.len_bytes() == 0 { 0 } else { self.rope.byte_to_line(safe_byte) };
            let new_col = start_byte.saturating_sub(self.rope.line_to_byte(new_line));

            tree.edit(&tree_sitter::InputEdit {
                start_byte,
                old_end_byte: end_byte,
                new_end_byte: start_byte,
                start_position: tree_sitter::Point { row: start_line, column: start_col },
                old_end_position: tree_sitter::Point {
                    row: start_line,
                    column: start_col + len,
                },
                new_end_position: tree_sitter::Point {
                    row: new_line,
                    column: new_col,
                },
            });

            self.reparse();
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
    /// Returns the deleted text.
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

        // Delete the range
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

        // Insert new text
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
        true
    }

    pub fn redo(&mut self) -> bool {
        let op = match self.undo_mgr.pop_redo() {
            Some(op) => op,
            None => return false,
        };

        let reverse = self.apply_forward(&op);
        self.undo_mgr.push_undo_no_clear(reverse);
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
                let mut forward_ops = Vec::new();
                for op in ops {
                    forward_ops.push(self.apply_forward(op));
                }
                EditOp::Group(forward_ops)
            }
        }
    }

    // --- Find ---

    pub fn find_all(&self, query: &str, case_sensitive: bool) -> Vec<FindMatch> {
        if query.is_empty() {
            return vec![];
        }

        let mut matches = Vec::new();
        let text = self.rope.to_string();

        let (search_text, search_query) = if case_sensitive {
            (text.clone(), query.to_string())
        } else {
            (text.to_lowercase(), query.to_lowercase())
        };

        let mut start = 0;
        while let Some(pos) = search_text[start..].find(&search_query) {
            let byte_pos = start + pos;
            let char_pos = text[..byte_pos].chars().count();
            let line = self.rope.char_to_line(char_pos);
            let line_start = self.rope.line_to_char(line);
            let col = char_pos - line_start;

            matches.push(FindMatch {
                line,
                col,
                length: query.chars().count(),
            });

            start = byte_pos + search_query.len();
        }

        matches
    }

    // --- Internal ---

    fn reparse(&mut self) {
        let rope = &self.rope;
        let new_tree = self.parser.parse_with(
            &mut |byte_offset, _position| {
                if byte_offset >= rope.len_bytes() {
                    return "";
                }
                let (chunk, chunk_start, _, _) = rope.chunk_at_byte(byte_offset);
                &chunk[byte_offset - chunk_start..]
            },
            self.tree.as_ref(),
        );
        if new_tree.is_none() {
            log::warn!("Tree-sitter incremental parse returned None");
        }
        self.tree = new_tree;
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
            _ => {
                self.tree = None;
            }
        }
    }

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

        let diagnostics = if let Some(path) = &self.file_path {
            let uri = {
                let p = path.display().to_string();
                #[cfg(target_os = "windows")]
                { format!("file:///{}", p.replace('\\', "/")) }
                #[cfg(not(target_os = "windows"))]
                { format!("file://{}", p) }
            };
            ipc.get_diagnostics_for_uri(&uri)
        } else {
            vec![]
        };

        EditorContent {
            line_count: lines.len(),
            lines,
            file_path: self.file_path.as_ref().map(|p| p.display().to_string()),
            language: self.language.clone(),
            modified: self.modified,
            diagnostics,
        }
    }

    pub fn get_full_text(&self) -> String {
        self.rope.to_string()
    }

    pub fn file_path_str(&self) -> Option<String> {
        self.file_path.as_ref().map(|p| p.display().to_string())
    }

    pub fn language(&self) -> Option<String> {
        self.language.clone()
    }

    pub fn version(&self) -> u32 {
        self.version
    }

    pub fn line_count(&self) -> usize {
        self.rope.len_lines()
    }
}
