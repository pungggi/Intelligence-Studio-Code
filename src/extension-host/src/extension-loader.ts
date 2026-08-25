/**
 * Extension Loader - Discovers, loads, and activates VS Code extensions.
 *
 * Responsibilities:
 * - Scan extension directories for package.json manifests
 * - Validate extension paths (prevent path traversal)
 * - Create extension contexts with vscode API shim
 * - Manage extension lifecycle (activate/deactivate)
 */

import { readFileSync, readdirSync, existsSync, realpathSync } from "fs";
import { join, resolve, relative, isAbsolute, sep } from "path";
import { VscodeApiShim } from "./vscode-api-shim.js";
import { LanguageClient } from "./language-client.js";

interface ExtensionManifest {
  name: string;
  publisher: string;
  version: string;
  main?: string;
  activationEvents?: string[];
  contributes?: {
    commands?: Array<{ command: string; title: string }>;
    configuration?: {
      properties?: Record<string, { type?: string; default?: unknown; description?: string }>;
    };
    [key: string]: unknown;
  };
}

type Thenable<T> = PromiseLike<T>;

interface LoadedExtension {
  id: string;
  manifest: ExtensionManifest;
  module: {
    activate?: (ctx: unknown) => unknown;
    deactivate?: () => Thenable<void> | void;
  } | null;
  isActive: boolean;
  extensionPath: string;
  context: { subscriptions: { dispose: () => void }[] } | null;
}

export class ExtensionLoader {
  private extensions = new Map<string, LoadedExtension>();
  private activationErrors = new Map<string, string>();
  /** Stable vscode API singleton — shared across all extensions to avoid require.cache pollution */
  private cachedVscodeApi: ReturnType<VscodeApiShim["createVscodeApi"]> | null = null;

  constructor(private apiShim: VscodeApiShim) {}

  private getVscodeApi(): ReturnType<VscodeApiShim["createVscodeApi"]> {
    if (!this.cachedVscodeApi) {
      this.cachedVscodeApi = this.apiShim.createVscodeApi();
    }
    return this.cachedVscodeApi;
  }

  /**
   * Scan a directory for VS Code extensions and activate them.
   */
  async scanAndActivate(extensionsDir: string): Promise<void> {
    const absDir = resolve(extensionsDir);
    if (!existsSync(absDir)) {
      console.warn(
        `[ExtLoader] Extensions directory not found: ${absDir}`
      );
      return;
    }

    const entries = readdirSync(absDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const extPath = join(absDir, entry.name);
      const manifestPath = join(extPath, "package.json");
      if (!existsSync(manifestPath)) continue;

      try {
        const manifest: ExtensionManifest = JSON.parse(
          readFileSync(manifestPath, "utf-8")
        );

        const id = `${manifest.publisher ?? "unknown"}.${manifest.name}`;
        this.validateExtensionManifest(id, manifest);

        this.extensions.set(id, {
          id,
          manifest,
          module: null,
          isActive: false,
          extensionPath: extPath,
          context: null,
        });

        // Register configuration defaults from this extension
        const configProps = manifest.contributes?.configuration?.properties;
        if (configProps) {
          this.apiShim.registerConfigurationDefaults(configProps);
          console.log(
            `[ExtLoader] Registered ${Object.keys(configProps).length} config defaults for ${id}`
          );
        }

        console.log(
          `[ExtLoader] Discovered: ${id} v${manifest.version}`
        );
      } catch (err) {
        console.error(
          `[ExtLoader] Failed to load extension from ${manifestPath}:`,
          err
        );
      }
    }

    // Activate all discovered extensions (simple eager activation for M2)
    for (const [id] of this.extensions) {
      try {
        await this.activate(id);
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : String(err);
        this.activationErrors.set(id, msg);
        console.error(`[ExtLoader] Failed to activate ${id}:`, err);
        // Notify frontend of activation failure via showMessage
        try {
          this.getVscodeApi().window.showErrorMessage(
            `Extension ${id} failed to activate: ${msg}`
          );
        } catch { /* ignore send failure */ }
      }
    }
  }

  /**
   * Activate a specific extension by ID.
   */
  async activate(extensionId: string): Promise<void> {
    const ext = this.extensions.get(extensionId);
    if (!ext) {
      throw new Error(`Extension not found: ${extensionId}`);
    }

    if (ext.isActive) return;

    if (!ext.manifest.main) {
      console.warn(
        `[ExtLoader] ${extensionId} has no main entry point, skipping`
      );
      return;
    }

    // Validate the main entry point stays within the extension directory
    const mainPath = resolve(ext.extensionPath, ext.manifest.main);
    const mainPathJs = mainPath + ".js";
    const realExtPath = realpathSync(ext.extensionPath);
    // Resolve whichever path variant actually exists; fall back to the raw path for the check
    const resolvedMain = existsSync(mainPath)
      ? realpathSync(mainPath)
      : existsSync(mainPathJs)
      ? realpathSync(mainPathJs)
      : mainPath;

    // Check for path traversal: resolved main must be inside extension dir.
    // Normalize separators so ".." check works on Windows (where relative() returns backslashes).
    const rel = relative(realExtPath, resolvedMain).split(sep).join("/");
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(
        `[ExtLoader] ${extensionId}: main entry '${ext.manifest.main}' escapes extension directory`
      );
    }

    if (!existsSync(mainPath) && !existsSync(mainPathJs)) {
      console.warn(
        `[ExtLoader] ${extensionId} main not found: ${mainPath}`
      );
      return;
    }

    try {
      // Use stable cached vscode API singleton to avoid require.cache pollution
      const vscodeApi = this.getVscodeApi();

      // M6: Build vscode-languageclient shim with LanguageClient that has vscodeApi attached
      const languageClientShim = {
        LanguageClient: class extends LanguageClient {
          constructor(id: string, name: string, serverOptions: unknown, clientOptions: unknown) {
            super(id, name, serverOptions as import("./language-client.js").ServerOptions, clientOptions as import("./language-client.js").ClientOptions);
            this.setVscodeApi(vscodeApi);
          }
        },
        TransportKind: { stdio: 0, ipc: 1, pipe: 2, socket: 3 },
      };

      const Module = require("module");
      const originalResolve = Module._resolveFilename;
      Module._resolveFilename = function (
        request: string,
        ...args: unknown[]
      ) {
        if (request === "vscode") {
          return "vscode";
        }
        if (request === "vscode-languageclient" || request === "vscode-languageclient/node") {
          return "vscode-languageclient";
        }
        return originalResolve.call(this, request, ...args);
      };
      require.cache["vscode"] = {
        id: "vscode",
        filename: "vscode",
        loaded: true,
        exports: vscodeApi,
      } as NodeJS.Module;
      require.cache["vscode-languageclient"] = {
        id: "vscode-languageclient",
        filename: "vscode-languageclient",
        loaded: true,
        exports: languageClientShim,
      } as NodeJS.Module;

      // Load the extension module, then restore the global monkeypatch
      let mod: { activate?: (ctx: unknown) => unknown; deactivate?: () => Thenable<void> | void };
      try {
        mod = require(mainPath);
      } finally {
        // Always restore the original resolver and clean up cache entries
        // to avoid global pollution across extensions
        Module._resolveFilename = originalResolve;
        delete require.cache["vscode"];
        delete require.cache["vscode-languageclient"];
      }
      ext.module = mod;

      // Create extension context
      const context = {
        subscriptions: [] as { dispose: () => void }[],
        extensionPath: ext.extensionPath,
        globalState: {
          get: () => undefined,
          update: async () => {},
        },
        workspaceState: {
          get: () => undefined,
          update: async () => {},
        },
      };
      ext.context = context;

      // Call activate
      if (typeof mod.activate === "function") {
        await mod.activate(context);
      }

      ext.isActive = true;
      console.log(`[ExtLoader] Activated: ${extensionId}`);
    } catch (err) {
      console.error(`[ExtLoader] Error activating ${extensionId}:`, err);
      throw err;
    }
  }

  getLoadedExtensions(): string[] {
    return Array.from(this.extensions.keys());
  }

  getActiveExtensions(): string[] {
    return Array.from(this.extensions.entries())
      .filter(([, ext]) => ext.isActive)
      .map(([id]) => id);
  }

  async deactivateAll(): Promise<void> {
    for (const [id, ext] of this.extensions.entries()) {
      if (ext.isActive && ext.module?.deactivate) {
        try {
          await ext.module.deactivate();
          console.log(`[ExtLoader] Deactivated: ${id}`);
        } catch (err) {
          console.error(`[ExtLoader] Failed to deactivate ${id}:`, err);
        }
      }
      // Dispose all subscriptions registered by the extension
      if (ext.context) {
        for (const sub of ext.context.subscriptions) {
          try {
            sub.dispose();
          } catch (err) {
            console.warn(`[ExtLoader] Error disposing subscription in ${id}:`, err);
          }
        }
      }
      ext.isActive = false;
    }
  }

  /**
   * M8: Load and activate a single extension from its directory path.
   * Used for hot-loading newly installed extensions.
   */
  async loadAndActivateSingle(extensionPath: string): Promise<void> {
    const absPath = resolve(extensionPath);
    const manifestPath = join(absPath, "package.json");
    if (!existsSync(manifestPath)) {
      throw new Error(`No package.json found at ${absPath}`);
    }

    let manifest: ExtensionManifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    } catch (err) {
      throw new Error(`Failed to parse manifest at ${manifestPath}: ${err instanceof Error ? err.message : String(err)}`);
    }

    const id = `${manifest.publisher ?? "unknown"}.${manifest.name}`;
    this.validateExtensionManifest(id, manifest);

    // Deactivate existing version if loaded
    if (this.extensions.has(id)) {
      await this.deactivateExtension(id);
    }

    this.extensions.set(id, {
      id,
      manifest,
      module: null,
      isActive: false,
      extensionPath: absPath,
      context: null,
    });

    // Register configuration defaults
    const configProps = manifest.contributes?.configuration?.properties;
    if (configProps) {
      this.apiShim.registerConfigurationDefaults(configProps);
    }

    console.log(`[ExtLoader] Hot-discovered: ${id} v${manifest.version}`);
    await this.activate(id);
  }

  /**
   * M8: Deactivate and remove a single extension by ID.
   */
  async deactivateExtension(extensionId: string): Promise<void> {
    const ext = this.extensions.get(extensionId);
    if (!ext) return;

    if (ext.isActive && ext.module?.deactivate) {
      try {
        await ext.module.deactivate();
        console.log(`[ExtLoader] Deactivated: ${extensionId}`);
      } catch (err) {
        console.error(`[ExtLoader] Error deactivating ${extensionId}:`, err);
      }
    }

    // Dispose all subscriptions registered by the extension
    if (ext.context) {
      for (const sub of ext.context.subscriptions) {
        try {
          sub.dispose();
        } catch (err) {
          console.warn(`[ExtLoader] Error disposing subscription in ${extensionId}:`, err);
        }
      }
    }

    this.extensions.delete(extensionId);
  }

  getActivationErrors(): Map<string, string> {
    return new Map(this.activationErrors);
  }

  /**
   * Validates an extension manifest for required fields and correct data types.
   * Throws if critical fields are missing.
   *
   * Note: this method also **sanitizes** the manifest in-place:
   * - `manifest.activationEvents` is replaced with a filtered array (non-string entries dropped),
   *   or reset to `[]` if it is not an array.
   * - `manifest.contributes.commands` is replaced with a filtered array (entries missing a string
   *   `command` or `title` are dropped), or reset to `[]` if it is not an array.
   */
  private validateExtensionManifest(id: string, manifest: ExtensionManifest): void {
    if (!manifest.name || typeof manifest.name !== "string") {
      throw new Error(`[ExtLoader] ${id}: missing or invalid 'name'`);
    }
    if (!manifest.version || typeof manifest.version !== "string") {
      throw new Error(`[ExtLoader] ${id}: missing or invalid 'version'`);
    }

    // Validate activationEvents (must be string[] if present)
    if (manifest.activationEvents !== undefined) {
      if (!Array.isArray(manifest.activationEvents)) {
        console.warn(`[ExtLoader] ${id}: 'activationEvents' must be an array — ignoring it`);
        manifest.activationEvents = [];
      } else {
        manifest.activationEvents = manifest.activationEvents.filter((ev) => {
          if (typeof ev === "string") return true;
          console.warn(`[ExtLoader] ${id}: non-string activationEvent entry dropped:`, ev);
          return false;
        });
      }
    }

    // Validate contributes.commands entries
    if (manifest.contributes?.commands !== undefined) {
      if (!Array.isArray(manifest.contributes.commands)) {
        console.warn(`[ExtLoader] ${id}: 'contributes.commands' must be an array — ignoring it`);
        manifest.contributes.commands = [];
      } else {
        manifest.contributes.commands = manifest.contributes.commands.filter((cmd) => {
          if (
            cmd && typeof cmd === "object" &&
            typeof (cmd as { command?: unknown }).command === "string" &&
            typeof (cmd as { title?: unknown }).title === "string"
          ) {
            return true;
          }
          console.warn(
            `[ExtLoader] ${id}: dropping invalid command entry (must have string 'command' and 'title'):`,
            cmd
          );
          return false;
        }) as Array<{ command: string; title: string }>;
      }
    }
  }
}
