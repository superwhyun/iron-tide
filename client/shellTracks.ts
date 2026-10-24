import * as THREE from "three";
import { RULES } from "../shared/config";
import type { GameEvent, Projectile, Snapshot } from "../shared/types";
import type { WarshipModel } from "./warship";
import { fxTextures } from "./fxTextures";
import type { ParticleSystem } from "./particles";

const { glow } = fxTextures;

interface Round {
  root: THREE.Group;
  trail: THREE.Line;
  head: THREE.Sprite;
  torpedo: boolean;
  wake: number;
}

/** Shells and torpedoes in flight: metal body, glowing tracer head and fading streak. */
export class ShellTracks {
  private rounds = new Map<number, Round>();
  private snapshot: Snapshot | null = null;
  private lastSnapshot: Snapshot | null = null;
  private received = 0;
  private demos: Projectile[] = [];
  constructor(
    private scene: THREE.Scene,
    private particles: ParticleSystem,
  ) {}
  get size() {
    return this.rounds.size;
  }
  /** Harbor preview salvo: three shells per turret simulated locally. */
  launchDemo(
    model: Pick<WarshipModel, "root" | "turrets">,
    caliber: number,
    nextId: () => number,
  ) {
    model.root.updateMatrixWorld(true);
    for (const turret of model.turrets) {
      const origin = (
          (turret.userData.recoil as THREE.Group | undefined) ?? turret
        ).localToWorld(
          new THREE.Vector3(0, 1.08, turret.userData.muzzleZ ?? 5),
        ),
        direction = new THREE.Vector3(0, 0, 1).transformDirection(
          turret.matrixWorld,
        );
      for (let n = 0; n < 3; n++)
        this.demos.push({
          id: nextId(),
          owner: "demo",
          kind: "AP",
          x: origin.x,
          z: origin.z,
          y: origin.y,
          vx: direction.x * 135 + (Math.random() - 0.5) * 3,
          vz: direction.z * 135 + (Math.random() - 0.5) * 3,
          vy: 34,
          age: 0,
          life: 4,
          damage: 0,
          caliber,
          range: 1000,
          distance: 0,
          start: { x: origin.x, z: origin.z },
        });
    }
  }
  private round(p: Projectile): Round {
    const root = new THREE.Group(),
      torpedo = p.kind === "TORP";
    const metal = new THREE.MeshStandardMaterial({
      color: torpedo ? "#2a373b" : "#4f4b45",
      roughness: 0.36,
      metalness: 0.8,
    });
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(
        torpedo ? 0.18 : 0.1,
        torpedo ? 0.21 : 0.115,
        torpedo ? 3 : 0.7,
        10,
      ),
      metal,
    );
    const tip = new THREE.Mesh(
      new THREE.ConeGeometry(torpedo ? 0.18 : 0.1, torpedo ? 0.65 : 0.28, 10),
      metal,
    );
    tip.position.y = torpedo ? 1.8 : 0.48;
    root.add(body, tip);
    const tint = new THREE.Color(
      torpedo ? "#c1e5df" : p.kind === "AP" ? "#ffb066" : "#ffd9a0",
    );
    const geometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(),
      new THREE.Vector3(),
    ]);
    // Bright head fading to nothing: additive blending treats black as transparent.
    geometry.setAttribute(
      "color",
      new THREE.Float32BufferAttribute(
        [
          ...tint
            .clone()
            .multiplyScalar(torpedo ? 0.5 : 1.7)
            .toArray(),
          0,
          0,
          0,
        ],
        3,
      ),
    );
    const line = new THREE.Line(
      geometry,
      new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    const heavy = (p.caliber ?? 0) >= 300;
    const head = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glow,
        color: tint.clone().multiplyScalar(2.6),
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    head.scale.setScalar(heavy ? 2.4 : p.kind === "SECONDARY" ? 0.9 : 1.6);
    head.visible = !torpedo;
    this.scene.add(root, line, head);
    return { root, trail: line, head, torpedo, wake: 0 };
  }
  private disposeRound(r: Round) {
    this.scene.remove(r.root, r.trail, r.head);
    r.root.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
    r.trail.geometry.dispose();
    (r.trail.material as THREE.Material).dispose();
    r.head.material.dispose();
  }
  update(
    dt: number,
    snapshot: Snapshot | null,
    playing: boolean,
    onSplash: (e: GameEvent) => void,
    nextId: () => number,
  ) {
    this.snapshot = snapshot;
    const now = performance.now() / 1000;
    if (this.snapshot !== this.lastSnapshot) {
      this.lastSnapshot = this.snapshot;
      this.received = now;
    }
    const elapsed = Math.min(0.1, now - this.received);
    const all = playing
      ? (this.snapshot?.projectiles ?? []).filter(
          (p) => !p.delay || p.delay <= 0,
        )
      : this.demos;
    if (!playing) {
      for (const p of this.demos) {
        p.age += dt;
        p.x += p.vx * dt;
        p.z += p.vz * dt;
        p.y += p.vy * dt - RULES.gravity * 0.5 * dt * dt;
        p.vy -= RULES.gravity * dt;
        if (p.y <= 0) {
          onSplash({
            id: nextId(),
            at: 0,
            type: "splash",
            x: p.x,
            z: p.z,
            caliber: p.caliber,
          });
          p.life = 0;
        }
      }
      this.demos = this.demos.filter((p) => p.life > 0 && p.age < p.life);
    }
    const ids = new Set(all.map((p) => p.id));
    for (const [id, r] of this.rounds)
      if (!ids.has(id)) {
        this.disposeRound(r);
        this.rounds.delete(id);
      }
    for (const p of all) {
      let r = this.rounds.get(p.id);
      if (!r) {
        r = this.round(p);
        this.rounds.set(p.id, r);
      }
      const age = playing ? elapsed : 0,
        pos = new THREE.Vector3(
          p.x + p.vx * age,
          Math.max(
            0.2,
            p.y +
              p.vy * age -
              (r.torpedo ? 0 : RULES.gravity * 0.5 * age * age),
          ),
          p.z + p.vz * age,
        ),
        velocity = new THREE.Vector3(
          p.vx,
          r.torpedo ? 0 : p.vy - RULES.gravity * age,
          p.vz,
        );
      r.root.position.copy(pos);
      r.head.position.copy(pos);
      r.root.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        velocity.clone().normalize(),
      );
      const length = r.torpedo ? 0.28 : 0.075,
        previous = pos.clone().addScaledVector(velocity, -length),
        positions = r.trail.geometry.attributes.position;
      positions.setXYZ(0, pos.x, pos.y, pos.z);
      positions.setXYZ(1, previous.x, Math.max(0.2, previous.y), previous.z);
      positions.needsUpdate = true;
      r.trail.geometry.computeBoundingSphere();
      if (r.torpedo) {
        r.wake += dt;
        if (r.wake > 0.14) {
          r.wake = 0;
          this.particles.decal(pos.clone().setY(0.5), 1.6, 1.4, 4.5, 0.55);
        }
      }
    }
  }
}
