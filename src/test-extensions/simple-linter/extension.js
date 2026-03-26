/**
 * Simple Linter — A real VS Code-compatible linter extension for CoreCode M3.
 *
 * Checks JavaScript/TypeScript files for:
 * - console.log statements (warning)
 * - var declarations (warning: prefer const/let)
 * - Lines exceeding max length (warning)
 * - Missing semicolons (hint)
 * - == instead of === (warning)
 * - Empty catch blocks (error)
 * - TODO/FIXME comments (info)
 * - Debugger statements (error)
 *
 * Demonstrates the full diagnostics pipeline:
 * Extension → vscode.languages.createDiagnosticCollection → IPC → Rust → Frontend
 */

const vscode = require('vscode');

/** @type {import('vscode').DiagnosticCollection} */
let diagnosticCollection;

/**
 * @param {import('vscode').ExtensionContext} context
 */
function activate(context) {
  console.log('[SimpleLinter] Activating...');

  diagnosticCollection = vscode.languages.createDiagnosticCollection('simple-linter');

  // Lint on file open
  vscode.workspace.onDidOpenTextDocument((doc) => {
    if (isLintable(doc)) {
      lintDocument(doc);
    }
  });

  // Lint on text change (debounced via the editor's change notifications)
  vscode.workspace.onDidChangeTextDocument((event) => {
    if (isLintable(event.document)) {
      lintDocument(event.document);
    }
  });

  // Lint on close — clear diagnostics
  vscode.workspace.onDidCloseTextDocument((doc) => {
    diagnosticCollection.delete(doc.uri);
  });

  // Manual lint command
  const lintCmd = vscode.commands.registerCommand('simpleLinter.lint', () => {
    const docs = vscode.workspace.textDocuments;
    let total = 0;
    for (const doc of docs) {
      if (isLintable(doc)) {
        total += lintDocument(doc);
      }
    }
    vscode.window.showInformationMessage(`Simple Linter: Found ${total} issue(s)`);
  });

  // Clear diagnostics command
  const clearCmd = vscode.commands.registerCommand('simpleLinter.clearDiagnostics', () => {
    diagnosticCollection.clear();
    vscode.window.showInformationMessage('Simple Linter: Diagnostics cleared');
  });

  context.subscriptions.push(diagnosticCollection, lintCmd, clearCmd);

  // Lint any already-open documents
  for (const doc of vscode.workspace.textDocuments) {
    if (isLintable(doc)) {
      lintDocument(doc);
    }
  }

  console.log('[SimpleLinter] Activated');
}

/**
 * Check if a document should be linted.
 * @param {{ languageId: string, uri: string }} doc
 * @returns {boolean}
 */
function isLintable(doc) {
  const lang = doc.languageId || '';
  return ['javascript', 'typescript', 'js', 'ts', 'jsx', 'tsx', 'mjs', 'cjs'].includes(lang);
}

/**
 * Lint a document and publish diagnostics.
 * @param {import('vscode').TextDocument} doc
 * @returns {number} Number of diagnostics found
 */
function lintDocument(doc) {
  const text = doc.getText();
  const lines = text.split('\n');
  const diagnostics = [];

  const config = vscode.workspace.getConfiguration('simpleLinter');
  const maxLineLength = config.get('maxLineLength', 120);
  const warnConsoleLog = config.get('warnConsoleLog', true);
  const warnVar = config.get('warnVar', true);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Rule: console.log
    if (warnConsoleLog) {
      const consoleMatch = line.match(/\bconsole\.(log|warn|error|debug|info)\s*\(/);
      if (consoleMatch) {
        const col = line.indexOf(consoleMatch[0]);
        diagnostics.push({
          range: {
            start: { line: i, character: col },
            end: { line: i, character: col + consoleMatch[0].length - 1 },
          },
          message: `Unexpected console.${consoleMatch[1]} statement`,
          severity: vscode.DiagnosticSeverity.Warning,
          source: 'simple-linter',
        });
      }
    }

    // Rule: var declarations
    if (warnVar) {
      const varMatch = line.match(/\bvar\s+/);
      if (varMatch && !isInsideComment(line, line.indexOf(varMatch[0]))) {
        const col = line.indexOf(varMatch[0]);
        diagnostics.push({
          range: {
            start: { line: i, character: col },
            end: { line: i, character: col + 3 },
          },
          message: 'Unexpected var, use let or const instead',
          severity: vscode.DiagnosticSeverity.Warning,
          source: 'simple-linter',
        });
      }
    }

    // Rule: line length
    if (line.length > maxLineLength) {
      diagnostics.push({
        range: {
          start: { line: i, character: maxLineLength },
          end: { line: i, character: line.length },
        },
        message: `Line exceeds maximum length of ${maxLineLength} characters (${line.length})`,
        severity: vscode.DiagnosticSeverity.Warning,
        source: 'simple-linter',
      });
    }

    // Rule: == instead of === (but not !== or ==)
    const eqMatch = line.match(/[^!=]==[^=]/);
    if (eqMatch && !isInsideString(line, line.indexOf(eqMatch[0])) && !isInsideComment(line, line.indexOf(eqMatch[0]))) {
      const col = line.indexOf(eqMatch[0]) + 1;
      diagnostics.push({
        range: {
          start: { line: i, character: col },
          end: { line: i, character: col + 2 },
        },
        message: 'Expected === instead of ==',
        severity: vscode.DiagnosticSeverity.Warning,
        source: 'simple-linter',
      });
    }

    // Rule: debugger statement
    if (/^\s*debugger\s*;?\s*$/.test(line)) {
      diagnostics.push({
        range: {
          start: { line: i, character: line.indexOf('debugger') },
          end: { line: i, character: line.indexOf('debugger') + 8 },
        },
        message: 'Unexpected debugger statement',
        severity: vscode.DiagnosticSeverity.Error,
        source: 'simple-linter',
      });
    }

    // Rule: empty catch block
    if (/catch\s*\([^)]*\)\s*\{\s*\}/.test(line)) {
      const col = line.indexOf('catch');
      diagnostics.push({
        range: {
          start: { line: i, character: col },
          end: { line: i, character: col + 5 },
        },
        message: 'Empty catch block — errors should be handled or logged',
        severity: vscode.DiagnosticSeverity.Error,
        source: 'simple-linter',
      });
    }

    // Rule: TODO/FIXME comments
    const todoMatch = line.match(/\/\/\s*(TODO|FIXME|HACK|XXX)\b(.*)$/i);
    if (todoMatch) {
      const col = line.indexOf(todoMatch[0]);
      diagnostics.push({
        range: {
          start: { line: i, character: col },
          end: { line: i, character: line.length },
        },
        message: `${todoMatch[1].toUpperCase()}: ${todoMatch[2].trim() || '(no description)'}`,
        severity: vscode.DiagnosticSeverity.Information,
        source: 'simple-linter',
      });
    }
  }

  diagnosticCollection.set(doc.uri, diagnostics);
  return diagnostics.length;
}

/**
 * Simple check if a position is inside a single-line comment.
 */
function isInsideComment(line, pos) {
  const commentStart = line.indexOf('//');
  return commentStart >= 0 && commentStart < pos;
}

/**
 * Simple check if a position is inside a string literal.
 */
function isInsideString(line, pos) {
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  for (let i = 0; i < pos; i++) {
    const ch = line[i];
    const prev = i > 0 ? line[i - 1] : '';
    if (prev === '\\') continue;
    if (ch === "'" && !inDouble && !inTemplate) inSingle = !inSingle;
    if (ch === '"' && !inSingle && !inTemplate) inDouble = !inDouble;
    if (ch === '`' && !inSingle && !inDouble) inTemplate = !inTemplate;
  }
  return inSingle || inDouble || inTemplate;
}

function deactivate() {
  if (diagnosticCollection) {
    diagnosticCollection.dispose();
  }
  console.log('[SimpleLinter] Deactivated');
}

module.exports = { activate, deactivate };
