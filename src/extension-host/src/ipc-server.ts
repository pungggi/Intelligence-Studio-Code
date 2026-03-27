/**
 * IPC Server - TCP server for communication with the native frontend.
 *
 * Cross-platform: uses TCP on localhost instead of Unix Domain Sockets.
 * Protocol: Length-prefixed JSON frames.
 * Each frame is [4 bytes LE length][JSON payload].
 */

import { createServer, Server, Socket } from "net";

const IPC_HOST = "127.0.0.1";
const IPC_PORT = 17532;

/** Maximum IPC frame size (10 MB). Must match Rust side. */
const MAX_FRAME_SIZE = 10 * 1024 * 1024;

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
  private host: string;
  private port: number;

  constructor(host?: string, port?: number) {
    this.host = host ?? IPC_HOST;
    this.port = port ?? IPC_PORT;
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((socket: Socket) => {
        console.log("[IPC] Frontend connected");
        this.client = socket;
        this.buffer = Buffer.alloc(0);

        socket.on("data", (data: Buffer) => {
          this.onData(data);
        });

        socket.on("close", () => {
          console.log("[IPC] Frontend disconnected");
          this.client = null;
        });

        socket.on("error", (err: Error) => {
          console.error("[IPC] Socket error:", err.message);
        });
      });

      this.server.listen(this.port, this.host, () => {
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

      // Reject oversized frames
      if (frameLen > MAX_FRAME_SIZE) {
        console.error(
          `[IPC] Frame too large (${frameLen} bytes, max ${MAX_FRAME_SIZE}), disconnecting client`
        );
        this.client?.destroy();
        this.buffer = Buffer.alloc(0);
        return;
      }

      if (this.buffer.length < 4 + frameLen) {
        break; // Incomplete frame, wait for more data
      }

      const payload = this.buffer.subarray(4, 4 + frameLen);
      this.buffer = this.buffer.subarray(4 + frameLen);

      try {
        const msg: IpcMessage = JSON.parse(payload.toString("utf-8"));
        this.messageHandler?.(msg);
      } catch (err) {
        console.error("[IPC] Failed to parse message:", err);
        // Frame was consumed from buffer, so alignment is preserved
      }
    }

    // Guard against unbounded accumulation
    if (this.buffer.length > MAX_FRAME_SIZE + 4) {
      console.error("[IPC] Accumulated buffer too large, disconnecting client");
      this.client?.destroy();
      this.buffer = Buffer.alloc(0);
    }
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  /** Send a JSON message with length-prefix framing. */
  send(msg: IpcMessage): void {
    if (!this.client || this.client.destroyed) return;

    const json = Buffer.from(JSON.stringify(msg), "utf-8");

    if (json.length > MAX_FRAME_SIZE) {
      console.error(`[IPC] Outgoing message too large (${json.length} bytes), dropping`);
      return;
    }

    const header = Buffer.alloc(4);
    header.writeUInt32LE(json.length, 0);
    const ok = this.client.write(Buffer.concat([header, json]));
    if (!ok) {
      console.warn("[IPC] Write backpressure detected, kernel buffer full");
    }
  }

  isConnected(): boolean {
    return this.client !== null && !this.client.destroyed;
  }

  async stop(): Promise<void> {
    this.client?.destroy();
    return new Promise((resolve) => {
      this.server?.close(() => {
        resolve();
      });
    });
  }
}
