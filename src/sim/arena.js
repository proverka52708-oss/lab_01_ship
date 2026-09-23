export function wrapPosition(ship, width, height) {
  if (ship.x < 0) ship.x += width
  if (ship.x > width) ship.x -= width
  if (ship.y < 0) ship.y += height
  if (ship.y > height) ship.y -= height
}
