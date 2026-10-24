import * as THREE from "three";
import type { GameEvent } from "../shared/types";
import type { WarshipModel } from "./warship";
import { fxTextures } from "./fxTextures";
import {
  columnGeometry,
  debrisGeometry,
  EMBER,
  HDR_FIRE,
  ParticleSystem,
  rand,
  randomUnit,
  sparkGeometry,
} from "./particles";
import { ShellTracks } from "./shellTracks";

export { fireTexture, smokeTexture, flameTexture } from "./fxTextures";

const { cloud, glow, fire, spray, ring, sheet } = fxTextures;

/** Translates server combat events into muzzle blasts, splashes, explosions and wrecks of smoke. */
export class CombatEffects {
  private ps: ParticleSystem;
  private tracks: ShellTracks;
  private serial = -1000;
  private emitted = 0;
  constructor(scene: THREE.Scene) {
    this.ps = new ParticleSystem(scene);
    this.tracks = new ShellTracks(scene, this.ps);
  }
  set budget(value: number) {
    this.ps.budget = value;
  }
  get diagnostics() {
    return {
      particles: this.ps.count,
      rounds: this.tracks.size,
      emitted: this.emitted,
    };
  }
  private get crowded() {
    return this.ps.crowded;
  }
  event(e: GameEvent, visual?: Pick<WarshipModel, "root" | "turrets">) {
    this.emitted++;
    if (e.type === "shot" && !["TORP", "MINE"].includes(e.text ?? ""))
      this.muzzle(e, visual);
    else if (e.type === "shot" && e.text === "TORP")
      this.launch(new THREE.Vector3(e.x, 1, e.z));
    else if (e.type === "splash") this.splash(e);
    else if (e.type === "intercept") {
      const p = new THREE.Vector3(e.x, 1, e.z);
      this.waterBurst(p, 1.25);
      this.ps.flash(p.clone().setY(2), 14, 0.2, 30);
    } else if (e.type === "hit") this.hit(e);
    else if (e.type === "sink") this.sink(e);
  }

  private muzzle(
    e: GameEvent,
    visual?: Pick<WarshipModel, "root" | "turrets">,
  ) {
    const caliber = e.caliber ?? 203,
      minor = ["SECONDARY", "RBU"].includes(e.text ?? ""),
      power = minor ? 0.45 : THREE.MathUtils.clamp(caliber / 260, 0.55, 1.6);
    const indices = e.turrets ?? (minor ? [] : [0]);
    if (visual) visual.root.updateMatrixWorld(true);
    const muzzles: { origin: THREE.Vector3; dir: THREE.Vector3 }[] = [];
    for (const index of indices) {
      const turret = visual?.turrets[index];
      if (!turret) continue;
      turret.userData.firedAt = performance.now() / 1000;
      if (e.elevation !== undefined)
        turret.userData.desiredElevation = e.elevation;
      const barrel =
        (turret.userData.recoil as THREE.Group | undefined) ?? turret;
      const origin = barrel.localToWorld(
        new THREE.Vector3(0, 1.08, turret.userData.muzzleZ ?? 5),
      );
      const dir = new THREE.Vector3(0, 0, 1)
        .transformDirection(barrel.matrixWorld)
        .normalize();
      muzzles.push({ origin, dir });
    }
    if (!muzzles.length)
      muzzles.push({
        origin: new THREE.Vector3(e.x, 5, e.z),
        dir: new THREE.Vector3(0, 0.3, 1).normalize(),
      });
    for (const { origin, dir } of muzzles) {
      this.ps.flash(origin, 9 * power, 0.09, 40 * power);
      // Directional jet: flame sprites stepping out along the bore.
      for (let n = 0; n < (minor ? 2 : 5); n++) {
        const d = (1.6 + n * 2.4) * power,
          size = (7.5 - n * 1.1) * power;
        this.ps.spawn(
          this.ps.sprite(
            n < 2 ? glow : fire,
            HDR_FIRE,
            1,
            origin.clone().addScaledVector(dir, d),
            size,
            true,
          ),
          {
            life: 0.1 + n * 0.025,
            velocity: dir.clone().multiplyScalar(30 * power),
            grow: 18 * power,
            kind: "flash",
          },
        );
      }
      // Cordite smoke blown down-range, then left hanging in the wind.
      const puffs = this.crowded ? 3 : minor ? 3 : Math.round(6 + power * 5);
      for (let n = 0; n < puffs; n++) {
        const along = rand(1, 12) * power;
        this.ps.smoke(
          origin.clone().addScaledVector(dir, along),
          rand(3, 5.5) * power,
          n % 3 ? "#8f8a80" : "#b5ad9f",
          rand(3.5, 6),
          dir
            .clone()
            .multiplyScalar(rand(16, 34) * power)
            .add(randomUnit().multiplyScalar(3)),
          rand(3.5, 6) * power,
          0.62,
          1.9,
        );
      }
      if (!minor && power > 0.8) {
        // Blast overpressure flattening the sea beside the hull.
        const water = origin
          .clone()
          .addScaledVector(dir, 7 * power)
          .setY(0.6);
        this.ps.decal(water, 4, 45 * power, 0.55, 0.3, ring, "shock");
        for (let n = 0; n < 5; n++)
          this.ps.spawn(
            this.ps.sprite(
              spray,
              "#dfe9ea",
              0.5,
              water.clone().setY(1.5),
              4 * power,
            ),
            {
              life: rand(0.9, 1.5),
              velocity: dir
                .clone()
                .setY(0)
                .normalize()
                .multiplyScalar(rand(8, 18))
                .add(new THREE.Vector3(rand(-3, 3), rand(1, 3), rand(-3, 3))),
              grow: 6,
              drag: 1.5,
              kind: "spray",
            },
          );
      }
      this.ps.flashLight(origin, (minor ? 120 : 520) * power, 60 * power, 0.14);
    }
  }

  private launch(position: THREE.Vector3) {
    for (let n = 0; n < 4; n++)
      this.ps.spawn(this.ps.sprite(spray, "#e8f0f0", 0.6, position, 2.2), {
        life: 1.1,
        velocity: new THREE.Vector3(rand(-3, 3), rand(3, 6), rand(-3, 3)),
        gravity: 12,
        grow: 2,
        kind: "spray",
      });
  }

  /** Water impact: rising column, spray plumes, droplet crown, base surge and lingering foam. */
  private waterBurst(position: THREE.Vector3, scale: number) {
    const base = position.clone().setY(0.3);
    // Translucent core gives the column its silhouette; spray sprites give it volume.
    const column = this.ps.mesh(columnGeometry, "#e2ecee", 0.85, base, {
      map: sheet,
    });
    column.scale.set(scale * 1.25, scale * 1.35, scale * 1.25);
    this.ps.spawn(column, { life: 2.6, kind: "column" });
    const plumes = this.crowded ? 3 : 8;
    for (let n = 0; n < plumes; n++)
      this.ps.spawn(
        this.ps.sprite(
          n % 3 ? spray : cloud,
          "#f0f5f5",
          0.85,
          base
            .clone()
            .add(
              new THREE.Vector3(rand(-1.5, 1.5), 2 * scale, rand(-1.5, 1.5)),
            ),
          rand(5, 9) * scale,
        ),
        {
          life: rand(2.2, 3),
          velocity: new THREE.Vector3(
            rand(-2.5, 2.5),
            (8 + n * 3.2 + rand(0, 3)) * scale,
            rand(-2.5, 2.5),
          ),
          gravity: 9,
          drag: 0.35,
          grow: 5 * scale,
          kind: "spray",
          fadeIn: 0.04,
        },
      );
    const droplets = Math.ceil((this.crowded ? 10 : 26) * scale);
    for (let n = 0; n < droplets; n++) {
      const a = n * 2.399,
        out = rand(3, 9) * scale;
      this.ps.spawn(
        this.ps.sprite(
          spray,
          "#f2f6f6",
          0.85,
          base.clone().setY(1),
          rand(1.4, 2.6) * scale,
        ),
        {
          life: rand(1.3, 2.1),
          velocity: new THREE.Vector3(
            Math.sin(a) * out,
            rand(8, 20) * scale,
            Math.cos(a) * out,
          ),
          gravity: 17,
          grow: 1.2,
          kind: "spray",
        },
      );
    }
    for (let n = 0; n < (this.crowded ? 4 : 10); n++) {
      const a = (n / 10) * Math.PI * 2 + rand(0, 0.4);
      this.ps.smoke(
        base.clone().setY(1.6),
        rand(5, 8) * scale,
        "#cfdcdd",
        rand(2.6, 3.6),
        new THREE.Vector3(Math.sin(a), 0.15, Math.cos(a)).multiplyScalar(
          rand(7, 12) * scale,
        ),
        6 * scale,
        0.5,
        0.9,
      );
    }
    this.ps.decal(base.clone().setY(0.55), 5 * scale, 4 * scale, 8, 0.75);
    this.ps.decal(
      base.clone().setY(0.5),
      3 * scale,
      42 * scale,
      3.6,
      0.45,
      ring,
      "shock",
    );
  }

  private splash(e: GameEvent) {
    const position = new THREE.Vector3(e.x, 0.3, e.z);
    if (e.text === "island") {
      const p = position.clone().setY(e.y ?? 3);
      this.ps.flash(p, 6, 0.1, 30);
      for (let n = 0; n < 10; n++)
        this.ps.smoke(
          p.clone(),
          rand(3.5, 6),
          n % 2 ? "#7d705c" : "#9b8e77",
          rand(2.4, 3.6),
          new THREE.Vector3(rand(-6, 6), rand(4, 11), rand(-6, 6)),
          5,
          0.8,
          0.7,
        );
      for (let n = 0; n < 8; n++) this.debris(p, 0.6, "#5b5143");
      return;
    }
    const caliber = e.caliber ?? 203,
      scale =
        e.text === "RBU"
          ? 0.95
          : e.text === "MINE"
            ? 2.1
            : THREE.MathUtils.clamp(0.5 + caliber / 360, 0.75, 1.75);
    this.waterBurst(position, scale);
    if (e.text === "MINE" || e.text === "RBU")
      this.ps.flashLight(position.clone().setY(3), 260, 50, 0.2, "#d7f1ff");
  }

  private debris(origin: THREE.Vector3, power: number, color = "#4a4541") {
    // Lit steel plates so tumbling fragments catch the sun instead of reading as black cut-outs.
    const m = new THREE.Mesh(
      debrisGeometry,
      new THREE.MeshStandardMaterial({
        color,
        roughness: 0.7,
        metalness: 0.55,
        transparent: true,
      }),
    );
    m.position.copy(origin);
    m.scale.setScalar(rand(0.25, 0.7) * Math.min(1.5, Math.max(0.7, power)));
    m.rotation.set(rand(0, 3), rand(0, 3), rand(0, 3));
    this.ps.spawn(m, {
      life: 4,
      velocity: new THREE.Vector3(
        rand(-1, 1) * 14 * power,
        rand(9, 24) * power,
        rand(-1, 1) * 14 * power,
      ),
      gravity: 24,
      kind: "debris",
      spin: new THREE.Vector3(rand(-9, 9), rand(-9, 9), rand(-9, 9)),
    });
  }

  private sparks(
    origin: THREE.Vector3,
    count: number,
    speed: number,
    hot = true,
  ) {
    for (let n = 0; n < count; n++) {
      const m = this.ps.mesh(
        sparkGeometry,
        hot ? "#ffc070" : "#fff4dc",
        1,
        origin,
        {
          additive: true,
        },
      );
      m.material.color.multiplyScalar(hot ? 4 : 3);
      const v = randomUnit()
        .add(new THREE.Vector3(0, 0.8, 0))
        .normalize()
        .multiplyScalar(rand(0.4, 1) * speed);
      m.scale.set(1, 1, rand(0.8, 2.2));
      m.lookAt(origin.clone().add(v));
      this.ps.spawn(m, {
        life: rand(0.35, 0.8),
        velocity: v,
        gravity: 22,
        kind: "spark",
      });
    }
  }

  private blasts: { at: number; position: THREE.Vector3 }[] = [];
  /** Shells of one salvo land together; later blasts at the same spot are damped to avoid whiteout. */
  private overlap(origin: THREE.Vector3) {
    this.blasts = this.blasts.filter((b) => this.ps.clock - b.at < 0.3);
    const count = this.blasts.filter(
      (b) => b.position.distanceTo(origin) < 35,
    ).length;
    this.blasts.push({ at: this.ps.clock, position: origin.clone() });
    return 1 / (1 + count * 0.9);
  }
  private explosion(origin: THREE.Vector3, power: number, smokeLife = 6) {
    const damp = this.overlap(origin);
    this.ps.flash(
      origin,
      12 * power * Math.sqrt(damp),
      0.12,
      55 * power * damp,
    );
    // Shock front: additive ring sprite racing outward.
    if (damp === 1)
      this.ps.spawn(
        this.ps.sprite(ring, "#ffd9a8", 0.6, origin, 3 * power, true),
        {
          life: 0.32,
          grow: 110 * power,
          kind: "flash",
        },
      );
    const balls = this.crowded
      ? 4
      : Math.round((6 + power * 4) * Math.sqrt(damp));
    for (let n = 0; n < balls; n++)
      this.ps.spawn(
        this.ps.sprite(
          n % 2 ? fire : glow,
          HDR_FIRE,
          1,
          origin,
          rand(4, 7) * power,
          true,
        ),
        {
          life: rand(0.55, 1.05),
          velocity: randomUnit()
            .add(new THREE.Vector3(0, 0.6, 0))
            .multiplyScalar(rand(5, 11) * power),
          drag: 2.6,
          grow: 9 * power,
          kind: "fire",
          colorFrom: HDR_FIRE.clone().multiplyScalar(rand(1, 1.6)),
          colorTo: EMBER,
        },
      );
    this.sparks(
      origin,
      Math.round((this.crowded ? 6 : 14) * power),
      30 * power,
    );
    for (let n = 0; n < Math.round((this.crowded ? 2 : 5) * power); n++)
      this.debris(origin, power);
    const puffs = Math.round((this.crowded ? 4 : 9) * power);
    for (let n = 0; n < puffs; n++)
      this.ps.smoke(
        origin.clone().add(randomUnit().multiplyScalar(power)),
        rand(4, 7) * power,
        n % 4 ? "#2a2d2f" : "#4d4642",
        rand(smokeLife * 0.7, smokeLife),
        new THREE.Vector3(rand(-6, 6), rand(4, 9), rand(-6, 6)).multiplyScalar(
          Math.sqrt(power),
        ),
        6.5 * power,
        0.6,
        0.6,
      );
    this.ps.flashLight(origin, 900 * power * damp, 110 * power, 0.32);
  }

  private hit(e: GameEvent) {
    const origin = new THREE.Vector3(e.x, e.y ?? 4, e.z);
    const damage = e.damage ?? 0;
    const underwater =
      e.weapon === "TORP" ||
      e.weapon === "MINE" ||
      e.result === "torpedo" ||
      e.result === "mine";
    if (underwater) {
      this.waterBurst(origin.clone().setY(0.3), 2.2);
      this.explosion(origin.clone().setY(2), 1.6, 7);
      return;
    }
    if (!(damage > 0)) {
      // Ricochet, shattered shell or spawn protection: sparks without a fireball.
      this.ps.flash(origin, 5, 0.08, 25);
      this.sparks(origin, e.result === "ricochet" ? 16 : 10, 26, false);
      this.ps.smoke(
        origin,
        2.5,
        "#6b6b68",
        1.6,
        new THREE.Vector3(0, 2, 0),
        3,
        0.5,
      );
      return;
    }
    const power = Math.min(2.6, 0.7 + Math.sqrt(damage / 1700));
    this.explosion(origin, power);
    if (e.result === "citadel")
      this.ps.later(0.16, () => {
        // Secondary detonation venting a jet of flame upward.
        this.explosion(origin.clone().setY(origin.y + 2), power * 1.25, 8);
        for (let n = 0; n < 6; n++)
          this.ps.spawn(
            this.ps.sprite(
              fire,
              HDR_FIRE,
              1,
              origin,
              [4 * power, 9 * power],
              true,
            ),
            {
              life: rand(0.6, 1),
              velocity: new THREE.Vector3(
                rand(-2, 2),
                rand(18, 32),
                rand(-2, 2),
              ),
              drag: 1.4,
              grow: 6,
              kind: "fire",
              colorFrom: HDR_FIRE.clone(),
              colorTo: EMBER,
            },
          );
      });
  }

  private sink(e: GameEvent) {
    const origin = new THREE.Vector3(e.x, 6, e.z);
    this.explosion(origin, 3.4, 12);
    for (let n = 1; n < 4; n++)
      this.ps.later(n * 0.32, () =>
        this.explosion(
          origin
            .clone()
            .add(new THREE.Vector3(rand(-18, 18), rand(-2, 3), rand(-18, 18))),
          rand(1.6, 2.4),
          10,
        ),
      );
    this.waterBurst(origin.clone().setY(0.3), 2.4);
    // Towering column of oily smoke.
    for (let n = 0; n < (this.crowded ? 8 : 22); n++)
      this.ps.smoke(
        origin
          .clone()
          .add(new THREE.Vector3(rand(-8, 8), rand(0, 10), rand(-8, 8))),
        rand(12, 20),
        n % 3 ? "#1d1f21" : "#3a3533",
        rand(11, 16),
        new THREE.Vector3(rand(-2, 2), rand(7, 14), rand(-2, 2)),
        6,
        0.85,
        0.25,
      );
  }

  /** Continuous emitters driven by the scene for burning, damaged or moving ships. */
  burn(position: THREE.Vector3, dt: number, intensity = 1) {
    if (Math.random() < dt * 16 * intensity)
      this.ps.spawn(
        this.ps.sprite(
          fire,
          HDR_FIRE,
          1,
          position
            .clone()
            .add(new THREE.Vector3(rand(-1.5, 1.5), 0, rand(-1.5, 1.5))),
          [3.5, 6],
          true,
        ),
        {
          life: rand(0.5, 0.85),
          velocity: new THREE.Vector3(
            rand(-0.6, 0.6),
            rand(4, 7),
            rand(-0.6, 0.6),
          ),
          grow: 2.5,
          wind: 0.6,
          kind: "fire",
          colorFrom: HDR_FIRE.clone().multiplyScalar(rand(0.7, 1.2)),
          colorTo: EMBER,
        },
      );
    if (!this.crowded && Math.random() < dt * 7 * intensity)
      this.ps.smoke(
        position.clone().setY(position.y + 4),
        rand(5, 8),
        Math.random() < 0.7 ? "#25282a" : "#3e3b38",
        rand(7, 10),
        new THREE.Vector3(rand(-2, 2), rand(5, 8), rand(-2, 2)),
        6,
        0.55,
        0.3,
      );
  }
  smolder(position: THREE.Vector3, dt: number, amount: number) {
    if (!this.crowded && Math.random() < dt * 4 * amount)
      this.ps.smoke(
        position.clone(),
        rand(3, 5),
        "#4b4f52",
        rand(4, 6),
        new THREE.Vector3(rand(-0.5, 0.5), rand(3, 5), rand(-0.5, 0.5)),
        3.5,
        0.5 * amount,
        0.3,
      );
  }
  wake(
    stern: THREE.Vector3,
    bow: THREE.Vector3,
    side: THREE.Vector3,
    speed: number,
    dt: number,
  ) {
    if (this.crowded || speed < 2) return;
    if (Math.random() < dt * Math.min(6, speed * 0.32))
      this.ps.decal(
        stern.clone().setY(0.45),
        rand(5, 8),
        2.2 + speed * 0.1,
        rand(6, 8),
        0.5,
      );
    if (speed > 9 && Math.random() < dt * speed * 0.35) {
      const out = side.clone().multiplyScalar(Math.random() < 0.5 ? -1 : 1);
      this.ps.spawn(
        this.ps.sprite(
          spray,
          "#eef4f4",
          0.55,
          bow.clone().addScaledVector(out, 2).setY(1.2),
          rand(1.8, 3),
        ),
        {
          life: rand(0.7, 1.1),
          velocity: out
            .multiplyScalar(rand(3, 6))
            .add(new THREE.Vector3(0, rand(2.5, 4.5), 0)),
          gravity: 10,
          grow: 2.5,
          kind: "spray",
        },
      );
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
    this.tracks.launchDemo(model, caliber, () => --this.serial);
    return e;
  }
  update(
    dt: number,
    snapshot: Parameters<ShellTracks["update"]>[1],
    playing: boolean,
    camera?: THREE.PerspectiveCamera,
  ) {
    this.tracks.update(
      dt,
      snapshot,
      playing,
      (e) => this.event(e),
      () => --this.serial,
    );
    this.ps.update(dt, camera);
  }
}
