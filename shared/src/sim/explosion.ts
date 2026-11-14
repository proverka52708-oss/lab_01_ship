import { Entity } from "./entity.ts";
import { Vector2 } from "./vector.ts";
import { mulberry32 } from "../prng.ts";
import type {
  ExplosionSnapshot,
  EntityKind,
  ExplosionParticleSnapshot,
} from "./snapshot-types.ts";

interface Particle extends Omit<ExplosionParticleSnapshot, "lifetime"> {
  readonly pos: Vector2;
  readonly vel: Vector2;
  lifetime: number;
  remaining: number;
}

export class Explosion extends Entity {
  readonly kind = "explosion" satisfies EntityKind;
  particles: Particle[];

  constructor(
    x = 0,
    y = 0,
    random: () => number = mulberry32(0),
    particleCount = 14,
    id?: number,
  ) {
    super({
      id,
      pos: new Vector2(x, y),
      radius: 0,
      kind: "explosion",
      collidable: false,
    });
    this.particles = [];
    this.reset(x, y, random, particleCount);
    this.idWasRestored = id !== undefined;
  }

  reset(
    x: number,
    y: number,
    random: () => number,
    particleCount = 14,
  ): void {
    this.resetForSpawn({
      pos: { x, y },
      vel: { x: 0, y: 0 },
      angle: 0,
      radius: 0,
      kind: "explosion",
      collidable: false,
    });
    for (let index = 0; index < particleCount; index += 1) {
      const angle = random() * Math.PI * 2;
      const speed = 35 + random() * 150;
      const lifetime = 0.35 + random() * 0.6;
      const particle = this.particles[index];
      if (particle) {
        particle.pos.set(x, y);
        particle.vel.set(
          Math.cos(angle) * speed,
          Math.sin(angle) * speed,
        );
        particle.lifetime = lifetime;
        particle.remaining = lifetime;
      } else {
        this.particles.push({
          pos: new Vector2(x, y),
          vel: Vector2.fromAngle(angle, speed),
          lifetime,
          remaining: lifetime,
        });
      }
    }
    this.particles.length = particleCount;
  }

  update(dt: number): void {
    let activeCount = 0;
    for (const particle of this.particles) {
      particle.remaining -= dt;
      particle.pos.addScaledInPlace(particle.vel, dt);
      if (particle.remaining > 0) {
        this.particles[activeCount] = particle;
        activeCount += 1;
      }
    }
    this.particles.length = activeCount;
    if (this.particles.length === 0) {
      this.alive = false;
    }
  }

  toSnapshot(): ExplosionSnapshot {
    return {
      ...super.toSnapshot(),
      kind: "explosion",
      particles: this.particles.map((particle) => ({
        pos: { x: particle.pos.x, y: particle.pos.y },
        vel: { x: particle.vel.x, y: particle.vel.y },
        lifetime: particle.lifetime,
        remaining: particle.remaining,
      })),
    };
  }

  static fromSnapshot(snapshot: ExplosionSnapshot): Explosion {
    const explosion = new Explosion(
      snapshot.pos.x,
      snapshot.pos.y,
      () => 0.5,
      0,
      snapshot.id,
    );
    explosion.particles = snapshot.particles.map((particle) => ({
      pos: new Vector2(particle.pos.x, particle.pos.y),
      vel: new Vector2(particle.vel.x, particle.vel.y),
      lifetime: particle.lifetime,
      remaining: particle.remaining,
    }));
    explosion.alive = snapshot.alive;
    return explosion;
  }
}
