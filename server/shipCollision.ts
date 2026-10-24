import { readFileSync } from "node:fs";
import {
  Box3,
  BufferGeometry,
  Matrix4,
  Quaternion,
  Ray,
  Triangle,
  Vector3,
} from "three";
import { HULLS, NPC_MODELS } from "../shared/config";
import { deckSurface, hullSurface } from "../shared/hullShape";
import { SUPERSTRUCTURE_ARMOR } from "../shared/armor";
import type { Hull, NpcModel, Ship, Vec2 } from "../shared/types";

export type ArmorZone =
  "side" | "upper" | "bow" | "deck" | "superstructure" | "turret";
/** The belt only covers the lower part of the freeboard; above it is thin plating. */
const BELT_TOP = 0.3;
export interface ShipHit {
  t: number;
  point: Vec2;
  y: number;
  normal: Vector3;
  zone: ArmorZone;
  armor: number;
}
type Face = {
  a: Vector3;
  b: Vector3;
  c: Vector3;
  normal: Vector3;
  center: Vector3;
  box: Box3;
};
type Tree = { box: Box3; faces?: Face[]; left?: Tree; right?: Tree };
type HullMesh = { tree: Tree; deck: number };
const npcMeshes = new Map<NpcModel, HullMesh>();
const humanMeshes = new Map<Hull, HullMesh>();
const mounts = new Map<string, number[]>();
function face(a: Vector3, b: Vector3, c: Vector3): Face {
  return {
    a,
    b,
    c,
    normal: Triangle.getNormal(a, b, c, new Vector3()),
    center: a
      .clone()
      .add(b)
      .add(c)
      .multiplyScalar(1 / 3),
    box: new Box3().setFromPoints([a, b, c]),
  };
}
function tree(faces: Face[]): Tree {
  const box = new Box3();
  for (const f of faces) box.union(f.box);
  if (faces.length <= 12) return { box, faces };
  const size = box.getSize(new Vector3()),
    axis =
      size.x > size.y && size.x > size.z ? "x" : size.y > size.z ? "y" : "z";
  faces.sort((a, b) => a.center[axis] - b.center[axis]);
  const mid = Math.floor(faces.length / 2);
  return {
    box,
    left: tree(faces.slice(0, mid)),
    right: tree(faces.slice(mid)),
  };
}
function boxTime(a: Vector3, delta: Vector3, box: Box3, limit = 1) {
  let near = 0,
    far = limit;
  for (const axis of ["x", "y", "z"] as const) {
    if (Math.abs(delta[axis]) < 1e-12) {
      if (a[axis] < box.min[axis] || a[axis] > box.max[axis]) return null;
      continue;
    }
    let lo = (box.min[axis] - a[axis]) / delta[axis],
      hi = (box.max[axis] - a[axis]) / delta[axis];
    if (lo > hi) [lo, hi] = [hi, lo];
    near = Math.max(near, lo);
    far = Math.min(far, hi);
    if (near > far) return null;
  }
  return near;
}
function cast(mesh: HullMesh, a: Vector3, b: Vector3) {
  const delta = b.clone().sub(a),
    length = delta.length();
  if (length < 1e-10) return null;
  const ray = new Ray(a, delta.clone().divideScalar(length)),
    point = new Vector3();
  let nearest = 1 + 1e-9,
    normal: Vector3 | null = null;
  function visit(node: Tree) {
    if (boxTime(a, delta, node.box, Math.min(1, nearest)) === null) return;
    if (node.faces)
      for (const f of node.faces) {
        if (!ray.intersectTriangle(f.a, f.b, f.c, false, point)) continue;
        const t = point.distanceTo(a) / length;
        if (t <= 1 + 1e-9 && t < nearest) {
          nearest = t;
          normal = f.normal;
        }
      }
    else {
      visit(node.left!);
      visit(node.right!);
    }
  }
  visit(mesh.tree);
  return normal
    ? {
        t: Math.min(1, nearest),
        point: a.clone().addScaledVector(delta, nearest),
        normal: (normal as Vector3).clone(),
      }
    : null;
}
function geometryFaces(g: BufferGeometry) {
  const p = g.attributes.position,
    indices = g.index,
    result: Face[] = [];
  for (let n = 0; n < (indices?.count ?? p.count); n += 3) {
    const vertices = [0, 1, 2].map((k) =>
      new Vector3().fromBufferAttribute(
        p,
        indices ? indices.getX(n + k) : n + k,
      ),
    );
    result.push(face(vertices[0], vertices[1], vertices[2]));
  }
  g.dispose();
  return result;
}
function humanMesh(hull: Hull) {
  const cached = humanMeshes.get(hull);
  if (cached) return cached;
  const c = HULLS[hull],
    w = c.beam * (hull === "battleship" ? 0.68 : 0.74),
    y = hull === "battleship" ? 2.35 : 1.85;
  const mesh = {
    tree: tree([
      ...geometryFaces(hullSurface(c.length, w, y)),
      ...geometryFaces(deckSurface(c.length, w, y + 0.03)),
    ]),
    deck: y + 0.03,
  };
  humanMeshes.set(hull, mesh);
  return mesh;
}
// Read only geometry from the original GLB; textures never enter the server.
function npcMesh(variant: NpcModel) {
  const cached = npcMeshes.get(variant);
  if (cached) return cached;
  const bytes = readFileSync(
    new URL(`../public${NPC_MODELS[variant].file}`, import.meta.url),
  );
  const jsonLength = bytes.readUInt32LE(12),
    doc = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString());
  const binary = bytes.subarray(28 + jsonLength),
    faces: Face[] = [];
  function accessor(id: number) {
    const a = doc.accessors[id],
      v = doc.bufferViews[a.bufferView];
    const count = a.type === "VEC3" ? 3 : 1,
      width =
        a.componentType === 5126 || a.componentType === 5125
          ? 4
          : a.componentType === 5123
            ? 2
            : 1;
    return (index: number, k = 0) => {
      const offset =
        (v.byteOffset ?? 0) +
        (a.byteOffset ?? 0) +
        index * (v.byteStride ?? width * count) +
        k * width;
      if (a.componentType === 5126) return binary.readFloatLE(offset);
      if (a.componentType === 5125) return binary.readUInt32LE(offset);
      if (a.componentType === 5123) return binary.readUInt16LE(offset);
      if (a.componentType === 5121) return binary.readUInt8(offset);
      throw Error(`Unsupported GLB component ${a.componentType}`);
    };
  }
  function node(index: number, parent: Matrix4) {
    const n = doc.nodes[index],
      local = n.matrix
        ? new Matrix4().fromArray(n.matrix)
        : new Matrix4().compose(
            new Vector3().fromArray(n.translation ?? [0, 0, 0]),
            new Quaternion().fromArray(n.rotation ?? [0, 0, 0, 1]),
            new Vector3().fromArray(n.scale ?? [1, 1, 1]),
          );
    const matrix = parent.clone().multiply(local);
    if (n.mesh !== undefined)
      for (const primitive of doc.meshes[n.mesh].primitives) {
        if (primitive.mode !== undefined && primitive.mode !== 4) continue;
        const position = accessor(primitive.attributes.POSITION),
          indices =
            primitive.indices === undefined
              ? null
              : accessor(primitive.indices);
        const count =
          doc.accessors[primitive.indices ?? primitive.attributes.POSITION]
            .count;
        for (let i = 0; i < count; i += 3) {
          const points = [0, 1, 2].map((k) => {
            const ix = indices ? indices(i + k) : i + k;
            return new Vector3(
              position(ix, 0),
              position(ix, 1),
              position(ix, 2),
            ).applyMatrix4(matrix);
          });
          faces.push(face(points[0], points[1], points[2]));
        }
      }
    for (const child of n.children ?? []) node(child, matrix);
  }
  for (const n of doc.scenes[doc.scene ?? 0].nodes) node(n, new Matrix4());
  const bounds = new Box3();
  for (const f of faces) bounds.union(f.box);
  const center = bounds.getCenter(new Vector3()),
    length = bounds.max.x - bounds.min.x;
  // Exactly the same centering, waterline, +90deg rotation and uniform scale as npcShip.ts.
  const normalized = faces.map((f) => {
    const p = [f.a, f.b, f.c].map(
      (v) =>
        new Vector3(
          (v.z - center.z) / length,
          (v.y + NPC_MODELS[variant].waterline) / length,
          -(v.x - center.x) / length,
        ),
    );
    return face(p[0], p[1], p[2]);
  });
  const mesh = { tree: tree(normalized), deck: 0.06 };
  const width = mesh.tree.box.max.x - mesh.tree.box.min.x,
    heights: number[] = [];
  for (const x of [-width * 0.3, width * 0.3])
    for (const z of [-0.3, -0.15, 0, 0.15, 0.3]) {
      const hit = cast(mesh, new Vector3(x, 1, z), new Vector3(x, -0.1, z));
      if (hit && hit.point.y > 0) heights.push(hit.point.y);
    }
  heights.sort((a, b) => a - b);
  if (heights.length) mesh.deck = heights[Math.floor(heights.length / 2)];
  npcMeshes.set(variant, mesh);
  return mesh;
}
export function shipMeshInfo(hull: Hull, variant?: NpcModel) {
  const m = variant ? npcMesh(variant) : humanMesh(hull),
    scale = variant ? HULLS[hull].length : 1;
  return {
    min: m.tree.box.min.clone().multiplyScalar(scale),
    max: m.tree.box.max.clone().multiplyScalar(scale),
    deck: m.deck * scale,
  };
}
export function intersectShip(
  from: Vec2 & { y: number },
  to: Vec2 & { y: number },
  s: Ship,
): ShipHit | null {
  const cfg = HULLS[s.hull],
    variant = s.bot ? (s.npcModel ?? "camouflage") : undefined;
  const mesh = variant ? npcMesh(variant) : humanMesh(s.hull),
    scale = variant ? cfg.length : 1;
  const cos = Math.cos(s.heading),
    sin = Math.sin(s.heading);
  const local = (p: Vec2 & { y: number }) =>
    new Vector3(
      ((p.x - s.x) * cos - (p.z - s.z) * sin) / scale,
      p.y / scale,
      ((p.x - s.x) * sin + (p.z - s.z) * cos) / scale,
    );
  const a = local(from),
    b = local(to),
    delta = b.clone().sub(a);
  let hit = cast(mesh, a, b),
    zone: ArmorZone | undefined;
  // Added animated main-battery turrets have independent geometry, outside the GLB.
  const width = cfg.beam * (s.hull === "battleship" ? 0.68 : 0.74),
    base = s.hull === "battleship" ? 2.35 : 1.85;
  function box(center: Vector3, size: Vector3, angle: number, kind: ArmorZone) {
    const c = Math.cos(angle),
      q = Math.sin(angle);
    const rotate = (p: Vector3) => {
      const x = p.x * scale - center.x,
        z = p.z * scale - center.z;
      return new Vector3(x * c - z * q, p.y * scale - center.y, x * q + z * c);
    };
    const start = rotate(a),
      end = rotate(b),
      movement = end.clone().sub(start),
      bounds = new Box3(
        size.clone().multiplyScalar(-0.5),
        size.clone().multiplyScalar(0.5),
      );
    const t = boxTime(start, movement, bounds);
    if (t === null || (hit && t >= hit.t)) return;
    const p = start.clone().addScaledVector(movement, t),
      normal = new Vector3();
    const distances = [
      Math.abs(Math.abs(p.x) - size.x / 2),
      Math.abs(Math.abs(p.y) - size.y / 2),
      Math.abs(Math.abs(p.z) - size.z / 2),
    ];
    const axis = distances.indexOf(Math.min(...distances));
    normal.setComponent(axis, Math.sign(p.getComponent(axis)) || 1);
    hit = {
      t,
      point: a.clone().addScaledVector(delta, t),
      normal: new Vector3(
        normal.x * c + normal.z * q,
        normal.y,
        -normal.x * q + normal.z * c,
      ),
    };
    zone = kind;
  }
  const mountKey = `${s.hull}:${variant ?? "human"}`;
  let heights = mounts.get(mountKey);
  if (!heights) {
    heights = s.turrets.map((t) => {
      if (!variant)
        return (
          base + 0.15 + (t.offset > 0 && t.offset < cfg.length * 0.25 ? 1.1 : 0)
        );
      const hit = cast(
        mesh,
        new Vector3(0, 2, t.offset / scale),
        new Vector3(0, -0.2, t.offset / scale),
      );
      return hit ? hit.point.y * scale + 0.12 : base;
    });
    mounts.set(mountKey, heights);
  }
  for (const [index, turret] of s.turrets.entries()) {
    const y = heights[index];
    box(
      new Vector3(0, y + 0.98, turret.offset),
      new Vector3(width * 0.53, 1.6, width * 0.5),
      turret.angle - s.heading,
      "turret",
    );
  }
  if (!variant)
    for (const [w, h, l, y, z] of [
      [width * 0.56, 1.55, cfg.length * 0.19, base + 0.8, 0],
      [width * 0.48, 1.65, cfg.length * 0.09, base + 2.2, cfg.length * 0.065],
      [width * 0.54, 0.75, cfg.length * 0.061, base + 3.28, cfg.length * 0.074],
      [width * 0.29, 0.8, cfg.length * 0.04, base + 4.25, cfg.length * 0.07],
      [width * 0.3, 2.7, width * 0.4, base + 2.15, -cfg.length * 0.065],
    ])
      box(new Vector3(0, y, z), new Vector3(w, h, l), 0, "superstructure");
  if (!hit) return null;
  const chosen = hit as { t: number; point: Vector3; normal: Vector3 };
  zone ??=
    chosen.point.y > mesh.deck + (variant ? 0.012 : 0.35)
      ? "superstructure"
      : Math.abs(chosen.normal.y) > 0.65
        ? "deck"
        : Math.abs(chosen.normal.z) > Math.abs(chosen.normal.x)
          ? "bow"
          : chosen.point.y > mesh.deck * BELT_TOP
            ? "upper"
            : "side";
  const armor =
    zone === "superstructure"
      ? SUPERSTRUCTURE_ARMOR[s.hull]
      : zone === "turret"
        ? cfg.armor.side
        : cfg.armor[zone];
  const normal = chosen.normal;
  return {
    t: chosen.t,
    point: {
      x: from.x + (to.x - from.x) * chosen.t,
      z: from.z + (to.z - from.z) * chosen.t,
    },
    y: from.y + (to.y - from.y) * chosen.t,
    normal: new Vector3(
      normal.x * cos + normal.z * sin,
      normal.y,
      -normal.x * sin + normal.z * cos,
    ),
    zone,
    armor,
  };
}
