import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { hullSurface, deckSurface, widthAt } from "../shared/hullShape";
import { HULLS } from "../shared/config";
import type { Hull } from "../shared/types";

const loader = new THREE.TextureLoader();
function texture(name: string, repeatX: number, repeatY: number, color = true) {
  const t = loader.load(`/textures/${name}.jpg`);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeatX, repeatY);
  t.anisotropy = 4;
  if (color) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const paintMap = texture("metal_plate_02_diff", 1, 1),
  paintNormal = texture("metal_plate_02_nor_gl", 1, 1, false),
  woodMap = texture("wood_planks_diff", 3, 14);
function material(
  color: string,
  roughness = 0.6,
  metalness = 0.4,
  map?: THREE.Texture,
) {
  const m = new THREE.MeshStandardMaterial({
    color,
    roughness,
    metalness,
    map,
    normalMap: map === paintMap ? paintNormal : null,
    normalScale: new THREE.Vector2(0.13, 0.13),
  });
  m.userData.shared = true;
  if (map === paintMap)
    m.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <map_fragment>",
        `#ifdef USE_MAP
    vec4 sampledDiffuseColor=texture2D(map,vMapUv);
    diffuseColor.rgb*=mix(vec3(.85),sampledDiffuseColor.rgb*1.65,.22);
    #endif`,
      );
    };
  return m;
}
const paint = material("#98a6aa", 0.62, 0.48, paintMap),
  upper = material("#bac1c0", 0.63, 0.35, paintMap),
  dark = material("#313b40", 0.56, 0.65),
  deck = material("#a49d80", 0.88, 0.04, woodMap),
  rubber = material("#191e20", 0.95, 0.02),
  glass = material("#243c46", 0.21, 0.65),
  boot = material("#33292a", 0.8, 0.15),
  rope = material("#a49f8a", 0.9, 0.05);
const waterline = new THREE.MeshStandardMaterial({
  color: "#17272d",
  roughness: 0.75,
});
waterline.userData.shared = true;
export interface WarshipModel {
  root: THREE.Group;
  turrets: THREE.Group[];
  beam: number;
  deckHeight: number;
}

function add(
  parent: THREE.Object3D,
  g: THREE.BufferGeometry,
  m: THREE.Material,
  x = 0,
  y = 0,
  z = 0,
) {
  const mesh = new THREE.Mesh(g, m);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}
function block(
  parent: THREE.Object3D,
  w: number,
  h: number,
  d: number,
  x: number,
  y: number,
  z: number,
  m: THREE.Material,
  bevel = 0.12,
) {
  const sh = new THREE.Shape();
  const r = Math.min(w, d) * 0.12;
  sh.moveTo(-w / 2 + r, -d / 2);
  sh.lineTo(w / 2 - r, -d / 2);
  sh.lineTo(w / 2, -d / 2 + r);
  sh.lineTo(w / 2, d / 2 - r);
  sh.lineTo(w / 2 - r, d / 2);
  sh.lineTo(-w / 2 + r, d / 2);
  sh.lineTo(-w / 2, d / 2 - r);
  sh.lineTo(-w / 2, -d / 2 + r);
  sh.closePath();
  const g = new THREE.ExtrudeGeometry(sh, {
    depth: h,
    bevelEnabled: true,
    bevelSize: bevel,
    bevelThickness: bevel,
    bevelSegments: 1,
    steps: 1,
  });
  g.rotateX(-Math.PI / 2);
  g.translate(0, -h / 2, 0);
  return add(parent, g, m, x, y, z);
}
function pipe(
  parent: THREE.Object3D,
  a: THREE.Vector3,
  b: THREE.Vector3,
  r: number,
  m: THREE.Material,
  r2 = r,
) {
  const direction = b.clone().sub(a),
    mesh = add(
      parent,
      new THREE.CylinderGeometry(r2, r, direction.length(), 8),
      m,
    );
  mesh.position.copy(a).add(b).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    direction.normalize(),
  );
  return mesh;
}
function cylinder(
  parent: THREE.Object3D,
  r: number,
  h: number,
  x: number,
  y: number,
  z: number,
  m: THREE.Material,
) {
  return add(parent, new THREE.CylinderGeometry(r, r, h, 24), m, x, y, z);
}
function mergeStatic(root: THREE.Group, animated: THREE.Group[]) {
  root.updateMatrixWorld(true);
  const byMat = new Map<THREE.Material, THREE.BufferGeometry[]>(),
    remove: THREE.Mesh[] = [];
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || Array.isArray(o.material)) return;
    let p: THREE.Object3D | null = o;
    while (p) {
      if (animated.includes(p as THREE.Group)) return;
      p = p.parent;
    }
    const g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
    g.applyMatrix4(o.matrixWorld);
    for (const k of Object.keys(g.attributes))
      if (!["position", "normal", "uv"].includes(k)) g.deleteAttribute(k);
    const bucket = byMat.get(o.material) ?? [];
    bucket.push(g);
    byMat.set(o.material, bucket);
    remove.push(o);
  });
  for (const mesh of remove) {
    mesh.removeFromParent();
    mesh.geometry.dispose();
  }
  for (const [m, geometries] of byMat) {
    const g = mergeGeometries(geometries);
    for (const part of geometries) part.dispose();
    if (g) add(root, g, m);
  }
}

export function buildWarship(
  hull: Hull,
  flagColor: string,
  caliber = HULLS[hull].caliber,
): WarshipModel {
  const c = { ...HULLS[hull], caliber },
    l = c.length,
    w = c.beam * (hull === "battleship" ? 0.68 : 0.74),
    y = hull === "battleship" ? 2.35 : 1.85,
    root = new THREE.Group();
  root.name = `detailed-${hull}`;
  const skin = hullSurface(l, w, y);
  paint.side = THREE.DoubleSide;
  add(root, skin, paint);
  const bottom = hullSurface(l, w, y);
  const pos = bottom.attributes.position;
  for (let i = 0; i < pos.count; i++) pos.setY(i, Math.min(pos.getY(i), -0.38));
  bottom.computeVertexNormals();
  add(root, bottom, boot);
  add(root, deckSurface(l, w, y + 0.03), deck);
  // Raised forecastle, breakwater and flared bow.
  block(root, w * 0.73, 0.4, l * 0.1, 0, y + 0.24, l * 0.26, paint, 0.06);
  for (const side of [-1, 1]) {
    const points: THREE.Vector3[] = [];
    for (let n = 0; n <= 55; n++) {
      const t = -0.46 + (n * 0.9) / 55,
        x = side * w * 0.5 * widthAt(t),
        dy = Math.max(0, (t - 0.15) / 0.35) ** 2 * 0.95;
      points.push(new THREE.Vector3(x, y + dy + 0.02, t * l));
    }
    for (let n = 0; n < points.length; n += 2) {
      const p = points[n];
      pipe(root, p, p.clone().add(new THREE.Vector3(0, 0.54, 0)), 0.018, upper);
    }
    for (const height of [0.22, 0.49])
      for (let n = 1; n < points.length; n++)
        pipe(
          root,
          points[n - 1].clone().add(new THREE.Vector3(0, height, 0)),
          points[n].clone().add(new THREE.Vector3(0, height, 0)),
          0.009,
          upper,
        );
    // Portlights, anchor hawse, fairleads and deck bollards.
    for (let n = 0; n < 22; n++) {
      const t = -0.35 + n * 0.027,
        x = side * w * 0.5 * widthAt(t);
      const port = cylinder(root, 0.065, 0.045, x, y - 0.4, t * l, dark);
      port.rotation.z = Math.PI / 2;
    }
    const anchor = new THREE.Vector3(side * w * 0.36, y - 0.2, l * 0.36);
    pipe(
      root,
      anchor,
      anchor.clone().add(new THREE.Vector3(0, -0.8, -0.15)),
      0.075,
      dark,
    );
    pipe(
      root,
      anchor.clone().add(new THREE.Vector3(0, -0.65, -0.35)),
      anchor.clone().add(new THREE.Vector3(0, -0.65, 0.35)),
      0.06,
      dark,
    );
    for (const t of [-0.41, -0.28, 0.3, 0.39]) {
      cylinder(root, 0.12, 0.35, side * w * 0.31, y + 0.2, t * l, dark);
      block(
        root,
        0.6,
        0.12,
        0.18,
        side * w * 0.31,
        y + 0.39,
        t * l,
        dark,
        0.02,
      );
    }
    for (let n = 0; n < 6; n++) {
      const x = side * w * 0.34,
        z = -l * 0.16 + n * l * 0.046;
      block(root, 0.5, 0.13, 0.75, x, y + 0.12, z, upper, 0.03);
    }
  }
  // A compact stepped conning tower, navigation bridge glazing and armored director.
  block(root, w * 0.56, 1.55, l * 0.19, 0, y + 0.8, 0, paint, 0.08);
  block(root, w * 0.48, 1.65, l * 0.09, 0, y + 2.2, l * 0.065, upper, 0.1);
  block(root, w * 0.54, 0.75, l * 0.061, 0, y + 3.28, l * 0.074, paint, 0.07);
  for (let n = -3; n <= 3; n++)
    block(
      root,
      w * 0.06,
      0.34,
      0.03,
      n * w * 0.064,
      y + 3.28,
      l * 0.106,
      glass,
      0.01,
    );
  for (const side of [-1, 1])
    for (let n = 0; n < 4; n++)
      block(
        root,
        0.03,
        0.3,
        l * 0.009,
        side * w * 0.275,
        y + 3.28,
        l * (0.052 + n * 0.013),
        glass,
        0.008,
      );
  block(root, w * 0.57, 0.13, l * 0.065, 0, y + 3.75, l * 0.075, upper, 0.03);
  block(root, w * 0.29, 0.8, l * 0.04, 0, y + 4.25, l * 0.07, paint, 0.08);
  cylinder(root, w * 0.17, 0.45, 0, y + 4.91, l * 0.07, dark);
  block(root, w * 0.75, 0.24, 0.34, 0, y + 5.1, l * 0.07, upper, 0.04);
  // Tapered funnels with caps, exhaust grilles and steam pipes.
  for (let n = 0; n < (hull === "battleship" ? 1 : 2); n++) {
    const z = -l * (0.065 + n * 0.095);
    const funnel = add(
      root,
      new THREE.CylinderGeometry(w * 0.12, w * 0.15, 2.45, 24),
      paint,
      0,
      y + 2.15,
      z,
    );
    funnel.scale.z = 1.35;
    cylinder(root, w * 0.123, 0.23, 0, y + 3.46, z, dark).scale.z = 1.35;
    for (let j = 0; j < 5; j++)
      pipe(
        root,
        new THREE.Vector3(-w * 0.1 + j * w * 0.05, y + 3.6, z - w * 0.1),
        new THREE.Vector3(-w * 0.1 + j * w * 0.05, y + 3.6, z + w * 0.1),
        0.025,
        dark,
      );
    pipe(
      root,
      new THREE.Vector3(w * 0.18, y, z),
      new THREE.Vector3(w * 0.18, y + 2.8, z),
      0.065,
      upper,
    );
  }
  const mastZ = l * 0.012,
    mastTop = y + l * 0.14;
  for (const side of [-1, 1])
    pipe(
      root,
      new THREE.Vector3(side * w * 0.2, y + 1, mastZ - l * 0.018),
      new THREE.Vector3(0, mastTop, mastZ),
      0.06,
      upper,
      0.025,
    );
  pipe(
    root,
    new THREE.Vector3(0, y + 1, mastZ),
    new THREE.Vector3(0, mastTop + 1.3, mastZ),
    0.055,
    upper,
    0.02,
  );
  for (const h of [0.62, 0.85]) {
    const yy = y + (mastTop - y) * h;
    pipe(
      root,
      new THREE.Vector3(-w * 0.4, yy, mastZ),
      new THREE.Vector3(w * 0.4, yy, mastZ),
      0.028,
      upper,
    );
    for (const side of [-1, 1])
      pipe(
        root,
        new THREE.Vector3(side * w * 0.4, yy, mastZ),
        new THREE.Vector3(0, mastTop, mastZ),
        0.006,
        dark,
      );
  }
  const radar = block(
    root,
    w * 0.4,
    0.65,
    0.07,
    0,
    mastTop + 0.4,
    mastZ,
    dark,
    0.01,
  );
  radar.rotation.x = 0.08;
  // Boats, davits, capstans, twin secondary mounts and ammunition lockers.
  for (const side of [-1, 1]) {
    const boat = add(
      root,
      new THREE.SphereGeometry(1, 16, 8),
      upper,
      side * w * 0.4,
      y + 1.1,
      -l * 0.11,
    );
    boat.scale.set(w * 0.1, 0.3, l * 0.042);
    const inset = add(
      root,
      new THREE.SphereGeometry(1, 16, 8),
      dark,
      side * w * 0.4,
      y + 1.28,
      -l * 0.11,
    );
    inset.scale.set(w * 0.075, 0.08, l * 0.033);
    for (const z of [-l * 0.145, -l * 0.075]) {
      pipe(
        root,
        new THREE.Vector3(side * w * 0.37, y, z),
        new THREE.Vector3(side * w * 0.46, y + 1.8, z),
        0.04,
        upper,
      );
      pipe(
        root,
        new THREE.Vector3(side * w * 0.46, y + 1.8, z),
        new THREE.Vector3(side * w * 0.36, y + 1.8, z),
        0.04,
        upper,
      );
    }
    if (c.secondaryRange)
      for (let n = 0; n < (hull === "battleship" ? 4 : 2); n++) {
        const z = -l * 0.19 + n * l * 0.09,
          x = side * w * 0.36;
        cylinder(root, 0.42, 0.24, x, y + 0.24, z, dark);
        block(root, 0.85, 0.55, 1, x, y + 0.65, z, paint, 0.08);
        for (const dz of [-0.17, 0.17])
          pipe(
            root,
            new THREE.Vector3(x, y + 0.74, z + dz),
            new THREE.Vector3(x + side * 1.6, y + 0.9, z + dz),
            0.055,
            dark,
          );
      }
    if (c.torpedo)
      for (let tube = 0; tube < 3; tube++) {
        const z = -l * 0.23 + side * 0.1;
        pipe(
          root,
          new THREE.Vector3(side * w * 0.18, y + 0.45, z + tube * 0.28),
          new THREE.Vector3(side * w * 0.47, y + 0.45, z + tube * 0.28),
          0.12,
          dark,
        );
      }
  }
  // Individual armored turrets, barbettes and hollow muzzles; barrels remain animated.
  const turrets: THREE.Group[] = [];
  c.turrets.forEach((offset, index) => {
    const t = new THREE.Group();
    t.name = `turret-${index}`;
    const raised = offset > 0 && offset < l * 0.25 ? 1.1 : 0;
    t.position.set(0, y + 0.15 + raised, offset);
    root.add(t);
    cylinder(t, w * 0.24, 0.7, 0, 0.2, 0, dark);
    block(t, w * 0.53, 1.08, w * 0.5, 0, 0.98, 0, paint, 0.15);
    block(t, w * 0.4, 0.12, w * 0.38, 0, 1.63, -0.1, upper, 0.035);
    const elevation = new THREE.Group();
    elevation.position.set(0, 0.97, w * 0.14);
    t.add(elevation);
    const recoil = new THREE.Group();
    recoil.position.set(0, -0.97, -w * 0.14);
    elevation.add(recoil);
    const length = l * (hull === "battleship" ? 0.105 : 0.08),
      radius = c.caliber / 2300;
    for (let n = 0; n < c.barrels; n++) {
      const x = (n - (c.barrels - 1) / 2) * w * 0.145;
      pipe(
        recoil,
        new THREE.Vector3(x, 0.97, w * 0.14),
        new THREE.Vector3(x, 1.08, w * 0.14 + length),
        radius,
        dark,
        radius * 0.72,
      );
      const ring = add(
        recoil,
        new THREE.TorusGeometry(radius * 0.78, radius * 0.18, 6, 16),
        dark,
        x,
        1.08,
        w * 0.14 + length,
      );
      ring.rotation.x = 0;
      const bore = add(
        recoil,
        new THREE.CircleGeometry(radius * 0.66, 12),
        rubber,
        x,
        1.08,
        w * 0.14 + length + 0.004,
      );
      bore.rotation.y = 0;
    }
    t.userData.recoil = recoil;
    t.userData.elevation = elevation;
    t.userData.recoilRestZ = -w * 0.14;
    t.userData.muzzleZ = w * 0.14 + length;
    t.userData.barrels = c.barrels;
    t.userData.width = w;
    t.userData.restY = t.position.y;
    turrets.push(t);
  });
  // Pennant and small hull number use crisp decals rather than bright toy-colored geometry.
  const cloth = new THREE.MeshBasicMaterial({
    color: flagColor,
    side: THREE.DoubleSide,
  });
  cloth.userData.shared = false;
  const flag = add(
    root,
    new THREE.PlaneGeometry(0.9, 0.45),
    cloth,
    0.5,
    mastTop - 0.5,
    mastZ,
  );
  flag.rotation.y = 0.3;
  const labelCanvas = document.createElement("canvas");
  labelCanvas.width = 256;
  labelCanvas.height = 96;
  const ctx = labelCanvas.getContext("2d")!;
  ctx.fillStyle = "#cbd0c9";
  ctx.font = "bold 70px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(
    hull === "destroyer" ? "903" : hull === "cruiser" ? "712" : "601",
    128,
    73,
  );
  const label = new THREE.CanvasTexture(labelCanvas);
  const decal = new THREE.MeshBasicMaterial({
    map: label,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
  });
  for (const side of [-1, 1]) {
    const m = add(
      root,
      new THREE.PlaneGeometry(1.45, 0.55),
      decal,
      side * w * 0.43,
      y - 0.55,
      l * 0.27,
    );
    m.rotation.y = (side * Math.PI) / 2;
  }
  mergeStatic(root, turrets);
  root.userData.modelRevision = 2;
  return { root, turrets, beam: w, deckHeight: y };
}
