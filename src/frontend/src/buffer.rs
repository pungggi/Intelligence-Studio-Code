//! Text buffer backed by a Rope data structure.
//!
//! Provides O(log n) insert/delete operations and efficient line indexing.
//! UTF-8 internally, with UTF-16 offset conversion for LSP compatibility.

use ropey::Rope;

pub struct TextBuffer {
    rope: Rope,
}

impl TextBuffer {
    pub fn new() -> Self {
        Self {
            rope: Rope::new(),
        }
    }

    pub fn from_str(text: &str) -> Self {
        Self {
            rope: Rope::from_str(text),
        }
    }

    /// Insert text at a byte offset.
    pub fn insert(&mut self, char_idx: usize, text: &str) {
        self.rope.insert(char_idx, text);
    }

    /// Remove a range of characters.
    pub fn remove(&mut self, range: std::ops::Range<usize>) {
        self.rope.remove(range);
    }

    /// Get the total number of lines.
    pub fn line_count(&self) -> usize {
        self.rope.len_lines()
    }

    /// Get a specific line as a string slice (via Cow).
    pub fn line(&self, line_idx: usize) -> ropey::RopeSlice<'_> {
        self.rope.line(line_idx)
    }

    /// Get the total character count.
    pub fn len_chars(&self) -> usize {
        self.rope.len_chars()
    }

    /// Convert a UTF-8 char offset to a UTF-16 offset (for LSP compatibility).
    pub fn char_to_utf16_offset(&self, char_idx: usize) -> usize {
        self.rope.char_to_utf16_cu(char_idx)
    }

    /// Convert a UTF-16 offset back to a char offset.
    pub fn utf16_to_char_offset(&self, utf16_idx: usize) -> usize {
        self.rope.utf16_cu_to_char(utf16_idx)
    }

    /// Get the full text as a String.
    pub fn to_string(&self) -> String {
        self.rope.to_string()
    }
}

impl Default for TextBuffer {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_insert_and_read() {
        let mut buf = TextBuffer::new();
        buf.insert(0, "Hello, World!");
        assert_eq!(buf.to_string(), "Hello, World!");
        assert_eq!(buf.len_chars(), 13);
    }

    #[test]
    fn test_line_count() {
        let buf = TextBuffer::from_str("line 1\nline 2\nline 3");
        assert_eq!(buf.line_count(), 3);
    }

    #[test]
    fn test_remove() {
        let mut buf = TextBuffer::from_str("Hello, World!");
        buf.remove(5..13);
        assert_eq!(buf.to_string(), "Hello");
    }

    #[test]
    fn test_utf16_conversion() {
        // ASCII is 1:1 between UTF-8 chars and UTF-16 code units
        let buf = TextBuffer::from_str("Hello");
        assert_eq!(buf.char_to_utf16_offset(3), 3);
    }
}
