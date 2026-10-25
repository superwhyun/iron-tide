import { api } from "../wallet";
import { coins, errorText, esc, modeName, time, toMicro } from "./format";

type ModeScope = "all" | "deathmatch" | "domination" | "team";
interface Rule {
  enabled: boolean;
  modes: ModeScope;
}
/** Mirrors server/rewardRules.ts; numbers arrive as strings while editing. */
export interface RewardRules {
  enabled: boolean;
  rank: Rule & { amounts: string[]; minWallets: number | string };
  playerKill: Rule & { amount: string };
  npc: {
    enabled: boolean;
    share: number | string;
    skillPercent: (number | string)[];
  };
  damage: Rule & { amount: string; per: number | string };
  domination: Rule & { amount: string; per: number | string };
  survival: Rule & { amount: string; minWallets: number | string };
  participation: Rule & { amount: string };
  teamWin: Rule & { amount: string };
  conditions: { minWallets: number | string; minDuration: number | string };
  caps: {
    perMatch: string;
    perPlayerDaily: string;
    dailyTotal: string;
    minPayout: string;
  };
}
interface PreviewPlayer {
  name: string;
  earned: string;
  amount: string;
  items: { label: string; amount: string }[];
  note?: string;
}
interface Preview {
  total: string;
  paidMatches: number;
  players: { name: string; amount: string }[];
  matches: {
    id: number;
    mode: string;
    endedAt: number;
    duration: number;
    skipped?: string;
    players: PreviewPlayer[];
  }[];
}
type RuleKey =
  | "rank"
  | "playerKill"
  | "damage"
  | "domination"
  | "survival"
  | "participation"
  | "teamWin";

const MAX_RANKS = 10;
const MODE_LABEL: Record<ModeScope, string> = {
  all: "모든 경기",
  deathmatch: "격침전만",
  domination: "거점전만",
  team: "팀전만",
};

/** Sets `value` at a dotted path on a copy of `rules`. */
function setIn(rules: RewardRules, path: string, value: unknown): RewardRules {
  const copy = structuredClone(rules) as unknown as Record<string, unknown>;
  const keys = path.split(".");
  let node = copy as Record<string, unknown>;
  for (const key of keys.slice(0, -1))
    node = node[key] as Record<string, unknown>;
  node[keys[keys.length - 1]] = value;
  return copy as unknown as RewardRules;
}
const decimal = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * The "보상 규칙" tab: edit the automatic reward rules, preview them on
 * recent matches, and save. Owns its draft so the 5 s refresh never
 * overwrites what the admin is typing.
 */
export class RulesTab {
  private saved: RewardRules | null = null;
  private defaults: RewardRules | null = null;
  private draft: RewardRules | null = null;
  private preview: Preview | null = null;
  private busy = "";
  private error = "";
  constructor(
    private render: () => void,
    private say: (kind: "ok" | "error", text: string) => void,
  ) {}
  get dirty() {
    return JSON.stringify(this.draft) !== JSON.stringify(this.saved);
  }
  async load() {
    if (this.saved) return;
    try {
      const r = await api<{ rules: RewardRules; defaults: RewardRules }>(
        "GET",
        "/api/admin/rules",
      );
      this.saved = r.rules;
      this.defaults = r.defaults;
      this.draft = structuredClone(r.rules);
    } catch (error) {
      this.error = errorText(error, "규칙을 불러오지 못했습니다.");
    }
    this.render();
  }

  // ── input ────────────────────────────────────────────────────────────
  /** Returns true when the event belonged to this tab. */
  input(el: HTMLInputElement | HTMLSelectElement) {
    const path = el.dataset.rule;
    if (!path || !this.draft) return false;
    const value =
      el instanceof HTMLInputElement && el.type === "checkbox"
        ? el.checked
        : el.value.trim();
    this.draft = setIn(this.draft, path, value);
    this.preview = null;
    this.render();
    return true;
  }
  click(el: HTMLElement) {
    const act = el.dataset.rulesAct;
    if (!act || !this.draft) return false;
    if (act === "rank-add" && this.draft.rank.amounts.length < MAX_RANKS)
      this.draft = setIn(this.draft, "rank.amounts", [
        ...this.draft.rank.amounts,
        "0",
      ]);
    else if (act === "rank-remove")
      this.draft = setIn(
        this.draft,
        "rank.amounts",
        this.draft.rank.amounts.filter(
          (_, i) => i !== Number(el.dataset.index),
        ),
      );
    else if (act === "defaults") this.draft = structuredClone(this.defaults!);
    else if (act === "revert") this.draft = structuredClone(this.saved!);
    else if (act === "preview") void this.runPreview();
    else if (act === "save") void this.save();
    if (act !== "preview" && act !== "save") this.preview = null;
    this.render();
    return true;
  }
  private async runPreview() {
    this.busy = "preview";
    this.render();
    try {
      this.preview = await api<Preview>("POST", "/api/admin/rules/preview", {
        rules: this.draft,
      });
    } catch (error) {
      this.say("error", errorText(error, "미리보기에 실패했습니다."));
    } finally {
      this.busy = "";
      this.render();
    }
  }
  private async save() {
    this.busy = "save";
    this.render();
    try {
      const r = await api<{ rules: RewardRules }>("PUT", "/api/admin/rules", {
        rules: this.draft,
      });
      this.saved = r.rules;
      this.draft = structuredClone(r.rules);
      this.say(
        "ok",
        `보상 규칙을 저장했습니다. 다음에 끝나는 경기부터 적용됩니다${r.rules.enabled ? "" : " (자동 지급 꺼짐)"}.`,
      );
    } catch (error) {
      this.say("error", errorText(error, "저장에 실패했습니다."));
    } finally {
      this.busy = "";
      this.render();
    }
  }

  // ── view ─────────────────────────────────────────────────────────────
  view() {
    if (this.error) return `<p class="notice error">${esc(this.error)}</p>`;
    const d = this.draft;
    if (!d) return '<p class="loading">규칙을 불러오는 중…</p>';
    return `
      ${this.headView(d)}
      <div class="rule-grid">
        ${this.rankCard(d)}
        ${this.killCard(d)}
        ${this.card(d, "damage", "피해량", `<label class="inline">${this.text("damage.amount", d.damage.amount)} CGC / 피해 ${this.text("damage.per", d.damage.per, "int")}</label>`, "적에게 준 실제 피해량에 비례합니다. NPC에게 준 피해는 아래 NPC 비율을 적용합니다.")}
        ${this.card(d, "domination", "거점 점수", `<label class="inline">${this.text("domination.amount", d.domination.amount)} CGC / ${this.text("domination.per", d.domination.per, "int")}점</label>`, "거점전 점수(거점 보유·점령·격침)에 비례합니다. 거점전에서만 계산됩니다.")}
        ${this.card(d, "survival", "무침몰 보너스", `<label class="inline">${this.text("survival.amount", d.survival.amount)} CGC</label><label class="inline">지갑 함장 ${this.text("survival.minWallets", d.survival.minWallets, "int")}명 이상일 때</label>`, "경기 내내 한 번도 침몰하지 않은 함장에게 줍니다.")}
        ${this.card(d, "teamWin", "팀 승리", `<label class="inline">${this.text("teamWin.amount", d.teamWin.amount)} CGC</label>`, "팀전에서 이긴 함대의 지갑 함장 모두에게 줍니다. 무승부면 주지 않습니다.")}
        ${this.card(d, "participation", "참가 보상", `<label class="inline">${this.text("participation.amount", d.participation.amount)} CGC</label>`, "경기가 끝날 때까지 남아 있던 지갑 함장 모두에게 줍니다.")}
        ${this.conditionsCard(d)}
        ${this.capsCard(d)}
      </div>
      ${this.previewView()}`;
  }
  private text(
    path: string,
    value: string | number,
    kind: "amount" | "int" = "amount",
  ) {
    return `<input class="num-input" id="rule-${path.replace(/\./g, "-")}" data-rule="${path}" value="${esc(String(value))}" inputmode="${kind === "int" ? "numeric" : "decimal"}" autocomplete="off" aria-label="${esc(path)}">`;
  }
  private toggle(path: string, on: boolean, label: string) {
    return `<label class="switch"><input type="checkbox" id="rule-${path.replace(/\./g, "-")}" data-rule="${path}" ${on ? "checked" : ""}><span></span>${esc(label)}</label>`;
  }
  private modeSelect(key: RuleKey, value: ModeScope) {
    return `<select data-rule="${key}.modes" id="rule-${key}-modes" aria-label="적용 경기">${(
      Object.keys(MODE_LABEL) as ModeScope[]
    )
      .map(
        (m) =>
          `<option value="${m}" ${m === value ? "selected" : ""}>${MODE_LABEL[m]}</option>`,
      )
      .join("")}</select>`;
  }
  private card(
    d: RewardRules,
    key: RuleKey,
    title: string,
    body: string,
    hint: string,
  ) {
    const rule = d[key];
    return `<section class="rule-card ${rule.enabled ? "" : "off"}">
      <header>${this.toggle(`${key}.enabled`, rule.enabled, title)}${this.modeSelect(key, rule.modes)}</header>
      <div class="rule-body">${body}</div>
      <small>${hint}</small>
    </section>`;
  }
  private headView(d: RewardRules) {
    const dirty = this.dirty;
    return `<section class="rules-head ${d.enabled ? "live" : ""}">
      <div>
        ${this.toggle("enabled", d.enabled, "경기 종료 시 자동 지급")}
        <small>${d.enabled ? "경기가 끝나면 아래 규칙으로 계산해 지갑 함장에게 바로 지급합니다. 경기·참가자마다 고정 요청 키를 써서 두 번 지급되지 않습니다." : "꺼져 있습니다. 경기가 끝나도 보상을 계산하거나 지급하지 않습니다."}</small>
      </div>
      <div class="rules-actions">
        ${dirty ? '<span class="dirty">저장하지 않은 변경</span>' : ""}
        <button class="outline" data-rules-act="defaults">기본값</button>
        ${dirty ? '<button class="outline" data-rules-act="revert">되돌리기</button>' : ""}
        <button class="outline" data-rules-act="preview" ${this.busy ? "disabled" : ""}>${this.busy === "preview" ? "계산 중…" : "최근 경기로 미리보기"}</button>
        <button class="primary" data-rules-act="save" ${dirty && !this.busy ? "" : "disabled"}>${this.busy === "save" ? "저장 중…" : "저장"}</button>
      </div>
    </section>`;
  }
  private rankCard(d: RewardRules) {
    const rows = d.rank.amounts
      .map(
        (a, i) =>
          `<li><b>${i + 1}위</b>${this.text(`rank.amounts.${i}`, a)} CGC${d.rank.amounts.length > 1 ? `<button class="text" data-rules-act="rank-remove" data-index="${i}" aria-label="${i + 1}위 삭제">삭제</button>` : ""}</li>`,
      )
      .join("");
    return this.card(
      d,
      "rank",
      "순위 보상",
      `<ol class="rank-rows">${rows}</ol>
       ${d.rank.amounts.length < MAX_RANKS ? '<button class="outline small" data-rules-act="rank-add">+ 순위 추가</button>' : ""}
       <label class="inline">지갑 함장 ${this.text("rank.minWallets", d.rank.minWallets, "int")}명 이상일 때</label>`,
      "NPC를 뺀 사람 사이의 순위입니다. 혼자 NPC와 싸운 경기에는 주지 않도록 최소 인원을 둡니다.",
    );
  }
  private killCard(d: RewardRules) {
    const kill = decimal(d.playerKill.amount),
      share = decimal(d.npc.share);
    const levels = d.npc.skillPercent
      .map((p, i) => {
        const each = (kill * share * decimal(p)) / 10_000;
        return `<li><b>지능 ${i + 1}</b>${this.text(`npc.skillPercent.${i}`, p, "int")}%<em>${each.toLocaleString("ko-KR", { maximumFractionDigits: 6 })} CGC</em></li>`;
      })
      .join("");
    return this.card(
      d,
      "playerKill",
      "격침 보상",
      `<label class="inline">플레이어 함선 1척당 ${this.text("playerKill.amount", d.playerKill.amount)} CGC</label>
       <div class="npc-block ${d.npc.enabled ? "" : "off"}">
         ${this.toggle("npc.enabled", d.npc.enabled, "NPC 격침·피해에도 지급")}
         <label class="inline">플레이어 보상의 ${this.text("npc.share", d.npc.share, "int")}% × 지능별 비율</label>
         <ol class="npc-levels">${levels}</ol>
       </div>`,
      "NPC 비율은 피해량 보상에도 똑같이 적용합니다. NPC 사냥으로 예산이 빠지지 않도록 낮게 두세요.",
    );
  }
  private conditionsCard(d: RewardRules) {
    return `<section class="rule-card fixed">
      <header><h3>지급 조건</h3></header>
      <div class="rule-body">
        <label class="inline">지갑 함장 ${this.text("conditions.minWallets", d.conditions.minWallets, "int")}명 이상 참가</label>
        <label class="inline">경기 시간 ${this.text("conditions.minDuration", d.conditions.minDuration, "int")}초 이상</label>
      </div>
      <small>조건을 못 채운 경기는 아무에게도 지급하지 않습니다. 중간에 나간 함장은 결과에 없으므로 받지 않습니다.</small>
    </section>`;
  }
  private capsCard(d: RewardRules) {
    return `<section class="rule-card fixed">
      <header><h3>상한</h3></header>
      <div class="rule-body caps">
        <label><span>경기당 1인</span>${this.text("caps.perMatch", d.caps.perMatch)}<em>CGC</em></label>
        <label><span>1인 하루</span>${this.text("caps.perPlayerDaily", d.caps.perPlayerDaily)}<em>CGC</em></label>
        <label><span>게임 전체 하루</span>${this.text("caps.dailyTotal", d.caps.dailyTotal)}<em>CGC</em></label>
        <label><span>최소 지급액</span>${this.text("caps.minPayout", d.caps.minPayout)}<em>CGC</em></label>
      </div>
      <small>하루는 서버 시간 자정 기준입니다. 남은 예산이 한 경기 지급액보다 적으면 그 경기는 보류되고, 지급 관리 탭에서 승인할 수 있습니다.</small>
    </section>`;
  }
  private previewView() {
    const p = this.preview;
    if (!p) return "";
    const top = p.players
      .slice(0, 5)
      .map((x) => `<li>${esc(x.name)}<em>${coins(toMicro(x.amount))}</em></li>`)
      .join("");
    const matches = p.matches
      .map(
        (m) => `<article class="preview-match">
        <header><strong>#${m.id} ${modeName(m.mode)}</strong><span>${time(m.endedAt)} · ${Math.round(m.duration / 60)}분</span></header>
        ${
          m.skipped
            ? `<p class="muted">${esc(m.skipped)}</p>`
            : m.players.length
              ? `<ul>${m.players
                  .map(
                    (x) =>
                      `<li><span>${esc(x.name)}${x.note ? `<small class="warn">${esc(x.note)}</small>` : ""}</span><strong>${coins(toMicro(x.amount))}</strong><small>${x.items.map((i) => `${esc(i.label)} ${coins(toMicro(i.amount))}`).join(" · ") || "해당 규칙 없음"}</small></li>`,
                  )
                  .join("")}</ul>`
              : '<p class="muted">지갑 함장이 없습니다.</p>'
        }
      </article>`,
      )
      .join("");
    return `<section class="panel preview">
      <header><h2>미리보기</h2><small>최근 ${p.matches.length}경기에 지금 규칙을 적용했다면 · 실제 지급 없음</small></header>
      <div class="preview-sum">
        <div><span>총 지급</span><strong>${coins(toMicro(p.total))}</strong></div>
        <div><span>지급된 경기</span><strong>${p.paidMatches} / ${p.matches.length}</strong></div>
        <ol>${top || "<li>받는 사람 없음</li>"}</ol>
      </div>
      <div class="preview-list">${matches || '<p class="muted">끝난 경기가 아직 없습니다.</p>'}</div>
    </section>`;
  }
}
