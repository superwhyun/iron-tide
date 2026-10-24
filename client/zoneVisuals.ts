import * as THREE from "three";
import type { Zone } from "../shared/types";

export const ZONE_COLORS = {
  mine: "#5ed6c4",
  enemy: "#ff8f74",
  neutral: "#e4ecee",
};
export const zoneColor = (zone: Zone, self: string) =>
  zone.owner === self
    ? ZONE_COLORS.mine
    : zone.owner
      ? ZONE_COLORS.enemy
      : ZONE_COLORS.neutral;

function letterTexture(letter: string) {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const ctx = c.getContext("2d")!;
  ctx.font = "700 92px Rajdhani, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 8;
  ctx.strokeStyle = "rgba(0,0,0,.55)";
  ctx.strokeText(letter, 64, 68);
  ctx.fillStyle = "#fff";
  ctx.fillText(letter, 64, 68);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
/** Vertical fade so the zone wall reads as a light curtain, not a solid tube. */
function curtainTexture() {
  const c = document.createElement("canvas");
  c.width = 4;
  c.height = 128;
  const ctx = c.getContext("2d")!;
  const g = ctx.createLinearGradient(0, 128, 0, 0);
  g.addColorStop(0, "rgba(255,255,255,.55)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, 128);
  return new THREE.CanvasTexture(c);
}

interface ZoneMesh {
  root: THREE.Group;
  border: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  wall: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>;
  progress: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  label: THREE.Sprite;
  shown: number;
}

/** Capture zones on the sea: border ring, light curtain, letter and capture arc. */
export class ZoneVisuals {
  private meshes = new Map<string, ZoneMesh>();
  private curtain = curtainTexture();
  constructor(private scene: THREE.Scene) {}
  private create(zone: Zone): ZoneMesh {
    const root = new THREE.Group();
    const material = (opacity: number, map?: THREE.Texture) =>
      new THREE.MeshBasicMaterial({
        transparent: true,
        opacity,
        map,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
    const border = new THREE.Mesh(
      new THREE.RingGeometry(zone.radius - 2.5, zone.radius, 96),
      material(0.75),
    );
    border.rotation.x = -Math.PI / 2;
    border.position.y = 0.8;
    const wall = new THREE.Mesh(
      new THREE.CylinderGeometry(zone.radius, zone.radius, 22, 96, 1, true),
      material(0.5, this.curtain),
    );
    wall.position.y = 11;
    const progress = new THREE.Mesh(
      new THREE.RingGeometry(zone.radius - 9, zone.radius - 4, 96, 1, 0, 0.001),
      material(0.85),
    );
    progress.rotation.x = -Math.PI / 2;
    progress.position.y = 0.9;
    const label = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: letterTexture(zone.id),
        transparent: true,
        depthWrite: false,
      }),
    );
    label.scale.setScalar(26);
    label.position.y = 40;
    for (const m of [border, wall, progress]) m.renderOrder = 2;
    root.add(border, wall, progress, label);
    root.position.set(zone.x, 0, zone.z);
    this.scene.add(root);
    return { root, border, wall, progress, label, shown: -1 };
  }
  update(zones: Zone[], self: string, time: number) {
    const ids = new Set(zones.map((z) => z.id));
    for (const [id, m] of this.meshes)
      if (!ids.has(id)) {
        this.scene.remove(m.root);
        this.meshes.delete(id);
      }
    for (const zone of zones) {
      let m = this.meshes.get(zone.id);
      if (!m) {
        m = this.create(zone);
        this.meshes.set(zone.id, m);
      }
      const color = zoneColor(zone, self);
      m.border.material.color.set(color);
      m.wall.material.color.set(color);
      m.label.material.color.set(color);
      m.wall.material.opacity = zone.contested
        ? 0.35 + Math.sin(time * 8) * 0.2
        : 0.45;
      const arc = Math.max(0.001, zone.progress * Math.PI * 2);
      if (Math.abs(arc - m.shown) > 0.01) {
        m.progress.geometry.dispose();
        m.progress.geometry = new THREE.RingGeometry(
          zone.radius - 9,
          zone.radius - 4,
          96,
          1,
          Math.PI / 2,
          arc,
        );
        m.shown = arc;
      }
      m.progress.visible = zone.progress > 0;
      m.progress.material.color.set(
        zone.capturer === self ? ZONE_COLORS.mine : ZONE_COLORS.enemy,
      );
    }
  }
}
