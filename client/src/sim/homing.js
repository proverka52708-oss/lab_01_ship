import { Vector2 } from './vector.js'

export function createHomingBehavior(getTarget, turnRate, speed) {
  return {
    update(entity, dt) {
      const target = getTarget()
      if (!target || !target.alive) return

      const offset = target.pos.sub(entity.pos)
      if (offset.length() === 0) return

      const desiredAngle = Math.atan2(offset.y, offset.x)
      let angleDifference = desiredAngle - entity.angle

      while (angleDifference > Math.PI) angleDifference -= Math.PI * 2
      while (angleDifference < -Math.PI) angleDifference += Math.PI * 2

      const maxTurn = turnRate * dt
      const turn = Math.max(-maxTurn, Math.min(maxTurn, angleDifference))
      entity.angle += turn
      entity.vel = Vector2.fromAngle(entity.angle, speed)
    },
  }
}
