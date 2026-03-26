/**
 * Extension Loader - Discovers, loads, and activates VS Code extensions.
 *
 * Responsibilities:
 * - Scan extension directories for package.json manifests
 * - Parse activation events
 * - Create sandboxed extension contexts
 * - Manage extension lifecycle (activate/deactivate)
 */

import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
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
  module: unknown;
  isActive: boolean;
}

export class ExtensionLoader {
  private extensions: Map<string, LoadedExtension> = new Map();

  constructor(private apiShim: VscodeApiShim) {}

  /**
   * Scan a directory for VS Code extensions and activate them.
   */
  async scanAndActivate(extensionsDir: string): Promise<void> {
    if (!existsSync(extensionsDir)) {
      console.warn(`[ExtLoader] Extensions directory not found: ${extensionsDir}`);
      return;
    }

    const entries = readdirSync(extensionsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const manifestPath = join(extensionsDir, entry.name, "package.json");
      if (!existsSync(manifestPath)) continue;

      try {
        const manifest: ExtensionManifest = JSON.parse(
          readFileSync(manifestPath, "utf-8")
        );
        const id = `${manifest.publisher}.${manifest.name}`;

        this.extensions.set(id, {
          id,
          manifest,
          module: null,
          isActive: false,
        });

        console.log(`[ExtLoader] Discovered: ${id} v${manifest.version}`);
      } catch (err) {
        console.error(`[ExtLoader] Failed to parse ${manifestPath}:`, err);
      }
    }

    // TODO M2: Activate extensions based on activation events
    // TODO M2: Inject vscode API shim into extension context
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

    // TODO M2: require() the extension's main module
    // TODO M2: Call activate() with the extension context
    // TODO M2: Provide the vscode API shim

    ext.isActive = true;
    console.log(`[ExtLoader] Activated: ${extensionId}`);
  }

  getLoadedExtensions(): string[] {
    return Array.from(this.extensions.keys());
  }
}
