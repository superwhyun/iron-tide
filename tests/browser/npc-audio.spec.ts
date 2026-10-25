import { test, expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { state, fixture, control, aimAt, mousePositions } from "./helpers";

declare global {
  interface Window {
    __mixProbe: {
      context: AudioContext;
      recorder: MediaRecorder;
      chunks: Blob[];
      levels: { at: number; rms: number; peak: number }[];
    };
  }
}
test("solo NPC match: imported armed ship, live AI, torpedo sound, speed audio and radio orders", async ({
  page,
}) => {
  test.setTimeout(180000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.addInitScript(() => {
    const proto = AudioNode.prototype as unknown as {
      connect: (destination: AudioNode, ...args: unknown[]) => AudioNode;
    };
    const original = proto.connect;
    proto.connect = function (this: AudioNode, destination, ...args) {
      if (destination instanceof AudioDestinationNode && !window.__mixProbe) {
        const context = this.context as AudioContext,
          sink = context.createMediaStreamDestination(),
          analyser = context.createAnalyser();
        analyser.fftSize = 2048;
        original.call(this, analyser);
        original.call(analyser, sink);
        const recorder = new MediaRecorder(sink.stream, {
          mimeType: "audio/webm;codecs=opus",
        });
        const probe = (window.__mixProbe = {
          context,
          recorder,
          chunks: [] as Blob[],
          levels: [] as { at: number; rms: number; peak: number }[],
        });
        recorder.ondataavailable = (e) => probe.chunks.push(e.data);
        recorder.start();
        const samples = new Float32Array(analyser.fftSize);
        setInterval(() => {
          analyser.getFloatTimeDomainData(samples);
          let energy = 0,
            peak = 0;
          for (const v of samples) {
            energy += v * v;
            peak = Math.max(peak, Math.abs(v));
          }
          probe.levels.push({
            at: context.currentTime,
            rms: Math.sqrt(energy / samples.length),
            peak,
          });
        }, 25);
      }
      return original.call(this, destination, ...args);
    };
  });
  await page.goto("/");
  await page.locator("#create-room").click();
  await expect(page.locator("#lobby-code")).not.toBeEmpty();
  const room = await page.locator("#lobby-code").innerText();
  for (const hull of ["wisconsin-golden", "destroyer", "cruiser"]) {
    await page.locator("#bot-hull").selectOption(hull);
    await page.locator("#add-bot").click();
  }
  await expect(page.locator(".player-row")).toHaveCount(4);
  await expect(page.locator("#player-list")).toContainText("Wisconsin Golden");
  // Fill the fleet to its eight-ship limit.
  await page.locator("#bot-hull").selectOption("destroyer");
  for (let i = 0; i < 4; i++) await page.locator("#add-bot").click();
  await expect(page.locator(".player-row")).toHaveCount(8);
  await expect(page.locator("#add-bot")).toBeDisabled();
  await page.screenshot({ path: "artifacts/browser-npc-lobby.png" });
  for (let left = 7; left >= 2; left--) {
    await page.locator("[data-remove-bot]").last().click();
    await expect(page.locator(".player-row")).toHaveCount(left);
  }
  await page.locator("#ready").click();
  await page.locator("#start").click();
  await expect(page.locator("#battle")).toBeVisible();
  await expect.poll(async () => (await state(page))?.scores.length).toBe(2);
  const self = (await state(page)).self.id,
    npc = (await state(page)).scores.find((p) => p.bot)!;
  await fixture(room, {
    players: [
      { id: self, x: -250, z: -700, heading: 0, speed: 0 },
      { id: npc.id, x: 250, z: -700, heading: 0, speed: 0 },
    ],
  });
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          window.__IRON_TIDE__.view.graphics.npcModels.some(
            (m) =>
              m.status === "ready" &&
              m.turrets === 3 &&
              m.variant === "wisconsin-golden",
          ),
        ),
      { timeout: 30000 },
    )
    .toBe(true);
  await control(page);
  await aimAt(page, 250, -700);
  await page.keyboard.press("Shift");
  await aimAt(page, 250, -700);
  await page.screenshot({ path: "artifacts/browser-npc-battle.png" });
  await expect
    .poll(
      async () =>
        (await state(page)).events.some(
          (e) => e.type === "shot" && e.owner === npc.id,
        ),
      { timeout: 20000 },
    )
    .toBe(true);
  expect(
    (await state(page)).contacts.find((p) => p.id === npc.id)?.speed,
  ).toBeGreaterThan(0);
  // Move the opponent out of detection so subsequent output measurements isolate our own sounds.
  await fixture(room, {
    players: [
      { id: npc.id, x: 1200, z: 1200 },
      { id: self, x: -250, z: -700, speed: 0, heading: 0 },
    ],
  });
  await page.keyboard.press("Shift");
  await expect
    .poll(() => page.evaluate(() => window.__IRON_TIDE__.view.audio.ready))
    .toBe(true);
  await expect
    .poll(() =>
      page.evaluate(() => window.__IRON_TIDE__.view.audio.vessel.loops),
    )
    .toBe(2);
  await page.waitForTimeout(3500);
  const rms = () =>
    page.evaluate(() => {
      const levels = window.__mixProbe.levels.slice(-8);
      return levels.reduce((s, p) => s + p.rms, 0) / levels.length;
    });
  const idle = await rms();
  expect(idle).toBeGreaterThan(0.0005);
  await page.keyboard.press("3");
  await aimAt(page, 250, -700);
  await expect
    .poll(() =>
      page.evaluate(() =>
        Math.hypot(
          window.__IRON_TIDE__.view.aim.x - 250,
          window.__IRON_TIDE__.view.aim.z + 700,
        ),
      ),
    )
    .toBeLessThan(20);
  const torpedoAt = await page.evaluate(
    () => window.__mixProbe.context.currentTime,
  );
  await page.mouse.click(
    mousePositions.get(page)!.x,
    mousePositions.get(page)!.y,
  );
  await expect
    .poll(async () => (await state(page)).self.torpedoReload)
    .toBeGreaterThan(0);
  await expect
    .poll(() =>
      page.evaluate(() => window.__IRON_TIDE__.view.audio.torpedoesPlayed),
    )
    .toBe(1);
  await expect
    .poll(() =>
      page.evaluate(
        (at) =>
          Math.max(
            ...window.__mixProbe.levels
              .filter((l) => l.at > at)
              .map((l) => l.rms),
          ),
        torpedoAt,
      ),
    )
    .toBeGreaterThan(idle * 2);
  await page.waitForTimeout(3000);
  await page.keyboard.press("w");
  await expect
    .poll(() =>
      page.evaluate(() => window.__IRON_TIDE__.view.audio.radio.order),
    )
    .toBe("throttle-2");
  await expect(page.locator("#radio-transmission")).toContainText("미속 전진");
  await expect.poll(rms).toBeGreaterThan(0.02);
  await page.keyboard.press("s");
  await expect
    .poll(() =>
      page.evaluate(() => window.__IRON_TIDE__.view.audio.radio.order),
    )
    .toBe("throttle-1");
  await page.keyboard.down("d");
  await expect
    .poll(() =>
      page.evaluate(() => window.__IRON_TIDE__.view.audio.radio.order),
    )
    .toBe("helm-right");
  const spoken = await page.evaluate(
    () => window.__IRON_TIDE__.view.audio.radio.played,
  );
  await page.waitForTimeout(600);
  expect(
    await page.evaluate(() => window.__IRON_TIDE__.view.audio.radio.played),
  ).toBe(spoken);
  await page.keyboard.up("d");
  await expect
    .poll(() =>
      page.evaluate(() => window.__IRON_TIDE__.view.audio.radio.order),
    )
    .toBe("helm-center");
  await page.keyboard.down("a");
  await expect
    .poll(() =>
      page.evaluate(() => window.__IRON_TIDE__.view.audio.radio.order),
    )
    .toBe("helm-left");
  await page.keyboard.up("a");
  await page.keyboard.press("Escape");
  await page.locator("#radio").click();
  await control(page);
  const idleRate = await page.evaluate(
    () => window.__IRON_TIDE__.view.audio.vessel.engineRate,
  );
  for (let i = 0; i < 4; i++) await page.keyboard.press("w");
  await expect
    .poll(async () => (await state(page)).self.speed, { timeout: 18000 })
    .toBeGreaterThan(18);
  expect(
    await page.evaluate(
      () => window.__IRON_TIDE__.view.audio.vessel.engineRate,
    ),
  ).toBeGreaterThan(idleRate + 0.25);
  expect(
    await page.evaluate(() => window.__IRON_TIDE__.view.audio.vessel.wakeGain),
  ).toBeGreaterThan(0.25);
  await page.waitForTimeout(600);
  const full = await rms();
  expect(full).toBeGreaterThan(idle * 1.5);
  await page.keyboard.press("Escape");
  await page.locator("#radio").click();
  await control(page);
  await page.keyboard.press("s");
  await expect
    .poll(() =>
      page.evaluate(() => window.__IRON_TIDE__.view.audio.radio.order),
    )
    .toBe("slow-4");
  await page.keyboard.press("Escape");
  await page.locator("#sound").click();
  await expect.poll(rms).toBeLessThan(0.0001);
  await page.locator("#sound").click();
  await expect.poll(rms).toBeGreaterThan(0.001);
  await page.locator("#battle-leave").click();
  await expect(page.locator("#harbor")).toBeVisible();
  await expect.poll(rms).toBeLessThan(0.0001);
  const data = await page.evaluate(async () => {
    const { recorder, chunks, levels } = window.__mixProbe;
    await new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
      recorder.stop();
    });
    const bytes = new Uint8Array(
      await new Blob(chunks, { type: "audio/webm" }).arrayBuffer(),
    );
    let binary = "";
    for (let i = 0; i < bytes.length; i += 32768)
      binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return { encoded: btoa(binary), levels };
  });
  await writeFile(
    "artifacts/navigation-radio-mix.webm",
    Buffer.from(data.encoded, "base64"),
  );
  await writeFile(
    "artifacts/navigation-radio-levels.json",
    JSON.stringify({ idle, full, torpedoAt, levels: data.levels }),
  );
  console.log("Actual master-output RMS:", { idle, full });
  expect(errors).toEqual([]);
});
