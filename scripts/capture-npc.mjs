import { chromium } from "@playwright/test";
const variant = process.argv[2] ?? "camouflage";
const browser = await chromium.launch({
  headless: true,
  args: ["--enable-unsafe-swiftshader"],
});
try {
  const page = await browser.newPage({
    viewport: { width: 1500, height: 950 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.route("**/__npc-preview", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<body style="margin:0"><div id="scene"></div></body>',
    }),
  );
  await page.goto("http://localhost:5173/__npc-preview");
  await page.evaluate(async (variant) => {
    const { SeaScene, createShip } = await import("/client/scene.ts");
    const sea = new SeaScene(document.querySelector("#scene"));
    const lights = sea.scene.children.filter((o) => o.isLight);
    sea.scene.clear();
    sea.scene.add(...lights);
    const ship = createShip("battleship", "#edc083", true, variant);
    sea.scene.add(ship.root);
    window.__npcPreview = { sea, ship };
  }, variant);
  await page.waitForFunction(
    () => window.__npcPreview.ship.root.userData.npcModel === "ready",
    { timeout: 30000 },
  );
  for (const [name, position] of [
    ["bow", [75, 38, 80]],
    ["stern", [-70, 42, -85]],
    ["side", [90, 25, 0]],
  ]) {
    await page.evaluate(
      ({ position }) => {
        const { sea } = window.__npcPreview;
        sea.camera.position.set(...position);
        sea.camera.lookAt(0, 5, 0);
        sea.camera.fov = 45;
        sea.camera.updateProjectionMatrix();
        sea.renderer.render(sea.scene, sea.camera);
      },
      { position },
    );
    await page.screenshot({ path: `artifacts/npc-${variant}-${name}.png` });
  }
  console.log(
    JSON.stringify({
      errors,
      model: await page.evaluate(() => window.__npcPreview.ship.root.userData),
    }),
  );
  if (errors.length) process.exitCode = 1;
} finally {
  await browser.close();
}
