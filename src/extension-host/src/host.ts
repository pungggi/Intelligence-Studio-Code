/**
 * CoreCode Extension Host
 *
 * Headless Node.js process that:
 * 1. Listens for IPC connections from the native frontend
 * 2. Loads and activates VS Code extensions
 * 3. Routes messages between extensions and the frontend
 */

import { resolve, relative, isAbsolute } from "path";
import { realpathSync, existsSync } from "fs";
import { ExtensionLoader } from "./extension-loader";
import { IpcServer } from "./ipc-server";
import { VscodeApiShim } from "./vscode-api-shim";

const IPC_HOST = process.env.CORECODE_IPC_HOST ?? "127.0.0.1";
const IPC_PORT = parseInt(process.env.CORECODE_IPC_PORT ?? "17532", 10);
const IPC_TOKEN = process.env.CORECODE_IPC_TOKEN ?? "";

async function main(): Promise<void> {
  console.log("[ExtensionHost] Starting...");

  const apiShim = new VscodeApiShim();
  const extensionLoader = new ExtensionLoader(apiShim);
  const ipcServer = new IpcServer(IPC_HOST, IPC_PORT, IPC_TOKEN);

  // Start IPC server and wait for frontend connection
  await ipcServer.start();
  console.log(`[ExtensionHost] IPC server listening on ${IPC_HOST}:${IPC_PORT}`);

  // Collect allowed extension directories for path validation
  const bundledDir =
    process.env.CORECODE_EXTENSIONS ??
    resolve(__dirname, "../../../test-extensions");
  const userExtDir = process.env.CORECODE_USER_EXTENSIONS ?? "";
  const allowedExtDirs: string[] = [];
  if (existsSync(bundledDir)) {
    try { allowedExtDirs.push(realpathSync(resolve(bundledDir))); } catch { /* skip */ }
  }
  if (userExtDir && existsSync(userExtDir)) {
    try { allowedExtDirs.push(realpathSync(resolve(userExtDir))); } catch { /* skip */ }
  }

  /** Validate that an extension path is inside an allowed extensions directory. */
  function isAllowedExtensionPath(extPath: string): boolean {
    const absPath = resolve(extPath);
    let realPath: string;
    try {
      realPath = existsSync(absPath) ? realpathSync(absPath) : absPath;
    } catch {
      return false;
    }
    return allowedExtDirs.some((dir) => {
      const rel = relative(dir, realPath);
      return !rel.startsWith("..") && !isAbsolute(rel);
    });
  }

  // Forward IPC messages to the API shim, with M8 extension lifecycle hooks
  ipcServer.onMessage(async (msg) => {
    // M8: Handle extension install/uninstall at host level
    if (msg.method === "extension/installed") {
      const p = msg.params as { path: string };
      if (p?.path) {
        // Validate path is within allowed extension directories
        if (!isAllowedExtensionPath(p.path)) {
          console.error(`[ExtensionHost] Rejected extension load — path outside allowed directories: ${p.path}`);
          return;
        }
        console.log(`[ExtensionHost] Hot-loading extension from: ${p.path}`);
        try {
          await extensionLoader.loadAndActivateSingle(p.path);
          console.log(`[ExtensionHost] Extension hot-loaded successfully`);
        } catch (err) {
          console.error(`[ExtensionHost] Failed to hot-load extension:`, err);
        }
      }
      return;
    }
    if (msg.method === "extension/uninstalled") {
      const p = msg.params as { id: string };
      if (p?.id) {
        console.log(`[ExtensionHost] Deactivating extension: ${p.id}`);
        await extensionLoader.deactivateExtension(p.id);
      }
      return;
    }
    // Multi-workspace: register/unregister workspace roots so extensions see the
    // correct vscode.workspace.workspaceFolders for each open window.
    if (msg.method === "workspace/register") {
      const p = msg.params as { workspace_id: string; root_path: string };
      if (p?.workspace_id && p?.root_path) {
        apiShim.registerWorkspace(p.workspace_id, p.root_path);
        console.log(`[ExtensionHost] Workspace registered: ${p.workspace_id} → ${p.root_path}`);
      }
      return;
    }
    if (msg.method === "workspace/unregister") {
      const p = msg.params as { workspace_id: string };
      if (p?.workspace_id) {
        apiShim.unregisterWorkspace(p.workspace_id);
        console.log(`[ExtensionHost] Workspace unregistered: ${p.workspace_id}`);
      }
      return;
    }
    apiShim.handleFrontendMessage(msg);
  });

  // Forward API shim events back to frontend
  apiShim.onOutgoing((msg) => {
    ipcServer.send(msg);
  });

  // Scan and activate extensions from all configured directories
  const extensionDirs = [bundledDir];
  if (userExtDir && userExtDir !== bundledDir) {
    extensionDirs.push(userExtDir);
  }

  for (const dir of extensionDirs) {
    console.log(`[ExtensionHost] Scanning extensions in: ${dir}`);
    await extensionLoader.scanAndActivate(dir);
  }

  const active = extensionLoader.getActiveExtensions();
  console.log(
    `[ExtensionHost] Ready — ${active.length} extension(s) active: ${active.join(", ") || "none"}`
  );

  // Graceful shutdown on SIGTERM and SIGINT
  const shutdown = async () => {
    console.log("[ExtensionHost] Shutting down...");
    await extensionLoader.deactivateAll();
    await ipcServer.stop();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("[ExtensionHost] Fatal error:", err);
  process.exit(1);
});
