import {
  expect,
  type Page,
  type Browser,
  type BrowserContext,
} from "@playwright/test";
import type { Snapshot, GameEvent } from "../../shared/types";
type View = {
  yaw: number;
  pitch: number;
  distance: number;
  binocular: boolean;
  aim: { x: number; z: number };
  fps: number;
  graphics: {
    particles: number;
    rounds: number;
    emitted: number;
    drawCalls: number;
    triangles: number;
    modelRevision: number;
    aimArea: {
      visible: boolean;
      radius: number;
      x: number;
      z: number;
      weapon: string;
      placement: boolean;
    };
    wrecks: { wrecks: number; halves: number; ages: number[] };
    npcModels: {
      id: string;
      status: string;
      turrets: number;
      variant: string;
    }[];
  };
  audio: {
    ready: boolean;
    recordedAssets: string[];
    activeVoices: number;
    shotsPlayed: number;
    volume: number;
    radioAssets: string[];
    torpedoesPlayed: number;
    vessel: {
      engineGain: number;
      wakeGain: number;
      engineRate: number;
      loops: number;
    };
    radio: {
      enabled: boolean;
      played: number;
      order: string | null;
      text: string;
      queued: number;
    };
  };
};
declare global {
  interface Window {
    __IRON_TIDE__: { state: Snapshot; room: { room: string }; view: View };
  }
}
const state = (p: Page) => p.evaluate(() => window.__IRON_TIDE__.state);
async function fixture(room: string, data: Record<string, unknown>) {
  const res = await fetch("http://127.0.0.1:3100/__test__/fixture", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-e2e-secret": "local-browser-verification",
    },
    body: JSON.stringify({ room, ...data }),
  });
  expect(res.ok).toBe(true);
  return res.json();
}
async function crew(browser: Browser, first = "cruiser", second = "destroyer") {
  const contexts: BrowserContext[] = [
    await browser.newContext(),
    await browser.newContext(),
  ];
  const [a, b] = await Promise.all(contexts.map((c) => c.newPage()));
  const errors: string[] = [];
  // Observe real server frames independently of slow software-rendered page tasks.
  const eventLog = new Map<Page, Map<number, GameEvent>>();
  for (const p of [a, b]) {
    const events = new Map<number, GameEvent>();
    eventLog.set(p, events);
    p.on("websocket", (socket) => {
      socket.on("framereceived", ({ payload }) => {
        const message = JSON.parse(payload.toString());
        if (message.type === "snapshot")
          for (const event of message.events) events.set(event.id, event);
      });
    });
    p.on("pageerror", (e) => errors.push(e.message));
    p.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
  }
  await a.goto("/");
  await b.goto("/");
  await a.locator("#captain-name").fill("청람 함장");
  await a.locator(`[data-hull=${first}]`).click();
  await a.locator("#create-room").click();
  await expect(a.locator("#lobby-code")).not.toBeEmpty();
  const room = await a.locator("#lobby-code").innerText();
  await b.locator("#captain-name").fill("해무 함장");
  await b.locator("#room-code").fill(room);
  await b.locator("#join-room").click();
  await expect(b.locator("#lobby-code")).toHaveText(room);
  await b.locator(`[data-hull=${second}]`).click();
  await expect(a.locator("#player-list .player-row")).toHaveCount(2);
  await a.locator("#ready").click();
  await b.locator("#ready").click();
  await expect(a.locator("#start")).toBeEnabled();
  await a.locator("#start").click();
  await expect(a.locator("#battle")).toBeVisible();
  await expect(b.locator("#battle")).toBeVisible();
  await expect.poll(async () => Boolean((await state(a))?.self)).toBe(true);
  return { a, b, room, contexts, errors, eventLog };
}
async function control(p: Page) {
  await p.bringToFront();
  await p.locator("#capture").click();
  await expect
    .poll(() => p.evaluate(() => Boolean(document.body.dataset.controls)))
    .toBe(true);
}
const mousePositions = new WeakMap<Page, { x: number; y: number }>();
async function aimAt(p: Page, x: number, z: number) {
  // Drive real mouse movement; diagnostics are read-only and never change simulation state.
  let cursor = mousePositions.get(p) ?? { x: 640, y: 400 };
  await p.mouse.move(cursor.x, cursor.y);
  await p.waitForTimeout(100);
  for (let n = 0; n < 3; n++) {
    const v = await p.evaluate(() => ({
      s: window.__IRON_TIDE__.state.self,
      v: window.__IRON_TIDE__.view,
    }));
    const d = Math.hypot(x - v.s.x, z - v.s.z);
    const yaw = Math.atan2(x - v.s.x, z - v.s.z);
    const diff = Math.atan2(Math.sin(yaw - v.v.yaw), Math.cos(yaw - v.v.yaw));
    const pitch = Math.atan2(
      v.v.binocular ? 18 : v.v.distance * 0.38 + 10,
      d + (v.v.binocular ? 25 : v.v.distance * 0.7),
    );
    const scale = v.v.binocular ? 0.00065 : 0.0025;
    cursor = {
      x: cursor.x - diff / scale,
      y: cursor.y + (pitch - v.v.pitch) / scale,
    };
    await p.mouse.move(cursor.x, cursor.y);
    await p.waitForTimeout(150);
  }
  mousePositions.set(p, cursor);
}

export { state, fixture, crew, control, aimAt, mousePositions };
