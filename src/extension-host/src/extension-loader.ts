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
import { join, resolve, relative, isAbsolute } from "path";
import { VscodeApiShim } from "./vscode-api-shim";

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

interface LoadedExtension {
  id: string;
  manifest: ExtensionManifest;
  module: {
    activate?: (ctx: unknown) => unknown;
    deactivate?: () => void;
  } | null;
  isActive: boolean;
  extensionPath: string;
}

export class ExtensionLoader {
  private extensions = new Map<string, LoadedExtension>();
  private activationErrors = new Map<string, string>();

  constructor(private apiShim: VscodeApiShim) {}

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

        // Validate required fields
        if (!manifest.name || typeof manifest.name !== "string") {
          console.warn(
            `[ExtLoader] Skipping ${entry.name}: missing or invalid 'name'`
          );
          continue;
        }

        const id = `${manifest.publisher ?? "unknown"}.${manifest.name}`;

        this.extensions.set(id, {
          id,
          manifest,
          module: null,
          isActive: false,
          extensionPath: extPath,
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
          `[ExtLoader] Failed to parse ${manifestPath}:`,
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
          this.apiShim.createVscodeApi().window.showErrorMessage(
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
    const realExtPath = realpathSync(ext.extensionPath);
    const realMainPath = existsSync(mainPath) ? realpathSync(mainPath) : mainPath;

    // Check for path traversal: resolved main must be inside extension dir
    const rel = relative(realExtPath, realMainPath);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(
        `[ExtLoader] ${extensionId}: main entry '${ext.manifest.main}' escapes extension directory`
      );
    }

    if (!existsSync(mainPath) && !existsSync(mainPath + ".js")) {
      console.warn(
        `[ExtLoader] ${extensionId} main not found: ${mainPath}`
      );
      return;
    }

    try {
      // Inject vscode API into the module's require cache before loading
      const vscodeApi = this.apiShim.createVscodeApi();
      const Module = require("module");
      const originalResolve = Module._resolveFilename;
      Module._resolveFilename = function (
        request: string,
        ...args: unknown[]
      ) {
        if (request === "vscode") {
          return "vscode";
        }
        return originalResolve.call(this, request, ...args);
      };
      require.cache["vscode"] = {
        id: "vscode",
        filename: "vscode",
        loaded: true,
        exports: vscodeApi,
      } as NodeJS.Module;

      // Load the extension module, then restore the global monkeypatch
      let mod: { activate?: (ctx: unknown) => unknown; deactivate?: () => void };
      try {
        mod = require(mainPath);
      } finally {
        // Always restore the original resolver to avoid global pollution
        Module._resolveFilename = originalResolve;
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

  getActivationErrors(): Map<string, string> {
    return this.activationErrors;
  }
}
