export type Hull = "destroyer" | "cruiser" | "battleship";
export type NpcModel = "camouflage" | "wisconsin-golden";
export type Ammo = "HE" | "AP" | "SAP" | "TORP" | "MINE" | "RBU";
export type Upgrade =
  | "range"
  | "salvo"
  | "reload"
  | "secondary"
  | "torpedo"
  | "engine"
  | "accuracy";
export type Vec2 = { x: number; z: number };
export type ModuleKind = "turret" | "rudder" | "engine";
/** Timed boosts from floating supply crates. */
export type BuffKind = "range" | "firepower" | "armor" | "engine" | "reload";
export type PickupKind = BuffKind | "repair";
export interface Pickup extends Vec2 {
  id: number;
  kind: PickupKind;
  expires: number;
}
export type Phase = "lobby" | "battle" | "results";
/**
 * deathmatch: ranked by kills. domination: race to the score limit by holding
 * zones. team: two fleets race to the team kill limit.
 */
export type GameMode = "deathmatch" | "domination" | "team";
/** Team index in team matches: 0 = red fleet, 1 = blue fleet. */
export type Team = 0 | 1;
export interface Zone extends Vec2 {
  id: string;
  radius: number;
  owner: string | null;
  /** Ship currently taking the zone and its progress 0..1. */
  capturer: string | null;
  progress: number;
  contested: boolean;
}
export interface Input {
  throttle: number;
  rudder: number;
  aim: Vec2;
  weapon: Ammo;
  firing: boolean;
  target: string | null;
}
export interface Status {
  fire: number[];
  flood: number;
  immune: number;
  dcp: number;
  special: number;
  charges: number;
  smoke: number;
  sonar: number;
  heal: number;
  healPool: number;
  protection: number;
  /** Seconds the steering gear stays jammed at its current angle. */
  rudderJam: number;
  /** Seconds the machinery is damaged (half top speed). */
  engineHit: number;
}
export interface Stats {
  damage: number;
  kills: number;
  deaths: number;
  shots: number;
  hits: number;
  /** Domination points: zone holding, captures and kills. */
  score: number;
}
export interface Ship {
  id: string;
  bot: boolean;
  npcModel?: NpcModel;
  name: string;
  hull: Hull;
  x: number;
  z: number;
  heading: number;
  speed: number;
  grounded: boolean;
  turn: number;
  hp: number;
  maxHp: number;
  alive: boolean;
  respawnAt: number;
  connected: boolean;
  disconnectedAt: number;
  input: Input;
  turrets: {
    angle: number;
    reload: number;
    offset: number;
    disabled?: number;
  }[];
  torpedoReload: number;
  mineReload: number;
  minesLeft: number;
  rocketReload: number;
  rocketsLeft: number;
  secondaryReload: number;
  secondaries: boolean;
  status: Status;
  bloom: number;
  level: number;
  xp: number;
  points: number;
  upgrades: Record<Upgrade, number>;
  stats: Stats;
  /** Seconds left on each active supply-crate boost. */
  buffs: Partial<Record<BuffKind, number>>;
}
export interface Projectile {
  id: number;
  owner: string;
  kind: Ammo | "SECONDARY";
  x: number;
  z: number;
  y: number;
  vx: number;
  vz: number;
  vy: number;
  age: number;
  life: number;
  damage: number;
  caliber: number;
  range: number;
  distance: number;
  start: Vec2;
  delay?: number;
}
export interface Mine extends Vec2 {
  id: number;
  owner: string;
  armedAt: number;
  expires: number;
}
export interface Smoke extends Vec2 {
  id: number;
  radius: number;
  expires: number;
}
export interface Island extends Vec2 {
  radius: number;
  height: number;
  seed: number;
}
export type HitResult =
  | "penetration"
  | "ricochet"
  | "shatter"
  | "overpen"
  | "citadel"
  | "torpedo"
  | "secondary"
  | "mine"
  | "protected";
export interface GameEvent {
  id: number;
  at: number;
  type:
    | "shot"
    | "splash"
    | "hit"
    | "sink"
    | "respawn"
    | "level"
    | "ability"
    | "intercept"
    | "module"
    | "capture"
    | "pickup";
  x: number;
  z: number;
  owner?: string;
  target?: string;
  result?: HitResult;
  damage?: number;
  text?: string;
  y?: number;
  weapon?: Ammo | "SECONDARY";
  zone?: string;
  armor?: number;
  angle?: number;
  caliber?: number;
  turrets?: number[];
  elevation?: number;
  count?: number;
  module?: ModuleKind;
}
export interface Contact extends Vec2 {
  id: string;
  bot: boolean;
  npcModel?: NpcModel;
  name: string;
  hull: Hull;
  heading: number;
  speed: number;
  hp: number;
  maxHp: number;
  alive: boolean;
  level: number;
  turrets: { angle: number; offset: number }[];
  fire: number;
  protection: number;
  buffs: BuffKind[];
  /** Team matches only. */
  team?: Team;
}
export interface LastSeen extends Vec2 {
  id: string;
  hull: Hull;
  at: number;
}
/** Public profile of a wallet-login account (the wallet is shown only to its owner). */
export interface AccountView {
  wallet: string;
  name: string;
  matches: number;
  wins: number;
  kills: number;
  deaths: number;
  damage: number;
}
export interface Score {
  id: string;
  bot: boolean;
  /** Signed in with a wallet (as opposed to a guest name). */
  verified?: boolean;
  npcModel?: NpcModel;
  /** NPC intelligence 1–5 (lobby only). */
  skill?: number;
  name: string;
  hull: Hull;
  connected: boolean;
  ready: boolean;
  kills: number;
  deaths: number;
  damage?: number;
  level?: number;
  accuracy?: number;
  score?: number;
  /** Team matches (and the lobby while one is set up). */
  team?: Team;
}
export interface Snapshot {
  type: "snapshot";
  room: string;
  host: string;
  phase: Phase;
  time: number;
  remaining: number;
  self: Ship;
  contacts: Contact[];
  lastSeen: LastSeen[];
  projectiles: Projectile[];
  mines: Mine[];
  smokes: Smoke[];
  events: GameEvent[];
  detected: boolean;
  scores: Score[];
  mode: GameMode;
  zones: Zone[];
  scoreLimit: number;
  pickups: Pickup[];
  /** Team matches: own team, kills per team, the limit and the winner at the end. */
  team?: Team;
  teamKills?: [number, number];
  teamKillLimit?: number;
  winner?: Team | null;
}
export interface Lobby {
  type: "lobby";
  room: string;
  host: string;
  phase: Phase;
  players: Score[];
  duration: number;
  mode: GameMode;
}
export type ClientMessage =
  | { type: "create"; name: string }
  | { type: "join"; name: string; room: string }
  | { type: "resume"; room: string; token: string }
  | { type: "select"; hull: Hull }
  | { type: "ready"; ready: boolean }
  | { type: "start" }
  | { type: "addBot"; hull: Hull; model?: NpcModel; skill?: number }
  | { type: "removeBot"; id: string }
  | { type: "mode"; mode: GameMode }
  | { type: "team"; team: Team; id?: string }
  | { type: "input"; input: Input }
  | { type: "salvo" }
  | { type: "ability"; ability: "dcp" | "special" }
  | { type: "upgrade"; upgrade: Upgrade }
  | { type: "secondary" }
  | { type: "rematch" }
  | { type: "leave" }
  | { type: "ping"; at: number };
export type ServerMessage =
  | Lobby
  | Snapshot
  | { type: "welcome"; id: string; token: string; room: string }
  | { type: "error"; message: string }
  | { type: "pong"; at: number }
  | { type: "left" };
