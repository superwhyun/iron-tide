import * as THREE from "three";
import { POWERUPS } from "../shared/powerups";
import type { Pickup, PickupKind } from "../shared/types";

function glyphTexture(kind: PickupKind) {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const ctx = c.getContext("2d")!;
  const info = POWERUPS[kind];
  ctx.fillStyle = "rgba(6,20,30,.82)";
  ctx.beginPath();
  ctx.arc(64, 64, 56, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 6;
  ctx.strokeStyle = info.color;
  ctx.stroke();
  ctx.fillStyle = info.color;
  ctx.font = "700 64px 'Noto Sans KR', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(info.glyph, 64, 68);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function beamTexture() {
  const c = document.createElement("canvas");
  c.width = 32;
  c.height = 128;
  const ctx = c.getContext("2d")!;
  const v = ctx.createLinearGradient(0, 128, 0, 0);
  v.addColorStop(0, "rgba(255,255,255,1)");
  v.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, 32, 128);
  // Soft horizontal falloff so the beam has no hard edges.
  ctx.globalCompositeOperation = "destination-in";
  const h = ctx.createLinearGradient(0, 0, 32, 0);
  h.addColorStop(0, "rgba(0,0,0,0)");
  h.addColorStop(0.5, "rgba(0,0,0,1)");
  h.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = h;
  ctx.fillRect(0, 0, 32, 128);
  return new THREE.CanvasTexture(c);
}

const crateGeometry = new THREE.BoxGeometry(4.2, 2.6, 4.2);
const bandGeometry = new THREE.BoxGeometry(4.35, 0.5, 4.35);
const beamGeometry = new THREE.PlaneGeometry(5, 70);
beamGeometry.translate(0, 35, 0);
const crateMaterial = new THREE.MeshStandardMaterial({
  color: "#3d4a3f",
  roughness: 0.75,
  metalness: 0.35,
});

interface CrateMesh {
  root: THREE.Group;
  bob: number;
}

/** Floating supply crates with a colored light beacon so they read from afar. */
export class SupplyVisuals {
  private crates = new Map<number, CrateMesh>();
  private glyphs = new Map<PickupKind, THREE.Texture>();
  private beam = beamTexture();
  constructor(private scene: THREE.Scene) {}
  private glyph(kind: PickupKind) {
    let t = this.glyphs.get(kind);
    if (!t) {
      t = glyphTexture(kind);
      this.glyphs.set(kind, t);
    }
    return t;
  }
  private create(p: Pickup): CrateMesh {
    const color = new THREE.Color(POWERUPS[p.kind].color);
    const root = new THREE.Group();
    const crate = new THREE.Mesh(crateGeometry, crateMaterial);
    crate.castShadow = true;
    const band = new THREE.Mesh(
      bandGeometry,
      new THREE.MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity: 1.6,
        roughness: 0.4,
      }),
    );
    // Two crossed planes give the beacon volume from any heading.
    const beams = [0, Math.PI / 2].map((angle) => {
      const beam = new THREE.Mesh(
        beamGeometry,
        new THREE.MeshBasicMaterial({
          map: this.beam,
          color: color.clone().multiplyScalar(2.2),
          transparent: true,
          opacity: 0.55,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide,
        }),
      );
      beam.rotation.y = angle;
      return beam;
    });
    const icon = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.glyph(p.kind),
        transparent: true,
        depthWrite: false,
      }),
    );
    icon.scale.setScalar(9);
    icon.position.y = 12;
    root.add(crate, band, icon, ...beams);
    root.position.set(p.x, 0.6, p.z);
    root.userData.spin = crate;
    root.userData.band = band;
    this.scene.add(root);
    return { root, bob: p.id * 1.7 };
  }
  private dispose(m: CrateMesh) {
    this.scene.remove(m.root);
    m.root.traverse((o) => {
      if (o instanceof THREE.Mesh && o.material !== crateMaterial)
        (o.material as THREE.Material).dispose();
      if (o instanceof THREE.Sprite) o.material.dispose();
    });
  }
  update(pickups: Pickup[], time: number) {
    const ids = new Set(pickups.map((p) => p.id));
    for (const [id, m] of this.crates)
      if (!ids.has(id)) {
        this.dispose(m);
        this.crates.delete(id);
      }
    for (const p of pickups) {
      let m = this.crates.get(p.id);
      if (!m) {
        m = this.create(p);
        this.crates.set(p.id, m);
      }
      m.root.position.y = 0.6 + Math.sin(time * 1.6 + m.bob) * 0.35;
      const spin = m.root.userData.spin as THREE.Mesh;
      spin.rotation.y = time * 0.4 + m.bob;
      spin.rotation.z = Math.sin(time * 1.1 + m.bob) * 0.06;
      (m.root.userData.band as THREE.Mesh).rotation.y = spin.rotation.y;
    }
  }
}
