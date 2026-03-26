//! Editor State — Rope text buffer + Tree-sitter syntax highlighting.
//!
//! This is the core editor engine. It owns the text buffer and provides
//! edit operations that keep the syntax tree in sync incrementally.

use crate::highlighting::{self, HighlightedLine};
use crate::{EditorContent, ExtHostStatus};
use anyhow::{Context, Result};
use ropey::Rope;
use std::fs;
use std::path::PathBuf;

pub struct EditorState {
    rope: Rope,
    file_path: Option<PathBuf>,
    language: Option<String>,
    modified: bool,
    parser: tree_sitter::Parser,
    tree: Option<tree_sitter::Tree>,
}

impl EditorState {
    pub fn new() -> Self {
        let mut parser = tree_sitter::Parser::new();
        // Default to JavaScript for now
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
        }
    }

    pub fn open_file(&mut self, path: &str) -> Result<()> {
        let content = fs::read_to_string(path).context("Failed to read file")?;
        self.rope = Rope::from_str(&content);
        self.file_path = Some(PathBuf::from(path));
        self.modified = false;

        // Detect language from extension
        let ext = PathBuf::from(path)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_string();

        self.language = Some(ext.clone());
        self.set_language_from_ext(&ext);

        // Full parse
        let source = self.rope.to_string();
        self.tree = self.parser.parse(&source, None);

        log::info!(
            "Opened {} ({} lines, language: {})",
            path,
            self.rope.len_lines(),
            ext
        );

        Ok(())
    }

    pub fn save_file(&self) -> Result<()> {
        let path = self
            .file_path
            .as_ref()
            .context("No file path set")?;
        fs::write(path, self.rope.to_string()).context("Failed to write file")?;
        log::info!("Saved {}", path.display());
        Ok(())
    }

    pub fn insert(&mut self, line: usize, col: usize, text: &str) -> Result<()> {
        let line = line.min(self.rope.len_lines().saturating_sub(1));
        let line_start = self.rope.line_to_char(line);
        let line_len = self.rope.line(line).len_chars();
        let col = col.min(line_len);
        let char_idx = line_start + col;
        let byte_idx = self.rope.char_to_byte(char_idx);

        self.rope.insert(char_idx, text);
        self.modified = true;

        // Incremental tree-sitter update
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

        Ok(())
    }

    pub fn delete(&mut self, line: usize, col: usize, len: usize) -> Result<()> {
        let line = line.min(self.rope.len_lines().saturating_sub(1));
        let line_start = self.rope.line_to_char(line);
        let line_len = self.rope.line(line).len_chars();
        let col = col.min(line_len);
        let char_idx = line_start + col;
        let end_idx = (char_idx + len).min(self.rope.len_chars());

        if char_idx >= end_idx {
            return Ok(());
        }

        let start_byte = self.rope.char_to_byte(char_idx);
        let end_byte = self.rope.char_to_byte(end_idx);

        self.rope.remove(char_idx..end_idx);
        self.modified = true;

        if let Some(tree) = &mut self.tree {
            let new_line = self.rope.byte_to_line(start_byte.min(self.rope.len_bytes().saturating_sub(1)));
            let new_col = start_byte.saturating_sub(self.rope.line_to_byte(new_line));

            tree.edit(&tree_sitter::InputEdit {
                start_byte,
                old_end_byte: end_byte,
                new_end_byte: start_byte,
                start_position: tree_sitter::Point { row: line, column: col },
                old_end_position: tree_sitter::Point {
                    row: line,
                    column: col + len,
                },
                new_end_position: tree_sitter::Point {
                    row: new_line,
                    column: new_col,
                },
            });

            self.reparse();
        }

        Ok(())
    }

    pub fn backspace(&mut self, line: usize, col: usize) -> Result<()> {
        if line == 0 && col == 0 {
            return Ok(());
        }

        if col == 0 {
            // Join with previous line
            let prev_line = line - 1;
            let prev_line_len = self.rope.line(prev_line).len_chars();
            // Delete the newline at end of previous line
            let nl_pos = self.rope.line_to_char(prev_line) + prev_line_len - 1;
            self.delete_at_char(nl_pos, 1)?;
        } else {
            self.delete(line, col - 1, 1)?;
        }

        Ok(())
    }

    fn delete_at_char(&mut self, char_idx: usize, len: usize) -> Result<()> {
        let end_idx = (char_idx + len).min(self.rope.len_chars());
        if char_idx >= end_idx {
            return Ok(());
        }

        let start_byte = self.rope.char_to_byte(char_idx);
        let end_byte = self.rope.char_to_byte(end_idx);
        let start_line = self.rope.char_to_line(char_idx);
        let start_col = char_idx - self.rope.line_to_char(start_line);

        self.rope.remove(char_idx..end_idx);
        self.modified = true;

        if let Some(tree) = &mut self.tree {
            let new_line = self.rope.byte_to_line(start_byte.min(self.rope.len_bytes().saturating_sub(1)));
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

        Ok(())
    }

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
        self.tree = new_tree;
    }

    fn set_language_from_ext(&mut self, ext: &str) {
        match ext {
            "js" | "jsx" | "mjs" | "cjs" => {
                let _ = self.parser.set_language(&tree_sitter_javascript::LANGUAGE.into());
            }
            "rs" => {
                let _ = self.parser.set_language(&tree_sitter_rust::LANGUAGE.into());
            }
            _ => {
                // Keep JavaScript as default
            }
        }
    }

    pub fn get_content(&self) -> EditorContent {
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

        EditorContent {
            line_count: lines.len(),
            lines,
            file_path: self.file_path.as_ref().map(|p| p.display().to_string()),
            language: self.language.clone(),
            modified: self.modified,
        }
    }

    pub fn ext_host_status(&self) -> ExtHostStatus {
        ExtHostStatus {
            running: false, // TODO: check actual Extension Host process
            commands: vec![],
        }
    }
}
