import test from 'node:test'
import assert from 'node:assert/strict'
import type { BinaryMessage } from '@dogfight/shared/codec'
import { GameSnapshotSchema, SnapshotAckSchema, SnapshotEntitySchema, type WireInputFields } from '@dogfight/shared/protocol'
import type { Input } from '../src/input.ts'
import { ClientNetcode, SnapshotBuffer } from '../src/netcode.ts'

type Snapshot = Extract<BinaryMessage, { type: 'snapshot' }>
type SnapshotEntity = Snapshot['entities'][number]
type ShipSnapshot = Extract<SnapshotEntity, { kind: 'ship' }>
type BulletSnapshot = Extract<SnapshotEntity, { kind: 'bullet' }>
type SnapshotAck = Snapshot['acks'][number]

const ship = (id: number, x: number, angle = 0): ShipSnapshot => {
  const entity = SnapshotEntitySchema.parse({
  id,
  kind: 'ship',
  x,
  y: 100,
  vx: 0,
  vy: 0,
  angle,
  radius: 13,
  hp: 3,
  thrust: 0,
  invulnerableTime: 0,
  shield: false,
  ownerId: 0,
  ttl: 0,
  commandSeq: 0,
  score: 0,
  })
  if (entity.kind !== 'ship') throw new TypeError('Expected a ship snapshot')
  return entity
}

const ack = (entityId: number, seq: number): SnapshotAck =>
  SnapshotAckSchema.parse({ entityId, seq })

const snapshot = (
  tick: number,
  entities: SnapshotEntity[],
  acks: SnapshotAck[] = [],
): Snapshot => GameSnapshotSchema.parse({ type: 'snapshot', tick, acks, entities })

const input = (isDown: Input['isDown']): Input => ({
  isDown,
  justPressed: () => false,
  endFrame: () => {},
  destroy: () => {},
})

test('snapshot interpolation blends remote entities and handles entities appearing or disappearing', () => {
  const buffer = new SnapshotBuffer()
  buffer.add(snapshot(10, [ship(1, 10), ship(3, 30)]), 100)
  buffer.add(snapshot(12, [ship(1, 30, Math.PI - 0.1), ship(2, 20)]), 200)
  const midpoint = buffer.interpolate(11)
  const first = midpoint.find((entity) => entity.id === 1)
  assert.ok(first)
  assert.equal(first.x, 20)
  assert.equal(midpoint.some((entity) => entity.id === 2), true)
  assert.equal(midpoint.some((entity) => entity.id === 3), false)
  assert.equal(
    buffer.interpolate(11.6).some((entity) => entity.id === 2),
    true,
  )
  assert.equal(buffer.add(snapshot(11, []), 300), false)
})

test('snapshot interpolation crosses arena edges along the shortest wrapped path', () => {
  const buffer = new SnapshotBuffer({ width: 960, height: 600 })
  buffer.add(snapshot(10, [ship(1, 950)]), 100)
  buffer.add(snapshot(12, [ship(1, 10)]), 200)

  const midpoint = buffer.interpolate(11)[0]
  assert.ok(midpoint)
  assert.equal(midpoint.x, 0)
  assert.equal(midpoint.y, 100)
})

test('prediction reacts immediately and reconciliation replays only unacknowledged input', () => {
  const commands: WireInputFields[] = []
  const netcode = new ClientNetcode({ sendInput: (command) => commands.push(command) })
  netcode.setIdentity({ id: 'pilot-a', entityId: 7 })
  netcode.receiveSnapshot(snapshot(1, [ship(7, 100, -Math.PI / 2)], [ack(7, 0)]), 100)
  netcode.step(1 / 30, input((code) => code === 'ArrowUp'))
  assert.ok(netcode.predicted)
  const predicted = { ...netcode.predicted }
  assert.ok(predicted.y < 100)
  assert.equal(netcode.pendingCount, 1)
  assert.equal(commands[0]?.seq, 1)
  netcode.receiveSnapshot(snapshot(2, [ship(7, 100, -Math.PI / 2)], [ack(7, 0)]), 150)
  assert.ok(netcode.predicted)
  assert.ok(Math.abs(netcode.predicted.y - predicted.y) < 0.001)
  assert.equal(netcode.pendingCount, 1)
  netcode.receiveSnapshot(snapshot(3, [ship(7, predicted.x, predicted.angle)], [ack(7, 1)]), 200)
  assert.equal(netcode.pendingCount, 0)
})

test('developer determinism experiment injects prediction-only drift that reconciliation corrects', () => {
  const netcode = new ClientNetcode()
  netcode.setIdentity({ id: 'pilot-a', entityId: 7 })
  netcode.receiveSnapshot(snapshot(1, [ship(7, 100)], [ack(7, 0)]), 100)
  netcode.setDeterminismBreak(true)
  netcode.step(1 / 30, input(() => false))
  assert.equal(netcode.predicted?.x, 101)

  netcode.receiveSnapshot(snapshot(2, [ship(7, 100)], [ack(7, 1)]), 150)
  assert.equal(netcode.predicted?.x, 100)
  assert.equal(netcode.correction, 1)
  assert.equal(netcode.pendingCount, 0)
})

test('local bullets appear immediately and reconcile when an authoritative commandSeq arrives', () => {
  const netcode = new ClientNetcode()
  netcode.setIdentity({ id: 'pilot-a', entityId: 7 })
  netcode.receiveSnapshot(snapshot(1, [ship(7, 100)], [ack(7, 0)]), 100)
  netcode.step(1 / 30, input((code) => code === 'KeyF'))
  assert.equal(netcode.predictedBullets.length, 1)
  const commandSeq = netcode.predictedBullets[0]?.commandSeq
  assert.ok(commandSeq !== undefined)
  const bulletSnapshot = SnapshotEntitySchema.parse({
    ...ship(8, 118),
    kind: 'bullet',
    ownerId: 7,
    commandSeq,
    ttl: 1.7,
    radius: 3,
  })
  if (bulletSnapshot.kind !== 'bullet') throw new TypeError('Expected a bullet snapshot')
  const bullet: BulletSnapshot = bulletSnapshot
  netcode.receiveSnapshot(snapshot(2, [ship(7, 100), bullet], [ack(7, commandSeq)]), 150)
  assert.equal(netcode.predictedBullets.length, 0)
  assert.equal(netcode.pendingCount, 0)
})
