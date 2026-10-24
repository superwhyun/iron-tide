import * as THREE from "three";

// Late-afternoon sun shared by the sky, sea glitter, fog and the shadow light.
export const SUN_DIRECTION = new THREE.Vector3(-0.52, 0.42, -0.46).normalize();
export const HORIZON_COLOR = new THREE.Color().setRGB(0.42, 0.5, 0.56);
export const FOG_DENSITY = 0.00026;

const NOISE_GLSL = /* glsl */ `
float hash(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
  return mix(mix(hash(i),hash(i+vec2(1.,0.)),f.x),mix(hash(i+vec2(0.,1.)),hash(i+vec2(1.,1.)),f.x),f.y);}
#ifdef LOW_QUALITY
#define OCTAVES 3
#else
#define OCTAVES 5
#endif
float fbm(vec2 p){float v=0.,a=.5;mat2 m=mat2(1.6,1.2,-1.2,1.6);
  for(int i=0;i<OCTAVES;i++){v+=a*noise(p);p=m*p;a*=.5;}return v;}
`;

// Linear-space atmosphere; the post pipeline applies ACES tone mapping and sRGB.
const ATMOSPHERE_GLSL = /* glsl */ `
uniform vec3 sunDir;
uniform vec3 horizonColor;
vec3 atmosphere(vec3 d){
  float h=clamp(d.y,0.,1.);
  vec3 zenith=vec3(.035,.11,.27);
  vec3 col=mix(horizonColor,zenith,pow(h,.42));
  float sd=max(dot(d,sunDir),0.);
  col+=vec3(1.,.6,.3)*(pow(sd,5.)*.2+pow(sd,42.)*.45)*(1.-h*.6);
  return col;
}
`;

/** Switches the sky and sea shaders to their cheaper variants (fewer octaves and ripples). */
export function useLowQuality(...materials: THREE.ShaderMaterial[]) {
  for (const m of materials) {
    m.defines = { ...m.defines, LOW_QUALITY: "" };
    m.needsUpdate = true;
  }
}

export function createSky(): THREE.Mesh<
  THREE.SphereGeometry,
  THREE.ShaderMaterial
> {
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      time: { value: 0 },
      sunDir: { value: SUN_DIRECTION },
      horizonColor: { value: HORIZON_COLOR },
    },
    vertexShader: /* glsl */ `varying vec3 vDir;
      void main(){vDir=position;vec4 p=projectionMatrix*modelViewMatrix*vec4(position,1.);gl_Position=p.xyww;}`,
    fragmentShader: /* glsl */ `varying vec3 vDir;uniform float time;
      ${NOISE_GLSL}${ATMOSPHERE_GLSL}
      void main(){
        vec3 d=normalize(vDir);
        vec3 col=atmosphere(d);
        float sd=max(dot(d,sunDir),0.);
        col+=vec3(30.,23.,15.)*smoothstep(.99955,.9998,sd);
        if(d.y>0.){
          vec2 uv=d.xz/(d.y+.1)*1.25+vec2(time*.0045,time*.002);
          float base=fbm(uv*1.1),detail=fbm(uv*3.4+base*1.7);
          float cover=smoothstep(.5,.82,base*.78+detail*.38);
          float fade=smoothstep(0.,.22,d.y);
          float lit=pow(sd,4.)*.7+smoothstep(.35,.85,detail)*.5;
          vec3 cloud=mix(vec3(.2,.22,.26),vec3(1.05,.92,.78),clamp(lit,0.,1.));
          col=mix(col,cloud*(.55+.45*clamp(d.y*2.,0.,1.)),cover*fade*.9);
        }
        gl_FragColor=vec4(col,1.);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(6000, 48, 24), material);
  sky.renderOrder = -10;
  sky.frustumCulled = false;
  return sky;
}

export function createOcean(): THREE.Mesh<
  THREE.PlaneGeometry,
  THREE.ShaderMaterial
> {
  const material = new THREE.ShaderMaterial({
    fog: false,
    uniforms: {
      time: { value: 0 },
      eye: { value: new THREE.Vector3() },
      sunDir: { value: SUN_DIRECTION },
      horizonColor: { value: HORIZON_COLOR },
      fogDensity: { value: FOG_DENSITY },
    },
    vertexShader: /* glsl */ `varying vec3 vWorld;
      void main(){vec4 w=modelMatrix*vec4(position,1.);vWorld=w.xyz;gl_Position=projectionMatrix*viewMatrix*w;}`,
    fragmentShader: /* glsl */ `varying vec3 vWorld;uniform float time;uniform vec3 eye;uniform float fogDensity;
      ${NOISE_GLSL}${ATMOSPHERE_GLSL}
      float swell(vec2 p){
        float t=time,s=0.;
        s+=sin(dot(p,vec2(.8,.6))*.066+t*.8)*.55;
        s+=sin(dot(p,vec2(-.45,.89))*.11+t*1.05)*.32;
        s+=sin(dot(p,vec2(.97,-.24))*.21+t*1.45)*.16;
        s+=sin(dot(p,vec2(.3,.95))*.37+t*1.9)*.085;
        s+=sin(dot(p,vec2(-.85,-.5))*.61+t*2.4)*.05;
        #ifndef LOW_QUALITY
        s+=sin(dot(p,vec2(.6,-.8))*1.03+t*3.1)*.028;
        s+=noise(p*.33+vec2(t*.31,t*.17))*.16+noise(p*.91-vec2(t*.27,t*.41))*.06;
        #endif
        return s;
      }
      void main(){
        vec2 p=vWorld.xz;
        vec3 toEye=eye-vWorld;float dist=length(toEye);vec3 v=toEye/dist;
        // A wider finite-difference step filters ripples that would alias in the distance.
        float e=.35+dist*.004;
        float hc=swell(p);
        float dx=(swell(p+vec2(e,0.))-swell(p-vec2(e,0.)))/(2.*e);
        float dz=(swell(p+vec2(0.,e))-swell(p-vec2(0.,e)))/(2.*e);
        float near=exp(-dist*.0009);
        vec3 n=normalize(vec3(-dx*(.45+.55*near),1.,-dz*(.45+.55*near)));
        float ndv=max(dot(n,v),0.);
        float fres=.02+.98*pow(1.-ndv,5.);
        vec3 r=reflect(-v,n);r.y=abs(r.y)+.015;r=normalize(r);
        vec3 refl=atmosphere(r);
        float sunLit=max(dot(n,sunDir),0.);
        float crest=clamp(hc*.7+.45,0.,1.);
        vec3 deep=vec3(.002,.012,.026);
        vec3 scatter=vec3(.004,.034,.042)*(.2+.8*crest)*(.35+.65*sunLit);
        float back=pow(max(dot(v,-normalize(vec3(sunDir.x,.0,sunDir.z))),0.),3.)*crest;
        vec3 water=deep+scatter+vec3(.01,.07,.065)*back*.3;
        vec3 col=mix(water,refl,fres);
        float rs=max(dot(r,sunDir),0.);
        col+=vec3(14.,11.,7.5)*pow(rs,700.)+vec3(1.,.75,.45)*pow(rs,70.)*.45;
        // Sparse whitecaps only on the sharpest crests.
        float foam=smoothstep(.9,1.1,crest+noise(p*.8+time*.35)*.3-.12)*near;
        foam*=smoothstep(.62,.85,noise(p*.05-time*.03))*smoothstep(.45,.85,noise(p*2.3+time*.5));
        col=mix(col,vec3(.5,.55,.57)*(.5+.5*sunLit),foam*.3);
        vec3 haze=atmosphere(normalize(vec3(-v.x,.015,-v.z)));
        col=mix(col,haze,1.-exp(-dist*fogDensity));
        gl_FragColor=vec4(col,1.);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const ocean = new THREE.Mesh(
    new THREE.PlaneGeometry(16000, 16000, 1, 1),
    material,
  );
  ocean.rotation.x = -Math.PI / 2;
  ocean.renderOrder = -5;
  return ocean;
}

// Sky-only scene used to bake a reflection probe so steel and glass pick up real sky light.
export function skyEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const scene = new THREE.Scene();
  const sky = createSky();
  scene.add(sky);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const texture = pmrem.fromScene(scene, 0.02).texture;
  pmrem.dispose();
  sky.geometry.dispose();
  sky.material.dispose();
  return texture;
}
