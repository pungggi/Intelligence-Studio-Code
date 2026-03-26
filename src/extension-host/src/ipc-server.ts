/**
 * IPC Server - Unix Domain Socket server for communication with the native frontend.
 *
 * Handles:
 * - Connection lifecycle (accept, disconnect, reconnect)
 * - FlatBuffers message framing
 * - Message routing
 */

import { createServer, Server, Socket } from "net";
import { unlinkSync, existsSync } from "fs";

export type MessageHandler = (message: Buffer) => void;

export class IpcServer {
  private server: Server | null = null;
  private client: Socket | null = null;
  private messageHandler: MessageHandler | null = null;

  constructor(private socketPath: string) {}

  async start(): Promise<void> {
    // Clean up stale socket file
    if (existsSync(this.socketPath)) {
      unlinkSync(this.socketPath);
    }

    return new Promise((resolve, reject) => {
      this.server = createServer((socket) => {
        console.log("[IPC] Frontend connected");
        this.client = socket;

        socket.on("data", (data) => {
          this.messageHandler?.(data);
        });

        socket.on("close", () => {
          console.log("[IPC] Frontend disconnected");
          this.client = null;
        });

        socket.on("error", (err) => {
          console.error("[IPC] Socket error:", err.message);
        });
      });

      this.server.listen(this.socketPath, () => {
        resolve();
      });

      this.server.on("error", reject);
    });
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  send(data: Buffer | Uint8Array): void {
    if (this.client && !this.client.destroyed) {
      this.client.write(data);
    }
  }

  async stop(): Promise<void> {
    this.client?.destroy();
    return new Promise((resolve) => {
      this.server?.close(() => {
        if (existsSync(this.socketPath)) {
          unlinkSync(this.socketPath);
        }
        resolve();
      });
    });
  }
}
