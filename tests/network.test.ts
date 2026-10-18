import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { WebSocket } from "ws";
import type { ServerMessage, ClientMessage } from "../shared/types";

const url = "ws://127.0.0.1:3108/ws";
let server: ChildProcess;
class Peer {
  messages: ServerMessage[] = [];
  constructor(public ws: WebSocket) {
    ws.on("message", (data) => this.messages.push(JSON.parse(data.toString())));
  }
  send(message: ClientMessage) {
    this.ws.send(JSON.stringify(message));
  }
  async wait<T extends ServerMessage["type"]>(
    type: T,
    predicate: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true,
  ): Promise<Extract<ServerMessage, { type: T }>> {
    const end = Date.now() + 5000;
    while (Date.now() < end) {
      const found = this.messages.find(
        (m) =>
          m.type === type &&
          predicate(m as Extract<ServerMessage, { type: T }>),
      );
      if (found) return found as Extract<ServerMessage, { type: T }>;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw Error(`Missing server message: ${type}`);
  }
  async close() {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      this.ws.once("close", () => resolve());
      this.ws.close();
    });
  }
}
async function peer() {
  const ws = new WebSocket(url);
  const p = new Peer(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return p;
}
beforeAll(async () => {
  server = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    env: { ...process.env, PORT: "3108", E2E_SECRET: "" },
    stdio: "ignore",
  });
  for (let n = 0; n < 100; n++) {
    try {
      const res = await fetch("http://127.0.0.1:3108/health");
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 40));
  }
  throw Error("Network test server did not start");
});
afterAll(async () => {
  if (server && !server.killed) {
    server.kill("SIGTERM");
    await new Promise<void>((resolve) => server.once("exit", () => resolve()));
  }
});
describe("real WebSocket authority and session lifecycle", () => {
  it("allows a host to manage NPCs, reserves slots, and transfers command only to humans", async () => {
    const a = await peer(),
      b = await peer(),
      c = await peer();
    try {
      a.send({ type: "create", name: "NPC 테스트" });
      const first = await a.wait("welcome");
      a.send({ type: "addBot", hull: "battleship" });
      const lobby = await a.wait("lobby", (m) => m.players.some((p) => p.bot));
      const bot = lobby.players.find((p) => p.bot)!;
      expect(bot.ready).toBe(true);
      b.send({ type: "join", room: first.room, name: "부함장" });
      const second = await b.wait("welcome");
      b.send({ type: "removeBot", id: bot.id });
      expect(
        (await b.wait("error", (m) => m.message.includes("제외"))).message,
      ).toContain("함대장");
      b.send({ type: "addBot", hull: "destroyer" });
      expect(
        (await b.wait("error", (m) => m.message.includes("추가"))).message,
      ).toContain("함대장");
      a.send({ type: "addBot", hull: "destroyer" });
      const full = await a.wait("lobby", (m) => m.players.length === 4);
      c.send({ type: "join", room: first.room, name: "C" });
      expect((await c.wait("error")).message).toContain("정원");
      const other = full.players.find((p) => p.bot && p.id !== bot.id)!;
      a.send({ type: "removeBot", id: other.id });
      await b.wait(
        "lobby",
        (m) =>
          m.players.length === 3 && !m.players.some((p) => p.id === other.id),
      );
      await a.close();
      await b.wait("lobby", (m) => m.host === second.id);
      b.send({ type: "ready", ready: true });
      // The disconnected human must still prevent launch until removed/reconnected.
      b.send({ type: "start" });
      expect(
        (await b.wait("error", (m) => m.message.includes("준비"))).message,
      ).toContain("준비");
    } finally {
      await a.close();
      await b.close();
      await c.close();
    }
  });
  it("deletes an NPC-only room when the last human explicitly leaves", async () => {
    const a = await peer(),
      b = await peer();
    try {
      a.send({ type: "create", name: "H" });
      const room = (await a.wait("welcome")).room;
      a.send({ type: "addBot", hull: "cruiser" });
      await a.wait("lobby", (m) => m.players.length === 2);
      a.send({ type: "leave" });
      await a.wait("left");
      b.send({ type: "join", room, name: "B" });
      expect((await b.wait("error")).message).toContain("찾을 수 없");
    } finally {
      await a.close();
      await b.close();
    }
  });
  it("starts a room, rejects unauthorized start/join, restores identity and transfers host", async () => {
    const a = await peer(),
      b = await peer(),
      late = await peer();
    let resumed: Peer | undefined;
    try {
      a.send({ type: "create", name: "A" });
      const first = await a.wait("welcome");
      b.send({ type: "join", name: "B", room: first.room });
      const second = await b.wait("welcome");
      b.send({ type: "start" });
      expect((await b.wait("error")).message).toContain("함대장");
      b.send({ type: "select", hull: "destroyer" });
      a.send({ type: "ready", ready: true });
      b.send({ type: "ready", ready: true });
      await a.wait(
        "lobby",
        (m) => m.players.length === 2 && m.players.every((s) => s.ready),
      );
      a.send({ type: "start" });
      const snap = await b.wait("snapshot");
      expect(snap.self.hull).toBe("destroyer");
      expect(snap.phase).toBe("battle");
      late.send({ type: "join", room: first.room, name: "Late" });
      expect((await late.wait("error")).message).toContain("이미 출항");
      await a.close();
      await b.wait("lobby", (m) => m.host === second.id);
      resumed = await peer();
      resumed.send({ type: "resume", room: first.room, token: first.token });
      expect((await resumed.wait("welcome")).id).toBe(first.id);
      expect((await resumed.wait("snapshot")).self.connected).toBe(true);
    } finally {
      await a.close();
      await b.close();
      await late.close();
      await resumed?.close();
    }
  });
  it("rejects forged reconnect tokens and cross-site WebSocket origins", async () => {
    const p = await peer();
    try {
      p.send({ type: "resume", room: "FAKE", token: "fake" });
      expect((await p.wait("error")).message).toContain("재접속");
    } finally {
      await p.close();
    }
    const bad = new WebSocket(url, {
      headers: { Origin: "https://unrelated.invalid" },
    });
    const code = await new Promise<number>((resolve, reject) => {
      bad.once("close", resolve);
      bad.once("error", reject);
    });
    expect(code).toBe(1008);
  });
  it("does not expose test fixtures in normal execution", async () => {
    const res = await fetch("http://127.0.0.1:3108/__test__/fixture", {
      method: "POST",
      headers: { "x-e2e-secret": "local-browser-verification" },
      body: "{}",
    });
    expect(res.status).toBe(404);
  });
});
