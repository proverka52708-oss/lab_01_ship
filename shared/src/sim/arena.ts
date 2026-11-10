interface ShipState {
  readonly x: number;
  readonly y: number;
  readonly [key: string]: unknown;
}

function wrapCoordinate(value: number, size: number): number {
  return ((value % size) + size) % size;
}

export function wrapShip<T extends ShipState>(
  ship: T,
  width: number,
  height: number,
): T & ShipState {
  if (width <= 0 || height <= 0) {
    throw new RangeError("Arena width and height must be positive.");
  }

  return {
    ...ship,
    x: wrapCoordinate(ship.x, width),
    y: wrapCoordinate(ship.y, height),
  };
}
