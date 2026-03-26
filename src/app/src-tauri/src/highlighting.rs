//! Syntax highlighting via Tree-sitter.
//!
//! Walks the syntax tree for a given line and produces highlight tokens
//! that the frontend can use for coloring.

use crate::Token;
use ropey::Rope;

/// Extract highlight tokens for a specific line from the syntax tree.
pub fn highlight_line(tree: &tree_sitter::Tree, rope: &Rope, line_idx: usize) -> Vec<Token> {
    let root = tree.root_node();
    let line_start_byte = rope.line_to_byte(line_idx);
    let line_end_byte = if line_idx + 1 < rope.len_lines() {
        rope.line_to_byte(line_idx + 1)
    } else {
        rope.len_bytes()
    };

    let mut tokens = Vec::new();
    collect_tokens_in_range(root, line_start_byte, line_end_byte, line_start_byte, &mut tokens);

    // Sort by start position and deduplicate overlaps
    tokens.sort_by_key(|t| t.start);
    tokens
}

fn collect_tokens_in_range(
    node: tree_sitter::Node,
    range_start: usize,
    range_end: usize,
    line_start_byte: usize,
    tokens: &mut Vec<Token>,
) {
    let node_start = node.start_byte();
    let node_end = node.end_byte();

    // Skip nodes entirely outside our range
    if node_end <= range_start || node_start >= range_end {
        return;
    }

    if node.child_count() == 0 {
        // Leaf node — map to a token
        let kind = map_kind(node.kind());
        if kind != "plain" {
            let start = node_start.max(range_start) - line_start_byte;
            let end = node_end.min(range_end) - line_start_byte;
            if start < end {
                tokens.push(Token {
                    start,
                    end,
                    kind: kind.to_string(),
                });
            }
        }
    } else {
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            collect_tokens_in_range(child, range_start, range_end, line_start_byte, tokens);
        }
    }
}

fn map_kind(kind: &str) -> &'static str {
    match kind {
        // Keywords
        "const" | "let" | "var" | "function" | "async" | "await" | "return" | "if" | "else"
        | "for" | "while" | "class" | "extends" | "new" | "import" | "export" | "from"
        | "try" | "catch" | "throw" | "typeof" | "instanceof" | "super" | "this" | "yield"
        | "of" | "in" | "switch" | "case" | "default" | "break" | "continue" | "do"
        | "fn" | "pub" | "mod" | "use" | "struct" | "enum" | "impl" | "trait" | "where"
        | "mut" | "ref" | "self" | "Self" | "crate" | "match" | "loop" | "move"
        | "static" | "type" | "as" | "unsafe" | "extern" | "dyn" => "keyword",

        // Strings
        "string" | "string_fragment" | "template_string" | "template_literal"
        | "escape_sequence" | "string_literal" | "char_literal" => "string",

        // Numbers
        "number" | "integer" | "float" | "integer_literal" | "float_literal" => "number",

        // Comments
        "comment" | "line_comment" | "block_comment" => "comment",

        // Properties
        "property_identifier" | "shorthand_property_identifier" | "field_identifier" => "property",

        // Types
        "type_identifier" | "predefined_type" | "primitive_type" => "type",

        // Constants
        "true" | "false" | "null" | "undefined" | "none" | "boolean" => "constant",

        // Operators
        "=" | "==" | "===" | "!=" | "!==" | "+" | "-" | "*" | "/" | "%" | "&&" | "||" | "!"
        | ">" | "<" | ">=" | "<=" | "=>" | "..." | "?." | "??" | "+=" | "-=" | "*=" | "/="
        | "&" | "|" | "^" | "~" | "<<" | ">>" | "->" | "::" => "operator",

        // Punctuation
        "(" | ")" | "{" | "}" | "[" | "]" | ";" | "," | "." | ":" => "punctuation",

        // Identifiers
        "identifier" => "variable",

        _ => "plain",
    }
}
