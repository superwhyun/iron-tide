import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { Snapshot } from "../shared/types";
const pieces: THREE.BufferGeometry[] = [new THREE.SphereGeometry(1.4, 14, 10)];
for (let n = 0; n < 10; n++) {
  const direction = new THREE.Vector3(
    Math.sin(n * 2.399) * 0.9,
    ((n % 3) - 1) * 0.55,
    Math.cos(n * 2.399) * 0.9,
  ).normalize();
  const g = new THREE.ConeGeometry(0.23, 0.95, 6);
  const transform = new THREE.Matrix4().compose(
    direction.clone().multiplyScalar(1.55),
    new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      direction,
    ),
    new THREE.Vector3(1, 1, 1),
  );
  g.applyMatrix4(transform);
  pieces.push(g);
}
const mineGeometry = mergeGeometries(pieces)!;
for (const g of pieces) g.dispose();
export class MineVisuals {
  private items = new Map<number, THREE.Group>();
  constructor(private scene: THREE.Scene) {}
  update(snapshot: Snapshot | null, playing: boolean) {
    const mines = playing ? (snapshot?.mines ?? []) : [],
      ids = new Set(mines.map((m) => m.id));
    for (const [id, root] of this.items)
      if (!ids.has(id)) {
        this.scene.remove(root);
        root.traverse((o) => {
          if (o instanceof THREE.Mesh) {
            if (o.geometry !== mineGeometry) o.geometry.dispose();
            (o.material as THREE.Material).dispose();
          }
        });
        this.items.delete(id);
      }
    for (const m of mines) {
      let root = this.items.get(m.id);
      const own = m.owner === snapshot!.self.id,
        armed = snapshot!.time >= m.armedAt;
      if (!root) {
        root = new THREE.Group();
        root.add(
          new THREE.Mesh(
            mineGeometry,
            new THREE.MeshStandardMaterial({
              color: "#253138",
              roughness: 0.48,
              metalness: 0.75,
            }),
          ),
        );
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(3, 3.2, 36),
          new THREE.MeshBasicMaterial({
            color: own ? "#8ce0bf" : "#ed977d",
            transparent: true,
            opacity: 0.65,
            side: THREE.DoubleSide,
            depthWrite: false,
          }),
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = 0.2;
        root.add(ring);
        this.scene.add(root);
        this.items.set(m.id, root);
      }
      root.position.set(
        m.x,
        0.55 + Math.sin(performance.now() * 0.002 + m.id) * 0.12,
        m.z,
      );
      (
        (root.children[1] as THREE.Mesh).material as THREE.MeshBasicMaterial
      ).opacity = armed
        ? 0.45 + Math.sin(performance.now() * 0.004) * 0.2
        : 0.2;
    }
  }
}
