import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    time: { value: 0 },
    resolution: { value: new THREE.Vector2(1, 1) },
    aberration: { value: 0 },
    damage: { value: 0 },
    flash: { value: 0 },
    vignette: { value: 0.32 },
  },
  vertexShader: /* glsl */ `varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
  fragmentShader: /* glsl */ `uniform sampler2D tDiffuse;uniform float time,aberration,damage,flash,vignette;uniform vec2 resolution;varying vec2 vUv;
    float hash(vec2 p){p=fract(p*vec2(443.897,441.423));p+=dot(p,p.yx+19.19);return fract((p.x+p.y)*p.x);}
    void main(){
      vec2 c=vUv-.5;float r=length(c*vec2(resolution.x/resolution.y,1.));
      vec2 off=c*(.0025+aberration*.022)*r;
      vec3 col=vec3(texture2D(tDiffuse,vUv+off).r,texture2D(tDiffuse,vUv).g,texture2D(tDiffuse,vUv-off).b);
      float l=dot(col,vec3(.2126,.7152,.0722));
      // Split-tone: cool steel shadows, warm sunlit highlights; mild filmic contrast.
      col*=mix(vec3(.93,1.,1.07),vec3(1.06,1.,.93),smoothstep(.05,.9,l));
      col=mix(vec3(l),col,1.06);
      col*=1.+flash*1.6;
      col+=vec3(1.,.55,.25)*flash*.12;
      float edge=smoothstep(.3,1.05,r);
      col*=1.-vignette*edge;
      col=mix(col,vec3(.55,.03,.02)*(.25+l*.8),clamp(damage,0.,1.)*smoothstep(.18,.95,r));
      col+=(hash(vUv*resolution+fract(time*7.)*311.)-.5)*.022*(.35+l);
      gl_FragColor=vec4(max(col,0.),1.);
    }`,
};

/** SwiftShader/llvmpipe and friends: rendering runs on the CPU, so skip the costly extras. */
export function isSoftwareRenderer(renderer: THREE.WebGLRenderer) {
  const gl = renderer.getContext();
  const debug = gl.getExtension("WEBGL_debug_renderer_info");
  const name = gl.getParameter(
    debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER,
  );
  return /swiftshader|llvmpipe|softpipe|software|basic render/i.test(
    String(name),
  );
}

const SLOW_FPS = 24;
const SLOW_FRAMES = 120;

/**
 * HDR pipeline (bloom, grading, impact flash/aberration) on capable GPUs; falls back
 * to a direct tone-mapped render on software or persistently slow renderers.
 */
export class PostFx {
  private composer?: EffectComposer;
  private grade?: ShaderPass;
  private slowFrames = 0;
  low: boolean;
  onDegrade?: () => void;
  readonly uniforms = {
    aberration: { value: 0 },
    damage: { value: 0 },
    flash: { value: 0 },
    vignette: { value: 0.32 },
  };
  constructor(
    private renderer: THREE.WebGLRenderer,
    private scene: THREE.Scene,
    private camera: THREE.Camera,
  ) {
    this.low = isSoftwareRenderer(renderer);
    if (!this.low) this.build();
  }
  private build() {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const target = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      samples: 4,
    });
    this.composer = new EffectComposer(this.renderer, target);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.composer.addPass(
      new UnrealBloomPass(
        new THREE.Vector2(size.x / 2, size.y / 2),
        0.62,
        0.55,
        0.92,
      ),
    );
    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);
    this.composer.addPass(new OutputPass());
  }
  setSize(width: number, height: number) {
    if (!this.composer || !this.grade) return;
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(width, height);
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.grade.uniforms.resolution.value.set(size.x, size.y);
  }
  private degrade() {
    this.low = true;
    this.composer?.dispose();
    this.composer = undefined;
    this.grade = undefined;
    this.onDegrade?.();
  }
  private adapt(fps: number) {
    if (this.low) return;
    this.slowFrames = fps < SLOW_FPS ? this.slowFrames + 1 : 0;
    if (this.slowFrames >= SLOW_FRAMES) this.degrade();
  }
  render(dt: number, fps: number) {
    this.adapt(fps);
    this.renderer.info.reset();
    if (!this.composer || !this.grade) {
      this.renderer.render(this.scene, this.camera);
      return;
    }
    const u = this.grade.uniforms;
    u.time.value += dt;
    for (const key of ["aberration", "damage", "flash", "vignette"] as const)
      u[key].value = this.uniforms[key].value;
    this.composer.render(dt);
  }
}
