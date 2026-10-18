import * as THREE from "three";

// Longitudinal stations and compound hull sections, rather than an extruded rounded slab.
const stations = [
  [-0.5, 0.38],
  [-0.46, 0.75],
  [-0.36, 0.95],
  [-0.2, 1],
  [0.05, 1],
  [0.22, 0.88],
  [0.35, 0.61],
  [0.44, 0.31],
  [0.5, 0.005],
];
export function widthAt(t: number) {
  for (let i = 1; i < stations.length; i++)
    if (t <= stations[i][0]) {
      const [a, wa] = stations[i - 1],
        [b, wb] = stations[i],
        f = (t - a) / (b - a);
      return THREE.MathUtils.lerp(wa, wb, f);
    }
  return 0.005;
}
export function hullSurface(length: number, width: number, top: number) {
  const p: number[] = [],
    uv: number[] = [],
    indices: number[] = [];
  const rows = [
    [-2.1, 0.13],
    [-1.4, 0.62],
    [-0.35, 0.9],
    [0.45, 0.96],
    [1.5, 1],
    [top, 1.025],
  ];
  for (const side of [-1, 1])
    for (let j = 0; j < rows.length; j++)
      for (let i = 0; i <= 80; i++) {
        const t = -0.5 + i / 80,
          f = widthAt(t),
          [y, scale] = rows[j],
          sheer = Math.max(0, (t - 0.15) / 0.35) ** 2 * 0.95;
        p.push(
          side * width * 0.5 * f * scale,
          y + (j > 3 ? sheer : 0),
          t * length,
        );
        uv.push((i / 80) * 9, j / (rows.length - 1));
      }
  const ring = 81,
    skin = rows.length * ring;
  for (let s = 0; s < 2; s++)
    for (let j = 0; j < rows.length - 1; j++)
      for (let i = 0; i < 80; i++) {
        const a = s * skin + j * ring + i,
          b = a + 1,
          c = a + ring,
          d = c + 1;
        if (s === 0) indices.push(a, c, b, b, c, d);
        else indices.push(a, b, c, b, d, c);
      }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(p, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}
export function deckSurface(l: number, w: number, y: number) {
  const p: number[] = [],
    uv: number[] = [],
    indices: number[] = [];
  for (let i = 0; i <= 80; i++)
    for (let n = 0; n <= 8; n++) {
      const t = -0.5 + i / 80,
        x = (n / 8 - 0.5) * w * widthAt(t),
        sheer = Math.max(0, (t - 0.15) / 0.35) ** 2 * 0.95;
      p.push(x, y + sheer + Math.cos((n / 8 - 0.5) * Math.PI) * 0.09, t * l);
      uv.push(n / 8, i / 80);
    }
  for (let i = 0; i < 80; i++)
    for (let n = 0; n < 8; n++) {
      const a = i * 9 + n;
      indices.push(a, a + 9, a + 1, a + 1, a + 9, a + 10);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(p, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}
