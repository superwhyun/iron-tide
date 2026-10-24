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
// Surf band: foam lines rolling onto the beach, faded with distance like fog.
export const surfMaterial = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  uniforms: { time: { value: 0 } },
  vertexShader: `varying vec2 vUv;varying float vDist;
    void main(){vUv=uv;vec4 w=modelMatrix*vec4(position,1.);vDist=distance(w.xyz,cameraPosition);gl_Position=projectionMatrix*viewMatrix*w;}`,
  fragmentShader: `varying vec2 vUv;varying float vDist;uniform float time;
    float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
    float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
      return mix(mix(hash(i),hash(i+vec2(1.,0.)),f.x),mix(hash(i+vec2(0.,1.)),hash(i+vec2(1.,1.)),f.x),f.y);}
    void main(){
      float across=vUv.y;
      float n=noise(vec2(vUv.x*3.,across*4.-time*.4))*.8+noise(vec2(vUv.x*11.,across*9.))*.35;
      float waves=smoothstep(.55,1.,sin(across*16.+time*1.6+n*3.)*.5+.5);
      float edge=smoothstep(0.,.12,across)*(1.-smoothstep(.25,1.,across));
      float shore=1.-smoothstep(0.,.18,across);
      float a=(waves*.55+shore*.7)*edge*smoothstep(.3,.7,n+.25);
      a*=exp(-vDist*.0011);
      gl_FragColor=vec4(vec3(.82,.88,.88),a*.75);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
});
function surfBand(i: Island) {
  const positions: number[] = [],
    uvs: number[] = [],
    index: number[] = [],
    steps = 256;
  for (let n = 0; n <= steps; n++) {
    const a = (n / steps) * Math.PI * 2,
      r = shoreRadius(i, a);
    for (const [k, scale] of [0.985, 1.13].entries()) {
      positions.push(
        i.x + Math.sin(a) * r * scale,
        0.42,
        i.z + Math.cos(a) * r * scale,
      );
      uvs.push((n / steps) * Math.round(i.radius / 6), k);
    }
    if (n < steps) {
      const b = n * 2;
      index.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(index);
  const band = new THREE.Mesh(g, surfMaterial);
  band.renderOrder = 1;
  return band;
}
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
  group.add(foam, surfBand(i));
  return group;
}
