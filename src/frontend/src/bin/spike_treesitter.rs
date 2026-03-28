//! Spike 4: Tree-sitter Integration
//!
//! Validates tree-sitter for incremental syntax parsing:
//! 1. Parse a 10,000-line JS file and measure initial parse time
//! 2. Edit a single line and measure incremental re-parse time
//! 3. Walk syntax nodes and map to highlight token types
//!
//! Success criteria:
//!   - Initial parse of 10,000 lines < 50ms
//!   - Incremental re-parse < 1ms
//!   - Correct syntax nodes for keywords, strings, comments
//!
//! Run: cargo run --bin spike-treesitter --release

use anyhow::Result;
use ropey::Rope;
use std::time::Instant;

fn main() -> Result<()> {
    println!("=== CoreCode Spike 4: Tree-sitter Integration ===\n");

    // --- Generate test content ---
    let js_content = generate_js_content(10_000);
    let line_count = js_content.lines().count();
    let byte_count = js_content.len();
    println!(
        "[Setup] Generated {} lines, {} bytes of JavaScript",
        line_count, byte_count
    );

    // Load into Rope buffer
    let mut rope = Rope::from_str(&js_content);

    // --- Test 1: Initial parse ---
    println!("\n--- Test 1: Initial Parse (10,000 lines) ---");

    let mut parser = tree_sitter::Parser::new();
    let language = tree_sitter_javascript::LANGUAGE;
    parser
        .set_language(&language.into())
        .expect("Failed to set JavaScript language");

    let parse_start = Instant::now();
    let tree = parser
        .parse(&js_content, None)
        .expect("Failed to parse");
    let parse_time_ms = parse_start.elapsed().as_secs_f64() * 1000.0;

    let root = tree.root_node();
    println!("  Parse time:  {:.2}ms", parse_time_ms);
    println!("  Root node:   {} ({}..{})", root.kind(), root.start_position().row, root.end_position().row);
    println!("  Child count: {}", root.child_count());
    println!("  Has errors:  {}", root.has_error());

    if parse_time_ms < 50.0 {
        println!("[Test 1] PASS: {:.2}ms < 50ms target", parse_time_ms);
    } else {
        println!("[Test 1] FAIL: {:.2}ms >= 50ms target", parse_time_ms);
    }

    // --- Test 2: Incremental re-parse ---
    println!("\n--- Test 2: Incremental Re-parse (single line edit) ---");

    // Edit line 5000: replace content
    let edit_line = 5000;
    let line_start_byte = rope.line_to_byte(edit_line);
    let line_end_byte = rope.line_to_byte(edit_line + 1);
    let old_line_len = line_end_byte - line_start_byte;

    let new_line = "  const updatedVariable = performComplexCalculation(a, b, c); // edited\n";
    let new_line_bytes = new_line.as_bytes();

    // Calculate positions for tree-sitter edit
    let start_position = tree_sitter::Point {
        row: edit_line,
        column: 0,
    };
    let old_end_position = tree_sitter::Point {
        row: edit_line,
        column: old_line_len,
    };
    let new_end_position = tree_sitter::Point {
        row: edit_line,
        column: new_line_bytes.len(),
    };

    // Apply edit to rope
    let rope_start_char = rope.byte_to_char(line_start_byte);
    let rope_end_char = rope.byte_to_char(line_end_byte);
    rope.remove(rope_start_char..rope_end_char);
    rope.insert(rope_start_char, new_line);

    // Notify tree-sitter of the edit
    let mut old_tree = tree;
    old_tree.edit(&tree_sitter::InputEdit {
        start_byte: line_start_byte,
        old_end_byte: line_start_byte + old_line_len,
        new_end_byte: line_start_byte + new_line_bytes.len(),
        start_position,
        old_end_position,
        new_end_position,
    });

    // Incremental re-parse using rope chunk callback (zero-copy)
    let reparse_start = Instant::now();
    let new_tree = parser
        .parse_with(
            &mut |byte_offset, _position| {
                if byte_offset >= rope.len_bytes() {
                    return "";
                }
                let (chunk, chunk_start, _, _) = rope.chunk_at_byte(byte_offset);
                &chunk[byte_offset - chunk_start..]
            },
            Some(&old_tree),
        )
        .expect("Failed to re-parse");
    let reparse_time_ms = reparse_start.elapsed().as_secs_f64() * 1000.0;

    println!("  Re-parse time: {:.3}ms", reparse_time_ms);

    // Show changed ranges
    let changed_ranges = old_tree.changed_ranges(&new_tree).collect::<Vec<_>>();
    println!("  Changed ranges: {}", changed_ranges.len());
    for range in &changed_ranges {
        println!(
            "    rows {}..{} bytes {}..{}",
            range.start_point.row,
            range.end_point.row,
            range.start_byte,
            range.end_byte
        );
    }

    if reparse_time_ms < 1.0 {
        println!("[Test 2] PASS: {:.3}ms < 1ms target", reparse_time_ms);
    } else {
        println!("[Test 2] FAIL: {:.3}ms >= 1ms target", reparse_time_ms);
    }

    // --- Test 3: Syntax node walking & highlight mapping ---
    println!("\n--- Test 3: Syntax Node Highlighting ---");

    let source = rope.to_string();
    let final_tree = parser.parse(&source, None).unwrap();
    let root = final_tree.root_node();

    // Count node types in the first 100 lines
    let mut token_counts = std::collections::HashMap::new();
    count_tokens(root, 0, 100, &mut token_counts);

    println!("  Token types in first 100 lines:");
    let mut sorted_tokens: Vec<_> = token_counts.iter().collect();
    sorted_tokens.sort_by(|a, b| b.1.cmp(a.1));
    for (token_type, count) in sorted_tokens.iter().take(15) {
        let highlight = map_node_to_highlight(token_type);
        println!("    {:<30} {:>5}x  -> {:?}", token_type, count, highlight);
    }

    // Verify expected tokens exist
    let has_keywords = token_counts.contains_key("function")
        || token_counts.contains_key("const")
        || token_counts.contains_key("if");
    let has_strings = token_counts.contains_key("string")
        || token_counts.contains_key("string_fragment")
        || token_counts.contains_key("template_string");
    let has_comments = token_counts.contains_key("comment")
        || token_counts.contains_key("line_comment");
    let has_identifiers = token_counts.contains_key("identifier")
        || token_counts.contains_key("property_identifier");

    println!("\n  Expected token presence:");
    println!("    Keywords:    {} {}", if has_keywords { "PASS" } else { "FAIL" }, if has_keywords { "" } else { "(missing)" });
    println!("    Strings:     {} {}", if has_strings { "PASS" } else { "FAIL" }, if has_strings { "" } else { "(missing)" });
    println!("    Comments:    {} {}", if has_comments { "PASS" } else { "FAIL" }, if has_comments { "" } else { "(missing)" });
    println!("    Identifiers: {} {}", if has_identifiers { "PASS" } else { "FAIL" }, if has_identifiers { "" } else { "(missing)" });

    let all_tokens_ok = has_keywords && has_strings && has_comments && has_identifiers;
    if all_tokens_ok {
        println!("[Test 3] PASS: All expected token types found");
    } else {
        println!("[Test 3] FAIL: Some token types missing");
    }

    // --- Test 4: Bulk incremental parse benchmark ---
    println!("\n--- Test 4: Bulk Incremental Parse (100 edits) ---");

    let mut current_tree = parser.parse(&source, None).unwrap();
    let mut current_rope = Rope::from_str(&source);
    let mut reparse_times = Vec::with_capacity(100);

    for i in 0..100 {
        let edit_line = (i * 97 + 13) % current_rope.len_lines().saturating_sub(1); // pseudo-random lines
        let line_start = current_rope.line_to_byte(edit_line);
        let line_end = current_rope.line_to_byte((edit_line + 1).min(current_rope.len_lines()));
        let old_len = line_end - line_start;

        let replacement = format!("  const v{} = compute({}, {});\n", i, i * 2, i * 3);
        let new_len = replacement.len();

        // Edit rope
        let cs = current_rope.byte_to_char(line_start);
        let ce = current_rope.byte_to_char(line_end);
        current_rope.remove(cs..ce);
        current_rope.insert(cs, &replacement);

        // Edit tree
        current_tree.edit(&tree_sitter::InputEdit {
            start_byte: line_start,
            old_end_byte: line_start + old_len,
            new_end_byte: line_start + new_len,
            start_position: tree_sitter::Point { row: edit_line, column: 0 },
            old_end_position: tree_sitter::Point { row: edit_line, column: old_len },
            new_end_position: tree_sitter::Point { row: edit_line, column: new_len },
        });

        // Incremental reparse using rope callback (zero-copy)
        let t = Instant::now();
        let rope_ref = &current_rope;
        let new_t = parser
            .parse_with(
                &mut |byte_offset, _position| {
                    if byte_offset >= rope_ref.len_bytes() {
                        return "";
                    }
                    let (chunk, chunk_start, _, _) = rope_ref.chunk_at_byte(byte_offset);
                    &chunk[byte_offset - chunk_start..]
                },
                Some(&current_tree),
            )
            .unwrap();
        reparse_times.push(t.elapsed().as_secs_f64() * 1000.0);
        current_tree = new_t;
    }

    let avg = reparse_times.iter().sum::<f64>() / reparse_times.len() as f64;
    let max = reparse_times.iter().cloned().fold(0.0_f64, f64::max);
    let mut sorted = reparse_times.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let p95 = if sorted.is_empty() {
        0.0
    } else {
        sorted[((sorted.len().saturating_sub(1)) as f64 * 0.95) as usize]
    };

    println!("  100 incremental re-parses:");
    println!("    avg={:.3}ms  max={:.3}ms  p95={:.3}ms", avg, max, p95);

    if avg < 1.0 {
        println!("[Test 4] PASS: avg {:.3}ms < 1ms target", avg);
    } else {
        println!("[Test 4] FAIL: avg {:.3}ms >= 1ms target", avg);
    }

    // --- Summary ---
    println!("\n=== SPIKE 4 SUMMARY ===");
    println!("Initial parse (10k lines): {:.2}ms  {}", parse_time_ms, if parse_time_ms < 50.0 { "PASS" } else { "FAIL" });
    println!("Incremental re-parse:      {:.3}ms  {}", reparse_time_ms, if reparse_time_ms < 1.0 { "PASS" } else { "FAIL" });
    println!("Token mapping:             {}",  if all_tokens_ok { "PASS" } else { "FAIL" });
    println!("Bulk incr. parse (avg):    {:.3}ms  {}", avg, if avg < 1.0 { "PASS" } else { "FAIL" });
    println!("========================\n");

    Ok(())
}

/// Generate realistic JavaScript content.
fn generate_js_content(lines: usize) -> String {
    let mut out = String::with_capacity(lines * 60);
    let blocks = [
        r#"// Module: data processing utilities
const { EventEmitter } = require('events');

/**
 * Process a batch of records and return aggregated results.
 * @param {Array} records - Input records to process
 * @param {Object} options - Processing configuration
 * @returns {Promise<Object>} Aggregated results
 */
async function processBatch(records, options = {}) {
  const { batchSize = 100, timeout = 5000 } = options;
  const results = [];

  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize);
    const processed = await Promise.all(
      batch.map(record => transformRecord(record))
    );
    results.push(...processed);
  }

  return { count: results.length, data: results };
}

function transformRecord(record) {
  if (!record || typeof record !== 'object') {
    throw new TypeError('Invalid record');
  }

  const { id, name, value, metadata = {} } = record;
  const timestamp = Date.now();

  return {
    id: String(id),
    name: name.trim().toLowerCase(),
    value: Number(value) || 0,
    score: calculateScore(value, metadata),
    processedAt: new Date(timestamp).toISOString(),
  };
}

function calculateScore(value, metadata) {
  const weight = metadata.weight || 1.0;
  const bonus = metadata.premium ? 1.5 : 1.0;
  return Math.round(value * weight * bonus * 100) / 100;
}

class DataPipeline extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.queue = [];
    this.isRunning = false;
  }

  async start() {
    this.isRunning = true;
    this.emit('start');

    while (this.queue.length > 0 && this.isRunning) {
      const item = this.queue.shift();
      try {
        const result = await processBatch(item.records, this.config);
        this.emit('batch-complete', result);
      } catch (error) {
        this.emit('error', error);
      }
    }

    this.isRunning = false;
    this.emit('done');
  }

  enqueue(records) {
    this.queue.push({ records, addedAt: Date.now() });
  }

  stop() {
    this.isRunning = false;
  }
}

module.exports = { processBatch, transformRecord, DataPipeline };
"#,
    ];

    let block = blocks[0];
    let block_lines: Vec<&str> = block.lines().collect();
    let mut line_idx = 0;

    while line_idx < lines {
        let src_line = block_lines[line_idx % block_lines.len()];
        out.push_str(src_line);
        out.push('\n');
        line_idx += 1;
    }

    out
}

/// Recursively count named leaf node types within a line range.
fn count_tokens(
    node: tree_sitter::Node,
    min_row: usize,
    max_row: usize,
    counts: &mut std::collections::HashMap<String, usize>,
) {
    let start_row = node.start_position().row;
    let end_row = node.end_position().row;

    // Skip nodes entirely outside our range
    if start_row > max_row || end_row < min_row {
        return;
    }

    if node.child_count() == 0 {
        // Leaf node
        let kind = node.kind().to_string();
        *counts.entry(kind).or_insert(0) += 1;
    } else {
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            count_tokens(child, min_row, max_row, counts);
        }
    }
}

/// Map tree-sitter node kinds to highlight categories.
#[derive(Debug)]
#[allow(dead_code)]
enum HighlightType {
    Keyword,
    String,
    Number,
    Comment,
    Function,
    Type,
    Variable,
    Operator,
    Punctuation,
    Property,
    Constant,
    Plain,
}

fn map_node_to_highlight(node_kind: &str) -> HighlightType {
    match node_kind {
        // Keywords
        "const" | "let" | "var" | "function" | "async" | "await" | "return" | "if" | "else"
        | "for" | "while" | "class" | "extends" | "new" | "import" | "export" | "from"
        | "try" | "catch" | "throw" | "typeof" | "instanceof" | "super" | "this" | "yield"
        | "of" | "in" => HighlightType::Keyword,

        // Strings
        "string" | "string_fragment" | "template_string" | "template_literal" | "escape_sequence"
        | "regex" | "regex_pattern" => HighlightType::String,

        // Numbers
        "number" | "integer" => HighlightType::Number,

        // Comments
        "comment" | "line_comment" | "block_comment" => HighlightType::Comment,

        // Function-related
        "call_expression" | "function_declaration" | "arrow_function" | "method_definition" => {
            HighlightType::Function
        }

        // Types
        "type_identifier" | "predefined_type" => HighlightType::Type,

        // Properties
        "property_identifier" | "shorthand_property_identifier" => HighlightType::Property,

        // Operators
        "=" | "==" | "===" | "!=" | "!==" | "+" | "-" | "*" | "/" | "%" | "&&" | "||" | "!"
        | ">" | "<" | ">=" | "<=" | "=>" | "..." | "?." | "??" => HighlightType::Operator,

        // Punctuation
        "(" | ")" | "{" | "}" | "[" | "]" | ";" | "," | "." | ":" => HighlightType::Punctuation,

        // Constants
        "true" | "false" | "null" | "undefined" => HighlightType::Constant,

        // Variables / identifiers
        "identifier" => HighlightType::Variable,

        _ => HighlightType::Plain,
    }
}
