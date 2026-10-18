import * as THREE from "three";
import { terrainHeight, shoreRadius } from "../shared/terrain";
import type { Island } from "../shared/types";
const loader = new THREE.TextureLoader();
function tex(name: string, color = true) {
  const t = loader.load(`/textures/${name}.jpg`);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  if (color) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const rock = tex("coast_land_rocks_01_diff"),
  grass = tex("aerial_grass_rock_diff"),
  sand = tex("coast_sand_01_diff"),
  normal = tex("rocky_terrain_nor_gl", false);
const landMat = new THREE.MeshStandardMaterial({
  color: "#c2c3ad",
  roughness: 0.97,
  normalMap: normal,
  normalScale: new THREE.Vector2(0.7, 0.7),
});
landMat.onBeforeCompile = (shader) => {
  shader.uniforms.rockMap = { value: rock };
  shader.uniforms.sandMap = { value: sand };
  shader.uniforms.grassMap = { value: grass };
  shader.vertexShader =
    "varying vec3 vLand; varying vec3 vSlope;\n" +
    shader.vertexShader.replace(
      "#include <begin_vertex>",
      "#include <begin_vertex>\nvLand=(modelMatrix*vec4(position,1.)).xyz;vSlope=normal;",
    );
  shader.fragmentShader =
    "uniform sampler2D rockMap;uniform sampler2D sandMap;uniform sampler2D grassMap;varying vec3 vLand;varying vec3 vSlope;\n" +
    shader.fragmentShader.replace(
      "#include <map_fragment>",
      `vec3 n=normalize(vSlope);vec3 blend=pow(abs(n),vec3(4.));blend/=max(.001,blend.x+blend.y+blend.z);
      vec3 r=texture2D(rockMap,vLand.zy*.035).rgb*blend.x+texture2D(rockMap,vLand.xz*.035).rgb*blend.y+texture2D(rockMap,vLand.xy*.035).rgb*blend.z;
      vec3 vegetation=texture2D(grassMap,vLand.xz*.019).rgb*vec3(.82,.95,.77);
      float vegetationMask=.5+.5*sin(vLand.x*.037+sin(vLand.z*.022)*2.);
      vec3 ground=mix(r*.84,vegetation,smoothstep(.54,.85,n.y)*smoothstep(6.,17.,vLand.y)*(.65+vegetationMask*.35));
      vec3 beach=texture2D(sandMap,vLand.xz*.045).rgb*.85;diffuseColor.rgb*=mix(beach,ground,smoothstep(.8,5.,vLand.y));`,
    );
};
export function createIsland(i: Island) {
  const group = new THREE.Group();
  const size = i.radius * 2.22,
    segments = 100,
    g = new THREE.PlaneGeometry(size, size, segments, segments);
  g.rotateX(-Math.PI / 2);
  const p = g.attributes.position,
    uv = g.attributes.uv;
  for (let n = 0; n < p.count; n++) {
    const x = p.getX(n) + i.x,
      z = p.getZ(n) + i.z;
    p.setXYZ(n, x, terrainHeight(i, { x, z }), z);
    uv.setXY(n, x * 0.06, z * 0.06);
  }
  g.computeVertexNormals();
  const mesh = new THREE.Mesh(g, landMat);
  mesh.receiveShadow = true;
  mesh.castShadow = true;
  group.add(mesh);
  const foamPoints: THREE.Vector3[] = [];
  for (let n = 0; n <= 256; n++) {
    const a = (n / 256) * Math.PI * 2,
      r = shoreRadius(i, a) * 1.012;
    foamPoints.push(
      new THREE.Vector3(i.x + Math.sin(a) * r, 0.35, i.z + Math.cos(a) * r),
    );
  }
  const foam = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(foamPoints),
    new THREE.LineBasicMaterial({
      color: "#cad9cf",
      transparent: true,
      opacity: 0.38,
    }),
  );
  group.add(foam);
  return group;
}
