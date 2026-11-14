import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import type { Match } from "./match.ts";

export type ArenaName = "standard" | "wide" | "compact";

export class Room extends EventEmitter {
  #clients = new Map<WebSocket, RoomPlayer>();
  id: string;
  name: string;
  capacity: number;
  arena: ArenaName;
  match: Match | null = null;

  constructor({ id, name, capacity, arena }: RoomDefinition) {
    super();
    this.id = id;
    this.name = name;
    this.capacity = capacity;
    this.arena = arena;
    this.on("error", (error) => console.error(`Room ${this.id}:`, error));
  }

  get size() {
    return this.#clients.size;
  }

  get summary() {
    return {
      id: this.id,
      name: this.name,
      players: this.size,
      capacity: this.capacity,
      arena: this.arena,
    };
  }

  has(client: WebSocket): boolean {
    return this.#clients.has(client);
  }

  join(
    client: WebSocket,
    playerName: string,
    matchId: string,
  ): RoomPlayer | false {
    if (this.#clients.has(client)) return false;
    if (this.size >= this.capacity) throw new Error("Room is full");

    const player: RoomPlayer = { id: randomUUID(), name: playerName };
    this.#clients.set(client, player);
    this.emit("join", { room: this.id, player });
    this.#send(client, { type: "joined", room: this.summary, player, matchId });
    this.broadcast({ type: "player-joined", player }, client);
    return player;
  }

  leave(client: WebSocket): boolean {
    const player = this.#clients.get(client);
    if (!player) return false;

    this.#clients.delete(client);
    this.broadcast({ type: "player-left", player });
    this.emit("leave", { room: this.id, player });
    if (this.size === 0) this.emit("empty", this);
    return true;
  }

  chat(client: WebSocket, text: string): void {
    const player = this.#clients.get(client);
    if (!player) throw new Error("Join a room before sending chat messages");

    const message = {
      type: "chat",
      roomId: this.id,
      player: player.name,
      text,
      timestamp: new Date().toISOString(),
    };
    this.emit("chat", message);
    this.broadcast(message);
  }

  broadcast(message: object, except: WebSocket | null = null): void {
    const payload = JSON.stringify(message);
    for (const client of this.#clients.keys()) {
      if (client === except || client.readyState !== 1) continue;
      if (client.bufferedAmount > 128 * 1024) {
        this.emit("slow-client", {
          room: this.id,
          bufferedAmount: client.bufferedAmount,
        });
        continue;
      }
      this.#send(client, payload);
    }
  }

  close(): void {
    for (const client of this.#clients.keys()) this.leave(client);
    this.removeAllListeners();
  }

  #send(client: WebSocket, message: object | string): void {
    if (client.readyState !== 1 || client.bufferedAmount > 128 * 1024) return;
    client.send(
      typeof message === "string" ? message : JSON.stringify(message),
      (error) => {
        if (error) this.emit("error", error);
      },
    );
  }
}

export interface RoomPlayer {
  id: string;
  name: string;
  entityId?: number;
}

export interface RoomDefinition {
  id: string;
  name: string;
  capacity: number;
  arena: ArenaName;
}
