import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { HULLS, NPC_MODELS } from "../shared/config";
import type { Hull, NpcModel } from "../shared/types";
import type { WarshipModel } from "./warship";

const assets = new Map<NpcModel, Promise<THREE.Group>>();
function load(variant: NpcModel) {
  if (assets.has(variant)) return assets.get(variant)!;
  const asset = new GLTFLoader()
    .loadAsync(NPC_MODELS[variant].file)
    .then((gltf) => {
      gltf.scene.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        o.geometry.userData.shared = true;
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          m.userData.shared = true;
          if (m instanceof THREE.MeshStandardMaterial) {
            m.roughness = variant === "wisconsin-golden" ? 0.45 : 0.78;
            m.metalness = variant === "wisconsin-golden" ? 0.7 : 0.25;
            if (m.map) m.map.anisotropy = 4;
          }
        }
      });
      return gltf.scene;
    });
  assets.set(variant, asset);
  return asset;
}
export function preloadNpcShip(variant: NpcModel = "camouflage") {
  void load(variant).catch((e) => console.error("NPC model could not load", e));
}
export function attachNpcShip(
  model: WarshipModel,
  hull: Hull,
  variant: NpcModel = "camouflage",
) {
  const { root, turrets } = model;
  root.userData.npcModel = "loading";
  root.userData.npcVariant = variant;
  void load(variant)
    .then((source) => {
      if (root.userData.disposed) return;
      // The supplied single-mesh GLB points toward -X. Its deck is near Y=-.04.
      const body = source.clone(true),
        size = new THREE.Box3()
          .setFromObject(body)
          .getSize(new THREE.Vector3());
      const center = new THREE.Box3()
        .setFromObject(body)
        .getCenter(new THREE.Vector3());
      body.position.set(-center.x, NPC_MODELS[variant].waterline, -center.z);
      const mount = new THREE.Group();
      mount.name = "npc-imported-hull";
      mount.rotation.y = Math.PI / 2;
      mount.scale.setScalar(HULLS[hull].length / size.x);
      mount.add(body);
      for (const child of root.children)
        if (!turrets.includes(child as THREE.Group)) child.visible = false;
      root.add(mount);
      mount.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.castShadow = true;
          o.receiveShadow = true;
        }
      });
      root.updateMatrixWorld(true);
      const ray = new THREE.Raycaster();
      for (const turret of turrets) {
        const world = root.localToWorld(
          new THREE.Vector3(0, 100, turret.position.z),
        );
        ray.set(world, new THREE.Vector3(0, -1, 0));
        const hit = ray.intersectObject(mount, true)[0];
        if (hit) turret.position.y = root.worldToLocal(hit.point).y + 0.12;
        turret.traverse((o) => {
          if (!(o instanceof THREE.Mesh)) return;
          const originals = Array.isArray(o.material)
            ? o.material
            : [o.material];
          const materials = originals.map((m) => {
            if (!(m instanceof THREE.MeshStandardMaterial) || !m.map) return m;
            const clone = m.clone();
            clone.userData.shared = false;
            clone.color.set(
              variant === "wisconsin-golden" ? "#d8bb71" : "#9aaa8e",
            );
            clone.onBeforeCompile = m.onBeforeCompile;
            return clone;
          });
          o.material = Array.isArray(o.material) ? materials : materials[0];
        });
      }
      root.userData.npcModel = "ready";
    })
    .catch((e) => {
      root.userData.npcModel = "error";
      console.error("NPC model could not load", e);
    });
}
