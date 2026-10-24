import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { emptyLedger, Game } from "./game";
import type { BotSkill } from "./bots";
import { AccountStore, type Account } from "./accounts";
import { WalletAuth } from "./walletAuth";
import { MetanomicClient, metanomicConfig } from "./metanomic";
import { RewardQueue } from "./rewardQueue";
import { AutoRewards } from "./autoRewards";
import { AdminSetup, createAdminRoutes } from "./adminRoutes";
import {
  cleanName,
  createAuthRoutes,
  readCookie,
  SESSION_COOKIE,
} from "./authRoutes";
import { RULES, HULLS, UPGRADE_KEYS } from "../shared/config";
import type {
  ClientMessage,
  Hull,
  ServerMessage,
  Upgrade,
} from "../shared/types";

const port = Number(process.env.PORT ?? 3000),
  root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist");
const rooms = new Map<string, Game>();
// Wallet accounts persist across restarts; ACCOUNT_DB=":memory:" for throwaway runs.
const accounts = new AccountStore(
  process.env.ACCOUNT_DB ??
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../data/iron-tide.sqlite",
    ),
);
// Chain named in the sign-in message; Ronin Saigon testnet unless configured.
const chainId = Number(process.env.GAME_CHAIN_ID ?? 2021);
const walletAuth = new WalletAuth(accounts, chainId);
const authRoutes = createAuthRoutes(accounts, walletAuth);
// CGC rewards are paid only when the Metanomic game credentials are configured.
const metanomicSettings = metanomicConfig();
const metanomic = metanomicSettings
  ? new MetanomicClient(metanomicSettings)
  : null;
const rewardQueue = new RewardQueue(accounts.db, metanomic);
const autoRewards = new AutoRewards(accounts, rewardQueue, metanomic);
const adminSetup = new AdminSetup(accounts);
const adminRoutes = createAdminRoutes(
  accounts,
  walletAuth,
  adminSetup,
  rewardQueue,
  metanomic,
  autoRewards,
);
/** Matches already written to account records, so results are counted once. */
const recorded = new WeakSet<Game>();
function recordResults(g: Game) {
  const ranking = g.ranking();
  const match = accounts.saveMatch(
    g.code,
    g.mode,
    ranking.map((ship, place) => {
      const npcSkill = g.botSkill(ship.id);
      return {
        accountId: g.accounts.get(ship.id) ?? null,
        name: ship.name,
        hull: ship.hull,
        place: place + 1,
        kills: ship.stats.kills,
        deaths: ship.stats.deaths,
        damage: Math.round(ship.stats.damage),
        score: Math.floor(ship.stats.score),
        ...(npcSkill ? { npcSkill } : {}),
        ledger: g.ledger.get(ship.id) ?? emptyLedger(),
      };
    }),
    Math.round(g.time),
  );
  ranking.forEach((ship, place) => {
    const account = g.accounts.get(ship.id);
    if (!account) return;
    accounts.recordMatch(account, {
      kills: ship.stats.kills,
      deaths: ship.stats.deaths,
      damage: ship.stats.damage,
      won: place === 0,
    });
  });
  // Failures are logged inside settle(); the match itself is already saved.
  void autoRewards.settle(match).catch(() => {});
}
type Session = {
  id: string;
  token: string;
  room: string;
  ws: WebSocket | null;
  lastActive: number;
  messages: number;
  window: number;
};
const sessions = new Map<string, Session>();
const send = (ws: WebSocket, msg: ServerMessage) => {
  if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 512_000)
    ws.send(JSON.stringify(msg));
};
const fail = (ws: WebSocket, message: string) =>
  send(ws, { type: "error", message });
const broadcast = (g: Game) => {
  for (const session of sessions.values())
    if (session.room === g.code && session.ws) send(session.ws, g.lobby());
};
const nameOf = (name: unknown) =>
  typeof name === "string"
    ? name
        .trim()
        .replace(/[<>\x00-\x1f]/g, "")
        .slice(0, 18) || "함장"
    : "함장";
function detach(s: Session) {
  const g = rooms.get(s.room),
    ship = g?.players.get(s.id);
  if (ship) {
    ship.connected = false;
    ship.disconnectedAt = Date.now();
    ship.input.firing = false;
  }
  s.ws = null;
  s.lastActive = Date.now();
  if (g) {
    if (g.host === s.id)
      g.host =
        [...g.players.values()].find((p) => p.connected && !p.bot)?.id ?? s.id;
    broadcast(g);
  }
}
function leave(s: Session) {
  const g = rooms.get(s.room);
  g?.remove(s.id);
  sessions.delete(s.token);
  if (g) {
    if ([...g.players.values()].some((p) => !p.bot)) broadcast(g);
    else rooms.delete(g.code);
  }
}

const server = http.createServer(async (req, res) => {
  if (req.url === "/health") {
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({ ok: true, rooms: rooms.size, players: sessions.size }),
    );
    return;
  }
  if (await adminRoutes(req, res)) return;
  if (await authRoutes(req, res)) return;
  // Test-only fixture control: absent unless explicitly enabled, protected by a per-run secret.
  if (
    process.env.NODE_ENV !== "production" &&
    process.env.E2E_SECRET &&
    req.url === "/__test__/fixture" &&
    req.method === "POST" &&
    req.headers["x-e2e-secret"] === process.env.E2E_SECRET
  ) {
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 10000) {
        res.writeHead(413);
        res.end();
        return;
      }
    }
    try {
      const data = JSON.parse(body),
        g = rooms.get(data.room);
      if (!g) throw Error("room not found");
      if (data.players)
        for (const update of data.players) {
          const s = g.players.get(update.id);
          if (!s) continue;
          for (const k of [
            "x",
            "z",
            "heading",
            "hp",
            "speed",
            "points",
            "level",
            "xp",
            "bloom",
            "torpedoReload",
          ] as const)
            if (Number.isFinite(update[k])) (s[k] as number) = update[k];
          if (update.status) Object.assign(s.status, update.status);
          if (update.aim) s.input.aim = update.aim;
          if (update.turrets) s.turrets = update.turrets;
        }
      if (data.advance)
        for (let i = 0; i < data.advance * RULES.tick; i++)
          g.step(1 / RULES.tick);
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({ time: g.time, players: [...g.players.values()] }),
      );
    } catch (e) {
      res.writeHead(400);
      res.end(String(e));
    }
    return;
  }
  if (req.url?.startsWith("/__test__/")) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" });
    res.end("Method not allowed");
    return;
  }
  if (process.env.NODE_ENV !== "production") {
    res.writeHead(404);
    res.end("Run the frontend at http://localhost:5173");
    return;
  }
  try {
    const pathname = decodeURIComponent(
        new URL(req.url ?? "/", "http://localhost").pathname,
      ),
      candidate = path.resolve(root, "." + pathname);
    if (candidate !== root && !candidate.startsWith(root + path.sep)) {
      res.writeHead(403);
      res.end();
      return;
    }
    const page = pathname === "/admin" ? "admin.html" : "index.html";
    const file = path.extname(candidate) ? candidate : path.join(root, page),
      data = await readFile(file);
    const mime: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript",
      ".css": "text/css",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".wav": "audio/wav",
      ".ogg": "audio/ogg",
      ".glb": "model/gltf-binary",
      ".woff2": "font/woff2",
    };
    res.setHeader(
      "Content-Type",
      mime[path.extname(file)] ?? "application/octet-stream",
    );
    res.setHeader("Content-Length", data.length);
    res.end(req.method === "HEAD" ? undefined : data);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
});
const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 4096 });
wss.on("connection", (ws, req) => {
  // Permit LAN hosting and the Vite proxy, but reject cross-site browser WebSocket requests.
  const origin = req.headers.origin;
  if (origin) {
    try {
      const url = new URL(origin),
        host = new URL(`http://${req.headers.host ?? ""}`).hostname;
      if (
        url.hostname !== host &&
        !(url.hostname === "localhost" && host === "127.0.0.1") &&
        !(url.hostname === "127.0.0.1" && host === "localhost")
      ) {
        ws.close(1008, "Origin mismatch");
        return;
      }
    } catch {
      ws.close(1008);
      return;
    }
  }
  let current: Session | undefined;
  let preAuthCount = 0;
  // The wallet session cookie travels with the WebSocket upgrade request.
  const account: Account | undefined = accounts.accountForToken(
    readCookie(req.headers.cookie, SESSION_COOKIE),
  );
  ws.on("message", (raw) => {
    try {
      const m = JSON.parse(raw.toString()) as ClientMessage;
      if (!m || typeof m !== "object" || typeof m.type !== "string") return;
      if (current) {
        const now = Date.now();
        if (now - current.window > 1000) {
          current.messages = 0;
          current.window = now;
        }
        if (++current.messages > 90) {
          ws.close(1008, "Rate limit");
          return;
        }
        current.lastActive = now;
      } else if (++preAuthCount > 10) {
        ws.close(1008);
        return;
      }
      if (m.type === "ping") {
        send(ws, { type: "pong", at: m.at });
        return;
      }
      if (m.type === "resume") {
        if (current) return;
        const s = sessions.get(m.token),
          g = s && rooms.get(s.room);
        if (
          !s ||
          s.room !== m.room ||
          !g ||
          !g.players.has(s.id) ||
          Date.now() - s.lastActive > RULES.reconnect * 1000
        ) {
          fail(ws, "재접속 시간이 지났습니다. 새로 참가해 주세요.");
          return;
        }
        if (s.ws && s.ws !== ws) {
          fail(ws, "다른 창에서 이미 접속 중입니다.");
          return;
        }
        s.ws = ws;
        s.lastActive = Date.now();
        current = s;
        g.players.get(s.id)!.connected = true;
        send(ws, { type: "welcome", id: s.id, token: s.token, room: s.room });
        broadcast(g);
        return;
      }
      if (m.type === "create" || m.type === "join") {
        if (current) {
          fail(ws, "이미 함대에 참가했습니다.");
          return;
        }
        let g: Game;
        if (m.type === "create") {
          if (rooms.size >= 100) throw Error("현재 함대가 가득 찼습니다.");
          let code;
          do {
            code = randomBytes(3).toString("hex").toUpperCase();
          } while (rooms.has(code));
          g = new Game(code);
          rooms.set(code, g);
        } else {
          const code = String(m.room).trim().toUpperCase();
          const found = rooms.get(code);
          if (!found) throw Error("함대 코드를 찾을 수 없습니다.");
          g = found;
        }
        const id = randomBytes(6).toString("hex"),
          token = randomBytes(24).toString("hex");
        // Signed-in captains keep their account name unless they type a new one.
        const typed = cleanName(m.name);
        if (account && typed && typed !== account.name) {
          accounts.rename(account.id, typed);
          account.name = typed;
        }
        g.add(id, account ? account.name : nameOf(m.name), account?.id);
        current = {
          id,
          token,
          room: g.code,
          ws,
          lastActive: Date.now(),
          messages: 0,
          window: Date.now(),
        };
        sessions.set(token, current);
        send(ws, { type: "welcome", id, token, room: g.code });
        broadcast(g);
        return;
      }
      if (!current) {
        fail(ws, "먼저 함대에 참가해 주세요.");
        return;
      }
      const g = rooms.get(current.room),
        s = g?.players.get(current.id);
      if (!g || !s) return;
      switch (m.type) {
        case "addBot":
          g.addBot(
            s.id,
            m.hull,
            m.model,
            m.skill === undefined ? undefined : (m.skill as BotSkill),
          );
          broadcast(g);
          break;
        case "mode":
          g.setMode(s.id, m.mode);
          broadcast(g);
          break;
        case "removeBot":
          g.removeBot(s.id, m.id);
          broadcast(g);
          break;
        case "select":
          if (Object.hasOwn(HULLS, m.hull)) g.select(s.id, m.hull as Hull);
          broadcast(g);
          break;
        case "ready":
          if (g.phase === "lobby") {
            m.ready === true ? g.ready.add(s.id) : g.ready.delete(s.id);
            broadcast(g);
          }
          break;
        case "start":
          g.start(s.id);
          broadcast(g);
          break;
        case "input":
          g.setInput(s.id, m.input);
          break;
        case "salvo":
          g.fire(s.id, true);
          break;
        case "ability":
          if (["dcp", "special"].includes(m.ability))
            g.ability(s.id, m.ability);
          break;
        case "upgrade":
          if (UPGRADE_KEYS.includes(m.upgrade as Upgrade))
            g.upgrade(s.id, m.upgrade);
          break;
        case "secondary":
          s.secondaries = !s.secondaries;
          break;
        case "rematch":
          g.rematch(s.id);
          broadcast(g);
          break;
        case "leave":
          leave(current);
          current = undefined;
          send(ws, { type: "left" });
          break;
      }
    } catch (e) {
      fail(ws, e instanceof Error ? e.message : "잘못된 요청입니다.");
    }
  });
  ws.on("close", () => {
    if (current && current.ws === ws) detach(current);
  });
  ws.on("error", () => {});
});
let last = performance.now(),
  acc = 0,
  snapshotClock = 0;
const timer = setInterval(() => {
  const now = performance.now();
  acc += Math.min((now - last) / 1000, 0.25);
  last = now;
  while (acc >= 1 / RULES.tick) {
    for (const g of rooms.values()) g.step(1 / RULES.tick);
    acc -= 1 / RULES.tick;
  }
  for (const g of rooms.values()) {
    if (g.phase === "results" && !recorded.has(g)) {
      recorded.add(g);
      recordResults(g);
    } else if (g.phase !== "results") recorded.delete(g);
  }
  snapshotClock++;
  if (snapshotClock % 2 === 0)
    for (const session of sessions.values()) {
      const g = rooms.get(session.room);
      if (g && session.ws && g.phase !== "lobby" && g.players.has(session.id))
        send(session.ws, g.snapshot(session.id));
    }
  for (const s of sessions.values())
    if (!s.ws && Date.now() - s.lastActive > RULES.reconnect * 1000) leave(s);
}, 1000 / RULES.tick);
const rewardTimer = setInterval(() => void rewardQueue.tick(), 3000);
server.listen(port, "0.0.0.0", () => {
  console.log(`IRON TIDE server · http://localhost:${port}`);
  console.log(
    metanomic
      ? `Metanomic 보상 연동 · 게임 ${metanomic.config.gameId}`
      : "Metanomic 미설정 · 보상은 대기열에 저장만 됩니다 (METANOMIC_API_URL / GAME_ID / GAME_KEY)",
  );
  if (adminSetup.code)
    console.log(
      [
        "",
        "  ┌───────────────────────────────────────────────┐",
        `  │  관리자 등록 코드: ${adminSetup.code}`,
        "  │  관리자 메뉴(/admin) 첫 화면에 입력하세요.",
        "  └───────────────────────────────────────────────┘",
        "",
      ].join("\n"),
    );
});
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    clearInterval(timer);
    clearInterval(rewardTimer);
    accounts.close();
    for (const ws of wss.clients) ws.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  });
