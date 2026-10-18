import type { GameEvent, HitResult, Vec2 } from "../shared/types";
const names: Record<HitResult, string> = {
  penetration: "관통",
  citadel: "핵심 구획",
  overpen: "과관통",
  ricochet: "도탄",
  shatter: "장갑 비관통",
  torpedo: "어뢰",
  secondary: "부포",
  mine: "기뢰",
  protected: "재출격 보호",
};
const zones: Record<string, string> = {
  side: "측면",
  bow: "선수·함미",
  deck: "갑판",
  superstructure: "상부 구조물",
  turret: "포탑",
};
function escape(text: string) {
  return text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}
type Group = {
  at: number;
  target: string;
  name: string;
  weapon: string;
  damage: number;
  count: number;
  results: Partial<Record<HitResult, number>>;
  last: GameEvent;
};
export class HitFeedback {
  private groups: Group[] = [];
  private intercept: { at: number; count: number } | null = null;
  private serial = 0;
  private pops: {
    at: number;
    eventAt: number;
    target: string;
    result: HitResult;
    damage: number;
    count: number;
    last: GameEvent;
    element: HTMLSpanElement;
  }[] = [];
  private tier(damage: number, result: HitResult) {
    return result === "citadel" || damage >= 6000
      ? "critical"
      : damage >= 3000
        ? "heavy"
        : damage >= 1000
          ? "medium"
          : damage > 0
            ? "light"
            : "blocked";
  }
  constructor(
    private panel: HTMLElement,
    private history: HTMLElement,
    private marker: HTMLElement,
    private floats: HTMLElement,
  ) {}
  reset() {
    this.groups = [];
    this.intercept = null;
    this.panel.innerHTML = "";
    this.history.innerHTML = "";
    this.floats.innerHTML = "";
    this.pops = [];
  }
  record(e: GameEvent, name: string) {
    const now = performance.now();
    if (e.type === "intercept") {
      this.intercept = { at: now, count: e.count ?? 1 };
      return;
    }
    if (e.type !== "hit" || !e.result) return;
    let group = this.groups.find(
      (g) =>
        g.target === e.target &&
        g.weapon === (e.weapon ?? "") &&
        now - g.at < 1300,
    );
    if (!group) {
      group = {
        at: now,
        target: e.target ?? "",
        name,
        weapon: e.weapon ?? "",
        damage: 0,
        count: 0,
        results: {},
        last: e,
      };
      this.groups.unshift(group);
    }
    group.at = now;
    group.count++;
    group.damage += e.damage ?? 0;
    group.results[e.result] = (group.results[e.result] ?? 0) + 1;
    group.last = e;
    this.groups = this.groups.slice(0, 8);
    // Coalesce only simultaneous impacts of the same type, never later damage.
    let pop = this.pops.find(
      (p) =>
        p.target === e.target &&
        p.result === e.result &&
        Math.abs(e.at - p.eventAt) < 0.07,
    );
    if (!pop) {
      const element = document.createElement("span");
      element.className = "hit-float";
      element.style.display = "none";
      element.dataset.duration = "3000";
      this.floats.append(element);
      pop = {
        at: now,
        eventAt: e.at,
        target: e.target ?? "",
        result: e.result,
        damage: 0,
        count: 0,
        last: e,
        element,
      };
      this.pops.unshift(pop);
    }
    pop.damage += e.damage ?? 0;
    pop.count++;
    pop.last = e;
    pop.element.dataset.tier = this.tier(pop.damage, pop.result);
    pop.element.textContent =
      pop.damage > 0
        ? `−${Math.round(pop.damage).toLocaleString()}`
        : `명중 · ${names[pop.result]}`;
    this.marker.dataset.kind = (e.damage ?? 0) > 0 ? "damage" : "blocked";
    this.marker.style.animation = "none";
    void this.marker.offsetWidth;
    this.marker.style.animation = "";
    this.marker.dataset.pulse = String(++this.serial);
  }
  render(
    project: (p: Vec2, y: number) => { x: number; y: number; visible: boolean },
  ) {
    const now = performance.now();
    this.groups = this.groups.filter((g) => now - g.at < 6500);
    const primary =
      this.groups.find((g) => g.weapon !== "SECONDARY") ?? this.groups[0];
    if (primary) {
      const positive = primary.damage > 0;
      const results = Object.entries(primary.results)
        .map(([key, count]) => `${names[key as HitResult]} ${count}발`)
        .join(" · ");
      const info = primary.last;
      const detail = [
        zones[info.zone ?? ""] ?? "",
        info.armor !== undefined ? `장갑 ${Math.round(info.armor)}mm` : "",
        info.angle !== undefined ? `입사각 ${Math.round(info.angle)}°` : "",
      ]
        .filter(Boolean)
        .join(" · ");
      this.panel.dataset.kind = positive ? "damage" : "blocked";
      this.panel.dataset.tier = this.tier(primary.damage, primary.last.result!);
      const html = `<strong>${positive ? "명중 확인" : "명중 · 피해 없음"}<b>${positive ? `피해 ${Math.round(primary.damage).toLocaleString()}` : "피해 0"}</b></strong><span>${escape(primary.name)} · ${primary.count}발 명중</span><p>${results}</p><small>${detail}</small>`;
      if (this.panel.innerHTML !== html) this.panel.innerHTML = html;
    } else if (this.intercept && now - this.intercept.at < 5000) {
      this.panel.innerHTML = `<strong>어뢰 ${this.intercept.count}발 요격</strong>`;
      this.panel.dataset.kind = "damage";
    } else this.panel.innerHTML = "";
    this.history.innerHTML = this.groups
      .slice(0, 4)
      .map(
        (g) =>
          `<div class="hit-entry ${g.damage > 0 ? "damage" : "blocked"}"><b>${escape(g.name)}</b><strong>${g.damage > 0 ? `피해 ${Math.round(g.damage).toLocaleString()}` : "명중 · 피해 0"}</strong><span>${Object.entries(
            g.results,
          )
            .map(([r, n]) => `${names[r as HitResult]} ${n}`)
            .join(" · ")}</span></div>`,
      )
      .join("");
    this.pops = this.pops.filter((p) => {
      if (now - p.at < 3000) return true;
      p.element.remove();
      return false;
    });
    const slots = new Map<string, number>();
    for (const pop of this.pops) {
      const p = project(pop.last, (pop.last.y ?? 4) + 3);
      const index = slots.get(pop.target) ?? 0;
      const total = this.pops.filter((p) => p.target === pop.target).length;
      slots.set(pop.target, index + 1);
      const age = now - pop.at;
      pop.element.style.display = p.visible ? "block" : "none";
      pop.element.style.left = `${Math.min(innerWidth - 160, Math.max(160, p.x + 155))}px`;
      pop.element.style.top = `${p.y - 25 - (total - 1 - index) * 76 - age * 0.009}px`;
      pop.element.style.opacity = String(Math.min(1, (3000 - age) / 450));
      pop.element.style.setProperty(
        "--pop-scale",
        String(age < 180 ? 1.5 - (0.5 * age) / 180 : 1),
      );
    }
  }
}
