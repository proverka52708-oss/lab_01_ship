import { readFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { Room } from "./room.js";

export class RoomManager extends EventEmitter {
  #rooms = new Map();

  async load(definitionsPath) {
    const content = await readFile(definitionsPath, "utf8");
    const definitions = JSON.parse(content);
    if (!Array.isArray(definitions.rooms)) {
      throw new Error("Room definitions must contain a rooms array");
    }

    for (const definition of definitions.rooms) this.create(definition);
    return this;
  }

  list() {
    return [...this.#rooms.values()].map((room) => room.summary);
  }

  get(id) {
    return this.#rooms.get(id);
  }

  create({ id, name, capacity = 4, arena = "standard" }) {
    if (typeof id !== "string" || !/^[a-z0-9-]{1,32}$/.test(id)) {
      throw new Error(
        "Room id must contain 1-32 lowercase letters, digits, or hyphens",
      );
    }
    if (
      typeof name !== "string" ||
      name.trim().length < 1 ||
      name.trim().length > 40
    ) {
      throw new Error("Room name must contain 1-40 characters");
    }
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 16) {
      throw new Error("Room capacity must be an integer between 1 and 16");
    }
    if (this.#rooms.has(id))
      throw new Error("A room with that id already exists");

    const room = new Room({ id, name: name.trim(), capacity, arena });
    room.once("empty", () => {
      if (this.#rooms.get(id) !== room) return;
      this.#rooms.delete(id);
      this.emit("room-removed", room.summary);
    });
    this.#rooms.set(id, room);
    this.emit("room-created", room.summary);
    return room;
  }

  close() {
    for (const room of this.#rooms.values()) room.close();
    this.#rooms.clear();
    this.removeAllListeners();
  }
}
