/**
 * CoreCode Extension Host
 *
 * Headless Node.js process that:
 * 1. Listens for IPC connections from the native frontend
 * 2. Loads and activates VS Code extensions
 * 3. Manages LSP server lifecycle
 * 4. Routes API calls between extensions and the frontend
 */

import { createServer } from "net";
import { ExtensionLoader } from "./extension-loader";
import { IpcServer } from "./ipc-server";
import { VscodeApiShim } from "./vscode-api-shim";

const SOCKET_PATH =
  process.env.CORECODE_SOCKET ?? "/tmp/corecode-extension-host.sock";

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
  apiShim.onEvent((event) => {
    ipcServer.send(event);
  });

  // TODO M2: Scan extension directories and load extensions
  // await extensionLoader.scanAndActivate('/path/to/extensions');

  console.log("[ExtensionHost] Ready");

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
