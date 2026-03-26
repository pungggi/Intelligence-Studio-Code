/**
 * Extension Loader - Discovers, loads, and activates VS Code extensions.
 *
 * Responsibilities:
 * - Scan extension directories for package.json manifests
 * - Parse activation events
 * - Create extension contexts with vscode API shim
 * - Manage extension lifecycle (activate/deactivate)
 */

import { readFileSync, readdirSync, existsSync } from "fs";
import { join, resolve } from "path";
import { VscodeApiShim } from "./vscode-api-shim";

interface ExtensionManifest {
  name: string;
  publisher: string;
  version: string;
  main?: string;
  activationEvents?: string[];
  contributes?: Record<string, unknown>;
}

interface LoadedExtension {
  id: string;
  manifest: ExtensionManifest;
  module: { activate?: (ctx: unknown) => unknown; deactivate?: () => void } | null;
  isActive: boolean;
  extensionPath: string;
}

export class ExtensionLoader {
  private extensions = new Map<string, LoadedExtension>();

  constructor(private apiShim: VscodeApiShim) {}

  /**
   * Scan a directory for VS Code extensions and activate them.
   */
  async scanAndActivate(extensionsDir: string): Promise<void> {
    const absDir = resolve(extensionsDir);
    if (!existsSync(absDir)) {
      console.warn(`[ExtLoader] Extensions directory not found: ${absDir}`);
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

        this.extensions.set(id, {
          id,
          manifest,
          module: null,
          isActive: false,
          extensionPath: extPath,
        });

        console.log(`[ExtLoader] Discovered: ${id} v${manifest.version}`);
      } catch (err) {
        console.error(`[ExtLoader] Failed to parse ${manifestPath}:`, err);
      }
    }

    // Activate all discovered extensions (simple eager activation for M2)
    for (const [id] of this.extensions) {
      try {
        await this.activate(id);
      } catch (err) {
        console.error(`[ExtLoader] Failed to activate ${id}:`, err);
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
      console.warn(`[ExtLoader] ${extensionId} has no main entry point`);
      return;
    }

    const mainPath = join(ext.extensionPath, ext.manifest.main);
    if (!existsSync(mainPath) && !existsSync(mainPath + ".js")) {
      console.warn(`[ExtLoader] ${extensionId} main not found: ${mainPath}`);
      return;
    }

    try {
      // Load the extension module
      const mod = require(mainPath);
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

      // Inject vscode API into the module's require cache
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

      // Call activate
      if (typeof mod.activate === "function") {
        await mod.activate(context);
      }

      ext.isActive = true;
      console.log(`[ExtLoader] Activated: ${extensionId}`);
    } catch (err) {
      console.error(`[ExtLoader] Error activating ${extensionId}:`, err);
    }
  }

  getLoadedExtensions(): string[] {
    return Array.from(this.extensions.keys());
  }

  getActiveExtensions(): string[] {
    return Array.from(this.extensions.entries())
      .filter(([_, ext]) => ext.isActive)
      .map(([id]) => id);
  }
}
