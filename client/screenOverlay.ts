// Droplets on the "lens" after a near miss; generated once so no image asset is needed.
function dropletSheet() {
  const size = 512,
    c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  let seed = 23;
  const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  for (let n = 0; n < 60; n++) {
    const x = random() * size,
      y = random() * size,
      r = 1.5 + Math.pow(random(), 3) * 9;
    if (r > 7 && random() < 0.4) {
      // Run-off streak trailing below a heavy drop.
      const streak = ctx.createLinearGradient(x, y, x, y + r * 4);
      streak.addColorStop(0, "rgba(220,235,240,.14)");
      streak.addColorStop(1, "rgba(220,235,240,0)");
      ctx.fillStyle = streak;
      ctx.fillRect(x - r * 0.25, y, r * 0.5, r * 4);
    }
    const body = ctx.createRadialGradient(
      x - r * 0.3,
      y - r * 0.35,
      r * 0.05,
      x,
      y,
      r,
    );
    body.addColorStop(0, "rgba(255,255,255,.5)");
    body.addColorStop(0.35, "rgba(210,228,235,.12)");
    body.addColorStop(0.9, "rgba(40,60,70,.12)");
    body.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.ellipse(
      x,
      y,
      r,
      r * (0.85 + random() * 0.3),
      random() * 3,
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }
  return c.toDataURL("image/png");
}

/** DOM layer for impact feedback that sits between the 3D view and the HUD. */
export class ScreenOverlay {
  private damage: HTMLElement;
  private spray: HTMLElement;
  private critical: HTMLElement;
  private hud: HTMLElement | null;
  constructor(root: HTMLElement) {
    root.innerHTML =
      '<div class="damage-flash"></div><div class="lens-spray"></div><div class="critical-edge"></div>';
    this.damage = root.querySelector(".damage-flash")!;
    this.spray = root.querySelector(".lens-spray")!;
    this.critical = root.querySelector(".critical-edge")!;
    this.spray.style.backgroundImage = `url(${dropletSheet()})`;
    this.hud = document.querySelector(".ship-hud");
  }
  trigger(kind: "damage" | "spray" | "blast", strength: number) {
    const k = Math.max(0.15, Math.min(1, strength));
    if (kind === "damage") {
      this.damage.animate([{ opacity: 0.35 + k * 0.65 }, { opacity: 0 }], {
        duration: 500 + k * 900,
        easing: "cubic-bezier(.2,.7,.3,1)",
      });
      this.hud?.animate(
        [
          { transform: "translate(0,0)" },
          { transform: `translate(${-6 * k}px,${3 * k}px)` },
          { transform: `translate(${5 * k}px,${-2 * k}px)` },
          { transform: "translate(0,0)" },
        ],
        { duration: 260, easing: "ease-out" },
      );
    } else if (kind === "spray") {
      this.spray.style.backgroundPosition = `${Math.random() * 512}px ${Math.random() * 512}px`;
      this.spray.animate(
        [
          { opacity: 0.2 + k * 0.5, transform: "translateY(0)" },
          { opacity: 0.3 * k, transform: "translateY(6px)", offset: 0.4 },
          { opacity: 0, transform: "translateY(18px)" },
        ],
        { duration: 2600, easing: "ease-in" },
      );
    }
  }
  /** 0 = healthy, 1 = about to sink. */
  setCritical(level: number) {
    this.critical.style.opacity = String(Math.max(0, Math.min(1, level)));
  }
}
