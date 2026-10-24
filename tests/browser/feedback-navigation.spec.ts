import { test, expect } from "@playwright/test";
import {
  crew,
  state,
  fixture,
  control,
  aimAt,
  mousePositions,
} from "./helpers";
import { shoreRadius } from "../../shared/terrain";
import { HULLS, ISLANDS } from "../../shared/config";
import { makeShip } from "../../server/game";
import { intersectShip } from "../../server/shipCollision";

test("coastal reverse hold, stable Shift aim, clear armor feedback, large damage and split sinking", async ({
  browser,
}) => {
  test.setTimeout(240000);
  const { a, b, room, contexts, errors, eventLog } = await crew(
    browser,
    "battleship",
    "cruiser",
  );
  try {
    const A = (await state(a)).self.id,
      B = (await state(b)).self.id;
    const r = shoreRadius(ISLANDS[0], Math.PI) + HULLS.battleship.length * 0.35;
    await fixture(room, {
      players: [
        { id: A, x: 0, z: -r, heading: 0, speed: 0, status: { protection: 0 } },
        { id: B, x: 1000, z: 1000 },
      ],
    });
    await control(a);
    for (let n = 0; n < 4; n++) await a.keyboard.press("w");
    await expect.poll(async () => (await state(a)).self.grounded).toBe(true);
    await expect(a.locator("#grounding-warning")).toContainText("해안 접촉");
    await a.keyboard.down("d");
    await a.waitForTimeout(1700);
    await a.keyboard.up("d");
    expect((await state(a)).self.heading).toBeLessThan(-0.02);
    await a.keyboard.down("s");
    await expect
      .poll(async () => (await state(a)).self.input.throttle, { timeout: 7000 })
      .toBe(0);
    await a.keyboard.up("s");
    await expect.poll(async () => (await state(a)).self.speed).toBeLessThan(-1);
    await expect.poll(async () => (await state(a)).self.grounded).toBe(false);
    await a.screenshot({ path: "artifacts/browser-coastal-escape.png" });
    await a.keyboard.press("w");
    await expect.poll(async () => (await state(a)).self.input.throttle).toBe(1);
    await fixture(room, {
      players: [
        {
          id: A,
          x: -200,
          z: -700,
          heading: 0,
          speed: 0,
          status: { protection: 0 },
        },
        {
          id: B,
          x: 250,
          z: -700,
          heading: 0,
          speed: 0,
          hp: 27000,
          status: { protection: 0 },
        },
      ],
    });
    await aimAt(a, 250, -700);
    const before = await a.evaluate(() => window.__IRON_TIDE__.view.aim);
    await a.keyboard.press("Shift");
    await expect
      .poll(() => a.evaluate(() => window.__IRON_TIDE__.view.binocular))
      .toBe(true);
    const after = await a.evaluate(() => window.__IRON_TIDE__.view.aim);
    expect(Math.hypot(before.x - after.x, before.z - after.z)).toBeLessThan(
      1.5,
    );
    await a.keyboard.press("Shift");
    const returned = await a.evaluate(() => window.__IRON_TIDE__.view.aim);
    expect(
      Math.hypot(before.x - returned.x, before.z - returned.z),
    ).toBeLessThan(1.5);
    // HE now pierces the thin upper side, so only belt hits shatter: fire
    // salvos until one shell lands on the belt.
    const hitsByA = () =>
      [...eventLog.get(a)!.values()].filter(
        (e) => e.type === "hit" && e.owner === A,
      );
    const shattered = () => hitsByA().some((e) => e.result === "shatter");
    for (let salvo = 0; salvo < 4 && !shattered(); salvo++) {
      if (salvo)
        await fixture(room, { advance: 13, players: [{ id: B, hp: 27000 }] });
      await expect
        .poll(async () => (await state(a)).self.turrets[0].reload)
        .toBe(0);
      const shots = (await state(a)).self.stats.shots;
      await a.mouse.dblclick(
        mousePositions.get(a)!.x,
        mousePositions.get(a)!.y,
      );
      // Wait for the whole salvo to land, hit or miss, before judging it.
      await expect
        .poll(async () => (await state(a)).self.stats.shots)
        .toBeGreaterThan(shots);
      await expect
        .poll(
          async () =>
            (await state(a)).projectiles.filter((p) => p.owner === A).length,
          { timeout: 10000 },
        )
        .toBe(0);
    }
    expect(shattered()).toBe(true);
    await expect(a.locator("#hit-feedback")).toContainText("명중");
    await expect(a.locator("#hit-feedback")).toContainText("장갑 비관통");
    await a.screenshot({
      path: "artifacts/browser-confirmed-nonpenetration.png",
    });
    await a.keyboard.press("2");
    await expect
      .poll(async () => (await state(a)).self.input.weapon)
      .toBe("AP");
    await fixture(room, { advance: 13 });
    await fixture(room, {
      players: [
        {
          id: B,
          x: 250,
          z: -700,
          heading: 0,
          speed: 0,
          // Low enough that a single overpenetration of the upper side sinks it.
          hp: 400,
          status: { protection: 0, fire: [0, 0] },
        },
      ],
    });
    await a.mouse.dblclick(mousePositions.get(a)!.x, mousePositions.get(a)!.y);
    // Change camera during flight, without re-aiming the salvo.
    await a.keyboard.press("Shift");
    await expect
      .poll(() => a.evaluate(() => window.__IRON_TIDE__.view.binocular))
      .toBe(true);
    const zoomAim = await a.evaluate(() => window.__IRON_TIDE__.view.aim);
    expect(Math.hypot(before.x - zoomAim.x, before.z - zoomAim.z)).toBeLessThan(
      1.5,
    );
    await expect(a.locator("#hit-feedback")).toContainText("피해");
    await expect
      .poll(
        () =>
          [...eventLog.get(a)!.values()].some(
            (e) => e.type === "sink" && e.owner === A && e.target === B,
          ),
        { timeout: 12000 },
      )
      .toBe(true);
    await expect
      .poll(() =>
        a.evaluate(() => window.__IRON_TIDE__.view.graphics.wrecks.halves),
      )
      .toBe(2);
    await a.screenshot({ path: "artifacts/browser-hit-split-sinking.png" });
    expect(errors).toEqual([]);
  } finally {
    for (const c of contexts) await c.close();
  }
});

test("original GLB surface matches server collision, and both detailed halves sink independently", async ({
  page,
}) => {
  test.setTimeout(120000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.route("**/__surface-preview", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<body style="margin:0"><div id="scene"></div></body>',
    }),
  );
  await page.goto("/__surface-preview");
  const rays = await page.evaluate(async () => {
    const modulePath = "/client/scene.ts",
      threePath = "/node_modules/three/build/three.module.js";
    const { SeaScene, createShip } = await import(modulePath),
      THREE = await import(threePath);
    const scene = new SeaScene(document.querySelector("#scene"));
    scene.preview.root.visible = false;
    const rows: any[] = [];
    for (const variant of ["camouflage", "wisconsin-golden"]) {
      const ship = createShip("battleship", "#edc083", true, variant);
      await new Promise<void>((resolve, reject) => {
        const start = performance.now();
        const poll = () => {
          if (ship.root.userData.npcModel === "ready") resolve();
          else if (performance.now() - start > 30000)
            reject(Error("GLB load timeout"));
          else setTimeout(poll, 30);
        };
        poll();
      });
      ship.root.updateMatrixWorld(true);
      const mesh = ship.root.getObjectByName("npc-imported-hull");
      for (const y of [1, 2.5, 14])
        for (const z of [-18, 0, 14]) {
          const ray = new THREE.Raycaster(
            new THREE.Vector3(-100, y, z),
            new THREE.Vector3(1, 0, 0),
          );
          const hit = ray.intersectObject(mesh, true)[0];
          rows.push({
            variant,
            y,
            z,
            point: hit
              ? { x: hit.point.x, y: hit.point.y, z: hit.point.z }
              : null,
          });
        }
      if (variant === "wisconsin-golden") {
        const wreckPath = "/client/wrecks.ts",
          fxPath = "/client/combatFx.ts";
        const { Wrecks } = await import(wreckPath),
          { CombatEffects, smokeTexture } = await import(fxPath);
        ship.root.position.set(-210, 0, -650);
        scene.scene.add(ship.root);
        ship.root.updateMatrixWorld(true);
        const wrecks = new Wrecks(scene.scene, smokeTexture),
          fx = new CombatEffects(scene.scene);
        const event = { id: 900, at: 0, type: "sink", x: -210, z: -650 };
        wrecks.spawn(event, ship.root, 76, 15, [ship.wake, ship.fire]);
        ship.root.visible = false;
        fx.event(event);
        (window as any).__surface = { scene, wrecks, fx };
      }
    }
    return rows;
  });
  for (const row of rays) {
    const s = makeShip("NPC", "NPC", "battleship");
    Object.assign(s, {
      x: 0,
      z: 0,
      heading: 0,
      bot: true,
      npcModel: row.variant,
    });
    const hit = intersectShip(
      { x: -100, y: row.y, z: row.z },
      { x: 100, y: row.y, z: row.z },
      s,
    );
    expect(!!hit).toBe(!!row.point);
    if (hit && row.point) expect(hit.point.x).toBeCloseTo(row.point.x, 2);
  }
  for (const [name, delta] of [
    ["explosion", 1],
    ["breakup", 3],
    ["submerged", 4],
  ] as const) {
    await page.evaluate((delta) => {
      const { scene, wrecks, fx } = (window as any).__surface;
      wrecks.update(delta, true);
      fx.update(delta, null, false);
      scene.camera.position.set(-152, 24, -584);
      scene.camera.lookAt(-210, -1, -650);
      scene.renderer.render(scene.scene, scene.camera);
    }, delta);
    await page.screenshot({ path: `artifacts/wisconsin-sinking-${name}.png` });
  }
  expect(errors).toEqual([]);
});

test("damage popups are 72px, color by damage, stack independently and last three seconds", async ({
  page,
}) => {
  await page.route("**/__damage-preview", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: '<link rel="stylesheet" href="/client/style.css"><body style="background:#112635"><div id="hit-feedback"></div><div id="hit-history"></div><div id="hit-marker"></div><div id="hit-floats"></div></body>',
    }),
  );
  await page.goto("/__damage-preview");
  await page.evaluate(async () => {
    const path = "/client/hitFeedback.ts",
      { HitFeedback } = await import(path);
    const q = (id: string) => document.getElementById(id)!;
    const h = new HitFeedback(
      q("hit-feedback"),
      q("hit-history"),
      q("hit-marker"),
      q("hit-floats"),
    );
    const p = {
      id: 1,
      at: 1,
      type: "hit",
      x: 0,
      z: 0,
      target: "enemy",
      weapon: "AP",
      result: "penetration",
      damage: 900,
      zone: "side",
      armor: 100,
      angle: 20,
    };
    h.record(p, "적 순양함");
    h.record({ ...p, id: 2, at: 1.3, damage: 3500 }, "적 순양함");
    h.record(
      { ...p, id: 3, at: 1.6, damage: 6500, result: "citadel" },
      "적 순양함",
    );
    (window as any).__damage = h;
    setInterval(() => h.render(() => ({ x: 530, y: 570, visible: true })), 30);
  });
  await expect(page.locator(".hit-float:visible")).toHaveCount(3);
  const sizes = await page.locator(".hit-float").evaluateAll((es) =>
    es.map((e) => ({
      size: parseFloat(getComputedStyle(e).fontSize),
      top: parseFloat((e as HTMLElement).style.top),
      tier: (e as HTMLElement).dataset.tier,
    })),
  );
  expect(sizes.every((s) => s.size >= 70)).toBe(true);
  expect(new Set(sizes.map((s) => s.tier)).size).toBe(3);
  expect(new Set(sizes.map((s) => s.top)).size).toBe(3);
  await page.screenshot({ path: "artifacts/browser-damage-stacking.png" });
  await page.waitForTimeout(2000);
  await expect(page.locator(".hit-float")).toHaveCount(3);
  await expect(page.locator(".hit-float")).toHaveCount(0, { timeout: 2000 });
});
