#!/usr/bin/env node
/**
 * Spike 3: Extension Host Proof-of-Concept
 *
 * Proves that a VS Code extension can be loaded and activated
 * in an isolated Node.js process, and that commands registered
 * by the extension can be invoked via IPC from the Rust frontend.
 *
 * Architecture:
 *   Rust Client --[Unix Socket]--> This Host --> Extension
 *
 * Protocol: Length-prefixed JSON (same framing as Spike 2 binary,
 *           but with JSON payloads for simplicity in the PoC)
 *
 * Usage:
 *   node src/extension-host/src/spike-ext-host.js
 *   cargo run --bin spike-ext-host
 */

const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

function getDefaultSocketPath() {
  const socketName = 'corecode-spike-ext-host.sock';
  if (process.platform === 'win32') {
    return path.join('\\\\.\\pipe', socketName);
  }
  return path.join(os.tmpdir(), socketName);
}

const SOCKET_PATH = process.env.CORECODE_SPIKE_SOCKET_PATH || getDefaultSocketPath();

// ============================================================
// VS Code API Shim — Minimal subset for Spike 3
// ============================================================

class VscodeApiShim {
  constructor() {
    this._commands = new Map();
    this._disposables = [];
    this._outputChannels = [];
    this._eventHandlers = {
      onDidChangeTextDocument: [],
    };
    this._diagnosticCollections = new Map();
  }

  /**
   * Build the `vscode` module that gets injected into extensions.
   */
  buildApi(extensionId) {
    const self = this;

    return {
      // --- vscode.commands ---
      commands: {
        registerCommand(command, callback) {
          console.log(`[API] ${extensionId}: registerCommand('${command}')`);
          self._commands.set(command, callback);
          const disposable = {
            dispose() {
              self._commands.delete(command);
            },
          };
          self._disposables.push(disposable);
          return disposable;
        },

        async executeCommand(command, ...args) {
          const handler = self._commands.get(command);
          if (!handler) {
            throw new Error(`Command not found: ${command}`);
          }
          return handler(...args);
        },
      },

      // --- vscode.window ---
      window: {
        showInformationMessage(message, ...items) {
          console.log(`[API] showInformationMessage: ${message}`);
          return Promise.resolve(items[0]);
        },
        showWarningMessage(message, ...items) {
          console.log(`[API] showWarningMessage: ${message}`);
          return Promise.resolve(items[0]);
        },
        showErrorMessage(message, ...items) {
          console.log(`[API] showErrorMessage: ${message}`);
          return Promise.resolve(items[0]);
        },
        createOutputChannel(name) {
          console.log(`[API] createOutputChannel: ${name}`);
          const channel = {
            name,
            _lines: [],
            appendLine(line) {
              this._lines.push(line);
              console.log(`[Output:${name}] ${line}`);
            },
            append(text) {
              console.log(`[Output:${name}] ${text}`);
            },
            show() {},
            hide() {},
            dispose() {},
          };
          self._outputChannels.push(channel);
          return channel;
        },
      },

      // --- vscode.workspace ---
      workspace: {
        getConfiguration(section) {
          return {
            get(key, defaultValue) {
              return defaultValue;
            },
            has(key) {
              return false;
            },
            update() {
              return Promise.resolve();
            },
          };
        },
        workspaceFolders: [],
        onDidChangeTextDocument: Object.assign(
          function onDidChangeTextDocument(listener) {
            self._eventHandlers.onDidChangeTextDocument.push(listener);
            return { dispose() {} };
          },
          {
            _listeners: self._eventHandlers.onDidChangeTextDocument,
            fire(event) {
              for (const listener of self._eventHandlers.onDidChangeTextDocument) {
                listener(event);
              }
            },
          }
        ),
      },

      // --- vscode.languages ---
      languages: {
        createDiagnosticCollection(name) {
          console.log(`[API] createDiagnosticCollection: ${name}`);
          const collection = {
            name,
            _entries: new Map(),
            set(uri, diagnostics) {
              this._entries.set(uri.toString(), diagnostics);
            },
            delete(uri) {
              this._entries.delete(uri.toString());
            },
            clear() {
              this._entries.clear();
            },
            dispose() {},
          };
          self._diagnosticCollections.set(name, collection);
          return collection;
        },
      },

      // --- vscode.Uri ---
      Uri: {
        file(fsPath) {
          return { scheme: 'file', fsPath, toString: () => `file://${fsPath}` };
        },
        parse(str) {
          return { scheme: 'file', fsPath: str, toString: () => str };
        },
      },

      // --- vscode.Disposable ---
      Disposable: {
        from(...disposables) {
          return {
            dispose() {
              for (const d of disposables) d.dispose();
            },
          };
        },
      },

      // --- vscode enums ---
      DiagnosticSeverity: {
        Error: 0,
        Warning: 1,
        Information: 2,
        Hint: 3,
      },

      // --- vscode.ExtensionContext (minimal) ---
      ExtensionMode: { Production: 1, Development: 2, Test: 3 },
    };
  }

  getRegisteredCommands() {
    return Array.from(this._commands.keys());
  }

  async executeCommand(command, ...args) {
    const handler = this._commands.get(command);
    if (!handler) {
      throw new Error(`Command not found: ${command}`);
    }
    return handler(...args);
  }
}

// ============================================================
// Extension Loader
// ============================================================

class ExtensionLoader {
  constructor(apiShim) {
    this.apiShim = apiShim;
    this.loadedExtensions = new Map();
  }

  /**
   * Load and activate an extension from a directory.
   */
  async loadExtension(extensionDir) {
    const manifestPath = path.join(extensionDir, 'package.json');
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`No package.json found in ${extensionDir}`);
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const extensionId = `${manifest.publisher || 'unknown'}.${manifest.name}`;

    console.log(`[Loader] Loading extension: ${extensionId} v${manifest.version}`);

    // Resolve the main entry point
    const mainPath = path.resolve(extensionDir, manifest.main || 'extension.js');
    if (!fs.existsSync(mainPath)) {
      throw new Error(`Main entry not found: ${mainPath}`);
    }

    const vscodeApi = this.apiShim.buildApi(extensionId);

    // ---------------------------------------------------------------------------
    // Module resolution override — intercept require('vscode')
    // ---------------------------------------------------------------------------
    // This monkey-patches Module._resolveFilename (a Node.js internal) so that
    // `require('vscode')` resolves to our in-memory shim instead of searching
    // node_modules.  The sentinel "vscode" is placed directly in require.cache.
    //
    // Compatibility: relies on Module._resolveFilename which is present in every
    // Node.js LTS version from v6 onward (tested through v22).  If Node ever
    // removes or renames this internal, this block and the matching cache entry
    // must be updated together — search for "Module._resolveFilename" and the
    // cache key "vscode" below.
    //
    // The same pattern is used in the production extension-loader.ts; keep both
    // in sync.
    // ---------------------------------------------------------------------------
    const Module = require('module');
    const originalResolveFilename = Module._resolveFilename;
    Module._resolveFilename = function (request, parent, isMain, options) {
      if (request === 'vscode') {
        return 'vscode';
      }
      return originalResolveFilename.call(this, request, parent, isMain, options);
    };

    require.cache['vscode'] = {
      id: 'vscode',
      filename: 'vscode',
      loaded: true,
      exports: vscodeApi,
    };

    // Load the extension module — restore resolver and clean up cache in all cases
    let extensionModule;
    try {
      extensionModule = require(mainPath);
    } finally {
      Module._resolveFilename = originalResolveFilename;
      delete require.cache['vscode'];
    }

    // Create a minimal ExtensionContext
    const storagePath = path.join(os.tmpdir(), 'corecode-ext-storage', extensionId);
    const context = {
      subscriptions: [],
      extensionPath: extensionDir,
      storagePath,
      globalStoragePath: path.join(os.tmpdir(), 'corecode-ext-global-storage'),
      extensionUri: vscodeApi.Uri.file(extensionDir),
      storageUri: vscodeApi.Uri.file(storagePath),
      globalStorageUri: vscodeApi.Uri.file(path.join(os.tmpdir(), 'corecode-ext-global-storage')),
      extensionMode: 1,
      logUri: vscodeApi.Uri.file(path.join(os.tmpdir(), 'corecode-ext-logs', extensionId)),
      asAbsolutePath(relativePath) {
        return path.join(extensionDir, relativePath);
      },
    };

    // Activate the extension
    const activateStart = Date.now();
    if (typeof extensionModule.activate === 'function') {
      await extensionModule.activate(context);
      const activateMs = Date.now() - activateStart;
      console.log(`[Loader] Activated ${extensionId} in ${activateMs}ms`);
    } else {
      console.log(`[Loader] ${extensionId} has no activate() function`);
    }

    this.loadedExtensions.set(extensionId, {
      manifest,
      module: extensionModule,
      context,
    });

    return extensionId;
  }
}

// ============================================================
// IPC Server — handles commands from Rust client
// ============================================================

function startIpcServer(apiShim) {
  if (fs.existsSync(SOCKET_PATH)) {
    fs.unlinkSync(SOCKET_PATH);
  }

  const server = net.createServer((socket) => {
    console.log('[IPC] Rust client connected');

    let buffer = Buffer.alloc(0);

    socket.on('data', async (data) => {
      buffer = Buffer.concat([buffer, data]);

      while (buffer.length >= 4) {
        const frameLen = buffer.readUInt32LE(0);
        if (buffer.length < 4 + frameLen) break;

        const payload = buffer.subarray(4, 4 + frameLen);
        buffer = buffer.subarray(4 + frameLen);

        try {
          const request = JSON.parse(payload.toString('utf8'));
          let response;

          switch (request.method) {
            case 'listCommands': {
              const commands = apiShim.getRegisteredCommands();
              response = { id: request.id, result: { commands } };
              break;
            }

            case 'executeCommand': {
              const startTime = process.hrtime.bigint();
              const result = await apiShim.executeCommand(
                request.params.command,
                ...(request.params.args || [])
              );
              const elapsed = Number(process.hrtime.bigint() - startTime) / 1_000_000;
              response = {
                id: request.id,
                result: { value: result, executionTimeMs: elapsed },
              };
              break;
            }

            case 'getExtensionInfo': {
              response = {
                id: request.id,
                result: {
                  commands: apiShim.getRegisteredCommands(),
                  shimVersion: '0.1.0-spike3',
                },
              };
              break;
            }

            default:
              response = {
                id: request.id,
                error: { message: `Unknown method: ${request.method}` },
              };
          }

          const respJson = JSON.stringify(response);
          const respBuf = Buffer.from(respJson, 'utf8');
          const frame = Buffer.alloc(4 + respBuf.length);
          frame.writeUInt32LE(respBuf.length, 0);
          respBuf.copy(frame, 4);
          socket.write(frame);
        } catch (err) {
          console.error('[IPC] Error handling request:', err.message);
          const errResp = JSON.stringify({
            id: -1,
            error: { message: err.message },
          });
          const errBuf = Buffer.from(errResp, 'utf8');
          const frame = Buffer.alloc(4 + errBuf.length);
          frame.writeUInt32LE(errBuf.length, 0);
          errBuf.copy(frame, 4);
          socket.write(frame);
        }
      }
    });

    socket.on('close', () => console.log('[IPC] Rust client disconnected'));
    socket.on('error', (err) => {
      if (err.code !== 'ECONNRESET') console.error('[IPC] Error:', err.message);
    });
  });

  server.on('error', (err) => {
    console.error(`[IPC] Failed to listen on ${SOCKET_PATH}:`, err.message);
    process.exit(1);
  });

  server.listen(SOCKET_PATH, () => {
    console.log(`[IPC] Listening on ${SOCKET_PATH}`);
  });

  return server;
}

// ============================================================
// Main
// ============================================================

async function main() {
  console.log('=== CoreCode Spike 3: Extension Host PoC ===\n');

  const apiShim = new VscodeApiShim();
  const loader = new ExtensionLoader(apiShim);

  // Load the test extension
  const testExtDir = path.resolve(__dirname, '../../test-extensions/hello-world');
  if (!fs.existsSync(testExtDir)) {
    console.error(`Test extension not found at: ${testExtDir}`);
    console.error('Please create the test extension first.');
    process.exit(1);
  }

  try {
    const extId = await loader.loadExtension(testExtDir);
    console.log(`\n[Host] Extension loaded: ${extId}`);
    console.log(`[Host] Registered commands: ${apiShim.getRegisteredCommands().join(', ')}`);
  } catch (err) {
    console.error('[Host] Failed to load extension:', err);
    process.exit(1);
  }

  // Start IPC server
  const server = startIpcServer(apiShim);

  console.log('\n[Host] Ready. Waiting for Rust client...\n');

  process.on('SIGINT', () => {
    console.log('\nShutting down...');
    server.close();
    if (fs.existsSync(SOCKET_PATH)) fs.unlinkSync(SOCKET_PATH);
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    server.close();
    if (fs.existsSync(SOCKET_PATH)) fs.unlinkSync(SOCKET_PATH);
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
