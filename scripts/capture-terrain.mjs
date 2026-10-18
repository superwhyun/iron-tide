import { chromium } from "@playwright/test";

// Inspect the same SeaScene, terrain and lighting used by the game, without HUD occlusion.
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
  await page.route("**/__terrain-preview", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<body style="margin:0"><div id="scene"></div></body>',
    }),
  );
  await page.goto("http://localhost:5173/__terrain-preview");
  await page.evaluate(async () => {
    const { SeaScene } = await import("/client/scene.ts");
    const sea = new SeaScene(document.querySelector("#scene"));
    window.__terrainPreview = sea;
    sea.render(0.016, null, false);
    sea.camera.fov = 55;
    sea.camera.position.set(-150, 85, -215);
    sea.camera.lookAt(0, 16, 0);
    sea.camera.updateProjectionMatrix();
  });
  await page.waitForTimeout(1800);
  await page.evaluate(() => {
    const sea = window.__terrainPreview;
    sea.renderer.render(sea.scene, sea.camera);
  });
  await page.screenshot({ path: "artifacts/realism-island.png" });
  console.log(JSON.stringify({ errors }));
  if (errors.length) process.exitCode = 1;
} finally {
  await browser.close();
}
