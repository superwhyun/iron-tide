import { HitFeedback } from "./hitFeedback";
import { ScreenOverlay } from "./screenOverlay";
import { armorPreview, isShell } from "./armorPreview";
import { incomingSide, predictIncoming } from "./incoming";
import { zoneColor } from "./zoneVisuals";
import {
  fetchAccount,
  logout,
  signInWithWallet,
  WalletDiscovery,
  walletErrorMessage,
  type WalletChoice,
} from "./wallet";
import "./style.css";
import { SeaScene } from "./scene";
import { AudioBus } from "./audio";
import {
  HULLS,
  NPC_MODELS,
  ISLANDS,
  RULES,
  THROTTLE_LABELS,
  UPGRADE_INFO,
  UPGRADE_KEYS,
  xpRequired,
  respawnDelay,
} from "../shared/config";
import { angleDiff, bearing, clamp, dist, intercept } from "../shared/math";
import { shoreRadius } from "../shared/terrain";
import { aimSolution, gunRangeFor, ORDNANCE } from "../shared/ballistics";
import { POWERUPS } from "../shared/powerups";
import type {
  AccountView,
  Ammo,
  ClientMessage,
  Hull,
  BuffKind,
  GameMode,
  Lobby,
  ModuleKind,
  PickupKind,
  ServerMessage,
  Snapshot,
  Upgrade,
} from "../shared/types";

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const number = (n: number) => Math.round(n).toLocaleString("ko-KR");
const timer = (s: number) =>
  `${Math.floor(Math.max(0, s) / 60)
    .toString()
    .padStart(2, "0")}:${Math.floor(Math.max(0, s) % 60)
    .toString()
    .padStart(2, "0")}`;
const emblem = `<svg viewBox="0 0 40 40" fill="none" aria-hidden="true"><path d="M20 3v26M13 10h14M12 16a8 8 0 1 0 16 0M6 25c2 8 8 12 14 12s12-4 14-12M3 28l3-4 5 2m18 0 5-2 3 4" stroke="currentColor" stroke-width="2"/></svg>`;
const hullIcon = (h: Hull) =>
  `<svg viewBox="0 0 120 40" fill="none" aria-hidden="true"><path d="M5 23h106l-12 12H18L5 23Z" fill="currentColor" opacity=".8"/><path d="M34 23v-8h43v8M48 15V8h15v7M54 8V2M25 22v-5h11m45 5v-5h13" stroke="currentColor" stroke-width="3"/>${h === "battleship" ? '<path d="M21 16h17m44 0h20M30 12h8m44 0h14" stroke="currentColor" stroke-width="3"/>' : ""}</svg>`;
const COMPASS_PX = 3;
function compassTape() {
  const cardinal: Record<number, string> = {
    0: "N",
    90: "E",
    180: "S",
    270: "W",
  };
  let html = "";
  for (let d = -180; d <= 540; d += 5) {
    const deg = ((d % 360) + 360) % 360,
      left = (d + 180) * COMPASS_PX;
    const label =
      cardinal[deg] ?? (deg % 15 === 0 ? String(deg).padStart(3, "0") : "");
    html += `<i class="${deg % 15 === 0 ? "major" : ""}${cardinal[deg] ? " cardinal" : ""}" style="left:${left}px">${label ? `<span>${label}</span>` : ""}</i>`;
  }
  return html;
}
$("app").innerHTML = `
  <div id="sea"></div><div class="vignette"></div>
  <section id="harbor" aria-label="함대 대기실">
    <header class="harbor-header"><a class="brand" href="/">${emblem}<span>IRON TIDE<small>철의 해역</small></span></a><span class="header-coordinates">34° 28′ N &nbsp; 128° 41′ E <i></i> SOUTHERN ARCHIPELAGO</span><span class="header-actions"><a class="admin-link" href="/admin">관리자</a><button id="help" class="icon-button">조작 안내 <span>?</span></button></span></header>
    <div class="harbor-copy"><div class="eyebrow"><span class="tiny-line"></span> NAVAL COMBAT / ONLINE</div><h1>바다를 읽고,<br>전장을 지배하라<span>.</span></h1><p>묵직한 선회. 한 발의 판단.<br>당신의 함선으로 이 해역의 주인이 되세요.</p><div class="mode-chips"><span>2—4인 개인전</span><span>8분 전술 해전</span><span>경기 중 함선 성장</span></div>
      <div id="connect-form" class="connection-card"><div id="account-box" class="account-box" aria-live="polite"></div><label for="captain-name">함장 이름 <span>CALLSIGN</span></label><input id="captain-name" maxlength="18" placeholder="함장 이름을 입력하세요" value="함장" autocomplete="nickname"/><div class="connect-actions"><button id="create-room" class="primary">새 함대 창설 <span>↗</span></button><div class="join-row"><input id="room-code" maxlength="6" placeholder="함대 코드" aria-label="함대 코드"/><button id="join-room" class="outline">참가</button></div></div><small id="connection-note">계정 없이, 함대 코드를 공유해 친구와 출항하세요.</small></div>
      <div id="lobby-panel" class="connection-card hidden"><div class="lobby-heading"><div><label>함대 코드 <span>INVITE YOUR FRIENDS</span></label><button id="copy-code" title="함대 코드 복사"><strong id="lobby-code"></strong><span>복사 ⧉</span></button></div><button id="leave-room" class="text-button">나가기</button></div><div class="mode-picker" role="radiogroup" aria-label="경기 방식"><button data-mode="deathmatch" role="radio"><strong>격침전</strong><small>많이 격침한 함장이 승리</small></button><button data-mode="domination" role="radio"><strong>거점전</strong><small>거점 4곳 점령 · 600점 선취</small></button></div><div id="player-list"></div><div class="npc-controls"><select id="bot-hull" aria-label="NPC 함종"><option value="destroyer">NPC 구축함</option><option value="cruiser">NPC 순양함</option><option value="battleship" selected>NPC 위장 전함</option><option value="wisconsin-golden">NPC Wisconsin Golden</option></select><select id="bot-skill" aria-label="NPC 지능"><option value="1">지능 1 · 초보</option><option value="2">지능 2 · 미숙</option><option value="3" selected>지능 3 · 보통</option><option value="4">지능 4 · 숙련</option><option value="5">지능 5 · 정예</option></select><button id="add-bot" class="outline">+ NPC 추가</button></div><div class="lobby-actions"><button id="ready" class="outline">출항 준비</button><button id="start" class="primary">출항 <span>→</span></button></div><small id="lobby-note">친구가 참가할 때까지 기다려 주세요.</small></div>
    </div>
    <aside class="ship-callout"><span id="ship-class">CRUISER / 순양함</span><h2 id="ship-name">청람</h2><p id="ship-role">정밀 포격 · 다목적 전투</p><div class="spec-bars" id="ship-specs"></div><div class="ship-label">기본 무장 <span id="ship-armament">203mm 주포 · 어뢰 · 부포</span></div><button id="preview-salvo" class="outline">주포 시연 · 음향 듣기</button><label class="volume-control">효과음 <input id="volume" type="range" min="0" max="100" value="72" aria-label="효과음 음량"/></label></aside>
    <div class="fleet-selection"><div class="selection-heading"><span>01 <b>함선 선택</b></span><small>각 함선은 매 경기 기본 무장으로 출항합니다.</small></div><div class="ship-cards">${(Object.keys(HULLS) as Hull[]).map((h, i) => `<button class="ship-card ${h === "cruiser" ? "selected" : ""}" data-hull="${h}" aria-pressed="${h === "cruiser"}"><span class="card-number">0${i + 1}</span>${hullIcon(h)}<span class="card-info"><strong>${HULLS[h].title} <small>${HULLS[h].name}</small></strong><span>${HULLS[h].role}</span></span><span class="selection-dot"></span></button>`).join("")}</div></div>
    <footer class="harbor-footer"><span>OPERATION 01 <b>군도 해역</b></span><span>THREE DIMENSIONS. ONE OCEAN.</span></footer>
  </section>
  <section id="battle" class="hidden" aria-label="전투 화면">
    <div id="impact-overlay" aria-hidden="true"></div>
    <div class="battle-top"><div class="battle-brand">${emblem}<span>IRON TIDE<small id="battle-room"></small></span></div><div id="zone-bar" class="zone-bar hidden" aria-label="거점 현황"></div><div class="match-time"><span id="match-mode">개인 격침전</span><strong id="match-clock">08:00</strong><div class="compass" aria-hidden="true"><div id="compass-tape">${compassTape()}</div><i id="compass-ship"></i><b id="compass-heading">000</b></div></div><div class="battle-right"><span id="network">연결 중</span><button id="sound" class="icon-button">음향 ON</button><button id="radio" class="icon-button">무전 ON</button><button id="battle-help" class="icon-button">조작 ?</button><button id="battle-leave" class="icon-button">나가기</button></div></div>
    <div id="detection" class="detection hidden">◈ &nbsp; 적에게 발견됨</div><div id="torpedo-warning" class="torpedo-warning hidden">⚠ 어뢰 접근 · 항로를 변경하세요</div><div id="incoming-warning" class="incoming-warning hidden" role="alert"></div><div id="grounding-warning" class="grounding-warning hidden"></div><div id="edge-warning" class="edge-warning hidden">해역 경계 접근</div>
    <div id="contacts"></div><div id="radio-transmission" class="hidden" aria-live="polite"><small>함교 무전 · RADIO</small><span></span></div><div id="reticle"><i></i><i></i><i></i><i></i><span id="aim-ready"></span></div><div id="binocular-vignette" class="hidden"></div><div id="binocular-ruler" class="hidden">−20 ┄┄┄ −15 ┄┄┄ −10 ┄┄┄ −5 ┄┄┼┄┄ 5 ┄┄┄ 10 ┄┄┄ 15 ┄┄┄ 20</div>
    <div id="aim-info"><span id="aim-distance"></span><span id="aim-flight"></span><span id="aim-status"></span><span id="aim-dispersion"></span></div><div id="target-info" class="hidden"></div><div id="armor-preview" class="hidden" aria-live="off"></div><div id="hit-feedback" role="status" aria-live="polite"></div><div id="hit-marker" aria-hidden="true"><i></i><i></i><i></i><i></i></div><div id="hit-history"></div><div id="hit-floats"></div><div id="event-feed"></div>
    <div class="ship-hud"><div class="hull-title"><span id="hud-hull"></span><strong id="hud-name"></strong><span id="hud-level">LV 1</span></div><div class="hp-row"><strong id="hp-value"></strong><small id="hp-max"></small></div><div class="hp-track"><div id="hp-repair"></div><div id="hp-bar"></div></div><div class="xp-track"><div id="xp-bar"></div></div><div class="status-line" id="ship-status"></div><div class="helm"><div class="speed"><strong id="speed">0.0</strong><span>kn</span></div><div class="engine"><span>ENGINE ORDER</span><strong id="throttle">정지</strong><div class="throttle-ticks">${THROTTLE_LABELS.map((v, i) => `<i data-throttle="${i}" title="${v}"></i>`).join("")}</div></div><div class="rudder"><span>RUDDER</span><strong id="rudder">중앙</strong></div></div><div id="turret-display"></div><button id="upgrade-open" class="upgrade-prompt">함선 강화 <b id="points-count">0</b><kbd>Ctrl</kbd></button></div>
    <div class="weapon-hud"><div class="weapon-row"><button data-weapon="HE" class="weapon active"><kbd>1</kbd><strong>고폭탄</strong><small>HE · 화재 유발</small></button><button data-weapon="AP" class="weapon"><kbd>2</kbd><strong>철갑탄</strong><small>AP · 장갑 관통</small></button><button data-weapon="TORP" class="weapon"><kbd>3</kbd><strong>어뢰</strong><small>TORPEDO</small></button><button data-weapon="SAP" class="weapon"><kbd>4</kbd><strong>반철갑탄</strong><small>SAP · 경장갑 타격</small></button><button data-weapon="MINE" class="weapon"><kbd>5</kbd><strong>기뢰 설치</strong><small>함미 투하</small></button><button data-weapon="RBU" class="weapon"><kbd>6</kbd><strong>대어뢰 로켓</strong><small>RBU · 수역 요격</small></button></div><div class="ability-row"><button id="ability-dcp"><kbd>R</kbd><span>피해 복구</span><strong id="dcp-timer">준비</strong></button><button id="ability-special"><kbd>T</kbd><span id="special-label">특수 장비</span><strong id="special-timer">준비</strong></button></div><div class="control-hint">W S 항속 &nbsp; A D 조타 &nbsp; 우클릭 둘러보기 &nbsp; Shift 쌍안경</div></div>
    <div class="minimap-wrap"><div class="minimap-heading"><span>군도 해역</span><small>TACTICAL MAP</small></div><canvas id="minimap" width="460" height="460" aria-label="전술 미니맵"></canvas><div class="map-legend"><span>▲ 내 함선</span><span>◇ 마지막 목격</span><span id="fps"></span></div></div>
    <div id="capture-prompt" class="capture-prompt"><strong>함선 지휘</strong><span>화면을 클릭하면 마우스로 조준합니다.</span><small>Esc: 커서 해제 · Ctrl: 강화 / UI 조작</small><button id="capture" class="primary">전투 조작 시작</button></div>
    <div id="respawn" class="respawn hidden"><div class="eyebrow">SHIP LOST</div><h2>함선 침몰</h2><p><strong id="respawn-clock">5</strong>초 후 재출격</p><small id="respawn-note">레벨과 강화는 이번 경기 동안 유지됩니다.</small></div>
    <div id="upgrade-panel" class="upgrade-panel hidden"><div class="panel-heading"><div><span class="eyebrow">FIELD MODIFICATION</span><h2>함선 강화 <b id="upgrade-points">0</b></h2></div><button id="upgrade-close" class="icon-button" aria-label="강화 창 닫기">×</button></div><p>전투는 계속됩니다. 항속과 항로를 확인하세요.</p><div id="upgrade-options"></div></div>
    <div id="scoreboard" class="modal-panel hidden"><h2>전투 현황</h2><div id="live-scores"></div></div>
  </section>
  <section id="results" class="results hidden"><div class="result-card"><span class="eyebrow">OPERATION COMPLETE</span><h1>교전 종료</h1><p id="winner"></p><div id="result-scores"></div><div class="result-actions"><button id="rematch" class="primary">다음 출항 준비 →</button><button id="result-leave" class="outline">함대 나가기</button></div><small id="result-note"></small></div></section>
  <div id="help-modal" class="modal-overlay hidden"><div class="help-card"><button id="help-close" class="icon-button close" aria-label="조작 안내 닫기">×</button><span class="eyebrow">CAPTAIN'S HANDBOOK</span><h2>함선 지휘 안내</h2><div class="help-grid"><div><h3>항해</h3><p>W / S · 항속 단계 변경, 길게 눌러 연속 변경<br>좌초 시 S 길게 · 후진 탈출<br>A / D · 누르는 동안 조타<br>Q / E · 지속 조타<br>배는 즉시 멈추거나 선회하지 않습니다.</p><h3>시야와 조준</h3><p>화면 클릭 · 마우스 조준 시작<br>우클릭 유지 · 조준을 유지하고 둘러보기<br>휠 · 확대 / 축소<br>Shift · 쌍안경, X · 표적 지정<br>Esc · 커서 해제</p></div><div><h3>무장</h3><p>1 · 고폭탄 / 2 · 철갑탄 / 3 · 어뢰<br>4 · 반철갑탄 / 5 · 기뢰 / 6 · 대어뢰 로켓<br>클릭 · 포탑 하나 발사<br>더블클릭 · 준비된 주포 일제사격<br>길게 누르기 · 순차 사격<br>어뢰는 배의 측면으로 발사합니다.<br>기뢰는 함미 투하, 로켓은 어뢰 앞 수역 조준<br>P · 부포 자동 사격 전환</p><h3>방어와 성장</h3><p>R · 화재·침수 복구 (체력 회복 아님)<br>T · 연막 / 음향 탐지 / 수리반<br>Ctrl · 커서와 함선 강화<br>Tab · 점수판<br>사격 관제 강화 · 착탄 원 축소</p></div></div><p class="help-tip">측면을 노출하면 포문을 더 많이 쓸 수 있지만 철갑탄에 취약합니다. 주포 발사는 피탐지 거리를 늘립니다. 섬과 연막을 이용해 재배치하세요.</p></div></div>
  <div id="connection-overlay" class="connection-overlay hidden"><strong>통신 재연결 중</strong><span>함선은 기존 항속과 항로를 유지합니다.</span></div><div id="toast" role="status" aria-live="polite"></div>
`;

let sea: SeaScene;
try {
  sea = new SeaScene($("sea"));
} catch {
  $("app").innerHTML =
    '<main class="fatal"><h1>3D 화면을 시작하지 못했습니다.</h1><p>WebGL을 지원하는 PC 브라우저에서 하드웨어 가속을 켜고 다시 열어 주세요.</p></main>';
  throw Error("WebGL unavailable");
}
const audio = new AudioBus();
let ws: WebSocket | null = null,
  queue: ClientMessage[] = [];
let lobby: Lobby | null = null,
  snap: Snapshot | null = null;
let identity = { id: "", token: "", room: "" };
let hull: Hull = "cruiser",
  playing = false,
  active = false,
  softControl = false,
  phase = "lobby",
  connectionRetries = 0,
  reconnectTimer = 0;
let throttle = 1,
  rudderLock = 0,
  weapon: Ammo = "HE",
  firing = false,
  target: string | null = null;
const keys = new Set<string>();
let scoreOpen = false,
  upgradeOpen = false,
  toastTimer = 0;
let savedLook = { yaw: 0, pitch: 0 };
let lastSnapshot = 0,
  ping = 0;
let handledEvents = new Set<number>();
let lastSend = 0,
  uiTime = 0;
let throttleHeld: { key: "w" | "s"; next: number } | null = null;
const overlay = new ScreenOverlay($("impact-overlay"));
sea.onImpact = (kind, strength) => overlay.trigger(kind, strength);
const hitFeedback = new HitFeedback(
  $("hit-feedback"),
  $("hit-history"),
  $("hit-marker"),
  $("hit-floats"),
);

const MODULE_LABEL: Record<ModuleKind, string> = {
  turret: "주포탑",
  rudder: "조타 장치",
  engine: "기관",
};
// ── Wallet sign-in (optional: guests still play with just a name) ──
const walletDiscovery = new WalletDiscovery();
let account: AccountView | null = null,
  walletBusy = "",
  walletChoices: WalletChoice[] | null = null;
const shortWallet = (w: string) => `${w.slice(0, 6)}…${w.slice(-4)}`;
function renderAccount() {
  const box = $("account-box");
  const nameInput = $<HTMLInputElement>("captain-name");
  if (account) {
    box.innerHTML = `<div class="account-row"><span class="account-badge">지갑</span><strong title="${esc(account.wallet)}">${shortWallet(account.wallet)}</strong><button id="wallet-logout" class="text-button">로그아웃</button></div><div class="account-stats">${account.matches}전 ${account.wins}승 · 격침 ${number(account.kills)} · 피해 ${number(account.damage)}</div>`;
    if (document.activeElement !== nameInput) nameInput.value = account.name;
    $("connection-note").textContent =
      "로그인한 지갑으로 출항합니다. 함장 이름과 경기 결과가 전적에 저장됩니다.";
    $("wallet-logout").onclick = async () => {
      try {
        await logout();
        account = null;
        renderAccount();
      } catch (error) {
        toast(
          error instanceof Error ? error.message : "로그아웃하지 못했습니다.",
        );
      }
    };
    return;
  }
  $("connection-note").textContent =
    "계정 없이 함대 코드를 공유해 친구와 출항할 수 있습니다.";
  const list = walletChoices
    ? walletChoices.length
      ? `<div class="wallet-list">${walletChoices.map((w, i) => `<button class="outline" data-wallet="${i}">${esc(w.name)}</button>`).join("")}</div>`
      : '<small class="wallet-missing">지갑 확장 프로그램을 찾지 못했습니다. Ronin Wallet 또는 MetaMask를 설치하세요.</small>'
    : "";
  box.innerHTML = `<button id="wallet-login" class="wallet-login" ${walletBusy ? "disabled" : ""}>${walletBusy || "지갑으로 로그인"}</button>${list}<small>로그인하면 함장 이름과 전적이 저장됩니다. 서명만 하며 거래나 토큰 승인은 하지 않습니다.</small>`;
  $("wallet-login").onclick = () => {
    walletDiscovery.request();
    const wallets = walletDiscovery.wallets();
    if (wallets.length === 1) void walletSignIn(wallets[0]);
    else {
      walletChoices = wallets;
      renderAccount();
    }
  };
  box
    .querySelectorAll<HTMLButtonElement>("[data-wallet]")
    .forEach(
      (b) =>
        (b.onclick = () =>
          void walletSignIn(walletChoices![Number(b.dataset.wallet)])),
    );
}
async function walletSignIn(choice: WalletChoice) {
  walletChoices = null;
  walletBusy = `${choice.name}에서 서명을 승인하세요…`;
  renderAccount();
  try {
    account = await signInWithWallet(choice.provider);
    toast(`${account.name} 함장 · 지갑 로그인 완료`);
  } catch (error) {
    toast(walletErrorMessage(error));
  } finally {
    walletBusy = "";
    renderAccount();
  }
}
async function refreshAccount() {
  try {
    account = await fetchAccount();
  } catch {
    account = null;
  }
  renderAccount();
}
function toast(message: string) {
  $("toast").textContent = message;
  $("toast").classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(
    () => $("toast").classList.remove("show"),
    4000,
  );
}
function send(message: ClientMessage) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}
function connect(message?: ClientMessage) {
  if (ws?.readyState === WebSocket.OPEN) {
    if (message) send(message);
    return;
  }
  if (message) queue.push(message);
  if (ws?.readyState === WebSocket.CONNECTING) return;
  ws = new WebSocket(
    `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`,
  );
  ws.onopen = () => {
    if (identity.token)
      send({ type: "resume", room: identity.room, token: identity.token });
    else {
      for (const m of queue) send(m);
      queue = [];
    }
  };
  ws.onmessage = (e) => {
    let m: ServerMessage;
    try {
      m = JSON.parse(e.data);
    } catch {
      return;
    }
    switch (m.type) {
      case "welcome": {
        const fresh = !identity.token;
        identity = { id: m.id, room: m.room, token: m.token };
        sessionStorage.setItem("iron-tide-session", JSON.stringify(identity));
        connectionRetries = 0;
        $("connection-overlay").classList.add("hidden");
        if (fresh) send({ type: "select", hull });
        break;
      }
      case "lobby":
        lobby = m;
        renderLobby();
        if (m.phase === "lobby" && playing) {
          playing = false;
          phase = "lobby";
          snap = null;
          release();
          document.body.classList.remove("playing");
          $("battle").classList.add("hidden");
          $("results").classList.add("hidden");
          $("harbor").classList.remove("hidden");
        }
        break;
      case "snapshot":
        lastSnapshot = performance.now();
        snap = m;
        if (!playing && m.phase !== "lobby") enterBattle();
        if (m.phase === "results" && phase !== "results") showResults();
        if (m.phase === "battle" && phase !== "results") phase = "battle";
        if (!m.self.alive) firing = false;
        handleEvents(m);
        break;
      case "error":
        toast(m.message);
        if (m.message.includes("재접속") || m.message.includes("다른 창")) {
          clearSession();
          $("connection-overlay").classList.add("hidden");
        }
        break;
      case "left":
        clearSession();
        break;
      case "pong":
        ping = Math.round(performance.now() - m.at);
        break;
    }
  };
  ws.onclose = () => {
    if (identity.token) {
      $("connection-overlay").classList.remove("hidden");
      if (connectionRetries++ < 30) {
        reconnectTimer = window.setTimeout(() => connect(), 1000);
      } else {
        toast("연결을 복구하지 못했습니다. 새로 참가해 주세요.");
        clearSession();
      }
    }
  };
  ws.onerror = () => {
    if (!identity.token) {
      queue = [];
      toast("서버에 연결할 수 없습니다. 서버 실행 상태를 확인하세요.");
    }
  };
}
function clearSession() {
  void refreshAccount();
  identity = { id: "", token: "", room: "" };
  sessionStorage.removeItem("iron-tide-session");
  clearTimeout(reconnectTimer);
  lobby = null;
  snap = null;
  playing = false;
  phase = "lobby";
  firing = false;
  document.body.classList.remove("playing");
  document.body.classList.remove("in-room");
  release();
  $("harbor").classList.remove("hidden");
  $("battle").classList.add("hidden");
  $("results").classList.add("hidden");
  $("connection-overlay").classList.add("hidden");
  $("connect-form").classList.remove("hidden");
  $("lobby-panel").classList.add("hidden");
}
function renderLobby() {
  if (!lobby) return;
  for (const p of lobby.players) if (p.bot) sea.prepareNpcs(p.npcModel);
  document.body.classList.add("in-room");
  $("connect-form").classList.add("hidden");
  $("lobby-panel").classList.remove("hidden");
  $("lobby-code").textContent = lobby.room;
  $("player-list").innerHTML = lobby.players
    .map(
      (p) =>
        `<div class="player-row" data-player="${esc(p.id)}"><span class="player-mark ${p.ready ? "is-ready" : ""}">${p.ready ? "✓" : "○"}</span><div><strong>${esc(p.name)} ${p.bot ? `<small>NPC · 지능 ${p.skill ?? 5}</small>` : p.id === lobby!.host ? "<small>함대장</small>" : ""}${p.verified ? '<small class="verified">지갑</small>' : ""}</strong><span>${HULLS[p.hull].title} · ${p.npcModel === "wisconsin-golden" ? NPC_MODELS[p.npcModel].title : HULLS[p.hull].name}</span></div><small>${!p.connected ? "재접속 대기" : p.ready ? "준비 완료" : "함선 정비 중"}</small>${p.bot && lobby!.host === identity.id ? `<button class="remove-bot" data-remove-bot="${esc(p.id)}" aria-label="${esc(p.name)} 제외">×</button>` : ""}</div>`,
    )
    .join("");
  document.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((b) => {
    const on = b.dataset.mode === lobby!.mode;
    b.classList.toggle("selected", on);
    b.setAttribute("aria-checked", String(on));
    b.disabled = lobby!.host !== identity.id;
  });
  const mine = lobby.players.find((p) => p.id === identity.id);
  if (mine) {
    hull = mine.hull;
    selectHullUI(hull);
    $("ready").textContent = mine.ready ? "준비 취소" : "출항 준비";
    $("ready").classList.toggle("is-ready", mine.ready);
  }
  ($("start") as HTMLButtonElement).disabled =
    lobby.host !== identity.id ||
    lobby.players.length < 2 ||
    lobby.players.some((p) => !p.ready || !p.connected);
  $("lobby-note").textContent =
    lobby.host !== identity.id
      ? "함대장이 출항을 시작합니다."
      : lobby.players.length < 2
        ? "친구를 초대하거나 NPC를 추가하면 혼자서도 출항할 수 있습니다."
        : "모든 함장이 준비하면 출항합니다. 플레이어·NPC 합계 최대 4척.";
  ($("add-bot") as HTMLButtonElement).disabled =
    lobby.host !== identity.id || lobby.players.length >= RULES.maxPlayers;
  for (const id of ["bot-hull", "bot-skill"])
    ($(id) as HTMLSelectElement).disabled =
      lobby.host !== identity.id || lobby.players.length >= RULES.maxPlayers;
}
function selectHullUI(h: Hull) {
  const c = HULLS[h];
  sea.setPreview(h);
  document.querySelectorAll<HTMLButtonElement>("[data-hull]").forEach((b) => {
    b.classList.toggle("selected", b.dataset.hull === h);
    b.setAttribute("aria-pressed", String(b.dataset.hull === h));
  });
  $("ship-class").textContent = `${h.toUpperCase()} / ${c.title}`;
  $("ship-name").textContent = c.name;
  $("ship-role").textContent = c.role;
  $("ship-armament").textContent =
    `${c.caliber}mm 주포${c.torpedo ? " · 어뢰" : ""}${c.secondaryRange ? " · 부포" : ""}`;
  $("ship-specs").innerHTML = [
    ["화력", c.shellDamage / 4400],
    ["기동", c.speed / 28],
    ["생존", c.hp / 50000],
    ["은폐", 1.25 - c.detect / 1100],
  ]
    .map(
      ([label, v]) =>
        `<div><span>${label}</span><i><b style="width:${Number(v) * 100}%"></b></i></div>`,
    )
    .join("");
}
function enterBattle() {
  playing = true;
  phase = snap!.phase;
  handledEvents.clear();
  hitFeedback.reset();
  throttle = snap!.self.input.throttle;
  weapon = snap!.self.input.weapon;
  target = null;
  rudderLock = snap!.self.input.rudder;
  keys.clear();
  firing = false;
  document.body.classList.add("playing");
  sea.setBinocular(false);
  $("harbor").classList.add("hidden");
  $("results").classList.add("hidden");
  $("battle").classList.remove("hidden");
  $("battle-room").textContent = `함대 ${identity.room}`;
  $("capture-prompt").classList.remove("hidden");
  audio.unlock();
}
function showResults() {
  phase = "results";
  firing = false;
  release();
  $("results").classList.remove("hidden");
  const scores = snap!.scores,
    domination = snap!.mode === "domination";
  $("winner").textContent =
    `${scores[0]?.name ?? "함장"} 함장 · ${domination ? `거점전 ${number(scores[0]?.score ?? 0)}점` : "해역 제압"}`;
  const row = domination ? "result-row with-score" : "result-row";
  $("result-scores").innerHTML =
    `<div class="${row} heading"><span>함장 / 함선</span>${domination ? "<span>점수</span>" : ""}<span>격침</span><span>피해량</span><span>명중률</span><span>레벨</span></div>` +
    scores
      .map(
        (p, i) =>
          `<div class="${row} ${p.id === identity.id ? "mine" : ""}"><span><b>${i + 1}</b><strong>${esc(p.name)}<small>${HULLS[p.hull].title}</small></strong></span>${domination ? `<span>${number(p.score ?? 0)}</span>` : ""}<span>${p.kills}</span><span>${number(p.damage ?? 0)}</span><span>${Math.round((p.accuracy ?? 0) * 100)}%</span><span>${p.level}</span></div>`,
      )
      .join("");
  ($("rematch") as HTMLButtonElement).disabled = snap!.host !== identity.id;
  $("result-note").textContent =
    snap!.host === identity.id
      ? "다음 경기는 레벨 1과 기본 무장으로 시작합니다."
      : "함대장이 다음 출항을 준비할 때까지 기다려 주세요.";
}
function handleEvents(s: Snapshot) {
  for (const e of s.events)
    if (!handledEvents.has(e.id)) {
      handledEvents.add(e.id);
      audio.event(e, e.owner === identity.id, {
        x: s.self.x,
        z: s.self.z,
        heading: sea.yaw,
      });
      if (
        (e.type === "hit" || e.type === "intercept") &&
        e.owner === identity.id
      ) {
        const name = s.scores.find((p) => p.id === e.target)?.name ?? "적 함선";
        hitFeedback.record(e, name);
      }
      if (e.type === "pickup" && e.owner === identity.id && e.text) {
        const info = POWERUPS[e.text as PickupKind];
        toast(
          `${info.name} 획득 · ${info.effect}${e.text === "repair" ? "" : " (20초)"}`,
        );
        audio.pickup();
      }
      if (e.type === "capture")
        toast(
          e.owner === identity.id
            ? `거점 ${e.text} 점령 · +20점`
            : `${s.scores.find((p) => p.id === e.owner)?.name ?? "적"} 함장이 거점 ${e.text} 점령`,
        );
      if (e.type === "module" && e.module) {
        if (e.target === identity.id)
          toast(`${MODULE_LABEL[e.module]} 고장 · R 피해 복구로 즉시 수리`);
        else if (e.owner === identity.id)
          toast(`적 ${MODULE_LABEL[e.module]} 파손`);
      }
      if (e.type === "level" && e.owner === identity.id)
        toast(`${e.text} · 강화 포인트 +1`);
      if (
        e.type === "sink" &&
        (e.owner === identity.id || e.target === identity.id)
      )
        toast(e.text ?? "함선 격침");
    }
  if (handledEvents.size > 2000)
    handledEvents = new Set(s.events.map((e) => e.id));
}
function capture() {
  if (phase !== "battle") return;
  audio.unlock();
  void sea.canvas.requestPointerLock().catch(() => {
    softControl = true;
    active = true;
    document.body.dataset.controls = "fallback";
    document.body.classList.add("soft-controls");
    $("capture-prompt").classList.add("hidden");
    sea.canvas.focus();
    toast(
      "마우스 잠금이 제한되어 창 안에서 조준합니다. Esc로 커서를 해제하세요.",
    );
  });
}
function release() {
  firing = false;
  keys.clear();
  throttleHeld = null;
  sea.freeLook = false;
  active = false;
  softControl = false;
  document.body.dataset.controls = "";
  document.body.classList.remove("soft-controls");
  document.exitPointerLock();
  $("capture-prompt").classList.toggle(
    "hidden",
    phase !== "battle" || upgradeOpen,
  );
}
function openUpgrade(value: boolean) {
  upgradeOpen = value;
  $("upgrade-panel").classList.toggle("hidden", !value);
  if (value) {
    release();
    renderUpgrades();
  } else
    $("capture-prompt").classList.toggle(
      "hidden",
      active || phase !== "battle",
    );
}
let lastUpgradeKey = "";
function renderUpgrades() {
  if (!snap) return;
  const s = snap.self,
    c = HULLS[s.hull];
  const key = JSON.stringify([s.id, s.hull, s.points, s.upgrades]);
  if (key === lastUpgradeKey) return;
  lastUpgradeKey = key;
  $("upgrade-points").textContent = String(s.points);
  $("upgrade-options").innerHTML = UPGRADE_KEYS.filter(
    (k) => k !== "torpedo" || c.torpedo,
  )
    .filter((k) => k !== "secondary" || c.secondaryRange > 0)
    .map(
      (k) =>
        `<button class="upgrade-option" data-upgrade="${k}" ${s.points <= 0 || s.upgrades[k] >= 3 ? "disabled" : ""}><div><strong>${UPGRADE_INFO[k].name}</strong><small>${UPGRADE_INFO[k].description}</small></div><span class="tiers">${[0, 1, 2].map((i) => `<i class="${i < s.upgrades[k] ? "filled" : ""}"></i>`).join("")}</span><b>${s.upgrades[k] >= 3 ? "MAX" : "+ 1"}</b></button>`,
    )
    .join("");
  document
    .querySelectorAll<HTMLButtonElement>("[data-upgrade]")
    .forEach(
      (b) =>
        (b.onclick = () =>
          send({ type: "upgrade", upgrade: b.dataset.upgrade as Upgrade })),
    );
}
function setWeapon(w: Ammo) {
  if (snap && w === "TORP" && !HULLS[snap.self.hull].torpedo) {
    toast("이 함선에는 어뢰가 없습니다.");
    return;
  }
  weapon = w;
  firing = false;
  pushInput();
}
function pushInput() {
  if (!snap || phase !== "battle") return;
  send({
    type: "input",
    input: {
      throttle,
      rudder: keys.has("a") ? -1 : keys.has("d") ? 1 : rudderLock,
      aim: sea.aim,
      weapon,
      firing,
      target,
    },
  });
}

$("create-room").onclick = () => {
  audio.unlock();
  connect({
    type: "create",
    name: ($("captain-name") as HTMLInputElement).value,
  });
};
$("join-room").onclick = () => {
  audio.unlock();
  const room = ($("room-code") as HTMLInputElement).value.trim();
  if (!room) {
    toast("친구에게 받은 함대 코드를 입력하세요.");
    return;
  }
  connect({
    type: "join",
    name: ($("captain-name") as HTMLInputElement).value,
    room,
  });
};
$("room-code").onkeydown = (e) => {
  if (e.key === "Enter") $("join-room").click();
};
document.querySelectorAll<HTMLButtonElement>("[data-hull]").forEach(
  (b) =>
    (b.onclick = () => {
      hull = b.dataset.hull as Hull;
      selectHullUI(hull);
      if (identity.id) send({ type: "select", hull });
    }),
);
$("copy-code").onclick = () => {
  navigator.clipboard
    ?.writeText(identity.room)
    .then(() => toast("함대 코드를 복사했습니다."))
    .catch(() => toast(`함대 코드: ${identity.room}`));
};
$("ready").onclick = () =>
  send({
    type: "ready",
    ready: !lobby?.players.find((p) => p.id === identity.id)?.ready,
  });
$("start").onclick = () => send({ type: "start" });
document
  .querySelectorAll<HTMLButtonElement>("[data-mode]")
  .forEach(
    (b) =>
      (b.onclick = () =>
        send({ type: "mode", mode: b.dataset.mode as GameMode })),
  );
$("add-bot").onclick = () => {
  const value = ($("bot-hull") as HTMLSelectElement).value;
  send({
    type: "addBot",
    hull: value === "wisconsin-golden" ? "battleship" : (value as Hull),
    model: value === "wisconsin-golden" ? "wisconsin-golden" : "camouflage",
    skill: Number(($("bot-skill") as HTMLSelectElement).value),
  });
};
$("player-list").addEventListener("click", (e) => {
  const button = (e.target as Element).closest<HTMLButtonElement>(
    "[data-remove-bot]",
  );
  if (button) send({ type: "removeBot", id: button.dataset.removeBot! });
});
$("radio").onclick = () => {
  $("radio").textContent = `무전 ${audio.toggleRadio() ? "ON" : "OFF"}`;
};
const leaveRoom = () => {
  send({ type: "leave" });
  clearSession();
};
for (const id of ["leave-room", "result-leave", "battle-leave"])
  $(id).onclick = leaveRoom;
$("rematch").onclick = () => send({ type: "rematch" });
$("capture").onclick = capture;
$("upgrade-open").onclick = () => openUpgrade(!upgradeOpen);
$("upgrade-close").onclick = () => openUpgrade(false);
$("ability-dcp").onclick = () => send({ type: "ability", ability: "dcp" });
$("ability-special").onclick = () =>
  send({ type: "ability", ability: "special" });
document
  .querySelectorAll<HTMLButtonElement>("[data-weapon]")
  .forEach((b) => (b.onclick = () => setWeapon(b.dataset.weapon as Ammo)));
$("sound").onclick = () => {
  $("sound").textContent = `음향 ${audio.toggle() ? "ON" : "OFF"}`;
};
$("preview-salvo").onclick = () => {
  audio.unlock();
  const e = sea.demoSalvo();
  audio.event(e, true);
  const button = $("preview-salvo") as HTMLButtonElement;
  button.disabled = true;
  setTimeout(() => (button.disabled = false), 2600);
};
$("volume").addEventListener("input", (e) =>
  audio.setVolume(Number((e.target as HTMLInputElement).value) / 100),
);
for (const id of ["help", "battle-help"])
  $(id).onclick = () => {
    release();
    $("help-modal").classList.remove("hidden");
  };
$("help-close").onclick = () => $("help-modal").classList.add("hidden");

document.addEventListener("pointerlockchange", () => {
  active = document.pointerLockElement === sea.canvas || softControl;
  document.body.dataset.controls = active
    ? softControl
      ? "fallback"
      : "locked"
    : "";
  $("capture-prompt").classList.toggle(
    "hidden",
    active || phase !== "battle" || upgradeOpen,
  );
  if (!active) {
    firing = false;
    keys.clear();
    sea.freeLook = false;
  }
});
sea.canvas.addEventListener("mousedown", (e) => {
  if (!playing || phase !== "battle") return;
  if (!active) {
    capture();
    return;
  }
  if (e.button === 0) {
    firing = true;
    pushInput();
  }
  if (e.button === 2) {
    sea.freeLook = true;
    savedLook = { yaw: sea.yaw, pitch: sea.pitch };
  }
});
document.addEventListener("mouseup", (e) => {
  if (e.button === 0) {
    firing = false;
    pushInput();
  }
  if (e.button === 2 && sea.freeLook) {
    sea.freeLook = false;
    sea.yaw = savedLook.yaw;
    sea.pitch = savedLook.pitch;
  }
});
sea.canvas.addEventListener("dblclick", (e) => {
  if (e.button === 0 && active) {
    pushInput();
    send({ type: "salvo" });
  }
});
sea.canvas.addEventListener("contextmenu", (e) => e.preventDefault());
let softCursor = { x: 0.5, y: 0.5 };
document.addEventListener("mousemove", (e) => {
  if (active && playing) {
    softCursor = { x: e.clientX / innerWidth, y: e.clientY / innerHeight };
    const scale = sea.binocular ? 0.00065 : 0.0025;
    sea.yaw -= e.movementX * scale;
    sea.pitch = clamp(
      sea.pitch + e.movementY * scale,
      sea.binocular ? 0.004 : 0.01,
      1.12,
    );
  }
});
sea.canvas.addEventListener(
  "wheel",
  (e) => {
    if (!playing) return;
    e.preventDefault();
    sea.setDistance(clamp(sea.distance + e.deltaY * 0.25, 90, 650));
  },
  { passive: false },
);
const keyOf = (e: KeyboardEvent) =>
  e.code.startsWith("Key")
    ? e.code.slice(3).toLowerCase()
    : e.code.startsWith("Digit")
      ? e.code.slice(5)
      : e.key.toLowerCase();
document.addEventListener("keydown", (e) => {
  if (e.target instanceof Element && e.target.matches("input,textarea")) return;
  const key = keyOf(e);
  if (key === "escape") {
    $("help-modal").classList.add("hidden");
    openUpgrade(false);
    release();
    return;
  }
  if (!playing || phase !== "battle") return;
  if (
    ["tab", " ", "control", "shift", "w", "s", "a", "d", "q", "e"].includes(key)
  )
    e.preventDefault();
  if (key === "tab") {
    scoreOpen = true;
    return;
  }
  if (key === "control") {
    if (!e.repeat) openUpgrade(true);
    return;
  }
  if (!active) return;
  if (key === "a" || key === "d") {
    keys.add(key);
    rudderLock = 0;
  }
  if (e.repeat) return;
  if (key === "w" || key === "s") {
    throttle = clamp(throttle + (key === "w" ? 1 : -1), 0, 5);
    throttleHeld = { key, next: performance.now() + 650 };
  }
  if (key === "q") rudderLock = rudderLock === 1 ? 0 : -1;
  if (key === "e") rudderLock = rudderLock === -1 ? 0 : 1;
  if (key === "1") setWeapon("HE");
  if (key === "2") setWeapon("AP");
  if (key === "3") setWeapon("TORP");
  if (key === "4") setWeapon("SAP");
  if (key === "5") setWeapon("MINE");
  if (key === "6") setWeapon("RBU");
  if (key === "shift") {
    sea.setBinocular(!sea.binocular);
    if (sea.freeLook) savedLook = { yaw: sea.yaw, pitch: sea.pitch };
    $("binocular-vignette").classList.toggle("hidden", !sea.binocular);
    $("binocular-ruler").classList.toggle("hidden", !sea.binocular);
  }
  if (key === "x" && snap) {
    const possible = snap.contacts
      .filter((c) => c.alive)
      .map((c) => ({
        id: c.id,
        d: Math.abs(angleDiff(bearing(snap!.self, c), sea.yaw)),
      }))
      .sort((a, b) => a.d - b.d);
    target = possible[0]?.id ?? null;
  }
  if (key === "r") send({ type: "ability", ability: "dcp" });
  if (key === "t") send({ type: "ability", ability: "special" });
  if (key === "p") send({ type: "secondary" });
  pushInput();
});
document.addEventListener("keyup", (e) => {
  keys.delete(keyOf(e));
  if (throttleHeld?.key === keyOf(e)) throttleHeld = null;
  if (e.key === "Tab") scoreOpen = false;
});
window.addEventListener("blur", () => {
  keys.clear();
  throttleHeld = null;
  firing = false;
  scoreOpen = false;
  pushInput();
});

const map = $<HTMLCanvasElement>("minimap"),
  ctx = map.getContext("2d")!;
function drawMap() {
  if (!snap) return;
  const s = snap.self,
    w = 460,
    k = w / (RULES.world * 2),
    xy = (p: { x: number; z: number }) => ({
      x: w / 2 - p.x * k,
      y: w / 2 - p.z * k,
    });
  ctx.clearRect(0, 0, w, w);
  ctx.fillStyle = "#092331e6";
  ctx.fillRect(0, 0, w, w);
  ctx.strokeStyle = "#43607455";
  ctx.lineWidth = 1;
  for (let i = 1; i < 6; i++) {
    ctx.beginPath();
    ctx.moveTo((i * w) / 6, 0);
    ctx.lineTo((i * w) / 6, w);
    ctx.moveTo(0, (i * w) / 6);
    ctx.lineTo(w, (i * w) / 6);
    ctx.stroke();
  }
  for (const i of ISLANDS) {
    ctx.fillStyle = "#798a75";
    ctx.beginPath();
    for (let n = 0; n <= 72; n++) {
      const a = (n / 72) * Math.PI * 2,
        r = shoreRadius(i, a);
      const p = xy({ x: i.x + Math.sin(a) * r, z: i.z + Math.cos(a) * r });
      if (n === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    ctx.closePath();
    ctx.fill();
  }
  for (const crate of snap.pickups) {
    const p = xy(crate);
    ctx.fillStyle = POWERUPS[crate.kind].color;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y - 7);
    ctx.lineTo(p.x + 6, p.y);
    ctx.lineTo(p.x, p.y + 7);
    ctx.lineTo(p.x - 6, p.y);
    ctx.closePath();
    ctx.fill();
  }
  for (const zone of snap.zones) {
    const p = xy(zone),
      color = zoneColor(zone, s.id);
    ctx.strokeStyle = color;
    ctx.fillStyle = `${color}22`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(p.x, p.y, zone.radius * k, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.font = "700 18px Rajdhani, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(zone.id, p.x, p.y + 6);
    ctx.textAlign = "start";
    ctx.lineWidth = 1;
  }
  for (const m of snap.smokes) {
    const p = xy(m);
    ctx.fillStyle = "#a0b2b64d";
    ctx.beginPath();
    ctx.arc(p.x, p.y, m.radius * k, 0, Math.PI * 2);
    ctx.fill();
  }
  for (const mine of snap.mines ?? []) {
    const p = xy(mine);
    ctx.strokeStyle = mine.owner === s.id ? "#8ce0bf" : "#ed977d";
    ctx.beginPath();
    ctx.moveTo(p.x - 4, p.y - 4);
    ctx.lineTo(p.x + 4, p.y + 4);
    ctx.moveTo(p.x - 4, p.y + 4);
    ctx.lineTo(p.x + 4, p.y - 4);
    ctx.stroke();
  }
  const me = xy(s);
  ctx.setLineDash([4, 5]);
  ctx.strokeStyle = "#8bc9c055";
  ctx.beginPath();
  ctx.arc(me.x, me.y, HULLS[s.hull].detect * k, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  for (const last of snap.lastSeen) {
    const p = xy(last);
    ctx.strokeStyle = "#dba79188";
    ctx.beginPath();
    ctx.moveTo(p.x, p.y - 7);
    ctx.lineTo(p.x + 5, p.y);
    ctx.lineTo(p.x, p.y + 7);
    ctx.lineTo(p.x - 5, p.y);
    ctx.closePath();
    ctx.stroke();
    ctx.fillStyle = "#dba791aa";
    ctx.font = "14px sans-serif";
    ctx.fillText(`${Math.floor(snap.time - last.at)}s`, p.x + 8, p.y + 4);
  }
  for (const c of [s, ...snap.contacts]) {
    if (!c.alive) continue;
    const p = xy(c);
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(-c.heading);
    ctx.fillStyle = c.id === s.id ? "#74ead2" : "#ff9c83";
    ctx.beginPath();
    ctx.moveTo(0, -10);
    ctx.lineTo(6, 7);
    ctx.lineTo(0, 4);
    ctx.lineTo(-6, 7);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  ctx.strokeStyle = "#70e3d088";
  ctx.beginPath();
  ctx.moveTo(me.x, me.y);
  const aim = xy(sea.aim);
  ctx.lineTo(aim.x, aim.y);
  ctx.stroke();
  for (const p of snap.projectiles.filter((p) => p.kind === "TORP")) {
    const pos = xy(p);
    ctx.fillStyle = p.owner === s.id ? "#a4ded2" : "#ffba78";
    ctx.fillRect(pos.x - 2, pos.y - 2, 4, 4);
  }
}
const degrees = (radians: number) =>
  ((((-radians * 180) / Math.PI) % 360) + 360) % 360;
function updateCompass(s: Snapshot) {
  const view = degrees(sea.yaw);
  $("compass-tape").style.transform =
    `translateX(${-(view + 180) * COMPASS_PX}px)`;
  $("compass-heading").textContent = String(Math.round(view) % 360).padStart(
    3,
    "0",
  );
  const offset = (angleDiff(-s.self.heading, -sea.yaw) * 180) / Math.PI;
  const marker = $("compass-ship");
  marker.hidden = Math.abs(offset) > 58;
  marker.style.transform = `translateX(${offset * COMPASS_PX}px)`;
  const shake = `translate(${sea.shakeOffset.x}px,${sea.shakeOffset.y}px)`;
  $("contacts").style.transform = shake;
  $("hit-floats").style.transform = shake;
}
/** Zone ownership strip and score race for domination matches. */
function renderZones(s: Snapshot["self"]) {
  const domination = snap!.mode === "domination";
  $("zone-bar").classList.toggle("hidden", !domination);
  $("match-mode").textContent = domination
    ? `거점전 · ${snap!.scoreLimit}점 선취`
    : "개인 격침전";
  if (!domination) return;
  const mine = snap!.scores.find((p) => p.id === s.id)?.score ?? 0,
    leader = snap!.scores.find((p) => p.id !== s.id);
  const here = snap!.zones.find((z) => dist(s, z) < z.radius);
  const status = !here
    ? ""
    : here.contested
      ? `거점 ${here.id} 교전 중 · 점령 정지`
      : here.owner === s.id
        ? `거점 ${here.id} 확보`
        : here.capturer === s.id
          ? `거점 ${here.id} 점령 중 ${Math.round(here.progress * 100)}%`
          : "";
  $("zone-bar").innerHTML =
    snap!.zones
      .map(
        (z) =>
          `<span class="zone-chip" data-owner="${z.owner === s.id ? "mine" : z.owner ? "enemy" : "neutral"}" data-capturing="${z.capturer === s.id ? "mine" : "enemy"}"${z.contested ? " data-contested" : ""} style="--progress:${z.progress}"><b>${z.id}</b></span>`,
      )
      .join("") +
    `<span class="zone-score"><strong>${number(mine)}</strong><small>/ ${snap!.scoreLimit}${leader ? ` · ${esc(leader.name)} ${number(leader.score ?? 0)}` : ""}</small></span>` +
    (status ? `<em>${status}</em>` : "");
}
/** Warns about enemy salvos that will land on our hull if we hold course. */
function renderIncoming(s: Snapshot["self"]) {
  const shells = s.alive
    ? predictIncoming(
        s,
        snap!.projectiles,
        (performance.now() - lastSnapshot) / 1000,
      )
    : [];
  sea.setIncoming(shells);
  const threats = shells.filter((p) => p.threat);
  const el = $("incoming-warning");
  el.classList.toggle("hidden", !threats.length);
  if (!threats.length) return;
  const first = threats[0];
  el.innerHTML = `<b>⚠ 포탄 접근 ${first.eta.toFixed(1)}초</b><span>${incomingSide(s, first)} · ${threats.length}발 · 변침 / 변속으로 회피</span>`;
  audio.warning();
}
const PREVIEW_REACH = 120;
/** Expected penetration against the locked target, or whatever is under the sight. */
function renderArmorPreview(
  s: Snapshot["self"],
  locked?: Snapshot["contacts"][number],
) {
  const shell = weapon,
    candidate =
      locked ??
      snap!.contacts
        .filter((c) => c.alive && dist(c, sea.aim) < PREVIEW_REACH)
        .sort((a, b) => dist(a, sea.aim) - dist(b, sea.aim))[0];
  const el = $("armor-preview");
  el.classList.toggle("hidden", !candidate || !isShell(shell) || !s.alive);
  if (!candidate || !isShell(shell)) return;
  el.innerHTML = armorPreview(s, candidate, shell).html;
}
function updateHUD() {
  if (!snap) return;
  const s = snap.self,
    c = HULLS[s.hull],
    range = gunRangeFor(s),
    d = dist(s, sea.aim);
  $("match-clock").textContent = timer(snap.remaining);
  $("hud-hull").textContent = c.title;
  $("hud-name").textContent = c.name;
  $("hud-level").textContent = `LV ${s.level}`;
  $("hp-value").textContent = number(s.hp);
  $("hp-max").textContent = `/ ${number(s.maxHp)}`;
  $("hp-bar").style.width = `${(s.hp / s.maxHp) * 100}%`;
  const health = s.alive ? s.hp / s.maxHp : 1;
  document
    .querySelector<HTMLElement>(".ship-hud")!
    .setAttribute(
      "data-hp",
      health < 0.3 ? "critical" : health < 0.6 ? "warn" : "ok",
    );
  overlay.setCritical(health < 0.3 ? 1 - health / 0.3 : 0);
  $("hp-repair").style.width =
    `${((s.hp + s.status.healPool) / s.maxHp) * 100}%`;
  $("xp-bar").style.width =
    `${s.level >= 10 ? 100 : (s.xp / xpRequired(s.level)) * 100}%`;
  $("points-count").textContent = String(s.points);
  $("upgrade-open").classList.toggle("has-points", s.points > 0);
  $("speed").textContent = (s.speed * 1.1).toFixed(1);
  $("throttle").textContent = THROTTLE_LABELS[s.input.throttle];
  $("grounding-warning").classList.toggle("hidden", !s.grounded || !s.alive);
  $("grounding-warning").textContent =
    `해안 접촉 · 기관 ${THROTTLE_LABELS[s.input.throttle]} · S 길게: 후진 / A·D: 탈출 조타`;
  $("rudder").textContent =
    s.turn < -0.1 ? "← 左" : s.turn > 0.1 ? "右 →" : "中央";
  document
    .querySelectorAll<HTMLElement>("[data-throttle]")
    .forEach((el) =>
      el.classList.toggle("current", Number(el.dataset.throttle) === throttle),
    );
  $("ship-status").innerHTML = [
    s.status.protection > 0
      ? `<span class="good">재출격 보호 ${Math.ceil(s.status.protection)}s</span>`
      : "",
    s.status.fire.some((f) => f > 0)
      ? `<span class="danger">화재 ${s.status.fire.filter((f) => f > 0).length}곳</span>`
      : "",
    s.status.flood > 0
      ? `<span class="danger">침수 ${Math.ceil(s.status.flood)}s</span>`
      : "",
    s.status.rudderJam > 0
      ? `<span class="danger">조타 고장 ${Math.ceil(s.status.rudderJam)}s</span>`
      : "",
    s.status.engineHit > 0
      ? `<span class="danger">기관 손상 ${Math.ceil(s.status.engineHit)}s</span>`
      : "",
    s.status.immune > 0 ? '<span class="good">피해 복구 중</span>' : "",
    s.status.sonar > 0 ? '<span class="good">음향 탐지 중</span>' : "",
    s.status.smoke > 0 ? '<span class="good">연막 전개 중</span>' : "",
    s.status.heal > 0 ? '<span class="good">체력 수리 중</span>' : "",
    ...(Object.entries(s.buffs) as [BuffKind, number][]).map(
      ([kind, left]) =>
        `<span class="buff" style="--buff:${POWERUPS[kind].color}">${POWERUPS[kind].glyph} ${POWERUPS[kind].name} ${Math.ceil(left)}s</span>`,
    ),
  ].join("");
  $("detection").classList.toggle("hidden", !snap.detected || !s.alive);
  $("edge-warning").classList.toggle(
    "hidden",
    Math.max(Math.abs(s.x), Math.abs(s.z)) < RULES.world - 150,
  );
  const torps = snap.projectiles.filter(
    (p) =>
      p.kind === "TORP" &&
      p.owner !== s.id &&
      dist(p, s) < 280 &&
      p.vx * (s.x - p.x) + p.vz * (s.z - p.z) > 0,
  );
  $("torpedo-warning").classList.toggle("hidden", !torps.length || !s.alive);
  if (torps.length && s.alive) audio.warning();
  renderIncoming(s);
  renderZones(s);
  $("dcp-timer").textContent =
    s.status.dcp > 0 ? `${Math.ceil(s.status.dcp)}s` : "준비";
  $("special-label").textContent = `${c.special} · ${s.status.charges}`;
  $("special-timer").textContent =
    s.status.special > 0
      ? `${Math.ceil(s.status.special)}s`
      : s.status.charges
        ? "준비"
        : "소진";
  ($("ability-dcp") as HTMLButtonElement).disabled =
    s.status.dcp > 0 || !s.alive;
  ($("ability-special") as HTMLButtonElement).disabled =
    s.status.special > 0 || s.status.charges === 0 || !s.alive;
  document.querySelectorAll<HTMLButtonElement>("[data-weapon]").forEach((b) => {
    b.classList.toggle("active", b.dataset.weapon === weapon);
    b.disabled = b.dataset.weapon === "TORP" && !c.torpedo;
  });
  $("turret-display").innerHTML = `<span>주포</span>${s.turrets
    .map((t, i) => {
      if ((t.disabled ?? 0) > 0)
        return `<i class="broken"><b>${i + 1}</b><small>고장 ${Math.ceil(t.disabled!)}</small></i>`;
      const ready = t.reload <= 0;
      const aligned = Math.abs(angleDiff(t.angle, bearing(s, sea.aim))) < 0.065;
      return `<i class="${ready && aligned ? "ready" : ""}"><b>${i + 1}</b><small>${ready ? (aligned ? "준비" : "선회") : t.reload.toFixed(1)}</small></i>`;
    })
    .join("")}<small>부포 ${s.secondaries ? "ON" : "OFF"} · P</small>`;
  const utility = weapon === "MINE" || weapon === "RBU";
  const maxRange =
    weapon === "TORP"
      ? c.torpedoRange
      : weapon === "RBU"
        ? ORDNANCE.rbu.range
        : range;
  const solution = aimSolution(s, sea.aim, weapon);
  $("aim-distance").textContent =
    weapon === "MINE"
      ? "함미에 기뢰 설치"
      : `${number(d)} / ${number(maxRange)} m`;
  $("aim-flight").textContent =
    weapon === "TORP"
      ? `어뢰 ${s.torpedoReload > 0 ? `${s.torpedoReload.toFixed(1)}s` : "준비"}`
      : weapon === "MINE"
        ? `남은 ${s.minesLeft}발 · ${s.mineReload > 0 ? `${s.mineReload.toFixed(1)}s` : "준비"}`
        : weapon === "RBU"
          ? `남은 ${s.rocketsLeft}회 · ${s.rocketReload > 0 ? `${s.rocketReload.toFixed(1)}s` : "준비"}`
          : `비행 ${(Math.min(d, range) / c.shellSpeed).toFixed(1)} s`;
  const relative = Math.abs(angleDiff(bearing(s, sea.aim), s.heading));
  const ready =
    weapon === "TORP"
      ? s.torpedoReload <= 0 && relative > 0.6 && relative < 2.55
      : weapon === "MINE"
        ? s.minesLeft > 0 &&
          s.mineReload <= 0 &&
          sea.diagnostics.aimArea.placement
        : weapon === "RBU"
          ? s.rocketsLeft > 0 && s.rocketReload <= 0
          : s.turrets.some(
              (t) =>
                t.reload <= 0 &&
                Math.abs(angleDiff(t.angle, bearing(s, sea.aim))) < 0.065,
            );
  $("aim-status").textContent =
    weapon === "MINE" && !sea.diagnostics.aimArea.placement
      ? "해안에 설치 불가"
      : weapon !== "MINE" && d > maxRange
        ? "사거리 밖"
        : ready
          ? weapon === "MINE"
            ? "설치 가능"
            : weapon === "RBU"
              ? "어뢰 앞 수역에 발사"
              : "발사 가능"
          : weapon === "TORP" && !(relative > 0.6 && relative < 2.55)
            ? "측면으로 조준"
            : utility
              ? "재사용 대기 / 탄약 소진"
              : "재장전 / 포탑 선회";
  $("aim-dispersion").textContent =
    weapon === "TORP"
      ? "3발 부채꼴 발사"
      : weapon === "MINE"
        ? `신관 ${ORDNANCE.mine.arm}초 · 폭발 반경 ${ORDNANCE.mine.blast}m`
        : `예상 분산 반경 ${solution.radius.toFixed(1)}m${weapon === "RBU" ? " · 로켓 6발" : ` · 관제 ${s.upgrades.accuracy}/3`}`;
  $("reticle").classList.toggle("ready", ready);
  $("reticle").classList.toggle("torpedo", weapon === "TORP");
  document.querySelector<HTMLElement>(
    '[data-weapon="MINE"] small',
  )!.textContent = `남은 ${s.minesLeft}발 · 함미 투하`;
  document.querySelector<HTMLElement>(
    '[data-weapon="RBU"] small',
  )!.textContent = `남은 ${s.rocketsLeft}회 · 어뢰 요격`;
  const targ = snap.contacts.find((c) => c.id === target);
  renderArmorPreview(s, targ);
  $("target-info").classList.toggle("hidden", !targ);
  if (targ)
    $("target-info").textContent =
      `표적 · ${targ.name} · ${number(dist(s, targ))} m`;
  if (targ && weapon === "TORP") {
    const lead = intercept(
      s,
      targ,
      targ.heading,
      targ.speed,
      45 * (1 + 0.08 * s.upgrades.torpedo),
    );
    const p = sea.screenPoint(lead, 1);
    $("aim-ready").textContent = p.visible ? "◈" : "";
    $("aim-ready").style.transform =
      `translate(${p.x - innerWidth / 2}px,${p.y - innerHeight / 2}px)`;
  } else $("aim-ready").textContent = "";
  $("contacts").innerHTML = snap.contacts
    .map((contact) => {
      const pos = sea.screenPoint(contact, 28);
      if (!pos.visible) return "";
      return `<div class="contact ${contact.id === target ? "locked" : ""}" data-contact="${contact.id}" style="left:${pos.x}px;top:${pos.y}px"><span>${HULLS[contact.hull].title} · ${number(dist(s, contact))}m</span><strong>${esc(contact.name)}${contact.buffs.map((k) => `<em class="contact-buff" style="color:${POWERUPS[k].color}" title="${POWERUPS[k].name}">${POWERUPS[k].glyph}</em>`).join("")}</strong><div><i style="width:${(contact.hp / contact.maxHp) * 100}%"></i></div></div>`;
    })
    .join("");
  $("respawn").classList.toggle("hidden", s.alive || phase !== "battle");
  $("respawn-note").textContent =
    `이번 경기 ${s.stats.deaths}회 침몰 · 다음 침몰 시 ${respawnDelay(s.stats.deaths + 1)}초 대기 · 레벨·강화 유지`;
  $("respawn-clock").textContent = String(
    Math.max(0, Math.ceil(s.respawnAt - snap.time)),
  );
  hitFeedback.render((p, y) => sea.screenPoint(p, y));
  $("event-feed").innerHTML = snap.events
    .filter((e) => e.type === "sink")
    .slice(-3)
    .map((e) => `<p>${esc(e.text ?? "함선 격침")}</p>`)
    .join("");
  $("scoreboard").classList.toggle("hidden", !scoreOpen);
  if (scoreOpen)
    $("live-scores").innerHTML = snap.scores
      .map(
        (p) =>
          `<div class="score-row"><strong>${esc(p.name)}</strong><span>${HULLS[p.hull].title}</span>${snap!.mode === "domination" ? `<span>${number(p.score ?? 0)}점</span>` : ""}<span>${p.kills} 격침 / ${p.deaths} 침몰</span></div>`,
      )
      .join("");
  $("network").textContent =
    performance.now() - lastSnapshot > 2000 ? "통신 지연" : `${ping} ms`;
  $("fps").textContent = `${Math.round(sea.fps)} FPS`;
  if (upgradeOpen) renderUpgrades();
  drawMap();
}
selectHullUI(hull);
void refreshAccount();
try {
  const saved = JSON.parse(
    sessionStorage.getItem("iron-tide-session") ?? "null",
  );
  if (saved?.token) {
    identity = saved;
    connect();
  }
} catch {
  sessionStorage.removeItem("iron-tide-session");
}
let previous = performance.now();
function frame(now: number) {
  const elapsed = (now - previous) / 1000;
  const dt = Math.min(0.1, elapsed);
  previous = now;
  if (active && playing && throttleHeld && now >= throttleHeld.next) {
    throttle = clamp(throttle + (throttleHeld.key === "w" ? 1 : -1), 0, 5);
    throttleHeld.next = now + 400;
    pushInput();
  }
  if (softControl && active && document.hasFocus()) {
    const horizontal = softCursor.x < 0.025 ? -1 : softCursor.x > 0.975 ? 1 : 0;
    const vertical = softCursor.y < 0.025 ? -1 : softCursor.y > 0.975 ? 1 : 0;
    sea.yaw -= horizontal * dt * (sea.binocular ? 0.35 : 1.1);
    sea.pitch = clamp(
      sea.pitch + vertical * dt * 0.35,
      sea.binocular ? 0.004 : 0.01,
      1.12,
    );
  }
  audio.updateVessel(
    playing && snap?.phase === "battle" && ws?.readyState === WebSocket.OPEN
      ? snap.self
      : null,
  );
  const radio = audio.diagnostics.radio;
  $("radio-transmission").classList.toggle("hidden", !playing || !radio.text);
  $("radio-transmission").querySelector("span")!.textContent = radio.text;
  sea.render(elapsed, snap, playing);
  if (playing && snap) updateCompass(snap);
  if (playing && snap) {
    if (now - lastSend >= 50) {
      pushInput();
      lastSend = now;
    }
    if (now - uiTime >= 80) {
      updateHUD();
      uiTime = now;
    }
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
setInterval(() => {
  if (ws?.readyState === WebSocket.OPEN)
    send({ type: "ping", at: performance.now() });
}, 2000);
// Read-only development diagnostics for reproducible visual/browser QA. No mutation API.
if (import.meta.env.DEV)
  Object.defineProperty(window, "__IRON_TIDE__", {
    value: {
      get state() {
        return snap;
      },
      get room() {
        return lobby;
      },
      get view() {
        return {
          yaw: sea.yaw,
          pitch: sea.pitch,
          distance: sea.distance,
          binocular: sea.binocular,
          aim: { ...sea.aim },
          fps: sea.fps,
          graphics: sea.diagnostics,
          audio: audio.diagnostics,
        };
      },
    },
  });
