import type { ReadonlyVector2 } from "../types.ts";

export class Vector2 {
  #x: number;
  #y: number;

  constructor(x = 0, y = 0) {
    this.#x = x;
    this.#y = y;
  }

  get x(): number {
    return this.#x;
  }

  get y(): number {
    return this.#y;
  }

  set(x: number, y: number): this {
    this.#x = x;
    this.#y = y;
    return this;
  }

  setX(x: number): this {
    this.#x = x;
    return this;
  }

  setY(y: number): this {
    this.#y = y;
    return this;
  }

  clone() {
    return new Vector2(this.#x, this.#y);
  }

  add(other: ReadonlyVector2): Vector2 {
    return new Vector2(this.#x + other.x, this.#y + other.y);
  }

  sub(other: ReadonlyVector2): Vector2 {
    return new Vector2(this.#x - other.x, this.#y - other.y);
  }

  scale(amount: number): Vector2 {
    return new Vector2(this.#x * amount, this.#y * amount);
  }

  length() {
    return Math.hypot(this.#x, this.#y);
  }

  lengthSquared() {
    return this.#x * this.#x + this.#y * this.#y;
  }

  normalize() {
    const magnitude = this.length();
    return magnitude === 0 ? new Vector2() : this.scale(1 / magnitude);
  }

  rotate(angle: number): Vector2 {
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    return new Vector2(
      this.#x * cosine - this.#y * sine,
      this.#x * sine + this.#y * cosine,
    );
  }

  dot(other: ReadonlyVector2): number {
    return this.#x * other.x + this.#y * other.y;
  }

  addInPlace(other: ReadonlyVector2): this {
    this.#x += other.x;
    this.#y += other.y;
    return this;
  }

  subInPlace(other: ReadonlyVector2): this {
    this.#x -= other.x;
    this.#y -= other.y;
    return this;
  }

  scaleInPlace(amount: number): this {
    this.#x *= amount;
    this.#y *= amount;
    return this;
  }

  addScaledInPlace(other: ReadonlyVector2, amount: number): this {
    this.#x += other.x * amount;
    this.#y += other.y * amount;
    return this;
  }

  static fromAngle(angle: number, magnitude = 1): Vector2 {
    return new Vector2(
      Math.cos(angle) * magnitude,
      Math.sin(angle) * magnitude,
    );
  }
}
