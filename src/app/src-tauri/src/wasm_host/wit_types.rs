//! Rust representations of the WIT types defined in `corecode.wit`.
//!
//! These structs are used for:
//! 1. Serialising results to the frontend via Tauri commands (Serialize).
//! 2. Converting to/from `wasmtime::component::Val` for untyped WASM calls.

use serde::{Deserialize, Serialize};
use wasmtime::component::Val;

// ── Primitive types ───────────���──────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Position {
    pub line: u32,
    pub character: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Range {
    pub start: Position,
    pub end: Position,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Location {
    pub uri: String,
    pub range: Range,
}

// ── Severity enum ──────────────���─────────────────────────��───────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
    Information,
    Hint,
}

// ── Diagnostic ────────────────────────────────────���──────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Diagnostic {
    pub range: Range,
    pub severity: Severity,
    pub message: String,
    pub source: Option<String>,
    pub code: Option<String>,
}

// ── Completion ───────────��───────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CompletionKind {
    Text,
    Method,
    Function,
    Constructor,
    Field,
    Variable,
    Class,
    Interface,
    Module,
    Property,
    Unit,
    Value,
    EnumMember,
    Keyword,
    Snippet,
    Color,
    File,
    Reference,
    Folder,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompletionItem {
    pub label: String,
    pub kind: Option<CompletionKind>,
    pub detail: Option<String>,
    pub documentation: Option<String>,
    pub insert_text: String,
    pub filter_text: Option<String>,
}

// ── Hover ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HoverResult {
    pub contents: String,
    pub range: Option<Range>,
}

// ── Text edit ──────────���───────────────────────────────���─────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TextEdit {
    pub range: Range,
    pub new_text: String,
}

// ── Code action ──────────���───────────────────────────���───────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodeAction {
    pub title: String,
    pub kind: Option<String>,
    pub edits: Vec<TextEdit>,
}

// ── Symbol ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SymbolKind {
    File,
    Module,
    Namespace,
    Package,
    Class,
    Method,
    Property,
    Field,
    Constructor,
    Enum,
    Interface,
    Function,
    Variable,
    Constant,
    String,
    Number,
    Boolean,
    Array,
    Object,
    Key,
    Null,
    EnumMember,
    Struct,
    Event,
    Operator,
    TypeParameter,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Symbol {
    pub name: String,
    pub kind: SymbolKind,
    pub location: Location,
    pub container_name: Option<String>,
}

// ── Folding range ───────────────────────��────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FoldingRange {
    pub start_line: u32,
    pub end_line: u32,
    pub kind: Option<String>,
}

// ── Val → Rust conversion helpers ────────────────────────────────────────────

/// Extract a string field from a WIT record Val.
fn get_str(record: &[(String, Val)], name: &str) -> String {
    record
        .iter()
        .find(|(k, _)| k == name)
        .and_then(|(_, v)| match v {
            Val::String(s) => Some(s.to_string()),
            _ => None,
        })
        .unwrap_or_default()
}

/// Extract an optional string field from a WIT record Val.
fn get_opt_str(record: &[(String, Val)], name: &str) -> Option<String> {
    record
        .iter()
        .find(|(k, _)| k == name)
        .and_then(|(_, v)| match v {
            Val::Option(opt) => match opt.as_deref() {
                Some(Val::String(s)) => Some(s.to_string()),
                _ => None,
            },
            Val::String(s) => Some(s.to_string()),
            _ => None,
        })
}

/// Extract a u32 field from a WIT record Val.
fn get_u32(record: &[(String, Val)], name: &str) -> u32 {
    record
        .iter()
        .find(|(k, _)| k == name)
        .and_then(|(_, v)| match v {
            Val::U32(n) => Some(*n),
            _ => None,
        })
        .unwrap_or(0)
}

/// Extract a record (list of named fields) from inside a Val.
fn as_record(val: &Val) -> Option<&[(String, Val)]> {
    match val {
        Val::Record(fields) => Some(fields.as_slice()),
        _ => None,
    }
}

impl Position {
    pub fn from_val(val: &Val) -> Option<Self> {
        let fields = as_record(val)?;
        Some(Position {
            line: get_u32(fields, "line"),
            character: get_u32(fields, "character"),
        })
    }

    pub fn to_val(&self) -> Val {
        Val::Record(vec![
            ("line".to_string(), Val::U32(self.line)),
            ("character".to_string(), Val::U32(self.character)),
        ])
    }
}

impl Range {
    pub fn from_val(val: &Val) -> Option<Self> {
        let fields = as_record(val)?;
        let start = fields
            .iter()
            .find(|(k, _)| k == "start")
            .and_then(|(_, v)| Position::from_val(v))?;
        let end = fields
            .iter()
            .find(|(k, _)| k == "end")
            .and_then(|(_, v)| Position::from_val(v))?;
        Some(Range { start, end })
    }

    pub fn to_val(&self) -> Val {
        Val::Record(vec![
            ("start".to_string(), self.start.to_val()),
            ("end".to_string(), self.end.to_val()),
        ])
    }
}

impl Location {
    pub fn from_val(val: &Val) -> Option<Self> {
        let fields = as_record(val)?;
        let uri = get_str(fields, "uri");
        let range = fields
            .iter()
            .find(|(k, _)| k == "range")
            .and_then(|(_, v)| Range::from_val(v))?;
        Some(Location { uri, range })
    }
}

impl Severity {
    pub fn from_val(val: &Val) -> Self {
        match val {
            Val::Enum(name) => match name.as_str() {
                "error" => Severity::Error,
                "warning" => Severity::Warning,
                "information" => Severity::Information,
                "hint" => Severity::Hint,
                _ => Severity::Information,
            },
            _ => Severity::Information,
        }
    }
}

impl Diagnostic {
    pub fn from_val(val: &Val) -> Option<Self> {
        let fields = as_record(val)?;
        let range = fields
            .iter()
            .find(|(k, _)| k == "range")
            .and_then(|(_, v)| Range::from_val(v))?;
        let severity = fields
            .iter()
            .find(|(k, _)| k == "severity")
            .map(|(_, v)| Severity::from_val(v))
            .unwrap_or(Severity::Information);
        Some(Diagnostic {
            range,
            severity,
            message: get_str(fields, "message"),
            source: get_opt_str(fields, "source"),
            code: get_opt_str(fields, "code"),
        })
    }

    pub fn to_val(&self) -> Val {
        let severity_name = match &self.severity {
            Severity::Error => "error",
            Severity::Warning => "warning",
            Severity::Information => "information",
            Severity::Hint => "hint",
        };
        Val::Record(vec![
            ("range".to_string(), self.range.to_val()),
            ("severity".to_string(), Val::Enum(severity_name.to_string())),
            ("message".to_string(), Val::String(self.message.clone())),
            (
                "source".to_string(),
                Val::Option(
                    self.source
                        .as_ref()
                        .map(|s| Box::new(Val::String(s.clone()))),
                ),
            ),
            (
                "code".to_string(),
                Val::Option(self.code.as_ref().map(|s| Box::new(Val::String(s.clone())))),
            ),
        ])
    }
}

impl CompletionKind {
    pub fn from_val(val: &Val) -> Self {
        match val {
            Val::Enum(name) => match name.as_str() {
                "text" => CompletionKind::Text,
                "method" => CompletionKind::Method,
                "function" => CompletionKind::Function,
                "constructor" => CompletionKind::Constructor,
                "field" => CompletionKind::Field,
                "variable" => CompletionKind::Variable,
                "class" => CompletionKind::Class,
                "interface" => CompletionKind::Interface,
                "module" => CompletionKind::Module,
                "property" => CompletionKind::Property,
                "unit" => CompletionKind::Unit,
                "value" => CompletionKind::Value,
                "enum-member" => CompletionKind::EnumMember,
                "keyword" => CompletionKind::Keyword,
                "snippet" => CompletionKind::Snippet,
                "color" => CompletionKind::Color,
                "file" => CompletionKind::File,
                "reference" => CompletionKind::Reference,
                "folder" => CompletionKind::Folder,
                _ => CompletionKind::Text,
            },
            _ => CompletionKind::Text,
        }
    }
}

impl CompletionItem {
    pub fn from_val(val: &Val) -> Option<Self> {
        let fields = as_record(val)?;
        let kind = fields
            .iter()
            .find(|(k, _)| k == "kind")
            .and_then(|(_, v)| match v {
                Val::Option(Some(inner)) => Some(CompletionKind::from_val(inner)),
                _ => None,
            });
        Some(CompletionItem {
            label: get_str(fields, "label"),
            kind,
            detail: get_opt_str(fields, "detail"),
            documentation: get_opt_str(fields, "documentation"),
            insert_text: get_str(fields, "insert-text"),
            filter_text: get_opt_str(fields, "filter-text"),
        })
    }
}

impl HoverResult {
    pub fn from_val(val: &Val) -> Option<Self> {
        let fields = as_record(val)?;
        let range = fields
            .iter()
            .find(|(k, _)| k == "range")
            .and_then(|(_, v)| match v {
                Val::Option(Some(inner)) => Range::from_val(inner),
                _ => None,
            });
        Some(HoverResult {
            contents: get_str(fields, "contents"),
            range,
        })
    }
}

impl TextEdit {
    pub fn from_val(val: &Val) -> Option<Self> {
        let fields = as_record(val)?;
        let range = fields
            .iter()
            .find(|(k, _)| k == "range")
            .and_then(|(_, v)| Range::from_val(v))?;
        Some(TextEdit {
            range,
            new_text: get_str(fields, "new-text"),
        })
    }
}

impl CodeAction {
    pub fn from_val(val: &Val) -> Option<Self> {
        let fields = as_record(val)?;
        let edits = fields
            .iter()
            .find(|(k, _)| k == "edits")
            .and_then(|(_, v)| match v {
                Val::List(items) => Some(items.iter().filter_map(TextEdit::from_val).collect()),
                _ => None,
            })
            .unwrap_or_default();
        Some(CodeAction {
            title: get_str(fields, "title"),
            kind: get_opt_str(fields, "kind"),
            edits,
        })
    }
}

impl SymbolKind {
    pub fn from_val(val: &Val) -> Self {
        match val {
            Val::Enum(name) => match name.as_str() {
                "file" => SymbolKind::File,
                "module" => SymbolKind::Module,
                "namespace" => SymbolKind::Namespace,
                "package" => SymbolKind::Package,
                "class" => SymbolKind::Class,
                "method" => SymbolKind::Method,
                "property" => SymbolKind::Property,
                "field" => SymbolKind::Field,
                "constructor" => SymbolKind::Constructor,
                "enum" => SymbolKind::Enum,
                "interface" => SymbolKind::Interface,
                "function" => SymbolKind::Function,
                "variable" => SymbolKind::Variable,
                "constant" => SymbolKind::Constant,
                "string" => SymbolKind::String,
                "number" => SymbolKind::Number,
                "boolean" => SymbolKind::Boolean,
                "array" => SymbolKind::Array,
                "object" => SymbolKind::Object,
                "key" => SymbolKind::Key,
                "null" => SymbolKind::Null,
                "enum-member" => SymbolKind::EnumMember,
                "struct" => SymbolKind::Struct,
                "event" => SymbolKind::Event,
                "operator" => SymbolKind::Operator,
                "type-parameter" => SymbolKind::TypeParameter,
                _ => SymbolKind::Variable,
            },
            _ => SymbolKind::Variable,
        }
    }
}

impl Symbol {
    pub fn from_val(val: &Val) -> Option<Self> {
        let fields = as_record(val)?;
        let kind = fields
            .iter()
            .find(|(k, _)| k == "kind")
            .map(|(_, v)| SymbolKind::from_val(v))
            .unwrap_or(SymbolKind::Variable);
        let location = fields
            .iter()
            .find(|(k, _)| k == "location")
            .and_then(|(_, v)| Location::from_val(v))?;
        Some(Symbol {
            name: get_str(fields, "name"),
            kind,
            location,
            container_name: get_opt_str(fields, "container-name"),
        })
    }
}

impl FoldingRange {
    pub fn from_val(val: &Val) -> Option<Self> {
        let fields = as_record(val)?;
        Some(FoldingRange {
            start_line: get_u32(fields, "start-line"),
            end_line: get_u32(fields, "end-line"),
            kind: get_opt_str(fields, "kind"),
        })
    }
}

/// Unwrap a WIT `result<list<T>, string>` Val into a Rust Result.
/// On Ok, calls `convert` on each list element. Returns `Err` if any
/// element fails conversion or if the inner type is not a `Val::List`.
pub fn unwrap_result_list<T>(val: &Val, convert: fn(&Val) -> Option<T>) -> Result<Vec<T>, String> {
    match val {
        Val::Result(Ok(Some(inner))) => {
            match inner.as_ref() {
                Val::List(items) => {
                    let mut results = Vec::with_capacity(items.len());
                    for (i, item) in items.iter().enumerate() {
                        match convert(item) {
                        Some(t) => results.push(t),
                        None => return Err(format!("unwrap_result_list: conversion failed at index {i}, value: {item:?}")),
                    }
                    }
                    Ok(results)
                }
                other => Err(format!(
                    "unwrap_result_list: expected Val::List, got {other:?}"
                )),
            }
        }
        Val::Result(Ok(None)) => Ok(vec![]),
        Val::Result(Err(Some(inner))) => match inner.as_ref() {
            Val::String(s) => Err(s.to_string()),
            other => Err(format!("{other:?}")),
        },
        Val::Result(Err(None)) => Err("unknown error".to_string()),
        other => Err(format!("unexpected return type: {other:?}")),
    }
}

/// Unwrap a WIT `result<option<T>, string>` Val into a Rust Result.
pub fn unwrap_result_option<T>(
    val: &Val,
    convert: fn(&Val) -> Option<T>,
) -> Result<Option<T>, String> {
    match val {
        Val::Result(Ok(Some(inner))) => match inner.as_ref() {
            Val::Option(Some(item)) => Ok(convert(item)),
            Val::Option(None) => Ok(None),
            // Some WASM components may return the value directly without Option wrapper
            other => Ok(convert(other)),
        },
        Val::Result(Ok(None)) => Ok(None),
        Val::Result(Err(Some(inner))) => match inner.as_ref() {
            Val::String(s) => Err(s.to_string()),
            other => Err(format!("{other:?}")),
        },
        Val::Result(Err(None)) => Err("unknown error".to_string()),
        other => Err(format!("unexpected return type: {other:?}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn position_roundtrip() {
        let pos = Position {
            line: 42,
            character: 7,
        };
        let val = pos.to_val();
        let back = Position::from_val(&val).unwrap();
        assert_eq!(back.line, 42);
        assert_eq!(back.character, 7);
    }

    #[test]
    fn range_roundtrip() {
        let r = Range {
            start: Position {
                line: 1,
                character: 0,
            },
            end: Position {
                line: 5,
                character: 10,
            },
        };
        let val = r.to_val();
        let back = Range::from_val(&val).unwrap();
        assert_eq!(back.start.line, 1);
        assert_eq!(back.end.character, 10);
    }

    #[test]
    fn diagnostic_roundtrip() {
        let d = Diagnostic {
            range: Range {
                start: Position {
                    line: 0,
                    character: 0,
                },
                end: Position {
                    line: 0,
                    character: 5,
                },
            },
            severity: Severity::Warning,
            message: "test warning".to_string(),
            source: Some("wasm-ext".to_string()),
            code: None,
        };
        let val = d.to_val();
        let back = Diagnostic::from_val(&val).unwrap();
        assert_eq!(back.message, "test warning");
        assert!(matches!(back.severity, Severity::Warning));
        assert_eq!(back.source, Some("wasm-ext".to_string()));
        assert_eq!(back.code, None);
    }

    #[test]
    fn severity_from_val() {
        assert!(matches!(
            Severity::from_val(&Val::Enum("error".to_string())),
            Severity::Error
        ));
        assert!(matches!(
            Severity::from_val(&Val::Enum("hint".to_string())),
            Severity::Hint
        ));
        // Unknown falls back to Information
        assert!(matches!(
            Severity::from_val(&Val::Enum("unknown".to_string())),
            Severity::Information
        ));
    }

    #[test]
    fn completion_item_from_val() {
        let val = Val::Record(vec![
            ("label".to_string(), Val::String("hello".to_string())),
            (
                "kind".to_string(),
                Val::Option(Some(Box::new(Val::Enum("function".to_string())))),
            ),
            ("detail".to_string(), Val::Option(None)),
            (
                "documentation".to_string(),
                Val::Option(Some(Box::new(Val::String("A function".to_string())))),
            ),
            (
                "insert-text".to_string(),
                Val::String("hello()".to_string()),
            ),
            ("filter-text".to_string(), Val::Option(None)),
        ]);
        let item = CompletionItem::from_val(&val).unwrap();
        assert_eq!(item.label, "hello");
        assert!(matches!(item.kind, Some(CompletionKind::Function)));
        assert_eq!(item.insert_text, "hello()");
        assert_eq!(item.documentation, Some("A function".to_string()));
    }

    #[test]
    fn hover_result_from_val() {
        let val = Val::Record(vec![
            ("contents".to_string(), Val::String("doc text".to_string())),
            ("range".to_string(), Val::Option(None)),
        ]);
        let hr = HoverResult::from_val(&val).unwrap();
        assert_eq!(hr.contents, "doc text");
        assert!(hr.range.is_none());
    }

    #[test]
    fn unwrap_result_list_ok_empty() {
        let val = Val::Result(Ok(Some(Box::new(Val::List(vec![])))));
        let result = unwrap_result_list(&val, Position::from_val);
        assert!(result.unwrap().is_empty());
    }

    #[test]
    fn unwrap_result_list_ok_with_positions() {
        let pos1 = Position {
            line: 10,
            character: 5,
        };
        let pos2 = Position {
            line: 20,
            character: 15,
        };
        let val = Val::Result(Ok(Some(Box::new(Val::List(vec![
            pos1.to_val(),
            pos2.to_val(),
        ])))));
        let result = unwrap_result_list(&val, Position::from_val).unwrap();
        assert_eq!(result.len(), 2);
        assert_eq!(result[0], pos1);
        assert_eq!(result[1], pos2);
    }

    #[test]
    fn unwrap_result_list_conversion_failure() {
        let val = Val::Result(Ok(Some(Box::new(Val::List(vec![Val::String(
            "not a record".to_string(),
        )])))));
        let result = unwrap_result_list(&val, Position::from_val);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("index 0"), "expected index in error: {err}");
    }

    #[test]
    fn unwrap_result_list_non_list_inner() {
        let val = Val::Result(Ok(Some(Box::new(Val::String("unexpected".to_string())))));
        let result = unwrap_result_list::<Position>(&val, Position::from_val);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            err.contains("expected Val::List"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn unwrap_result_list_err() {
        let val = Val::Result(Err(Some(Box::new(Val::String("oops".to_string())))));
        let result = unwrap_result_list::<Position>(&val, Position::from_val);
        assert_eq!(result.unwrap_err(), "oops");
    }

    #[test]
    fn unwrap_result_option_none() {
        let val = Val::Result(Ok(Some(Box::new(Val::Option(None)))));
        let result = unwrap_result_option(&val, HoverResult::from_val);
        assert!(result.unwrap().is_none());
    }

    #[test]
    fn unwrap_result_option_some_with_hover() {
        let hover = HoverResult {
            contents: "type Foo = Bar".to_string(),
            range: Some(Range {
                start: Position {
                    line: 1,
                    character: 0,
                },
                end: Position {
                    line: 1,
                    character: 14,
                },
            }),
        };
        let record = Val::Record(vec![
            (
                "contents".to_string(),
                Val::String("type Foo = Bar".to_string()),
            ),
            (
                "range".to_string(),
                Val::Option(Some(Box::new(
                    Range {
                        start: Position {
                            line: 1,
                            character: 0,
                        },
                        end: Position {
                            line: 1,
                            character: 14,
                        },
                    }
                    .to_val(),
                ))),
            ),
        ]);
        let val = Val::Result(Ok(Some(Box::new(Val::Option(Some(Box::new(record)))))));
        let result = unwrap_result_option(&val, HoverResult::from_val).unwrap();
        assert!(result.is_some());
        let hr = result.unwrap();
        assert_eq!(hr.contents, "type Foo = Bar");
        assert_eq!(hr.range, hover.range);
    }

    #[test]
    fn text_edit_from_val() {
        let val = Val::Record(vec![
            (
                "range".to_string(),
                Range {
                    start: Position {
                        line: 0,
                        character: 0,
                    },
                    end: Position {
                        line: 0,
                        character: 3,
                    },
                }
                .to_val(),
            ),
            ("new-text".to_string(), Val::String("new".to_string())),
        ]);
        let edit = TextEdit::from_val(&val).unwrap();
        assert_eq!(edit.new_text, "new");
        assert_eq!(edit.range.start.line, 0);
        assert_eq!(edit.range.end.character, 3);
    }

    #[test]
    fn folding_range_from_val() {
        let val = Val::Record(vec![
            ("start-line".to_string(), Val::U32(10)),
            ("end-line".to_string(), Val::U32(20)),
            (
                "kind".to_string(),
                Val::Option(Some(Box::new(Val::String("comment".to_string())))),
            ),
        ]);
        let fr = FoldingRange::from_val(&val).unwrap();
        assert_eq!(fr.start_line, 10);
        assert_eq!(fr.end_line, 20);
        assert_eq!(fr.kind, Some("comment".to_string()));
    }

    #[test]
    fn location_from_val() {
        let val = Val::Record(vec![
            ("uri".to_string(), Val::String("file:///foo.rs".to_string())),
            (
                "range".to_string(),
                Range {
                    start: Position {
                        line: 1,
                        character: 2,
                    },
                    end: Position {
                        line: 3,
                        character: 4,
                    },
                }
                .to_val(),
            ),
        ]);
        let loc = Location::from_val(&val).unwrap();
        assert_eq!(loc.uri, "file:///foo.rs");
        assert_eq!(loc.range.start.line, 1);
    }

    #[test]
    fn symbol_kind_from_val() {
        assert!(matches!(
            SymbolKind::from_val(&Val::Enum("function".to_string())),
            SymbolKind::Function
        ));
        assert!(matches!(
            SymbolKind::from_val(&Val::Enum("class".to_string())),
            SymbolKind::Class
        ));
        assert!(matches!(
            SymbolKind::from_val(&Val::Enum("enum-member".to_string())),
            SymbolKind::EnumMember
        ));
    }

    #[test]
    fn code_action_from_val() {
        let edit_val = Val::Record(vec![
            (
                "range".to_string(),
                Range {
                    start: Position {
                        line: 0,
                        character: 0,
                    },
                    end: Position {
                        line: 0,
                        character: 5,
                    },
                }
                .to_val(),
            ),
            ("new-text".to_string(), Val::String("fixed".to_string())),
        ]);
        let val = Val::Record(vec![
            ("title".to_string(), Val::String("Fix it".to_string())),
            (
                "kind".to_string(),
                Val::Option(Some(Box::new(Val::String("quickfix".to_string())))),
            ),
            ("edits".to_string(), Val::List(vec![edit_val])),
        ]);
        let action = CodeAction::from_val(&val).unwrap();
        assert_eq!(action.title, "Fix it");
        assert_eq!(action.kind, Some("quickfix".to_string()));
        assert_eq!(action.edits.len(), 1);
        assert_eq!(action.edits[0].new_text, "fixed");
    }
}
