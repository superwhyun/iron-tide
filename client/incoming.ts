import * as THREE from "three";
import { HULLS, RULES } from "../shared/config";
import { angleDiff, bearing, dist } from "../shared/math";
import type { Projectile, Ship } from "../shared/types";

/** Shells landing farther than this from our predicted position are ignored. */
const WATCH_RADIUS = 160;
const MAX_MARKERS = 24;

export interface IncomingShell {
  x: number;
  z: number;
  /** Seconds until splash or impact. */
  eta: number;
  /** Lands on (or right next to) our hull if we hold course and speed. */
  threat: boolean;
}

/**
 * Predicts where enemy main-battery shells will land, against where our own
 * ship will be at that moment if it holds course and speed. `age` is how old
 * the snapshot is, in seconds.
 */
export function predictIncoming(
  self: Ship,
  projectiles: Projectile[],
  age: number,
): IncomingShell[] {
  const result: IncomingShell[] = [];
  const reach = HULLS[self.hull].length * 0.55 + 8;
  for (const p of projectiles) {
    if (p.owner === self.id || (p.delay ?? 0) > 0) continue;
    if (p.kind === "TORP" || p.kind === "SECONDARY" || p.kind === "MINE")
      continue;
    const g = RULES.gravity,
      fall = (p.vy + Math.sqrt(Math.max(0, p.vy * p.vy + 2 * g * p.y))) / g,
      eta = fall - age;
    if (eta <= 0) continue;
    const impact = { x: p.x + p.vx * fall, z: p.z + p.vz * fall };
    const ahead = self.speed * fall;
    const me = {
      x: self.x + Math.sin(self.heading) * ahead,
      z: self.z + Math.cos(self.heading) * ahead,
    };
    const miss = dist(impact, me);
    if (miss > WATCH_RADIUS) continue;
    result.push({ ...impact, eta, threat: miss < reach });
  }
  return result.sort((a, b) => a.eta - b.eta);
}

/** Which side of our ship the salvo is coming from, for the warning banner. */
export function incomingSide(self: Ship, from: { x: number; z: number }) {
  const relative = angleDiff(bearing(self, from), self.heading);
  if (Math.abs(relative) < 0.6) return "선수";
  if (Math.abs(relative) > 2.5) return "선미";
  // Heading decreases when turning right, so negative relative bearings are starboard.
  return relative < 0 ? "우현" : "좌현";
}

/** Pulsing rings on the water where incoming shells will splash. */
export class IncomingMarkers {
  private rings: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>[] = [];
  private list: IncomingShell[] = [];
  constructor(scene: THREE.Scene) {
    const geometry = new THREE.RingGeometry(0.8, 1, 40);
    geometry.rotateX(-Math.PI / 2);
    for (let n = 0; n < MAX_MARKERS; n++) {
      const ring = new THREE.Mesh(
        geometry,
        new THREE.MeshBasicMaterial({
          transparent: true,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      );
      ring.renderOrder = 3;
      ring.visible = false;
      this.rings.push(ring);
      scene.add(ring);
    }
  }
  set(list: IncomingShell[]) {
    this.list = list.slice(0, MAX_MARKERS);
  }
  update(time: number, visible: boolean) {
    this.rings.forEach((ring, i) => {
      const shell = this.list[i];
      ring.visible = visible && Boolean(shell);
      if (!shell) return;
      // Rings tighten as the shell nears the water.
      const size = 6 + Math.min(4, shell.eta) * 3;
      ring.position.set(shell.x, 0.7, shell.z);
      ring.scale.setScalar(size * (1 + Math.sin(time * 12) * 0.06));
      ring.material.color.set(shell.threat ? "#ff4a3a" : "#ffc06a");
      ring.material.opacity = shell.threat ? 0.85 : 0.45;
    });
  }
}
