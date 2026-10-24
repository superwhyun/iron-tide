import * as THREE from "three";

// Deterministic PRNG so textures look identical on every load.
function seeded(seed: number) {
  return () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
}
function canvas(width: number, height = width) {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  return { c, ctx: c.getContext("2d")! };
}
function finish(c: HTMLCanvasElement, srgb = true) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.userData.shared = true;
  return t;
}
function blob(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  inner: string,
  outer = "rgba(255,255,255,0)",
) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, inner);
  g.addColorStop(1, outer);
  ctx.fillStyle = g;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
}

/** Billowing smoke puff: clustered lobes with a denser core and ragged edge. */
function smokePuff() {
  const { c, ctx } = canvas(128);
  const random = seeded(7);
  for (let n = 0; n < 46; n++) {
    const a = random() * Math.PI * 2,
      d = Math.pow(random(), 0.7) * 34,
      r = 12 + random() * 20;
    blob(
      ctx,
      64 + Math.cos(a) * d,
      64 + Math.sin(a) * d,
      r,
      `rgba(255,255,255,${0.1 + random() * 0.12})`,
    );
  }
  // Shade the lower-right of the puff so it reads as a volume, not a disk.
  const shade = ctx.createLinearGradient(30, 30, 110, 110);
  shade.addColorStop(0, "rgba(0,0,0,0)");
  shade.addColorStop(1, "rgba(0,0,0,0.28)");
  ctx.globalCompositeOperation = "source-atop";
  ctx.fillStyle = shade;
  ctx.fillRect(0, 0, 128, 128);
  return finish(c);
}
function radialGlow() {
  const { c, ctx } = canvas(128);
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.12, "rgba(255,245,210,.95)");
  g.addColorStop(0.4, "rgba(255,160,45,.32)");
  g.addColorStop(1, "rgba(255,100,10,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  return finish(c);
}
function burning() {
  const { c, ctx } = canvas(128, 256);
  for (let n = 0; n < 32; n++) {
    const level = n / 31,
      x = 64 + Math.sin(n * 2.399) * 25 * (1 - level),
      y = 220 - level * 185;
    const radius = 32 * (1 - level * 0.8);
    const g = ctx.createRadialGradient(x, y, 0, x, y, radius);
    g.addColorStop(
      0,
      level < 0.35 ? "rgba(255,248,199,.95)" : "rgba(255,188,43,.8)",
    );
    g.addColorStop(0.35, "rgba(255,151,19,.8)");
    g.addColorStop(0.7, "rgba(245,58,3,.4)");
    g.addColorStop(1, "rgba(170,22,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  }
  return finish(c);
}
/** Spray: a soft mist core peppered with droplets. */
function sprayCloud() {
  const { c, ctx } = canvas(128);
  const random = seeded(31);
  blob(ctx, 64, 64, 58, "rgba(255,255,255,.35)");
  for (let n = 0; n < 160; n++) {
    const a = random() * Math.PI * 2,
      d = Math.pow(random(), 0.55) * 56,
      r = 1 + random() * 3.5;
    blob(
      ctx,
      64 + Math.cos(a) * d,
      64 + Math.sin(a) * d,
      r,
      `rgba(255,255,255,${0.45 + random() * 0.5})`,
    );
  }
  return finish(c);
}
function shockRing() {
  const { c, ctx } = canvas(128);
  const g = ctx.createRadialGradient(64, 64, 34, 64, 64, 63);
  g.addColorStop(0, "rgba(255,255,255,0)");
  g.addColorStop(0.62, "rgba(255,255,255,.75)");
  g.addColorStop(0.78, "rgba(255,255,255,.25)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  return finish(c);
}
/** Churned foam patch for splash scars, wakes and torpedo tracks. */
function foamPatch() {
  const { c, ctx } = canvas(256);
  const random = seeded(97);
  for (let n = 0; n < 260; n++) {
    const a = random() * Math.PI * 2,
      d = Math.pow(random(), 0.6) * 110,
      r = 3 + random() * 11;
    blob(
      ctx,
      128 + Math.cos(a) * d,
      128 + Math.sin(a) * d,
      r,
      `rgba(255,255,255,${0.12 + random() * 0.32})`,
    );
  }
  ctx.globalCompositeOperation = "destination-in";
  const edge = ctx.createRadialGradient(128, 128, 40, 128, 128, 128);
  edge.addColorStop(0, "rgba(0,0,0,1)");
  edge.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = edge;
  ctx.fillRect(0, 0, 256, 256);
  return finish(c);
}

/** Wraps around the splash column: ragged vertical sheets of water thinning toward the top. */
function waterSheet() {
  const { c, ctx } = canvas(256, 256);
  const random = seeded(53);
  for (let n = 0; n < 220; n++) {
    const x = random() * 256,
      w = 2 + random() * 9,
      top = random() * 90,
      g = ctx.createLinearGradient(0, top, 0, 256);
    g.addColorStop(0, "rgba(255,255,255,0)");
    g.addColorStop(0.35, `rgba(255,255,255,${0.15 + random() * 0.35})`);
    g.addColorStop(1, `rgba(255,255,255,${0.35 + random() * 0.4})`);
    ctx.fillStyle = g;
    ctx.fillRect(x, top, w, 256 - top);
  }
  for (let n = 0; n < 500; n++)
    blob(
      ctx,
      random() * 256,
      random() * 140,
      1 + random() * 3,
      "rgba(255,255,255,.5)",
    );
  const t = finish(c);
  t.wrapS = THREE.RepeatWrapping;
  // Lathe UVs run bottom (v=0) to top (v=1); canvas y runs the other way.
  t.flipY = true;
  return t;
}
export const fxTextures = {
  sheet: waterSheet(),
  cloud: smokePuff(),
  glow: radialGlow(),
  fire: burning(),
  spray: sprayCloud(),
  ring: shockRing(),
  foam: foamPatch(),
};
export const fireTexture = fxTextures.fire;
export const smokeTexture = fxTextures.cloud;
export const flameTexture = fxTextures.glow;
