import * as THREE from "three";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { aimSolution } from "../shared/ballistics";
import { ISLANDS } from "../shared/config";
import { terrainHeight } from "../shared/terrain";
import { dist } from "../shared/math";
import type { Ship, Vec2 } from "../shared/types";

export class AimArea {
  root = new THREE.Group();
  private fill = new THREE.Mesh(
    new THREE.CircleGeometry(1, 80),
    new THREE.MeshBasicMaterial({
      color: "#f2d195",
      transparent: true,
      opacity: 0.12,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  private border = new Line2(
    new LineGeometry().setPositions(
      Array.from({ length: 97 }, (_, n) => [
        Math.sin((n / 96) * Math.PI * 2),
        0,
        Math.cos((n / 96) * Math.PI * 2),
      ]).flat(),
    ),
    new LineMaterial({
      color: "#ffe4ab",
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    }),
  );
  diagnostics = {
    visible: false,
    radius: 0,
    x: 0,
    z: 0,
    weapon: "HE",
    placement: true,
  };
  constructor(scene: THREE.Scene) {
    this.border.material.linewidth = 2.2;
    this.fill.rotation.x = -Math.PI / 2;
    this.root.add(this.fill, this.border);
    this.root.visible = false;
    scene.add(this.root);
  }
  update(s: Ship | null, aim: Vec2) {
    this.border.material.resolution.set(window.innerWidth, window.innerHeight);
    this.root.visible = !!s?.alive && s.input.weapon !== "TORP";
    if (!s || !this.root.visible) {
      this.diagnostics.visible = false;
      return;
    }
    const solution = aimSolution(s, aim),
      mine = s.input.weapon === "MINE";
    const placement =
      !mine || !ISLANDS.some((i) => terrainHeight(i, solution.center) > 0);
    const color =
      !placement || (!mine && dist(s, aim) > solution.range)
        ? "#eb937b"
        : mine
          ? "#8ce0bf"
          : s.input.weapon === "RBU"
            ? "#a1e9ff"
            : "#ffe4ab";
    this.fill.material.color.set(color);
    this.border.material.color.set(color);
    this.root.position.set(solution.center.x, 1.25, solution.center.z);
    this.root.scale.set(solution.radius, 1, solution.radius);
    this.diagnostics = {
      visible: true,
      radius: solution.radius,
      ...solution.center,
      weapon: s.input.weapon,
      placement,
    };
  }
}
