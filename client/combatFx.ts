import * as THREE from "three";
import { RULES } from "../shared/config";
import type { GameEvent, Projectile, Snapshot } from "../shared/types";
import type { WarshipModel } from "./warship";

function spriteTexture(smoke: boolean) {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const ctx = c.getContext("2d")!;
  if (smoke) {
    for (let n = 0; n < 34; n++) {
      const a = n * 2.399,
        r = 12 + (n % 7) * 4,
        x = 64 + Math.sin(a) * r,
        y = 64 + Math.cos(a) * r,
        gradient = ctx.createRadialGradient(x, y, 0, x, y, 24 + (n % 5));
      gradient.addColorStop(0, "rgba(255,255,255,.17)");
      gradient.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 128, 128);
    }
  } else {
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.12, "rgba(255,245,210,.95)");
    g.addColorStop(0.4, "rgba(255,160,45,.32)");
    g.addColorStop(1, "rgba(255,100,10,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
  }
  return new THREE.CanvasTexture(c);
}
function burningTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  for (let n = 0; n < 32; n++) {
    const level = n / 31,
      x = 64 + Math.sin(n * 2.399) * 25 * (1 - level),
      y = 220 - level * 185;
    const radius = 32 * (1 - level * 0.8);
    const g = ctx.createRadialGradient(x, y, 0, x, y, radius);
    g.addColorStop(
      0,
      level < 0.35 ? "rgba(255,248,199,.95)" : "rgba(255,188,43,.8)",
    );
    g.addColorStop(0.35, "rgba(255,151,19,.8)");
    g.addColorStop(0.7, "rgba(245,58,3,.4)");
    g.addColorStop(1, "rgba(170,22,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  }
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
export const fireTexture = burningTexture();
const cloud = spriteTexture(true),
  glow = spriteTexture(false);
export { cloud as smokeTexture, glow as flameTexture };
const columnGeometry = new THREE.LatheGeometry(
  [
    new THREE.Vector2(0, 0),
    new THREE.Vector2(2, 1),
    new THREE.Vector2(1.25, 5),
    new THREE.Vector2(0.8, 12),
    new THREE.Vector2(0.3, 19),
    new THREE.Vector2(0, 22),
  ],
  16,
);
const ringGeometry = new THREE.RingGeometry(0.7, 1, 40);
ringGeometry.rotateX(-Math.PI / 2);
interface Particle {
  object: THREE.Object3D;
  age: number;
  life: number;
  velocity: THREE.Vector3;
  gravity: number;
  grow: number;
  opacity: number;
  kind: string;
  startScale: THREE.Vector3;
}
interface Round {
  root: THREE.Group;
  trail: THREE.Line;
  torpedo: boolean;
}
export class CombatEffects {
  private particles: Particle[] = [];
  private rounds = new Map<number, Round>();
  private snapshot: Snapshot | null = null;
  private received = 0;
  private demos: Projectile[] = [];
  private serial = -1000;
  private emitted = 0;
  constructor(private scene: THREE.Scene) {}
  get diagnostics() {
    return {
      particles: this.particles.length,
      rounds: this.rounds.size,
      emitted: this.emitted,
    };
  }
  private particle(
    object: THREE.Object3D,
    life: number,
    velocity: THREE.Vector3,
    gravity = 0,
    grow = 0,
    kind = "smoke",
  ) {
    this.scene.add(object);
    const material = (object as THREE.Sprite).material as THREE.SpriteMaterial;
    this.particles.push({
      object,
      age: 0,
      life,
      velocity,
      gravity,
      grow,
      opacity: material?.opacity ?? 1,
      kind,
      startScale: object.scale.clone(),
    });
  }
  private puff(
    position: THREE.Vector3,
    size: number,
    color: string,
    life: number,
    velocity: THREE.Vector3,
    grow: number,
    flash = false,
  ) {
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: flash ? glow : cloud,
        color,
        transparent: true,
        opacity: flash ? 1 : 0.68,
        depthWrite: false,
        blending: flash ? THREE.AdditiveBlending : THREE.NormalBlending,
      }),
    );
    sprite.position.copy(position);
    sprite.scale.set(size, size, 1);
    sprite.material.rotation = Math.random() * Math.PI * 2;
    this.particle(sprite, life, velocity, 0, grow, flash ? "flash" : "smoke");
  }
  event(e: GameEvent, visual?: Pick<WarshipModel, "root" | "turrets">) {
    this.emitted++;
    const position = new THREE.Vector3(e.x, 2, e.z);
    if (e.type === "shot" && !["TORP", "MINE"].includes(e.text ?? "")) {
      const heavy = (e.caliber ?? 203) >= 300,
        indices =
          e.turrets ?? (["SECONDARY", "RBU"].includes(e.text ?? "") ? [] : [0]);
      if (visual) visual.root.updateMatrixWorld(true);
      const origins: THREE.Vector3[] = [];
      for (const index of indices) {
        const turret = visual?.turrets[index];
        if (!turret) continue;
        turret.userData.firedAt = performance.now() / 1000;
        if (e.elevation !== undefined)
          turret.userData.desiredElevation = e.elevation;
        const local = new THREE.Vector3(0, 1.08, turret.userData.muzzleZ ?? 5);
        const barrel = turret.userData.recoil as THREE.Group | undefined;
        origins.push((barrel ?? turret).localToWorld(local));
      }
      if (!origins.length) origins.push(position.clone().setY(5));
      for (const origin of origins) {
        this.puff(
          origin,
          heavy ? 11 : 6,
          "#ffe2ac",
          0.13,
          new THREE.Vector3(),
          12,
          true,
        );
        for (let n = 0; n < (heavy ? 6 : 3); n++) {
          const a = Math.random() * Math.PI * 2;
          this.puff(
            origin.clone(),
            2 + Math.random() * 2,
            "#aeb2af",
            2.8 + Math.random(),
            new THREE.Vector3(
              Math.sin(a) * 3,
              1.8 + Math.random() * 2,
              Math.cos(a) * 3,
            ),
            4.7,
          );
        }
        const light = new THREE.PointLight("#ffb76d", heavy ? 180 : 80, 35, 2);
        light.position.copy(origin);
        this.particle(light, 0.12, new THREE.Vector3(), 0, 0, "light");
      }
    } else if (e.type === "splash") {
      if (e.text === "island") {
        for (let n = 0; n < 9; n++)
          this.puff(
            position.clone(),
            4,
            "#8b8371",
            2.4,
            new THREE.Vector3(
              (Math.random() - 0.5) * 8,
              4 + Math.random() * 5,
              (Math.random() - 0.5) * 8,
            ),
            5,
          );
        return;
      }
      const scale =
        e.text === "island"
          ? 0.55
          : (e.caliber ?? 203) >= 300
            ? 1.8
            : e.text === "RBU"
              ? 1.1
              : 1.35;
      const column = new THREE.Mesh(
        columnGeometry,
        new THREE.MeshBasicMaterial({
          color: "#c0d9de",
          transparent: true,
          opacity: 0.82,
          depthWrite: false,
        }),
      );
      column.position.set(e.x, 0.2, e.z);
      column.scale.setScalar(scale);
      this.particle(column, 1.9, new THREE.Vector3(), 0, 0, "column");
      const ring = new THREE.Mesh(
        ringGeometry,
        new THREE.MeshBasicMaterial({
          color: "#c5dfdc",
          transparent: true,
          opacity: 0.4,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      );
      ring.position.set(e.x, 0.24, e.z);
      ring.scale.setScalar(3);
      this.particle(ring, 3.6, new THREE.Vector3(), 0, 10 * scale, "ring");
      for (let n = 0; n < Math.ceil(22 * scale); n++) {
        const a = n * 2.399;
        this.puff(
          position.clone(),
          1.6 * scale,
          "#e5eded",
          1.5,
          new THREE.Vector3(
            Math.sin(a) * (3 + Math.random() * 7) * scale,
            (9 + Math.random() * 17) * scale,
            Math.cos(a) * (3 + Math.random() * 7) * scale,
          ),
          0.3,
        );
        this.particles[this.particles.length - 1].gravity = 17;
      }
      this.puff(
        position.clone().setY(2),
        12 * scale,
        "#c3d6d8",
        2.7,
        new THREE.Vector3(2, 2, 0),
        9,
      );
    } else if (e.type === "intercept") {
      this.puff(position, 10, "#d9eff6", 0.25, new THREE.Vector3(), 22, true);
    } else if (e.type === "hit" || e.type === "sink") {
      const big = e.type === "sink";
      const strength = big
        ? 3.5
        : Math.min(2.8, 0.8 + Math.sqrt((e.damage ?? 0) / 1600));
      const blocked = e.type === "hit" && !(e.damage && e.damage > 0);
      const amount = big ? 28 : blocked ? 4 : Math.ceil(7 * strength);
      this.puff(
        position.clone().setY(e.y ?? 4),
        big ? 34 : blocked ? 3 : 10 * strength,
        blocked ? "#e6f1ff" : "#ffc16a",
        big ? 1.6 : blocked ? 0.18 : 0.75,
        new THREE.Vector3(),
        8,
        true,
      );
      if (!blocked)
        for (let n = 0; n < (big ? 10 : 4); n++) {
          const sprite = new THREE.Sprite(
            new THREE.SpriteMaterial({
              map: fireTexture,
              transparent: true,
              opacity: 1,
              depthWrite: false,
              blending: THREE.AdditiveBlending,
            }),
          );
          sprite.position.set(
            e.x + Math.sin(n * 2.399) * strength,
            e.y ?? 4,
            e.z + Math.cos(n * 2.399) * strength,
          );
          sprite.scale.set(
            (big ? 7 : 3) * strength,
            (big ? 12 : 6) * strength,
            1,
          );
          this.particle(
            sprite,
            big ? 3 : 1.6,
            new THREE.Vector3(
              (Math.random() - 0.5) * 3,
              2 + Math.random() * 3,
              (Math.random() - 0.5) * 3,
            ),
            0,
            2,
            "fire",
          );
        }
      for (let n = 0; n < amount; n++) {
        const a = n * 2.399;
        this.puff(
          position.clone().setY(e.y ?? 4),
          big ? 13 : 4 * strength,
          n % 3 ? "#444b50" : "#9c8c73",
          big ? 9 : 3.5,
          new THREE.Vector3(
            Math.sin(a) * (big ? 9 : 4 * strength),
            3 + Math.random() * 6,
            Math.cos(a) * (big ? 9 : 4 * strength),
          ),
          big ? 9 : 4 * strength,
        );
      }
      for (let n = 0; n < (big ? 18 : 8); n++) {
        const mesh = new THREE.Mesh(
          new THREE.BoxGeometry(0.045, 0.045, 0.8 + Math.random() * 1.2),
          new THREE.MeshBasicMaterial({
            color: "#ffd3a0",
            transparent: true,
            opacity: 1,
            depthWrite: false,
          }),
        );
        mesh.position.copy(position).setY(e.y ?? 4);
        mesh.quaternion.setFromEuler(
          new THREE.Euler(Math.random() * 3, Math.random() * 3, 0),
        );
        this.particle(
          mesh,
          0.5 + Math.random() * 0.4,
          new THREE.Vector3(
            (Math.random() - 0.5) * 25,
            Math.random() * 20,
            (Math.random() - 0.5) * 25,
          ),
          20,
          0,
          "spark",
        );
      }
    }
  }
  demo(model: Pick<WarshipModel, "root" | "turrets">, caliber: number) {
    const e: GameEvent = {
      id: --this.serial,
      at: 0,
      type: "shot",
      x: model.root.position.x,
      z: model.root.position.z,
      text: "AP",
      caliber,
      turrets: model.turrets.map((_, i) => i),
    };
    this.event(e, model);
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
          id: --this.serial,
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
    return e;
  }
  private round(p: Projectile) {
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
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(),
        new THREE.Vector3(),
      ]),
      new THREE.LineBasicMaterial({
        color: torpedo ? "#c1e5df" : p.kind === "AP" ? "#ffbc79" : "#ffe2b1",
        transparent: true,
        opacity: torpedo ? 0.55 : 0.9,
        depthWrite: false,
      }),
    );
    this.scene.add(root, line);
    return { root, trail: line, torpedo };
  }
  update(dt: number, snapshot: Snapshot | null, playing: boolean) {
    const now = performance.now() / 1000;
    if (snapshot !== this.snapshot) {
      this.snapshot = snapshot;
      this.received = now;
    }
    const elapsed = Math.min(0.1, now - this.received);
    const all = playing
      ? (snapshot?.projectiles ?? []).filter((p) => !p.delay || p.delay <= 0)
      : this.demos;
    if (!playing) {
      for (const p of this.demos) {
        p.age += dt;
        p.x += p.vx * dt;
        p.z += p.vz * dt;
        p.y += p.vy * dt - RULES.gravity * 0.5 * dt * dt;
        p.vy -= RULES.gravity * dt;
        if (p.y <= 0) {
          this.event({
            id: --this.serial,
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
        this.scene.remove(r.root, r.trail);
        r.root.traverse((o) => {
          if (o instanceof THREE.Mesh) {
            o.geometry.dispose();
            (o.material as THREE.Material).dispose();
          }
        });
        r.trail.geometry.dispose();
        (r.trail.material as THREE.Material).dispose();
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
      r.root.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        velocity.clone().normalize(),
      );
      const length = r.torpedo ? 0.28 : 0.09,
        previous = pos.clone().addScaledVector(velocity, -length),
        positions = r.trail.geometry.attributes.position;
      positions.setXYZ(0, pos.x, pos.y, pos.z);
      positions.setXYZ(1, previous.x, Math.max(0.2, previous.y), previous.z);
      positions.needsUpdate = true;
      r.trail.geometry.computeBoundingSphere();
    }
    for (const p of this.particles) {
      p.age += dt;
      p.object.position.addScaledVector(p.velocity, dt);
      p.velocity.y -= p.gravity * dt;
      if (p.kind === "light")
        (p.object as THREE.PointLight).intensity *= Math.exp(-dt * 30);
      else {
        const material = (p.object as THREE.Sprite)
          .material as THREE.SpriteMaterial;
        material.opacity =
          p.opacity * Math.pow(Math.max(0, 1 - p.age / p.life), 0.7);
        if (p.kind === "column")
          p.object.scale.y =
            Math.max(0.04, Math.sin(Math.min(1, p.age / p.life) * Math.PI)) *
            p.startScale.y;
        else if (p.kind === "ring") {
          p.object.scale.x = p.object.scale.z = p.startScale.x + p.age * p.grow;
          p.object.scale.y = 1;
        } else {
          p.object.scale.x = p.startScale.x + p.age * p.grow;
          p.object.scale.y = p.startScale.y + p.age * p.grow;
        }
        if (p.kind === "smoke" && material.rotation !== undefined)
          material.rotation += dt * 0.05;
      }
      if (p.age >= p.life) {
        this.scene.remove(p.object);
        if (p.kind !== "light") {
          const obj = p.object as THREE.Mesh;
          if (
            obj.geometry &&
            obj.geometry !== columnGeometry &&
            obj.geometry !== ringGeometry
          )
            obj.geometry.dispose();
          (obj.material as THREE.Material).dispose();
        }
      }
    }
    this.particles = this.particles.filter((p) => p.age < p.life);
  }
}
