import { Wrecks } from "./wrecks";
import { viewForAim } from "../shared/cameraAim";
import {
  CombatEffects,
  flameTexture,
  smokeTexture,
  fireTexture,
} from "./combatFx";
import { buildWarship } from "./warship";
import { attachNpcShip, preloadNpcShip } from "./npcShip";
import { AimArea } from "./aimArea";
import { MineVisuals } from "./mines";
import { aimSolution } from "../shared/ballistics";
import { createIsland } from "./terrain";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import * as THREE from "three";
import { HULLS, ISLANDS, RULES } from "../shared/config";
import { angleDiff, bearing, clamp, dist } from "../shared/math";
import type {
  Contact,
  GameEvent,
  Hull,
  Ship,
  Snapshot,
  Vec2,
  NpcModel,
} from "../shared/types";

interface ShipVisual {
  root: THREE.Group;
  turrets: THREE.Group[];
  wake: THREE.Mesh;
  fire: THREE.Group;
  hull: Hull;
  bot: boolean;
  npcModel?: NpcModel;
}
let sharedWake: THREE.CanvasTexture | undefined;
function wakeTexture() {
  if (sharedWake) return sharedWake;
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createLinearGradient(0, 0, 0, 256);
  gradient.addColorStop(0, "rgba(255,255,255,0)");
  gradient.addColorStop(0.65, "rgba(255,255,255,.55)");
  gradient.addColorStop(1, "rgba(255,255,255,.9)");
  ctx.strokeStyle = gradient;
  ctx.lineWidth = 2;
  for (const side of [-1, 1])
    for (let n = 0; n < 18; n++) {
      ctx.beginPath();
      ctx.moveTo(64 + side * (8 + n * 0.6), 256);
      ctx.bezierCurveTo(
        64 + side * (9 + n * 0.7),
        195,
        64 + side * (35 + n * 0.6),
        80,
        64 + side * (48 + n * 0.5),
        0,
      );
      ctx.stroke();
    }
  sharedWake = new THREE.CanvasTexture(canvas);
  sharedWake.colorSpace = THREE.SRGBColorSpace;
  return sharedWake;
}
export function createShip(
  hull: Hull,
  teamColor = "#7bb9ee",
  bot = false,
  npcModel: NpcModel = "camouflage",
): ShipVisual {
  const model = buildWarship(
    hull,
    teamColor,
    npcModel === "wisconsin-golden" && bot ? 406 : undefined,
  );
  if (bot) attachNpcShip(model, hull, npcModel);
  const c = HULLS[hull],
    root = model.root,
    w = model.beam,
    l = c.length,
    turrets = model.turrets;
  turrets.forEach((t, i) => {
    if (c.turrets[i] < 0) t.rotation.y = Math.PI;
  });
  const wakeMat = new THREE.MeshBasicMaterial({
    color: "#a2d7dc",
    map: wakeTexture(),
    transparent: true,
    opacity: 0.22,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const wake = new THREE.Mesh(
    new THREE.PlaneGeometry(w * 1.8, l * 1.8),
    wakeMat,
  );
  wake.rotation.x = -Math.PI / 2;
  wake.position.set(0, 0.6, -l);
  wake.visible = false;
  root.add(wake);
  const fire = new THREE.Group();
  for (let n = 0; n < 2; n++) {
    const flame = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: fireTexture,
        color: "#ffb15c",
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    flame.scale.set(7, 11, 1);
    flame.position.set(0, 6, n ? l * 0.2 : -l * 0.2);
    fire.add(flame);
    const smoke = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: smokeTexture,
        color: "#30383d",
        transparent: true,
        opacity: 0.7,
        depthWrite: false,
      }),
    );
    smoke.scale.set(11, 21, 1);
    smoke.position.set(2, 17, n ? l * 0.2 : -l * 0.2);
    fire.add(smoke);
  }
  root.add(fire);
  fire.visible = false;
  return {
    root,
    turrets,
    wake,
    fire,
    hull,
    bot,
    npcModel: bot ? npcModel : undefined,
  };
}

export class SeaScene {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(55, 1, 1, 7000);
  canvas: HTMLCanvasElement;
  yaw = 0.8;
  pitch = 0.22;
  distance = 220;
  binocular = false;
  freeLook = false;
  aim: Vec2 = { x: 0, z: 0 };
  previewHull: Hull = "cruiser";
  private ships = new Map<string, ShipVisual>();
  private smokes = new Map<number, THREE.Group>();
  private water: THREE.ShaderMaterial;
  private preview: ShipVisual;
  private ray = new THREE.Raycaster();
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private seenEvents = new Set<number>();
  private smooth = new THREE.Vector3();
  private lastSelf = "";
  private previewTime = 0;
  fps = 60;
  private torpedoGuide = new THREE.Group();
  private torpedoArcs: THREE.Line[] = [];
  private torpedoFan: THREE.Mesh;
  constructor(container: HTMLElement) {
    for (let i = 0; i < 2; i++) {
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(
          Array.from({ length: 35 }, () => new THREE.Vector3()),
        ),
        new THREE.LineBasicMaterial({
          color: "#86d9b5",
          transparent: true,
          opacity: 0.38,
          depthWrite: false,
        }),
      );
      this.torpedoArcs.push(line);
      this.torpedoGuide.add(line);
    }
    const fanGeometry = new THREE.BufferGeometry();
    fanGeometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(new Float32Array(9), 3),
    );
    this.torpedoFan = new THREE.Mesh(
      fanGeometry,
      new THREE.MeshBasicMaterial({
        color: "#89e3ba",
        transparent: true,
        opacity: 0.17,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    this.torpedoGuide.add(this.torpedoFan);
    this.scene.add(this.torpedoGuide);
    this.torpedoGuide.visible = false;
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: "high-performance",
    });
    this.renderer.localClippingEnabled = true;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.8));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.98;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(
      new RoomEnvironment(),
      0.04,
    ).texture;
    pmrem.dispose();
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.canvas = this.renderer.domElement;
    this.canvas.id = "ocean";
    this.canvas.setAttribute("aria-label", "3D 해전 화면");
    this.canvas.tabIndex = 0;
    container.append(this.canvas);
    this.scene.background = new THREE.Color("#a6c4d1");
    this.scene.fog = new THREE.FogExp2("#aac6d2", 0.00024);
    this.scene.add(new THREE.HemisphereLight("#d3ecff", "#173744", 2.5));
    const sun = new THREE.DirectionalLight("#fff1d4", 3.3);
    sun.position.set(-500, 900, -400);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -400;
    sun.shadow.camera.right = 400;
    sun.shadow.camera.top = 400;
    sun.shadow.camera.bottom = -400;
    sun.shadow.camera.far = 2500;
    sun.shadow.bias = -0.0004;
    this.scene.add(sun);
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(6200, 32, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        uniforms: {},
        vertexShader:
          "varying vec3 vPos; void main(){vPos=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}",
        fragmentShader:
          "varying vec3 vPos; void main(){float h=normalize(vPos).y; vec3 color=mix(vec3(.72,.83,.86),vec3(.18,.39,.57),smoothstep(0.,.8,h));float s=pow(max(0.,dot(normalize(vPos),normalize(vec3(-.5,.65,-.4)))),180.);gl_FragColor=vec4(color+vec3(.9,.7,.4)*s,1.); }",
      }),
    );
    this.scene.add(sky);
    this.water = new THREE.ShaderMaterial({
      uniforms: { time: { value: 0 }, eye: { value: new THREE.Vector3() } },
      vertexShader: `varying vec3 world;uniform float time;void main(){vec3 p=position;p.z+=sin(dot(p.xy,vec2(.87,.49))*.039+time*.75)*.48+sin(dot(p.xy,vec2(-.31,.95))*.091+time*1.1)*.23;vec4 w=modelMatrix*vec4(p,1.);world=w.xyz;gl_Position=projectionMatrix*viewMatrix*w;}`,
      fragmentShader: `varying vec3 world;uniform float time;uniform vec3 eye;
      void main(){vec2 p=world.xz;float a=dot(p,vec2(.89,.45))*.085+time*1.2,b=dot(p,vec2(-.3,.95))*.19+time*1.7,c=dot(p,vec2(.71,-.7))*.44-time*2.1;
      vec2 slope=cos(a)*vec2(.89,.45)*.075+cos(b)*vec2(-.3,.95)*.035+cos(c)*vec2(.71,-.7)*.014;vec3 n=normalize(vec3(-slope.x,1.,-slope.y));vec3 view=normalize(eye-world);float fres=pow(1.-max(0.,dot(n,view)),3.);float shine=pow(max(0.,dot(reflect(normalize(vec3(.5,-.65,.4)),n),view)),180.);
      vec3 base=mix(vec3(.013,.095,.14),vec3(.19,.34,.43),fres);base+=sin(a*3.+sin(b))*sin(c)*.0025+shine*vec3(1.,.88,.65)*1.3;float d=length(eye-world);base=mix(base,vec3(.65,.77,.82),1.-exp(-d*.00022));gl_FragColor=vec4(base,1.);}`,
    });
    const ocean = new THREE.Mesh(
      new THREE.PlaneGeometry(16000, 16000, 160, 160),
      this.water,
    );
    ocean.rotation.x = -Math.PI / 2;
    this.scene.add(ocean);
    for (const i of ISLANDS) this.scene.add(createIsland(i));
    const ring = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-RULES.world, 1, -RULES.world),
        new THREE.Vector3(RULES.world, 1, -RULES.world),
        new THREE.Vector3(RULES.world, 1, RULES.world),
        new THREE.Vector3(-RULES.world, 1, RULES.world),
      ]),
      new THREE.LineBasicMaterial({
        color: "#d39353",
        transparent: true,
        opacity: 0.35,
      }),
    );
    this.scene.add(ring);
    this.preview = createShip("cruiser");
    this.preview.root.position.set(-210, 0, -650);
    this.scene.add(this.preview.root);
    this.resize();
    window.addEventListener("resize", () => this.resize());
  }
  resize() {
    const w = innerWidth,
      h = innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
  setPreview(hull: Hull) {
    if (this.previewHull === hull) return;
    this.scene.remove(this.preview.root);
    this.disposeObject(this.preview.root);
    this.preview = createShip(hull, HULLS[hull].color);
    this.preview.root.position.set(-210, 0, -650);
    this.scene.add(this.preview.root);
    this.previewHull = hull;
  }
  prepareNpcs(variant: NpcModel = "camouflage") {
    preloadNpcShip(variant);
  }
  private disposeObject(root: THREE.Object3D) {
    root.userData.disposed = true;
    root.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Sprite) {
        if (o instanceof THREE.Mesh && !o.geometry.userData.shared) {
          if (o.geometry.userData.wreckRefs > 0)
            o.geometry.userData.disposeAfterWreck = true;
          else o.geometry.dispose();
        }
        for (const m of Array.isArray(o.material) ? o.material : [o.material])
          if (!m.userData.shared) m.dispose();
      }
    });
  }
  private fx = new CombatEffects(this.scene);
  private wrecks = new Wrecks(this.scene, smokeTexture);
  private aimArea = new AimArea(this.scene);
  private mineVisuals = new MineVisuals(this.scene);
  private addEffect(e: GameEvent) {
    if (e.type === "sink") {
      const ship = this.ships.get(e.target ?? "");
      if (ship)
        this.wrecks.spawn(
          e,
          ship.root,
          HULLS[ship.hull].length,
          HULLS[ship.hull].beam,
          [ship.wake, ship.fire],
        );
    }
    this.fx.event(e, this.ships.get(e.owner ?? ""));
  }
  demoSalvo() {
    for (const t of this.preview.turrets) t.rotation.y = -Math.PI / 2;
    return this.fx.demo(this.preview, HULLS[this.previewHull].caliber);
  }
  get diagnostics() {
    return {
      ...this.fx.diagnostics,
      wrecks: this.wrecks.diagnostics,
      drawCalls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      modelRevision: this.preview.root.userData.modelRevision,
      aimArea: { ...this.aimArea.diagnostics },
      npcModels: [...this.ships.entries()]
        .filter(([, s]) => s.bot)
        .map(([id, s]) => ({
          id,
          status: s.root.userData.npcModel,
          variant: s.npcModel,
          turrets: s.turrets.length,
        })),
    };
  }
  private animateGuns(v: ShipVisual, time: number, aimDistance?: number) {
    for (const t of v.turrets) {
      const age = time - (t.userData.firedAt ?? -100);
      const recoil = t.userData.recoil as THREE.Group | undefined;
      if (recoil)
        recoil.position.z =
          (t.userData.recoilRestZ ?? 0) +
          (age < 1 ? -0.65 * Math.exp(-age * 6) : 0);
      if (aimDistance !== undefined) {
        const speed = HULLS[v.hull].shellSpeed,
          flight = Math.max(0.15, aimDistance / speed);
        t.userData.desiredElevation = Math.atan2(
          RULES.gravity * 0.5 * flight - 8 / flight,
          speed,
        );
      }
      const elevation = t.userData.elevation as THREE.Group | undefined;
      if (elevation)
        elevation.rotation.x +=
          (-clamp(t.userData.desiredElevation ?? 0, -0.18, 0.7) -
            elevation.rotation.x) *
          0.2;
    }
  }
  screenPoint(p: Vec2, y = 15) {
    const v = new THREE.Vector3(p.x, y, p.z).project(this.camera);
    return {
      x: (v.x * 0.5 + 0.5) * innerWidth,
      y: (-0.5 * v.y + 0.5) * innerHeight,
      visible:
        v.z < 1 && v.z > -1 && Math.abs(v.x) < 1.15 && Math.abs(v.y) < 1.15,
    };
  }
  setDistance(value: number) {
    this.distance = value;
    Object.assign(
      this,
      viewForAim(this.smooth, this.aim, this.binocular, this.distance),
    );
  }
  setBinocular(value: boolean) {
    if (value === this.binocular) return;
    this.binocular = value;
    Object.assign(
      this,
      viewForAim(this.smooth, this.aim, value, this.distance),
    );
    this.camera.fov = value ? 14 : 55;
    this.camera.updateProjectionMatrix();
  }
  render(dt: number, snapshot: Snapshot | null, playing: boolean) {
    const time = performance.now() / 1000;
    this.previewTime += dt;
    this.water.uniforms.time.value = time;
    this.fps = this.fps * 0.95 + 0.05 / Math.max(dt, 0.001);
    dt = Math.min(dt, 0.1);
    this.preview.root.visible = !playing;
    this.torpedoGuide.visible = Boolean(
      playing &&
      snapshot?.phase === "battle" &&
      snapshot.self.alive &&
      snapshot.self.input.weapon === "TORP",
    );
    if (!playing) {
      this.preview.root.rotation.y =
        0.6 + Math.sin(this.previewTime * 0.12) * 0.17;
      this.preview.root.position.y = Math.sin(time) * 0.18;
      this.animateGuns(this.preview, time);
      this.camera.fov = 45;
      this.camera.position.set(-130, 64, -735);
      this.camera.lookAt(-210, 4, -642);
      this.camera.updateProjectionMatrix();
      for (const v of this.ships.values()) v.root.visible = false;
    }
    if (playing && snapshot) {
      const self = snapshot.self;
      if (this.lastSelf !== self.id) {
        this.smooth.set(self.x, 0, self.z);
        this.yaw = self.heading;
        this.pitch = 0.22;
        this.lastSelf = self.id;
      }
      this.smooth.lerp(
        new THREE.Vector3(self.x, 0, self.z),
        1 - Math.exp(-dt * 9),
      );
      const desiredFov = this.binocular ? 14 : 55;
      if (this.camera.fov !== desiredFov) {
        this.camera.fov = desiredFov;
        this.camera.updateProjectionMatrix();
      }
      const offset = this.binocular ? 25 : this.distance * 0.7;
      const elevation = this.binocular ? 18 : this.distance * 0.38 + 10;
      this.camera.position.set(
        this.smooth.x - Math.sin(this.yaw) * offset,
        elevation,
        this.smooth.z - Math.cos(this.yaw) * offset,
      );
      const direction = new THREE.Vector3(
        Math.sin(this.yaw) * Math.cos(this.pitch),
        -Math.sin(this.pitch),
        Math.cos(this.yaw) * Math.cos(this.pitch),
      );
      this.camera.lookAt(
        this.camera.position.clone().add(direction.multiplyScalar(1000)),
      );
      this.camera.updateMatrixWorld();
      if (!this.freeLook) {
        this.ray.setFromCamera(new THREE.Vector2(0, 0), this.camera);
        const hit = new THREE.Vector3();
        if (this.ray.ray.intersectPlane(this.plane, hit))
          this.aim = {
            x: clamp(hit.x, -RULES.world, RULES.world),
            z: clamp(hit.z, -RULES.world, RULES.world),
          };
      }
      if (this.torpedoGuide.visible) {
        const range = HULLS[self.hull].torpedoRange;
        this.torpedoArcs.forEach((line, index) => {
          const side = index === 0 ? -1 : 1,
            positions = line.geometry.attributes.position;
          positions.setXYZ(0, self.x, 1.3, self.z);
          for (let n = 0; n < 33; n++) {
            const a = self.heading + side * (0.6 + ((2.55 - 0.6) * n) / 32);
            positions.setXYZ(
              n + 1,
              self.x + Math.sin(a) * range,
              1.3,
              self.z + Math.cos(a) * range,
            );
          }
          positions.setXYZ(34, self.x, 1.3, self.z);
          positions.needsUpdate = true;
          line.geometry.computeBoundingSphere();
        });
        const a = bearing(self, this.aim),
          valid =
            Math.abs(angleDiff(a, self.heading)) >= 0.6 &&
            Math.abs(angleDiff(a, self.heading)) <= 2.55;
        const vertices = this.torpedoFan.geometry.attributes.position;
        vertices.setXYZ(0, self.x, 1.5, self.z);
        vertices.setXYZ(
          1,
          self.x + Math.sin(a - 0.045) * range,
          1.5,
          self.z + Math.cos(a - 0.045) * range,
        );
        vertices.setXYZ(
          2,
          self.x + Math.sin(a + 0.045) * range,
          1.5,
          self.z + Math.cos(a + 0.045) * range,
        );
        vertices.needsUpdate = true;
        this.torpedoFan.geometry.computeBoundingSphere();
        (this.torpedoFan.material as THREE.MeshBasicMaterial).color.set(
          valid ? "#89e3ba" : "#ed9478",
        );
      }
      // Clone a sinking ship before it disappears from the visible contacts.
      for (const e of snapshot.events)
        if (e.type === "sink" && !this.seenEvents.has(e.id)) {
          this.seenEvents.add(e.id);
          this.addEffect(e);
        }
      const contacts: (Contact | Ship)[] = [self, ...snapshot.contacts],
        liveIds = new Set(contacts.map((s) => s.id));
      for (const [id, v] of this.ships) {
        if (!liveIds.has(id)) {
          this.scene.remove(v.root);
          this.disposeObject(v.root);
          this.ships.delete(id);
        }
      }
      for (const s of contacts) {
        let v = this.ships.get(s.id);
        if (
          !v ||
          v.hull !== s.hull ||
          v.bot !== s.bot ||
          v.npcModel !== s.npcModel
        ) {
          if (v) {
            this.scene.remove(v.root);
            this.disposeObject(v.root);
          }
          v = createShip(
            s.hull,
            s.id === self.id ? "#5ed6c4" : "#f2a08e",
            s.bot,
            s.npcModel,
          );
          v.root.position.set(s.x, 0, s.z);
          v.root.rotation.y = s.heading;
          this.ships.set(s.id, v);
          this.scene.add(v.root);
        }
        v.root.visible = s.alive && !(this.binocular && s.id === self.id);
        v.root.position.x +=
          (s.x - v.root.position.x) * (1 - Math.exp(-dt * 12));
        v.root.position.z +=
          (s.z - v.root.position.z) * (1 - Math.exp(-dt * 12));
        v.root.position.y = Math.sin(time * 1.3 + s.x) * 0.18;
        v.root.rotation.y +=
          angleDiff(s.heading, v.root.rotation.y) * (1 - Math.exp(-dt * 10));
        v.root.rotation.z = Math.sin(time * 0.8 + s.z) * 0.008;
        s.turrets.forEach((t, i) => {
          if (v!.turrets[i])
            v!.turrets[i].rotation.y = angleDiff(t.angle, s.heading);
        });
        v.wake.visible = Math.abs(s.speed) > 1;
        v.wake.scale.set(1, clamp(Math.abs(s.speed) / 15, 0.1, 2), 1);
        this.animateGuns(
          v,
          time,
          s.id === self.id && ["HE", "AP", "SAP"].includes(self.input.weapon)
            ? aimSolution(self, this.aim).distance
            : undefined,
        );
        v.fire.visible =
          "status" in s ? s.status.fire.some((f) => f > 0) : s.fire > 0;
        v.fire.scale.y = 1 + Math.sin(time * 16) * 0.2;
      }
      const smokeIds = new Set(snapshot.smokes.map((s) => s.id));
      for (const [id, mesh] of this.smokes)
        if (!smokeIds.has(id)) {
          this.scene.remove(mesh);
          this.disposeObject(mesh);
          this.smokes.delete(id);
        }
      for (const smoke of snapshot.smokes) {
        let mesh = this.smokes.get(smoke.id);
        if (!mesh) {
          mesh = new THREE.Group();
          for (let n = 0; n < 14; n++) {
            const a = n * 2.399 + smoke.id,
              r = smoke.radius * Math.sqrt(n / 16);
            const cloud = new THREE.Sprite(
              new THREE.SpriteMaterial({
                map: smokeTexture,
                color: "#b7bfc0",
                transparent: true,
                opacity: 0.4,
                depthWrite: false,
              }),
            );
            cloud.position.set(
              Math.sin(a) * r,
              5 + (n % 4) * 5,
              Math.cos(a) * r,
            );
            cloud.scale.set(smoke.radius * 0.95, 38 + (n % 3) * 8, 1);
            cloud.material.rotation = a;
            mesh.add(cloud);
          }
          this.scene.add(mesh);
          this.smokes.set(smoke.id, mesh);
        }
        mesh.position.set(smoke.x, 0, smoke.z);
        for (const cloud of mesh.children as THREE.Sprite[])
          cloud.material.opacity = clamp(
            (smoke.expires - snapshot.time) / 12,
            0,
            0.4,
          );
      }
      for (const e of snapshot.events)
        if (!this.seenEvents.has(e.id)) {
          this.seenEvents.add(e.id);
          this.addEffect(e);
        }
      if (this.seenEvents.size > 3000)
        this.seenEvents = new Set(snapshot.events.map((e) => e.id));
    }
    this.fx.update(dt, snapshot, playing);
    this.wrecks.update(dt, playing);
    this.aimArea.update(
      playing && snapshot?.phase === "battle" ? snapshot.self : null,
      this.aim,
    );
    this.mineVisuals.update(snapshot, playing && snapshot?.phase === "battle");
    this.water.uniforms.eye.value.copy(this.camera.position);
    this.renderer.render(this.scene, this.camera);
  }
}
