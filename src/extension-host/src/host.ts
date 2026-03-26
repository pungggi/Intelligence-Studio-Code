/**
 * CoreCode Extension Host
 *
 * Headless Node.js process that:
 * 1. Listens for IPC connections from the native frontend
 * 2. Loads and activates VS Code extensions
 * 3. Routes messages between extensions and the frontend
 */

import { resolve } from "path";
import { ExtensionLoader } from "./extension-loader";
import { IpcServer } from "./ipc-server";
import { VscodeApiShim } from "./vscode-api-shim";

const SOCKET_PATH =
  process.env.CORECODE_SOCKET ?? "/tmp/corecode-ext-host.sock";

async function main(): Promise<void> {
  console.log("[ExtensionHost] Starting...");

  const apiShim = new VscodeApiShim();
  const extensionLoader = new ExtensionLoader(apiShim);
  const ipcServer = new IpcServer(SOCKET_PATH);

  // Start IPC server and wait for frontend connection
  await ipcServer.start();
  console.log(`[ExtensionHost] IPC server listening on ${SOCKET_PATH}`);

  // Forward IPC messages to the API shim
  ipcServer.onMessage((msg) => {
    apiShim.handleFrontendMessage(msg);
  });

  // Forward API shim events back to frontend
  apiShim.onOutgoing((msg) => {
    ipcServer.send(msg);
  });

  // Scan and activate extensions
  const extensionsDir =
    process.env.CORECODE_EXTENSIONS ??
    resolve(__dirname, "../../../test-extensions");

  console.log(`[ExtensionHost] Scanning extensions in: ${extensionsDir}`);
  await extensionLoader.scanAndActivate(extensionsDir);

  const active = extensionLoader.getActiveExtensions();
  console.log(
    `[ExtensionHost] Ready — ${active.length} extension(s) active: ${active.join(", ") || "none"}`
  );

  // Keep process alive
  process.on("SIGTERM", async () => {
    console.log("[ExtensionHost] Shutting down...");
    await ipcServer.stop();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("[ExtensionHost] Fatal error:", err);
  process.exit(1);
});
