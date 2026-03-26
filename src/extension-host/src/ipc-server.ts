/**
 * IPC Server - Unix Domain Socket server for communication with the native frontend.
 *
 * Protocol: Length-prefixed JSON frames.
 * Each frame is [4 bytes LE length][JSON payload].
 */

import { createServer, Server, Socket } from "net";
import { unlinkSync, existsSync } from "fs";

export interface IpcMessage {
  method: string;
  params?: Record<string, unknown>;
}

export type MessageHandler = (message: IpcMessage) => void;

export class IpcServer {
  private server: Server | null = null;
  private client: Socket | null = null;
  private messageHandler: MessageHandler | null = null;
  private buffer: Buffer = Buffer.alloc(0);

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
        this.buffer = Buffer.alloc(0);

        socket.on("data", (data) => {
          this.onData(data);
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

  private onData(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data]);

    // Process complete frames
    while (this.buffer.length >= 4) {
      const frameLen = this.buffer.readUInt32LE(0);
      if (this.buffer.length < 4 + frameLen) {
        break; // Incomplete frame
      }

      const payload = this.buffer.subarray(4, 4 + frameLen);
      this.buffer = this.buffer.subarray(4 + frameLen);

      try {
        const msg: IpcMessage = JSON.parse(payload.toString("utf-8"));
        this.messageHandler?.(msg);
      } catch (err) {
        console.error("[IPC] Failed to parse message:", err);
      }
    }
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  /** Send a JSON message with length-prefix framing. */
  send(msg: IpcMessage): void {
    if (!this.client || this.client.destroyed) return;

    const json = Buffer.from(JSON.stringify(msg), "utf-8");
    const header = Buffer.alloc(4);
    header.writeUInt32LE(json.length, 0);
    this.client.write(Buffer.concat([header, json]));
  }

  isConnected(): boolean {
    return this.client !== null && !this.client.destroyed;
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
