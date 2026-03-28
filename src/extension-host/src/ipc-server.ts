/**
 * IPC Server - TCP server for communication with the native frontend.
 *
 * Cross-platform: uses TCP on localhost instead of Unix Domain Sockets.
 * Protocol: Length-prefixed JSON frames.
 * Each frame is [4 bytes LE length][JSON payload].
 *
 * Security: Requires authentication via a shared secret token.
 * The first message on any new connection must be an `ipc/auth` message
 * containing the expected token. Unauthenticated connections are rejected.
 */

import { createServer, Server, Socket } from "net";
import { timingSafeEqual } from "node:crypto";

const IPC_HOST = "127.0.0.1";
const IPC_PORT = parseInt(process.env.CORECODE_IPC_PORT ?? "0", 10);

/** Maximum IPC frame size (10 MB). Must match Rust side. */
const MAX_FRAME_SIZE = 10 * 1024 * 1024;

/** Timeout for authentication handshake (5 seconds). */
const AUTH_TIMEOUT_MS = 5000;

export interface IpcMessage {
  method: string;
  params?: Record<string, unknown>;
}

export type MessageHandler = (message: IpcMessage) => void;

export class IpcServer {
  private server: Server | null = null;
  private client: Socket | null = null;
  private messageHandler: MessageHandler | null = null;
  private bufferChunks: Buffer[] = [];
  private bufferLength: number = 0;
  private host: string;
  private port: number;
  private actualPort: number = 0;
  private authToken: string;
  private authenticated: boolean = false;
  private authTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(host?: string, port?: number, authToken?: string) {
    this.host = host ?? IPC_HOST;
    this.port = port ?? IPC_PORT;
    this.authToken = authToken ?? "";
  }

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = createServer((socket: Socket) => {
        console.log("[IPC] Frontend connected");
        if (this.client && !this.client.destroyed) {
          console.warn("[IPC] Closing previous client connection before accepting new one");
          this.client.destroy();
        }
        this.client = socket;
        this.authenticated = false;
        this.bufferChunks = [];
        this.bufferLength = 0;

        // Start auth timeout — disconnect if not authenticated in time
        if (this.authToken) {
          this.authTimer = setTimeout(() => {
            if (!this.authenticated) {
              console.error("[IPC] Auth timeout — disconnecting unauthenticated client");
              socket.destroy();
            }
          }, AUTH_TIMEOUT_MS);
        } else {
          // No token configured — all connections are accepted without authentication.
          // WARNING: this should only occur in development. In production the Tauri
          // backend always generates a token and passes it via CORECODE_IPC_TOKEN.
          console.error(
            "[IPC] SECURITY WARNING: no auth token set — accepting all connections without authentication. " +
            "Set CORECODE_IPC_TOKEN to enable authentication."
          );
          this.authenticated = true;
        }

        socket.on("data", (data: Buffer) => {
          this.onData(data);
        });

        socket.on("close", () => {
          console.log("[IPC] Frontend disconnected");
          this.client = null;
          this.authenticated = false;
          if (this.authTimer) {
            clearTimeout(this.authTimer);
            this.authTimer = null;
          }
        });

        socket.on("error", (err: Error) => {
          console.error("[IPC] Socket error:", err.message);
        });
      });

      this.server.listen(this.port, this.host, () => {
        const addr = this.server!.address();
        if (addr && typeof addr === "object") {
          this.actualPort = addr.port;
        }
        resolve(this.actualPort);
      });

      this.server.on("error", reject);
    });
  }

  private compactBuffer(): Buffer {
    if (this.bufferChunks.length === 0) return Buffer.alloc(0);
    if (this.bufferChunks.length === 1) return this.bufferChunks[0];
    const buf = Buffer.concat(this.bufferChunks, this.bufferLength);
    this.bufferChunks = [buf];
    return buf;
  }

  private onData(data: Buffer): void {
    this.bufferChunks.push(data);
    this.bufferLength += data.length;

    // Process complete frames
    while (this.bufferLength >= 4) {
      const buffer = this.compactBuffer();
      const frameLen = buffer.readUInt32LE(0);

      // Reject oversized frames
      if (frameLen > MAX_FRAME_SIZE) {
        console.error(
          `[IPC] Frame too large (${frameLen} bytes, max ${MAX_FRAME_SIZE}), disconnecting client`
        );
        this.client?.destroy();
        this.bufferChunks = [];
        this.bufferLength = 0;
        return;
      }

      if (this.bufferLength < 4 + frameLen) {
        break; // Incomplete frame, wait for more data
      }

      const payload = buffer.subarray(4, 4 + frameLen);
      const remaining = buffer.subarray(4 + frameLen);
      this.bufferChunks = remaining.length > 0 ? [remaining] : [];
      this.bufferLength = remaining.length;

      let msg: IpcMessage;
      try {
        msg = JSON.parse(payload.toString("utf-8"));
      } catch (err) {
        console.error("[IPC] Failed to parse message:", err, "raw payload:", payload.toString("utf-8"));
        continue;
      }

      try {
        // Gate on authentication: first message must be ipc/auth with correct token
        if (!this.authenticated) {
          if (msg.method === "ipc/auth" && this.authToken) {
            const providedToken = (msg.params as { token?: string })?.token;
            const tokensMatch = providedToken != null &&
              providedToken.length === this.authToken.length &&
              timingSafeEqual(Buffer.from(providedToken), Buffer.from(this.authToken));
            if (tokensMatch) {
              this.authenticated = true;
              if (this.authTimer) {
                clearTimeout(this.authTimer);
                this.authTimer = null;
              }
              console.log("[IPC] Client authenticated successfully");
            } else {
              console.error("[IPC] Auth failed — invalid token, disconnecting");
              this.client?.destroy();
              this.bufferChunks = [];
              this.bufferLength = 0;
              return;
            }
          } else {
            console.error("[IPC] Received message before authentication, disconnecting");
            this.client?.destroy();
            this.bufferChunks = [];
            this.bufferLength = 0;
            return;
          }
          continue; // Don't forward auth message to handler
        }

        this.messageHandler?.(msg);
      } catch (err) {
        console.error("[IPC] Runtime error handling message:", err);
      }
    }

    // Guard against unbounded accumulation
    if (this.bufferLength > MAX_FRAME_SIZE + 4) {
      console.error("[IPC] Accumulated buffer too large, disconnecting client");
      this.client?.destroy();
      this.bufferChunks = [];
      this.bufferLength = 0;
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

  getPort(): number {
    return this.actualPort;
  }

  async stop(): Promise<void> {
    this.client?.destroy();
    if (!this.server) return;
    return new Promise((resolve) => {
      this.server!.close(() => {
        resolve();
      });
    });
  }
}
