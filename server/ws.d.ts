declare module "ws" {
  import { EventEmitter } from "node:events";
  import type { IncomingMessage } from "node:http";
  import type { Duplex } from "node:stream";

  export type RawData = Buffer | ArrayBuffer | Buffer[];

  export class WebSocket extends EventEmitter {
    static readonly CONNECTING: number;
    static readonly OPEN: number;
    static readonly CLOSING: number;
    static readonly CLOSED: number;

    constructor(address: string);
    readonly readyState: number;
    readonly bufferedAmount: number;
    send(data: string | Buffer, callback?: (error?: Error) => void): void;
    close(code?: number, reason?: string): void;
    terminate(): void;
    ping(): void;
    on(event: "message", listener: (data: RawData, isBinary: boolean) => void): this;
    on(event: "pong" | "open", listener: () => void): this;
    on(event: "close", listener: (code: number, reason: Buffer) => void): this;
    on(event: "error", listener: (error: Error) => void): this;
  }

  export class WebSocketServer extends EventEmitter {
    readonly clients: Set<WebSocket>;
    constructor(options: {
      noServer: boolean;
      maxPayload: number;
      perMessageDeflate: boolean;
    });
    handleUpgrade(
      request: IncomingMessage,
      socket: Duplex,
      head: Buffer,
      callback: (client: WebSocket) => void,
    ): void;
    close(callback?: (error?: Error) => void): void;
    on(
      event: "connection",
      listener: (client: WebSocket, request: IncomingMessage) => void,
    ): this;
  }

  export default WebSocket;
}
