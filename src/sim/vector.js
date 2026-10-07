export class Vector2 {
  constructor(x = 0, y = 0) {
    this.x = x
    this.y = y
  }

  add(other) {
    return new Vector2(this.x + other.x, this.y + other.y)
  }

  sub(other) {
    return new Vector2(this.x - other.x, this.y - other.y)
  }

  scale(amount) {
    return new Vector2(this.x * amount, this.y * amount)
  }

  length() {
    return Math.hypot(this.x, this.y)
  }

  normalize() {
    const magnitude = this.length()
    if (magnitude === 0) return new Vector2()
    return this.scale(1 / magnitude)
  }

  rotate(angle) {
    const cosine = Math.cos(angle)
    const sine = Math.sin(angle)
    return new Vector2(this.x * cosine - this.y * sine, this.x * sine + this.y * cosine)
  }

  dot(other) {
    return this.x * other.x + this.y * other.y
  }

  static fromAngle(angle, magnitude = 1) {
    return new Vector2(Math.cos(angle) * magnitude, Math.sin(angle) * magnitude)
  }
}
