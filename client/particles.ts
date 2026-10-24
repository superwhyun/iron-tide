import * as THREE from "three";
import { fxTextures } from "./fxTextures";

const { cloud, glow, spray, foam } = fxTextures;
const WIND = new THREE.Vector3(2.4, 0, 1.2);
const LIGHT_POOL = 6;
// HDR tints push flashes past the bloom threshold.
export const HDR_FLASH = new THREE.Color(9, 6.2, 3.2);
export const HDR_FIRE = new THREE.Color(5.5, 2.6, 0.8);
export const EMBER = new THREE.Color(1.1, 0.22, 0.04);

export const columnGeometry = new THREE.LatheGeometry(
  [
    new THREE.Vector2(0, 0),
    new THREE.Vector2(2.3, 0.6),
    new THREE.Vector2(1.6, 4),
    new THREE.Vector2(1.05, 10),
    new THREE.Vector2(0.75, 16),
    new THREE.Vector2(0.35, 21),
    new THREE.Vector2(0, 23),
  ],
  18,
);
export const flatGeometry = new THREE.PlaneGeometry(1, 1);
flatGeometry.rotateX(-Math.PI / 2);
export const sparkGeometry = new THREE.BoxGeometry(0.06, 0.06, 1);
export const debrisGeometry = new THREE.BoxGeometry(1, 0.35, 0.7);
const SHARED_GEOMETRY = new Set<THREE.BufferGeometry>([
  columnGeometry,
  flatGeometry,
  sparkGeometry,
  debrisGeometry,
]);

export type Kind =
  | "smoke"
  | "flash"
  | "fire"
  | "spray"
  | "column"
  | "decal"
  | "shock"
  | "spark"
  | "debris";

interface Particle {
  object: THREE.Object3D;
  material:
    THREE.SpriteMaterial | THREE.MeshBasicMaterial | THREE.MeshStandardMaterial;
  age: number;
  life: number;
  velocity: THREE.Vector3;
  gravity: number;
  drag: number;
  grow: number;
  opacity: number;
  kind: Kind;
  startScale: THREE.Vector3;
  spin: THREE.Vector3;
  wind: number;
  fadeIn: number;
  colorFrom?: THREE.Color;
  colorTo?: THREE.Color;
}
export type SpawnOptions = Partial<
  Omit<Particle, "object" | "material" | "age">
> & {
  life: number;
};
interface PooledLight {
  light: THREE.PointLight;
  age: number;
  life: number;
  peak: number;
}

export const rand = (min: number, max: number) =>
  min + Math.random() * (max - min);
export const randomUnit = () =>
  new THREE.Vector3(rand(-1, 1), rand(-1, 1), rand(-1, 1)).normalize();

/** Pooled-light, budgeted particle simulation shared by every combat effect. */
export class ParticleSystem {
  private particles: Particle[] = [];
  private lights: PooledLight[] = [];
  private nextLight = 0;
  private pending: { at: number; run: () => void }[] = [];
  clock = 0;
  private eye = new THREE.Vector3();
  private viewSlope = 0.52;
  constructor(private scene: THREE.Scene) {
    // A fixed light pool keeps the shader light count constant (no recompiles mid-battle).
    for (let n = 0; n < LIGHT_POOL; n++) {
      const light = new THREE.PointLight("#ffb46b", 0, 60, 2);
      scene.add(light);
      this.lights.push({ light, age: 1, life: 1, peak: 0 });
    }
  }
  /** Hard cap on live particles; lowered on software renderers. */
  budget = 2200;
  get count() {
    return this.particles.length;
  }
  get crowded() {
    return this.particles.length > this.budget * 0.75;
  }
  spawn(
    object: THREE.Sprite | THREE.Mesh,
    options: SpawnOptions,
  ): Particle | undefined {
    const material = object.material as Particle["material"];
    if (this.particles.length >= this.budget) {
      material.dispose();
      return undefined;
    }
    this.scene.add(object);
    const particle: Particle = {
      object,
      material,
      age: 0,
      velocity: new THREE.Vector3(),
      gravity: 0,
      drag: 0,
      grow: 0,
      opacity: material.opacity,
      kind: "smoke",
      startScale: object.scale.clone(),
      spin: new THREE.Vector3(),
      wind: 0,
      fadeIn: 0,
      ...options,
    };
    if (particle.colorFrom) material.color.copy(particle.colorFrom);
    this.particles.push(particle);
    return particle;
  }
  sprite(
    map: THREE.Texture,
    color: THREE.ColorRepresentation,
    opacity: number,
    position: THREE.Vector3,
    size: number | [number, number],
    additive = false,
  ) {
    const s = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map,
        color,
        transparent: true,
        opacity,
        depthWrite: false,
        blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
        rotation: Math.random() * Math.PI * 2,
      }),
    );
    s.position.copy(position);
    const [w, h] = Array.isArray(size) ? size : [size, size];
    s.scale.set(w, h, 1);
    return s;
  }
  mesh(
    geometry: THREE.BufferGeometry,
    color: THREE.ColorRepresentation,
    opacity: number,
    position: THREE.Vector3,
    options: { map?: THREE.Texture; additive?: boolean } = {},
  ) {
    const m = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({
        color,
        map: options.map,
        transparent: true,
        opacity,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: options.additive
          ? THREE.AdditiveBlending
          : THREE.NormalBlending,
      }),
    );
    m.position.copy(position);
    return m;
  }
  flashLight(
    position: THREE.Vector3,
    intensity: number,
    distance: number,
    life = 0.18,
    color = "#ffb46b",
  ) {
    const slot = this.lights[this.nextLight++ % LIGHT_POOL];
    slot.light.position.copy(position);
    slot.light.distance = distance;
    slot.light.color.set(color);
    slot.light.intensity = intensity;
    Object.assign(slot, { age: 0, life, peak: intensity });
  }
  later(delay: number, run: () => void) {
    this.pending.push({ at: this.clock + delay, run });
  }
  smoke(
    position: THREE.Vector3,
    size: number,
    color: THREE.ColorRepresentation,
    life: number,
    velocity: THREE.Vector3,
    grow: number,
    opacity = 0.72,
    drag = 0.6,
  ) {
    this.spawn(this.sprite(cloud, color, opacity, position, size), {
      life,
      velocity,
      grow,
      drag,
      wind: 1,
      fadeIn: 0.08,
      spin: new THREE.Vector3(0, 0, rand(-0.25, 0.25)),
    });
  }
  flash(position: THREE.Vector3, size: number, life: number, grow = 0) {
    this.spawn(this.sprite(glow, HDR_FLASH, 1, position, size, true), {
      life,
      grow,
      kind: "flash",
    });
  }
  decal(
    position: THREE.Vector3,
    size: number,
    grow: number,
    life: number,
    opacity: number,
    map = foam,
    kind: Kind = "decal",
  ) {
    const m = this.mesh(flatGeometry, "#e4eef0", opacity, position, { map });
    m.scale.set(size, 1, size);
    m.rotation.y = Math.random() * Math.PI * 2;
    m.renderOrder = 2;
    this.spawn(m, { life, grow, kind });
  }
  update(dt: number, camera?: THREE.PerspectiveCamera) {
    this.clock += dt;
    if (camera) {
      this.eye.copy(camera.position);
      this.viewSlope = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    }
    const due = this.pending.filter((p) => p.at <= this.clock);
    this.pending = this.pending.filter((p) => p.at > this.clock);
    for (const p of due) p.run();
    for (const slot of this.lights) {
      slot.age += dt;
      slot.light.intensity =
        slot.age >= slot.life
          ? 0
          : slot.peak * Math.pow(1 - slot.age / slot.life, 2);
    }
    for (const p of this.particles) this.step(p, dt);
    this.particles = this.particles.filter((p) => {
      if (p.age < p.life) return true;
      this.scene.remove(p.object);
      const geometry = (p.object as THREE.Mesh).geometry;
      if (geometry && !SHARED_GEOMETRY.has(geometry)) geometry.dispose();
      p.material.dispose();
      return false;
    });
  }
  private step(p: Particle, dt: number) {
    p.age += dt;
    const t = Math.min(1, p.age / p.life);
    if (p.drag) p.velocity.multiplyScalar(Math.exp(-p.drag * dt));
    p.velocity.y -= p.gravity * dt;
    p.object.position.addScaledVector(p.velocity, dt);
    if (p.wind) p.object.position.addScaledVector(WIND, p.wind * dt * t);
    const material = p.material;
    const fadeIn = p.fadeIn ? Math.min(1, p.age / (p.life * p.fadeIn)) : 1;
    // Fade volumes that would fill the screen (e.g. our own gun smoke in binocular view).
    let near = 1;
    if (["smoke", "spray", "debris", "spark"].includes(p.kind)) {
      const d = Math.max(1, p.object.position.distanceTo(this.eye));
      const size = Math.max(p.object.scale.x, p.object.scale.z);
      const cover = size / (2 * d * this.viewSlope);
      near = THREE.MathUtils.clamp((0.55 - cover) / 0.35, 0, 1);
    }
    material.opacity = p.opacity * fadeIn * near * Math.pow(1 - t, 0.8);
    if (p.colorFrom && p.colorTo)
      material.color.copy(p.colorFrom).lerp(p.colorTo, Math.pow(t, 0.6));
    switch (p.kind) {
      case "column": {
        // Fast eruption, slow collapse back into the sea.
        const rise = 1 - Math.pow(1 - Math.min(1, t / 0.16), 3);
        const fall = t < 0.35 ? 1 : 1 - Math.pow((t - 0.35) / 0.65, 1.6);
        p.object.scale.y = Math.max(0.03, rise * fall) * p.startScale.y;
        p.object.scale.x = p.object.scale.z = p.startScale.x * (1 + t * 0.7);
        material.opacity = p.opacity * Math.pow(1 - t, 0.6);
        break;
      }
      case "decal":
      case "shock": {
        const s =
          p.startScale.x + p.grow * (p.kind === "shock" ? Math.sqrt(t) : p.age);
        p.object.scale.set(s, 1, s);
        break;
      }
      case "spark":
        p.object.lookAt(p.object.position.clone().add(p.velocity));
        break;
      case "debris":
        p.object.rotation.x += p.spin.x * dt;
        p.object.rotation.y += p.spin.y * dt;
        p.object.rotation.z += p.spin.z * dt;
        if (p.object.position.y < 0.3 && p.velocity.y < 0) {
          p.age = p.life;
          if (!this.crowded)
            this.spawn(
              this.sprite(
                spray,
                "#eef4f4",
                0.7,
                p.object.position.clone().setY(0.6),
                1.6,
              ),
              {
                life: 0.8,
                velocity: new THREE.Vector3(0, rand(4, 7), 0),
                gravity: 14,
                grow: 2,
                kind: "spray",
              },
            );
        }
        break;
      default: {
        const s = p.object as THREE.Sprite;
        s.scale.x = p.startScale.x + p.age * p.grow;
        s.scale.y = p.startScale.y + p.age * p.grow;
        if (p.spin.z) s.material.rotation += p.spin.z * dt;
      }
    }
  }
}
