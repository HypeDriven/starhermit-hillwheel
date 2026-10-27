// The browser build's pure game modules — the deterministic rules (rules.js:
// terrain, physics step, legality, scoring, hashing, commands), the
// versioned content (content.js: themes, lessons, Journey stages,
// challenges, the Daily) and the session with its command log, undo
// snapshots and replay envelope (session.js) — imported unchanged (allowJs)
// and typed here with the shapes this client reads.
import * as RulesJs from "../rules.js";
import * as ContentJs from "../content.js";
import * as SessionJs from "../session.js";

export interface Terrain { height(x: number): number; slope(x: number): number; length: number }
export interface Vehicle {
  x: number; y: number; vx: number; vy: number; angle: number; av: number; grounded: boolean; fuel: number; fuelMax: number;
}
export interface Can { x: number; taken: boolean }
export interface State {
  seed: number; mode: string; roughness: number; tick: number; maxTicks: number; terminalReason: string | null; invalidActions: number;
  vehicle: Vehicle; terrain: Terrain; checkpoints: number[]; cans: Can[]; goalX: number; nextCheckpoint: number;
  cansCollected: number; smoothLandings: number; wasAirborne: boolean; airTime: number;
  input: { throttle: number; brake: number; tilt: number };
}
export interface Config {
  seed: number; length: number; roughness: number; fuel: number; fuelCans: number; checkpoints?: number; maxTicks?: number; mode: string;
}
export interface Breakdown {
  distance: number; checkpointBonus: number; finishBonus: number; landingBonus: number; canBonus: number; fuelBonus: number; timeBonus: number; total: number;
}
export interface Result { sessionId: string; terminalReason: string; breakdown: Breakdown; ticks: number; invalidActions: number; hash: number }
export interface Theme { id: string; name: string; sky: number; fog: number; ground: number; groundFar: number; tree: number; rock: number; accent: number }
export interface Tutorial {
  id: string; order: number; title: string; text: string; requires: { minX?: number; cans?: number }; hint: string | null;
  config: Omit<Config, "seed" | "mode">;
}
export interface Stage { id: string; index: number; name: string; seed: number; length: number; roughness: number; fuel: number; fuelCans: number; checkpoints: number; theme: string; mastery: boolean }
export interface Challenge { id: string; name: string; desc: string; config: Omit<Config, "mode"> }
export interface Daily { id: string; name: string; date: string; seed: number; length: number; roughness: number; fuel: number; fuelCans: number; checkpoints: number; theme: string; excluded: boolean }
export interface Session {
  id: string; config: Config; state: State; snapshots: unknown[];
  nextCommandId(): string;
  apply(cmd: { id: string; type: string; throttle?: number; brake?: number; tilt?: number }): { ok: boolean; reason?: string };
  pushUndoSnapshot(): void;
  undo(): { ok: boolean; reason?: string };
  finished(): boolean;
  result(): Result;
  close(): void;
}

interface RulesApi {
  TICK_RATE: number;
  DT: number;
  TERMINAL: Record<string, string>;
  mulberry32(seed: number): () => number;
  scoreBreakdown(s: State): Breakdown;
}
interface ContentApi {
  THEMES: Theme[];
  TUTORIALS: Tutorial[];
  STAGES: Stage[];
  CHALLENGES: Challenge[];
  dailyContent(date: string): Daily;
  levelConfig(level: object, mode: string): Config;
  tutorialConfig(t: Tutorial): Config;
  getStage(i: number): Stage;
  getTheme(id: string): Theme;
}
interface SessionApi {
  createSession(config: Config, id?: string): Session;
}

export const Rules = RulesJs as unknown as RulesApi;
export const Content = ContentJs as unknown as ContentApi;
export const Sess = SessionJs as unknown as SessionApi;
