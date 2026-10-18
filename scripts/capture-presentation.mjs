import { chromium } from "@playwright/test";
import { writeFile } from "node:fs/promises";
const browser = await chromium.launch({
  headless: true,
  args: ["--enable-unsafe-swiftshader"],
});
try {
  const page = await browser.newPage({
      viewport: { width: 1600, height: 1000 },
    }),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text().slice(0, 250));
  });
  await page.addInitScript(() => {
    const original = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (destination, ...args) {
      if (destination instanceof AudioDestinationNode && !window.__recording) {
        const output = this.context.createMediaStreamDestination();
        original.call(this, output);
        const recorder = new MediaRecorder(output.stream, {
            mimeType: "audio/webm;codecs=opus",
          }),
          chunks = [];
        recorder.ondataavailable = (e) => chunks.push(e.data);
        recorder.start();
        window.__recording = { recorder, chunks };
      }
      return original.call(this, destination, ...args);
    };
  });
  await page.goto("http://localhost:5173");
  await page.waitForTimeout(2200);
  for (const hull of ["destroyer", "cruiser", "battleship"]) {
    await page.locator(`[data-hull=${hull}]`).click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `artifacts/realism-${hull}.png` });
  }
  await page.locator("#preview-salvo").click();
  await page.waitForTimeout(450);
  await page.screenshot({ path: "artifacts/realism-broadside.png" });
  await page.waitForTimeout(8500);
  const encoded = await page.evaluate(async () => {
    const { recorder, chunks } = window.__recording;
    await new Promise((resolve) => {
      recorder.onstop = resolve;
      recorder.stop();
    });
    const bytes = new Uint8Array(
      await new Blob(chunks, { type: "audio/webm" }).arrayBuffer(),
    );
    let s = "";
    for (let i = 0; i < bytes.length; i += 32768)
      s += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return btoa(s);
  });
  await writeFile(
    "artifacts/cannon-mix-preview.webm",
    Buffer.from(encoded, "base64"),
  );
  console.log(
    JSON.stringify({
      errors,
      diagnostics: await page.evaluate(() => window.__IRON_TIDE__.view),
    }),
  );
  if (errors.length) process.exitCode = 1;
} finally {
  await browser.close();
}
