import { fireTexture } from "./combatFx";
import * as THREE from "three";
import type { GameEvent } from "../shared/types";
interface Half {
  root: THREE.Group;
  plane: THREE.Plane;
  side: number;
  base: THREE.Vector3;
  heading: number;
  materials: THREE.Material[];
}
interface Wreck {
  age: number;
  halves: Half[];
  length: number;
  steam: THREE.Sprite[];
  geometries: Set<THREE.BufferGeometry>;
  flames: THREE.Sprite[];
}
export class Wrecks {
  private items: Wreck[] = [];
  constructor(
    private scene: THREE.Scene,
    private cloud: THREE.Texture,
  ) {}
  get diagnostics() {
    return {
      wrecks: this.items.length,
      halves: this.items.reduce((n, w) => n + w.halves.length, 0),
      ages: this.items.map((w) => w.age),
    };
  }
  clear() {
    for (const w of this.items) this.dispose(w);
    this.items = [];
  }
  private dispose(w: Wreck) {
    for (const half of w.halves) {
      this.scene.remove(half.root);
      for (const m of half.materials) m.dispose();
      half.root.traverse((o) => {
        if (o instanceof THREE.Mesh && o.userData.wreckCap)
          o.geometry.dispose();
      });
    }
    for (const g of w.geometries) {
      g.userData.wreckRefs = Math.max(0, (g.userData.wreckRefs ?? 1) - 1);
      if (!g.userData.wreckRefs && g.userData.disposeAfterWreck) {
        g.dispose();
        delete g.userData.disposeAfterWreck;
      }
    }
    for (const s of [...w.steam, ...w.flames]) {
      this.scene.remove(s);
      s.material.dispose();
    }
  }
  spawn(
    e: GameEvent,
    source: THREE.Group,
    length: number,
    beam: number,
    exclude: THREE.Object3D[],
  ) {
    const halves: Half[] = [];
    const geometries = new Set<THREE.BufferGeometry>();
    beam *= 0.78;
    for (const side of [-1, 1]) {
      const root = new THREE.Group(),
        plane = new THREE.Plane(),
        materials: THREE.Material[] = [];
      const shared = new Map<THREE.Material, THREE.Material>();
      function material(original: THREE.Material) {
        let m = shared.get(original);
        if (m) return m;
        m = original.clone();
        m.onBeforeCompile = original.onBeforeCompile;
        m.clippingPlanes = [plane];
        m.clipShadows = true;
        materials.push(m);
        shared.set(original, m);
        return m;
      }
      function copy(o: THREE.Object3D): THREE.Object3D | null {
        if (exclude.includes(o) || !o.visible || o instanceof THREE.Light)
          return null;
        let c: THREE.Object3D;
        if (o instanceof THREE.Mesh)
          c = new THREE.Mesh(
            o.geometry,
            Array.isArray(o.material)
              ? o.material.map(material)
              : material(o.material),
          );
        else if (o instanceof THREE.Line)
          c = new THREE.Line(
            o.geometry,
            Array.isArray(o.material)
              ? o.material.map(material)
              : material(o.material),
          );
        else if (o instanceof THREE.Sprite) return null;
        else c = new THREE.Group();
        c.position.copy(o.position);
        c.quaternion.copy(o.quaternion);
        c.scale.copy(o.scale);
        c.castShadow = o.castShadow;
        c.receiveShadow = o.receiveShadow;
        for (const child of o.children) {
          const clone = copy(child);
          if (clone) c.add(clone);
        }
        return c;
      }
      // Each half contains the original detailed geometry. GPU clipping cuts it
      // in ship-local coordinates and follows the independently sinking half.
      for (const child of source.children) {
        const clone = copy(child);
        if (clone) root.add(clone);
      }
      const steel = new THREE.MeshStandardMaterial({
        color: "#251f1c",
        roughness: 0.94,
        metalness: 0.5,
        side: THREE.DoubleSide,
      });
      const rust = new THREE.MeshStandardMaterial({
        color: "#71523d",
        roughness: 0.85,
        metalness: 0.5,
      });
      materials.push(steel, rust);
      const shape = new THREE.Shape();
      shape.moveTo(-beam * 0.46, -1.8);
      shape.lineTo(-beam * 0.5, 1.2);
      shape.lineTo(-beam * 0.36, 3.7);
      shape.lineTo(-beam * 0.17, 3.2);
      shape.lineTo(0, 4.2);
      shape.lineTo(beam * 0.16, 3.4);
      shape.lineTo(beam * 0.4, 3.9);
      shape.lineTo(beam * 0.5, 1);
      shape.lineTo(beam * 0.4, -1.8);
      shape.closePath();
      const cap = new THREE.Mesh(new THREE.ShapeGeometry(shape), steel);
      cap.position.z = side * 0.035;
      cap.userData.wreckCap = true;
      root.add(cap);
      for (let n = 0; n < 7; n++) {
        const rib = new THREE.Mesh(
          new THREE.BoxGeometry(0.13, 2.8, 0.25 + Math.random() * 0.6),
          rust,
        );
        rib.position.set((n - 3) * beam * 0.115, 0.4, side * 0.16);
        rib.rotation.z = (Math.random() - 0.5) * 0.4;
        rib.userData.wreckCap = true;
        root.add(rib);
      }
      const base = new THREE.Vector3(e.x, source.position.y, e.z),
        heading = source.rotation.y;
      root.position.copy(base);
      root.rotation.y = heading;
      this.scene.add(root);
      root.traverse((o) => {
        if (
          o instanceof THREE.Mesh &&
          !o.userData.wreckCap &&
          !geometries.has(o.geometry)
        ) {
          geometries.add(o.geometry);
          o.geometry.userData.wreckRefs =
            (o.geometry.userData.wreckRefs ?? 0) + 1;
        }
      });
      halves.push({ root, plane, side, base, heading, materials });
    }
    const steam: THREE.Sprite[] = [];
    for (let n = 0; n < 10; n++) {
      const s = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: this.cloud,
          color: n < 5 ? "#171c1d" : "#d9e5e4",
          transparent: true,
          opacity: 0,
          depthWrite: false,
        }),
      );
      s.position.set(e.x, 4, e.z);
      this.scene.add(s);
      steam.push(s);
    }
    const flames: THREE.Sprite[] = [];
    for (let n = 0; n < 6; n++) {
      const flame = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: fireTexture,
          transparent: true,
          opacity: 1,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      this.scene.add(flame);
      flames.push(flame);
    }
    this.items.push({ age: 0, halves, length, steam, geometries, flames });
    while (this.items.length > 4) this.dispose(this.items.shift()!);
  }
  update(dt: number, playing: boolean) {
    if (!playing) {
      this.clear();
      return;
    }
    for (const w of this.items) {
      w.age += dt;
      const age = w.age,
        breaking = Math.max(0, age - 0.4);
      for (const half of w.halves) {
        const { side, heading, root } = half;
        const apart = side * Math.min(w.length * 0.11, breaking * 0.7);
        root.position.set(
          half.base.x + Math.sin(heading) * apart,
          -0.3 * breaking * breaking,
          half.base.z + Math.cos(heading) * apart,
        );
        root.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), heading);
        root.rotateX(-side * Math.min(1.15, breaking * 0.09));
        root.rotateZ(side * Math.min(0.35, breaking * 0.023));
        root.updateMatrixWorld(true);
        half.plane
          .set(new THREE.Vector3(0, 0, side), 0)
          .applyMatrix4(root.matrixWorld);
      }
      for (const [n, flame] of w.flames.entries()) {
        const half = w.halves[n % 2];
        const point = half.root.localToWorld(
          new THREE.Vector3(
            Math.sin(n * 2.4) * 1.4,
            4,
            half.side * w.length * (0.23 + (n % 3) * 0.04),
          ),
        );
        flame.position.copy(point);
        flame.visible = point.y > -0.4 && age < 10;
        const flicker = 1 + Math.sin(age * 17 + n * 3) * 0.15;
        flame.scale.set((6 + (n % 2)) * flicker, (13 + (n % 3)) * flicker, 1);
        flame.material.opacity =
          Math.min(1, age * 2) * Math.max(0, 1 - (age - 6) / 4);
      }
      const center = w.halves[0].base;
      for (const [n, s] of w.steam.entries()) {
        const phase = age + n * 0.19,
          smoke = n < 5;
        const size = smoke ? 7 + age * 2.1 : 4 + age * 1.1;
        s.scale.set(size, size * (smoke ? 1.4 : 0.6), 1);
        s.position.set(
          center.x + Math.sin(n * 2.399) * age * 0.5,
          smoke ? 5 + age * (1.1 + n * 0.08) : 0.8,
          center.z + Math.cos(n * 2.399) * age * 0.6,
        );
        s.material.opacity =
          Math.min(0.7, age * 1.5) *
          Math.max(0, 1 - (age - 6) / 6) *
          (smoke ? 0.9 : 0.6);
        s.material.rotation = Math.sin(phase * 0.3) * 0.1;
      }
    }
    this.items = this.items.filter((w) => {
      if (w.age < 13) return true;
      this.dispose(w);
      return false;
    });
  }
}
