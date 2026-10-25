import "./admin.css";
import {
  api,
  signChallenge,
  WalletDiscovery,
  walletErrorMessage,
  type WalletChoice,
} from "../wallet";
import { AMOUNT, coins, esc, modeName, short, time, toMicro } from "./format";
import { RulesTab } from "./rulesTab";

interface Status {
  hasAdmin: boolean;
  isAdmin: boolean;
  wallet: string | null;
  metanomic: { connected: boolean; gameId?: string; assetId?: string };
}
interface Player {
  id: string;
  wallet: string;
  name: string;
  matches: number;
  wins: number;
  kills: number;
  deaths: number;
  damage: number;
  paid: string;
  pending: string;
}
interface MatchEntry {
  accountId: string | null;
  name: string;
  hull: string;
  place: number;
  kills: number;
  deaths: number;
  damage: number;
  score: number;
}
interface MatchReward {
  accountId: string;
  amount: string;
  items: { label: string; amount: string }[];
  status: "QUEUED" | "HELD" | "SKIPPED";
  note: string | null;
}
interface Match {
  id: number;
  room: string;
  mode: string;
  endedAt: number;
  entries: MatchEntry[];
  /** Automatic rule rewards; a "*" row explains a skipped match. */
  rewards: MatchReward[];
}
interface Reward {
  id: string;
  accountId: string;
  wallet: string;
  name: string;
  amount: string;
  memo: string;
  matchId: number | null;
  status: "PENDING" | "SUBMITTED" | "DONE" | "FAILED";
  error: string | null;
  createdAt: number;
}
interface Overview {
  players: Player[];
  matches: Match[];
  rewards: Reward[];
  budget: { available?: string; onchain?: string; reserved?: string } | null;
  budgetError: string | null;
  heldMatches: number;
  autoEnabled: boolean;
}

const HULL: Record<string, string> = {
  destroyer: "구축함",
  cruiser: "순양함",
  battleship: "전함",
};
const root = document.getElementById("admin")!;
const discovery = new WalletDiscovery();

let status: Status | null = null,
  overview: Overview | null = null,
  selected = new Set<string>(),
  wallets: WalletChoice[] | null = null,
  busy = "",
  notice: { kind: "ok" | "error"; text: string } | null = null,
  confirmUntil = 0,
  matchContext: number | null = null,
  tab: "pay" | "rules" = "pay";
const rulesTab = new RulesTab(() => render(), say);

function say(kind: "ok" | "error", text: string) {
  notice = { kind, text };
  render();
}
function walletButtons(action: string) {
  if (busy) return `<button class="primary" disabled>${esc(busy)}</button>`;
  if (!wallets)
    return `<button class="primary" data-act="${action}">지갑 연결 · 서명</button>`;
  if (!wallets.length)
    return `<p class="warn">지갑 확장 프로그램을 찾지 못했습니다. Ronin Wallet 또는 MetaMask를 설치하고 새로고침하세요.</p>`;
  return `<div class="wallets">${wallets.map((w, i) => `<button class="primary" data-act="${action}" data-wallet="${i}">${esc(w.name)}로 서명</button>`).join("")}</div>`;
}

async function signWith(choice: WalletChoice, setup: boolean) {
  busy = `${choice.name}에서 서명을 승인하세요…`;
  wallets = null;
  render();
  try {
    if (setup) {
      const setupCode = (
        document.getElementById("setup-code") as HTMLInputElement
      ).value.trim();
      if (!setupCode)
        throw new Error("서버 터미널에 출력된 등록 코드를 입력하세요.");
      const signed = await signChallenge(choice.provider, (address) =>
        api("POST", "/api/admin/setup/challenge", { address, setupCode }),
      );
      await api("POST", "/api/admin/setup", { ...signed, setupCode });
      notice = { kind: "ok", text: "관리자 지갑을 등록했습니다." };
    } else {
      const signed = await signChallenge(choice.provider, (address) =>
        api("POST", "/api/auth/challenge", { address }),
      );
      await api("POST", "/api/auth/session", signed);
    }
  } catch (error) {
    notice = { kind: "error", text: walletErrorMessage(error) };
  } finally {
    busy = "";
    await load();
  }
}
function pickWallet(action: string, index?: string) {
  if (index !== undefined) {
    void signWith(wallets![Number(index)], action === "setup");
    return;
  }
  discovery.request();
  const found = discovery.wallets();
  if (found.length === 1) void signWith(found[0], action === "setup");
  else {
    wallets = found;
    render();
  }
}

function setupView() {
  return `<section class="gate card">
    <span class="eyebrow">FIRST RUN · 관리자 등록</span>
    <h1>관리자 지갑 등록</h1>
    <p>아직 관리자가 없습니다. 서버를 실행한 터미널에 출력된 <b>관리자 등록 코드</b>를 입력하고, 관리자로 쓸 지갑으로 서명하세요. 등록은 한 번만 할 수 있고 이후에는 이 지갑만 관리자 메뉴에 들어올 수 있습니다.</p>
    <label>관리자 등록 코드<input id="setup-code" placeholder="ABCD-1234" autocomplete="off" spellcheck="false" maxlength="32"></label>
    ${walletButtons("setup")}
    <small>서명만 하며 거래나 토큰 사용 승인은 하지 않습니다.</small>
  </section>`;
}
function loginView() {
  return `<section class="gate card">
    <span class="eyebrow">ADMIN SIGN-IN</span>
    <h1>관리자 로그인</h1>
    <p>등록된 관리자 지갑으로 서명하세요. 다른 지갑으로 로그인하면 관리자 메뉴가 열리지 않습니다.</p>
    ${walletButtons("login")}
  </section>`;
}

function statTiles(o: Overview, s: Status) {
  const inFlight = o.rewards.filter(
    (r) => r.status === "PENDING" || r.status === "SUBMITTED",
  );
  const paid = o.rewards
    .filter((r) => r.status === "DONE")
    .reduce((n, r) => n + toMicro(r.amount), 0n);
  const budget = !s.metanomic.connected
    ? "미설정"
    : o.budget?.available
      ? `${Number(o.budget.available).toLocaleString("ko-KR")} CGC`
      : "조회 실패";
  return `<section class="tiles">
    <div class="tile ${s.metanomic.connected ? "ok" : "warn"}"><span>Metanomic</span><strong>${s.metanomic.connected ? "연결됨" : "미설정"}</strong><small>${s.metanomic.connected ? `${esc(s.metanomic.gameId ?? "")} · ${esc(s.metanomic.assetId ?? "")}` : "지급 요청은 저장 후 대기"}</small></div>
    <div class="tile"><span>사용 가능 예산</span><strong>${budget}</strong><small>${o.budgetError ? esc(o.budgetError) : "게임 예산 · 계약이 최종 검사"}</small></div>
    <div class="tile ${o.autoEnabled ? "ok" : "warn"}"><span>자동 지급</span><strong>${o.autoEnabled ? "켜짐" : "꺼짐"}</strong><small>${o.heldMatches ? `예산 부족 보류 ${o.heldMatches}경기` : "경기 종료 시 규칙대로 지급"}</small></div>
    <div class="tile"><span>처리 중 지급</span><strong>${inFlight.length}건</strong><small>Saigon 최종 확정 약 20–30분</small></div>
    <div class="tile"><span>지급 완료</span><strong>${coins(paid)}</strong><small>최근 100건 기준</small></div>
  </section>${
    s.metanomic.connected
      ? ""
      : `<p class="banner">Metanomic이 설정되지 않아 지급 요청을 서버 DB에 저장만 합니다. 서버에 <code>METANOMIC_API_URL</code>, <code>METANOMIC_GAME_ID</code>, <code>METANOMIC_GAME_KEY</code>(선택 <code>METANOMIC_ASSET_ID</code>)를 설정하고 재시작하면 대기 중인 지급을 같은 요청 키로 전송합니다.</p>`
  }${
    o.heldMatches
      ? `<p class="banner">예산이 부족해 자동 보상 ${o.heldMatches}경기가 보류되었습니다. 예산을 확보한 뒤 아래 최근 경기에서 <b>보류 지급</b>을 누르세요.</p>`
      : ""
  }`;
}
function playersPanel(o: Overview) {
  const all = o.players.length && o.players.every((p) => selected.has(p.id));
  const rows = o.players
    .map(
      (p) => `<tr class="${selected.has(p.id) ? "picked" : ""}">
      <td><input type="checkbox" data-pick="${esc(p.id)}" ${selected.has(p.id) ? "checked" : ""} aria-label="${esc(p.name)} 선택"></td>
      <td><strong>${esc(p.name)}</strong><small title="${esc(p.wallet)}">${short(p.wallet)}</small></td>
      <td class="num">${p.matches}전 ${p.wins}승</td>
      <td class="num">${p.kills} / ${p.deaths}</td>
      <td class="num">${p.damage.toLocaleString("ko-KR")}</td>
      <td class="num">${coins(toMicro(p.paid))}${toMicro(p.pending) > 0n ? `<small>+${coins(toMicro(p.pending))} 처리 중</small>` : ""}</td>
    </tr>`,
    )
    .join("");
  return `<section class="panel">
    <header><h2>플레이어</h2><small>지갑으로 로그인한 계정 ${o.players.length}명</small></header>
    ${
      o.players.length
        ? `<div class="scroll"><table><thead><tr><th><input type="checkbox" data-pick-all ${all ? "checked" : ""} aria-label="전체 선택"></th><th>함장 · 지갑</th><th class="num">전적</th><th class="num">격침/침몰</th><th class="num">누적 피해</th><th class="num">받은 CGC</th></tr></thead><tbody>${rows}</tbody></table></div>`
        : '<p class="empty">아직 지갑으로 로그인한 플레이어가 없습니다.</p>'
    }
  </section>`;
}
function payPanel(o: Overview) {
  const picked = o.players.filter((p) => selected.has(p.id));
  const amount =
    (document.getElementById("pay-amount") as HTMLInputElement | null)?.value ??
    "";
  const memo =
    (document.getElementById("pay-memo") as HTMLInputElement | null)?.value ??
    "";
  const valid = AMOUNT.test(amount) && toMicro(amount) > 0n;
  const total = valid ? coins(toMicro(amount) * BigInt(picked.length)) : "–";
  const confirming = Date.now() < confirmUntil;
  return `<aside class="panel pay">
    <header><h2>보상 지급</h2><small>선택한 플레이어의 로그인 지갑으로 지급</small></header>
    <div class="chips">${picked.length ? picked.map((p) => `<span>${esc(p.name)}</span>`).join("") : "<em>왼쪽 목록이나 최근 경기에서 받을 플레이어를 선택하세요.</em>"}</div>
    <label>1인당 금액 (CGC)<input id="pay-amount" inputmode="decimal" placeholder="예: 10" value="${esc(amount)}" autocomplete="off"></label>
    <label>사유 (선택)<input id="pay-memo" maxlength="80" placeholder="예: 10월 4주 거점전 1위" value="${esc(memo)}"></label>
    ${matchContext ? `<small class="context">경기 #${matchContext} 보상으로 기록됩니다.</small>` : ""}
    <div class="total"><span>${picked.length}명 × ${valid ? esc(amount) : "–"} CGC</span><strong>${total}</strong></div>
    <button class="primary ${confirming ? "confirm" : ""}" data-act="pay" ${picked.length && valid && !busy ? "" : "disabled"}>${confirming ? `확인 · ${picked.length}명에게 ${total} 지급` : "지급 요청"}</button>
    <small>요청은 먼저 서버 DB에 저장되고, 같은 요청 키로 Metanomic에 전송해 중복 지급을 막습니다.</small>
  </aside>`;
}
function matchesPanel(o: Overview) {
  if (!o.matches.length)
    return '<section class="panel"><header><h2>최근 경기</h2></header><p class="empty">끝난 경기가 아직 없습니다.</p></section>';
  return `<section class="panel"><header><h2>최근 경기</h2><small>지갑 계정만 선택할 수 있습니다</small></header><div class="matches">${o.matches
    .map(
      (m) => `<article class="match">
      <header><strong>${modeName(m.mode)}</strong><span>#${m.id} · 전장 ${esc(m.room)} · ${time(m.endedAt)}</span></header>
      <ol>${m.entries
        .map(
          (e) =>
            `<li class="${e.accountId ? "" : "guest"}"><b>${e.place}</b><span>${esc(e.name)}<small>${HULL[e.hull] ?? esc(e.hull)}${e.accountId ? "" : " · 게스트/NPC"}</small></span><em>${m.mode === "domination" ? `${e.score}점 · ` : ""}${e.kills}격침 · ${e.damage.toLocaleString("ko-KR")}</em>${autoReward(m, e.accountId)}</li>`,
        )
        .join("")}</ol>
      ${matchRewardNote(m)}
      <footer>${m.rewards.some((r) => r.status === "HELD") ? `<button class="primary small" data-release="${m.id}">보류 지급</button>` : ""}<button class="outline" data-match="${m.id}" data-scope="winner">1위 선택</button><button class="outline" data-match="${m.id}" data-scope="all">참가자 모두 선택</button></footer>
    </article>`,
    )
    .join("")}</div></section>`;
}
const REWARD_STATE = { QUEUED: "자동 지급", HELD: "보류", SKIPPED: "미지급" };
function autoReward(m: Match, accountId: string | null) {
  const r = accountId && m.rewards.find((x) => x.accountId === accountId);
  if (!r) return "";
  const detail = r.items
    .map((i) => `${i.label} ${coins(toMicro(i.amount))}`)
    .join("\n");
  return `<i class="auto ${r.status.toLowerCase()}" title="${esc(detail + (r.note ? `\n${r.note}` : ""))}">${REWARD_STATE[r.status]} ${r.status === "SKIPPED" ? "" : coins(toMicro(r.amount))}${r.note ? ` · ${esc(r.note)}` : ""}</i>`;
}
function matchRewardNote(m: Match) {
  const skipped = m.rewards.find((r) => r.accountId === "*");
  return skipped
    ? `<small class="muted">자동 보상 없음: ${esc(skipped.note ?? "")}</small>`
    : "";
}
// Same reference already used: a new reward could pay twice (§9).
const REFERENCE_CONFLICTS = [
  "IDEMPOTENCY_CONFLICT",
  "BUSINESS_REFERENCE_CONFLICT",
];
const STATUS_LABEL = {
  PENDING: "전송 대기",
  SUBMITTED: "확정 대기",
  DONE: "지급 완료",
  FAILED: "실패",
};
function historyPanel(o: Overview, s: Status) {
  if (!o.rewards.length)
    return '<section class="panel"><header><h2>지급 내역</h2></header><p class="empty">아직 지급 요청이 없습니다.</p></section>';
  return `<section class="panel"><header><h2>지급 내역</h2><small>최근 100건 · 5초마다 갱신</small></header><div class="scroll"><table><thead><tr><th>요청 시각</th><th>받는 사람</th><th class="num">금액</th><th>사유</th><th>상태</th><th></th></tr></thead><tbody>${o.rewards
    .map(
      (r) => `<tr>
      <td>${time(r.createdAt)}</td>
      <td><strong>${esc(r.name)}</strong><small title="${esc(r.wallet)}">${short(r.wallet)}</small></td>
      <td class="num">${coins(toMicro(r.amount))}</td>
      <td>${esc(r.memo) || "–"}${r.matchId ? `<small>경기 #${r.matchId}</small>` : ""}</td>
      <td><span class="pill ${r.status.toLowerCase()}">${r.status === "PENDING" && !s.metanomic.connected ? "연결 대기" : STATUS_LABEL[r.status]}</span>${r.error ? `<small class="error">${esc(r.error)}</small>` : ""}</td>
      <td>${r.status !== "FAILED" ? "" : r.error && REFERENCE_CONFLICTS.includes(r.error) ? '<small class="error">기존 보상 확인 필요</small>' : `<button class="outline" data-reissue="${esc(r.id)}">다시 지급</button>`}</td>
    </tr>`,
    )
    .join("")}</tbody></table></div></section>`;
}
function dashboard(s: Status, o: Overview) {
  return `<header class="topbar">
    <div class="brand"><b>IRON TIDE</b><span>관리자 콘솔</span></div>
    <div class="who"><span class="badge">관리자</span><span title="${esc(s.wallet ?? "")}">${short(s.wallet ?? "")}</span><a href="/">게임으로</a><button class="text" data-act="logout">로그아웃</button></div>
  </header>
  <nav class="tabs" role="tablist">
    <button role="tab" aria-selected="${tab === "pay"}" data-tab="pay">지급 관리</button>
    <button role="tab" aria-selected="${tab === "rules"}" data-tab="rules">보상 규칙</button>
  </nav>
  ${
    tab === "rules"
      ? rulesTab.view()
      : `${statTiles(o, s)}
  <div class="layout">${playersPanel(o)}${payPanel(o)}</div>
  ${matchesPanel(o)}
  ${historyPanel(o, s)}`
  }`;
}

function render() {
  // Preserve what the admin is typing across re-renders.
  const focus = document.activeElement as HTMLInputElement | null,
    focusId = focus?.id,
    caret = focus?.selectionStart ?? null;
  const code = (
    document.getElementById("setup-code") as HTMLInputElement | null
  )?.value;
  const body = !status
    ? '<p class="loading">불러오는 중…</p>'
    : !status.hasAdmin
      ? setupView()
      : !status.isAdmin
        ? loginView()
        : overview
          ? dashboard(status, overview)
          : '<p class="loading">불러오는 중…</p>';
  root.innerHTML = `${notice ? `<p class="notice ${notice.kind}" role="status">${esc(notice.text)}</p>` : ""}${body}`;
  if (code !== undefined) {
    const input = document.getElementById(
      "setup-code",
    ) as HTMLInputElement | null;
    if (input) input.value = code;
  }
  if (focusId) {
    const again = document.getElementById(focusId) as HTMLInputElement | null;
    again?.focus();
    if (again && caret !== null) again.setSelectionRange(caret, caret);
  }
}

async function load() {
  try {
    status = await api<Status>("GET", "/api/admin/status");
    overview = status.isAdmin
      ? await api<Overview>("GET", "/api/admin/overview")
      : null;
    if (overview)
      selected = new Set(
        [...selected].filter((id) =>
          overview!.players.some((p) => p.id === id),
        ),
      );
  } catch (error) {
    notice = {
      kind: "error",
      text: error instanceof Error ? error.message : "불러오지 못했습니다.",
    };
  }
  render();
}

async function pay() {
  const amount = (
    document.getElementById("pay-amount") as HTMLInputElement
  ).value.trim();
  const memo = (document.getElementById("pay-memo") as HTMLInputElement).value;
  if (Date.now() >= confirmUntil) {
    confirmUntil = Date.now() + 5000;
    render();
    setTimeout(render, 5100);
    return;
  }
  confirmUntil = 0;
  busy = "지급 요청 중…";
  render();
  try {
    overview = await api<Overview>("POST", "/api/admin/rewards", {
      accountIds: [...selected],
      amount,
      memo,
      matchId: matchContext,
    });
    say("ok", `${selected.size}명에게 ${amount} CGC 지급을 요청했습니다.`);
    selected = new Set();
    matchContext = null;
    (document.getElementById("pay-amount") as HTMLInputElement).value = "";
    (document.getElementById("pay-memo") as HTMLInputElement).value = "";
  } catch (error) {
    say(
      "error",
      error instanceof Error ? error.message : "지급 요청에 실패했습니다.",
    );
  } finally {
    busy = "";
    render();
  }
}

root.addEventListener("click", (event) => {
  const el = (event.target as Element).closest<HTMLElement>(
    "[data-act],[data-match],[data-reissue],[data-tab],[data-rules-act],[data-release]",
  );
  if (!el) return;
  notice = null;
  if (el.dataset.tab) {
    tab = el.dataset.tab === "rules" ? "rules" : "pay";
    if (tab === "rules") void rulesTab.load();
    render();
    return;
  }
  if (rulesTab.click(el)) return;
  if (el.dataset.release) {
    void api<Overview>(
      "POST",
      `/api/admin/match-rewards/${el.dataset.release}/release`,
    )
      .then((o) => {
        overview = o;
        say("ok", `경기 #${el.dataset.release}의 보류된 보상을 지급합니다.`);
      })
      .catch((error) => say("error", error.message));
    return;
  }
  const act = el.dataset.act;
  if (act === "setup" || act === "login") pickWallet(act, el.dataset.wallet);
  else if (act === "pay") void pay();
  else if (act === "logout") void api("DELETE", "/api/auth/session").then(load);
  else if (el.dataset.match) {
    const match = overview?.matches.find(
      (m) => m.id === Number(el.dataset.match),
    );
    const ids = (match?.entries ?? [])
      .filter(
        (e) => e.accountId && (el.dataset.scope === "all" || e.place === 1),
      )
      .map((e) => e.accountId!);
    if (!ids.length)
      say("error", "이 경기에는 지갑으로 로그인한 대상이 없습니다.");
    else {
      selected = new Set(ids);
      matchContext = match!.id;
      render();
    }
  } else if (el.dataset.reissue)
    void api<Overview>(
      "POST",
      `/api/admin/rewards/${encodeURIComponent(el.dataset.reissue)}/reissue`,
    )
      .then((o) => {
        overview = o;
        say("ok", "새 요청으로 다시 지급합니다.");
      })
      .catch((error) => say("error", error.message));
});
root.addEventListener("change", (event) => {
  const input = event.target as HTMLInputElement;
  if (rulesTab.input(input)) return;
  if (input.dataset.pick) {
    if (input.checked) selected.add(input.dataset.pick);
    else selected.delete(input.dataset.pick);
    matchContext = null;
    render();
  } else if (input.hasAttribute("data-pick-all")) {
    selected = new Set(input.checked ? overview!.players.map((p) => p.id) : []);
    matchContext = null;
    render();
  }
});
root.addEventListener("input", (event) => {
  const target = event.target as HTMLInputElement;
  if (target.type !== "checkbox" && rulesTab.input(target)) return;
  if ((event.target as HTMLElement).id === "pay-amount") {
    confirmUntil = 0;
    render();
  }
});

void load();
setInterval(() => {
  if (status?.isAdmin && !busy && Date.now() >= confirmUntil) void load();
}, 5000);
