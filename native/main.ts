// Hillwheel on the StarHermit engine: the entry module (starhermit.txt
// engine.entry), played natively by the StarHermit client and in browsers by
// the engine's web runtime. The rules (rules.js), content (content.js) and
// session with its command log and undo snapshots (session.js) are the
// browser build's, unchanged; this module is what game.js did around them —
// the phase machine (title → mode select → preparing → countdown → active ⇄
// paused → resolving → results → progression), input (the driving actions
// from keys and pads, the on-screen pedals by touch or mouse, held or
// toggled), coaching, practice undo, achievements, progression, the Daily,
// results and posting a finished run to the high-score board, and the
// lifecycle (a hidden window pauses the run, as visibilitychange did).
// Screens and HUD are drawn by screens.ts (starhermit:ui), the hills by
// render.ts (starhermit:scene).
//
// Time is the runtime's fixed steps at the rules' 60 Hz: one rules step per
// fixed step while the run is active, and the 3-2-1 countdown counts steps
// (900 ms a beat, 1600 ms for a lesson's text), so pauses, a hidden window
// and slow frames never cost time and play scripts replay exactly. The
// vehicle is drawn between the last two steps by the frame's interpolation.
import "./i18n.ts";
import { clipboard, frame, onFixedUpdate, onPreferencesChange, onRender, onResume, onStart, onSuspend, onUpdate, preferences, setFixedRate } from "starhermit:engine";
import { bindings, onAction, onPointerButton, onTouch, primaryPointer, value } from "starhermit:input";
import * as ui from "starhermit:ui";
import { onSessionEnded, requestSignIn } from "starhermit:platform";
import { Content, Rules, Sess, type Breakdown, type Config, type Daily, type Result, type Session, type State, type Tutorial, type Vehicle } from "./game.ts";
import * as audio from "./audio.ts";
import { account, N, T } from "./i18n.ts";
import * as platform from "./platform.ts";
import { lookFor } from "./quality.ts";
import * as render from "./render.ts";
import { drawScreens } from "./screens.ts";
import { applyContrast, initStyles } from "./style.ts";

export type Screen = "title" | "setup" | "settings" | "help" | "leaderboard" | "game";
export type Mode = "journey" | "learn" | "daily" | "practice" | "challenge";
export type Phase = "title" | "mode-select" | "preparing" | "countdown" | "active" | "paused" | "resolving" | "results";
export type Pedal = "throttle" | "brake" | "tiltL" | "tiltR";
export const PEDALS: Pedal[] = ["tiltL", "brake", "throttle", "tiltR"];
const ACTION_OF: Record<Pedal, string> = { throttle: "throttle", brake: "brake", tiltL: "tilt_back", tiltR: "tilt_forward" };

export interface LevelMeta {
  kind: Mode; index: number; id: string; theme: string;
  /** The display name (translated where drawn). */
  name: () => string;
  intro?: string; tutorial?: Tutorial; daily?: Daily;
}
export interface Coach {
  throttled: boolean; tilted: boolean; airHint: boolean; fuelHint: boolean; idle: number;
  active: "gas" | "idle" | "air" | "fuel" | null;
  /** The hint text (drawn each frame in the current language) and when it hides (frame time; 0 never). */
  hint: (() => string) | null; hintUntil: number;
  highlight: Pedal | null;
}
export interface Results {
  result: Result; breakdown: Breakdown; won: boolean; newAchievements: string[];
  nextLabel: string | null; stageName: () => string; isDaily: boolean;
}

const ACHIEVEMENTS: { key: string; name: string; check: (c: { finished: boolean; smoothLandings: number; streak: number; stagesCompleted: number; totalDistance: number }) => boolean }[] = [
  { key: "first_finish", name: N("First Finish"), check: (c) => c.finished },
  { key: "smooth_operator", name: N("Smooth Operator"), check: (c) => c.smoothLandings >= 3 },
  { key: "streak_3", name: N("Hat Trick"), check: (c) => c.streak >= 3 },
  { key: "mastery_20", name: N("Hill Veteran"), check: (c) => c.stagesCompleted >= 20 },
  { key: "long_haul", name: N("Long Haul"), check: (c) => c.totalDistance >= 50000 },
];

export const app = {
  screen: "title" as Screen,
  phase: "title" as Phase,
  /** The mode whose level list the setup screen shows. */
  setupMode: "journey" as Mode,
  /** Frame the screen or overlay opened on (the press that opened it must not also act on it). */
  openedFrame: 0,
  focusNext: null as string | null,
  session: null as Session | null,
  meta: null as LevelMeta | null,
  /** The vehicle before the latest rules step (drawn between it and the current one). */
  prevVehicle: null as Vehicle | null,
  coach: null as Coach | null,
  countdown: { n: 0, ticks: 0 },
  results: null as Results | null,
  lb: null as { posted: boolean; rank: number | null } | "posting" | null,
  board: null as { loading: boolean; entries: { name: string; score: number; me?: boolean }[] | null } | null,
  mirror: "",
  toast: null as { text: () => string; until: number } | null,
  daily: null as Daily | null,
};
export const settings = platform.settings;
let streak = 0;
const now = (): number => frame().time;

// ------------------------------------------------------------------ helpers
export function announce(text: string, assertive = false): void {
  if (text) ui.announce(text.slice(0, 500), { politeness: assertive ? "assertive" : "polite" });
}
/** ui.js toast(): 3.5 s over any screen. */
export function toast(text: () => string): void {
  app.toast = { text, until: now() + 3.5 };
  announce(text());
}
export function click(): void { audio.event("click"); }
export function progress(): platform.Progress { return platform.progress(); }
/** Pure-touch devices get pedal-only wording (a touch laptop still has keys). */
export function touchOnly(): boolean {
  const pp = primaryPointer();
  if (pp !== "none") return pp === "coarse";
  // Before any pointer use (a phone before its first touch reports none): phone-sized windows are touch.
  const f = frame(), sc = ui.preferences().scale;
  const w = f.width / sc, h = f.height / sc;
  return (w <= 640 && h >= w) || (w > h && h <= 500);
}

const KEY_GLYPHS: Record<string, string> = { "Arrow Up": "↑", "Arrow Down": "↓", "Arrow Left": "←", "Arrow Right": "→", Escape: "Esc" };
/** ui.js keysFor: the effective keys of an action, e.g. "↑ / W". */
export function keysFor(action: string, sep = " / "): string {
  const names = bindings(action).filter((b) => b.device === "keyboard").map((b) => (b.label === "Space" ? T("Space") : KEY_GLYPHS[b.label] ?? b.label));
  return [...new Set(names)].join(sep);
}
/** "Hold ↑ or W" / "Hold GAS" (game.js _gasVerb). */
export function gasVerb(): string {
  const hold = settings.holdToDrive !== false;
  if (touchOnly()) return hold ? T("Hold GAS") : T("Tap GAS");
  return T(hold ? "Hold {keys}" : "Tap {keys}", { keys: keysFor("throttle", " " + T("or") + " ") });
}
/** Display names for content: "Stage n", "Mastery n", "Daily <date>", lesson titles and challenge names are keys. */
export function stageLabel(s: { name: string }): () => string {
  const m = /^(Stage|Mastery) (\d+)$/.exec(s.name || "");
  return m ? () => T(`${m[1]} {n}`, { n: m[2]! }) : () => T(s.name);
}
export function dailyLabel(d: { name: string }): () => string {
  const m = /^Daily (.+)$/.exec(d.name || "");
  return m ? () => T("Daily {date}", { date: m[1]! }) : () => T(d.name);
}
export function dailyContent(): Daily {
  const date = platform.todayUTC();
  if (!app.daily || app.daily.date !== date) app.daily = Content.dailyContent(date);
  return app.daily;
}
/** A player who has never finished a lesson or a stage is sent to the first lesson by Quick play. */
export function isFirstRun(): boolean {
  return progress().tutorialDone.length === 0 && Object.keys(progress().stagesCompleted).length === 0;
}

// ------------------------------------------------------------------ navigation
export function show(screen: Screen, focus: string | null = null): void {
  app.screen = screen;
  app.openedFrame = frame().frame;
  app.focusNext = focus;
  ui.setFocus(null);
}
export function showTitle(): void {
  app.phase = "title";
  show("title", "btn-quick");
}
export function showSetup(mode: Mode): void {
  click();
  app.phase = "mode-select";
  app.setupMode = mode;
  show("setup", null);
}
export function openPage(screen: "settings" | "help"): void { click(); show(screen, "btn-back"); }
export function backToTitle(): void { click(); showTitle(); }
export function showLeaderboard(): void {
  click();
  show("leaderboard", "btn-back");
  app.board = { loading: true, entries: null };
  const local = (): { name: string; score: number }[] => Object.entries(progress().dailyBest ?? {})
    .map(([id, score]) => ({ date: id.replace(/^daily-/, ""), score }))
    .sort((x, y) => y.score - x.score || (x.date < y.date ? 1 : -1))
    .slice(0, 20)
    .map((e) => ({ name: e.date, score: e.score, daily: true }));
  // Signed in: the platform board (top 20). A guest: their own best Daily scores, as standalone did.
  if (!platform.signedIn()) { app.board = { loading: false, entries: local() }; return; }
  void platform.readBoard().then((entries) => { if (app.screen === "leaderboard") app.board = { loading: false, entries }; });
}
export function quickPlay(): void {
  click();
  if (isFirstRun()) startTutorial(0);
  else startJourneyLevel(progress().lastStage || 0);
}

// ------------------------------------------------------------------ level start
function prepare(config: Config, meta: LevelMeta): void {
  endSession();
  app.phase = "preparing";
  app.session = Sess.createSession(config);
  app.meta = meta;
  app.prevVehicle = { ...app.session.state.vehicle };
  app.results = null;
  app.lb = null;
  app.mirror = "";
  render.loadLevel(app.session.state, meta.theme || "meadow", config.seed);
  const hint = meta.tutorial?.hint;
  app.coach = {
    throttled: false, tilted: false, airHint: false, fuelHint: false, idle: 0, active: null, hint: null, hintUntil: 0,
    highlight: hint === "throttle" ? "throttle" : hint === "brake" ? "brake" : hint === "tilt" ? "tiltR" : null,
  };
  pedals.clear();
  toggled.clear();
  lastInput = { throttle: 0, brake: 0, tilt: 0 };
  show("game", null);
  beginCountdown(3);
}
function beginCountdown(n: number): void {
  app.phase = "countdown";
  const intro = n === 3 && app.meta?.intro;
  app.countdown = { n, ticks: Math.round(Rules.TICK_RATE * (intro ? 1.6 : 0.9)) };
  audio.event("countdown");
  announce(intro ? T(app.meta!.intro!) : String(n));
}
/** The countdown's text for the HUD: the lesson's text on its first beat, else the number. */
export function countdownText(): string | null {
  if (app.phase !== "countdown") return null;
  return app.countdown.n === 3 && app.meta?.intro ? T(app.meta.intro) : String(app.countdown.n);
}
function go(): void {
  audio.event("go");
  app.phase = "active";
  audio.startMusic();
  audio.startAmbience();
  announce(T("Go! {verb} to drive.", { verb: gasVerb() }));
  // Keep the "how do I move" prompt up until the first press of the throttle.
  if (app.coach) { app.coach.active = "gas"; app.coach.hint = () => T("{verb} to drive", { verb: gasVerb() }); app.coach.hintUntil = 0; }
}

export function startJourneyLevel(i: number): void {
  const s = Content.getStage(i);
  progress().lastStage = i;
  platform.saveNow();
  prepare(Content.levelConfig(s, "journey"), { kind: "journey", index: i, id: s.id, theme: s.theme, name: stageLabel(s) });
}
export function startTutorial(i: number): void {
  const t = Content.TUTORIALS[i]!;
  prepare(Content.tutorialConfig(t), { kind: "learn", index: i, id: t.id, theme: "meadow", name: () => T(t.title), intro: t.text, tutorial: t });
}
export function startDaily(d: Daily): void {
  prepare(Content.levelConfig(d, "daily"), { kind: "daily", index: 0, id: d.id, theme: d.theme, name: dailyLabel(d), daily: d });
}
export function startPractice(i: number): void {
  const cfg: Config = { seed: (0x9ac0 + i * 977) >>> 0, length: 300 + i * 120, roughness: 0.5 + i * 0.35, fuel: 100, fuelCans: 2 + i, checkpoints: 2, mode: "practice" };
  prepare(cfg, { kind: "practice", index: i, id: "practice-" + i, theme: Content.THEMES[i % Content.THEMES.length]!.id, name: () => T("Practice") });
}
export function startChallenge(i: number): void {
  const c = Content.CHALLENGES[i]!;
  prepare(Content.levelConfig(c.config, "challenge"), { kind: "challenge", index: i, id: c.id, theme: "ember", name: () => T(c.name) });
}
export function restartLevel(): void {
  click();
  const m = app.meta;
  if (!m) { showTitle(); return; }
  if (m.kind === "journey") startJourneyLevel(m.index);
  else if (m.kind === "learn") startTutorial(m.index);
  else if (m.kind === "daily") startDaily(m.daily ?? dailyContent());
  else if (m.kind === "practice") startPractice(m.index);
  else startChallenge(m.index);
}
export function nextLevel(): void {
  click();
  const m = app.meta;
  if (m?.kind === "journey" && m.index + 1 < Content.STAGES.length) startJourneyLevel(m.index + 1);
  else if (m?.kind === "learn" && m.index + 1 < Content.TUTORIALS.length) startTutorial(m.index + 1);
  else if (m?.kind === "learn") startJourneyLevel(0); // training done: straight into the Journey
  else quitToTitle(false);
}
function endSession(): void {
  app.session?.close();
  app.session = null;
  audio.setEngine(false);
  audio.stopMusic();
  audio.stopAmbience();
}
export function quitToTitle(withClick = true): void {
  if (withClick) click();
  const s = app.session;
  if (s && !s.finished()) s.apply({ id: s.nextCommandId(), type: "abandon" });
  endSession();
  app.meta = null;
  app.coach = null;
  render.showSky();
  showTitle();
}

// ------------------------------------------------------------------ pause / resume / undo
export function pauseRun(): void {
  if (app.phase !== "active") return;
  app.phase = "paused";
  audio.setEngine(false);
  audio.setSuspended(true);
  app.openedFrame = frame().frame;
  app.focusNext = "btn-resume";
  ui.setFocus(null);
  announce(T("Paused"));
}
export function resumeRun(): void {
  if (app.phase !== "paused") return;
  click();
  if (!app.session) { showTitle(); return; }
  app.phase = "active";
  audio.setSuspended(false);
  audio.startAmbience();
  app.openedFrame = frame().frame;
  ui.setFocus(null);
}
export function canUndo(): boolean { return app.meta?.kind === "practice" && !!app.session && app.session.snapshots.length > 0; }
export function undo(): void {
  const s = app.session;
  if (app.meta?.kind !== "practice" || !s) return;
  const r = s.undo();
  if (r.ok) {
    app.prevVehicle = { ...s.state.vehicle };
    announce(T("Undone"));
    if (app.phase === "paused") resumeRun();
  } else {
    announce(T("Nothing to undo"), true);
    audio.event("invalid");
  }
}
export function copyInvite(): void {
  click();
  const link = platform.inviteLink();
  if (!link) return;
  try { clipboard.writeText(link); toast(() => account().copied); }
  catch { toast(() => account().copyFailed.replace("{link}", link)); }
}
export function signIn(): void { click(); void requestSignIn().catch(() => undefined); }

// ------------------------------------------------------------------ input
/** The on-screen pedals held: by touch (any number of fingers) or the mouse, against the rectangles
 * screens.ts laid them out at (window pixels, set each frame). */
export const pedalRects = new Map<Pedal, { x: number; y: number; width: number; height: number }>();
const fingers = new Map<number, Pedal>();
let mousePedal: Pedal | null = null;
let lastTouch = -1e9;
const pedals = new Set<Pedal>();
/** Toggle mode (Hold to drive off): pedals a tap latched on. */
const toggled = new Set<Pedal>();
function pedalAt(x: number, y: number): Pedal | null {
  for (const [p, r] of pedalRects) if (x >= r.x && y >= r.y && x <= r.x + r.width && y <= r.y + r.height) return p;
  return null;
}
function driving(): boolean { return app.screen === "game" && (app.phase === "active" || app.phase === "countdown"); }
function pedalPress(p: Pedal, down: boolean): void {
  if (down) {
    if (settings.holdToDrive === false) { if (toggled.has(p)) toggled.delete(p); else toggled.add(p); }
    audio.event("input");
  }
}
function syncPedals(): void {
  const held = new Set<Pedal>([...fingers.values()]);
  if (mousePedal) held.add(mousePedal);
  for (const p of PEDALS) {
    const was = pedals.has(p), is = held.has(p);
    if (is && !was) pedalPress(p, true);
  }
  pedals.clear();
  for (const p of held) pedals.add(p);
}
onTouch((e) => {
  lastTouch = now();
  if (e.control) return;
  if (e.phase === "start") {
    const p = driving() ? pedalAt(e.x, e.y) : null;
    if (p) fingers.set(e.id, p);
  } else if (e.phase === "move") {
    // A finger sliding off its pedal lets go of it (pointerleave), as before.
    const p = fingers.get(e.id);
    if (p && pedalAt(e.x, e.y) !== p) fingers.delete(e.id);
  } else fingers.delete(e.id);
  syncPedals();
});
onPointerButton((e) => {
  if (e.button !== 0 || now() - lastTouch < 0.6) return;
  if (e.pressed) mousePedal = driving() ? pedalAt(e.x, e.y) : null;
  else mousePedal = null;
  syncPedals();
});
/** Whether a pedal shows held (pressed, toggled on, or its key down). */
export function pedalShown(p: Pedal): boolean {
  return settings.holdToDrive === false ? toggled.has(p) || keyHeld(p) : pedals.has(p) || keyHeld(p);
}
function keyHeld(p: Pedal): boolean {
  if (ui.capturingKeys()) return false;
  const v = value(ACTION_OF[p]);
  return p === "throttle" || p === "brake" ? v > 0.2 : v > 0.3;
}
function pedalHeld(p: Pedal): boolean { return (settings.holdToDrive === false ? toggled.has(p) : pedals.has(p)) || keyHeld(p); }

onAction((e) => {
  if (!e.pressed) return;
  const fresh = frame().frame !== app.openedFrame;
  if (app.screen !== "game") {
    // Escape leaves a list or page, as its Back button.
    if (e.action === "pause" && fresh && app.screen !== "title" && !ui.capturingKeys()) backToTitle();
    return;
  }
  if (["throttle", "brake", "tilt_back", "tilt_forward"].includes(e.action)) {
    if (driving() && !ui.capturingKeys()) audio.event("input");
    return;
  }
  if (e.action === "pause") {
    if (!fresh) return;
    if (app.phase === "active") pauseRun();
    else if (app.phase === "paused") resumeRun();
  } else if (e.action === "undo") {
    if (app.meta?.kind === "practice" && (app.phase === "active" || app.phase === "paused")) undo();
  } else if (e.action === "recenter") render.recenter();
});

// ------------------------------------------------------------------ coaching (game.js _coach)
export function coachHint(): string | null {
  const c = app.coach;
  if (!c || !c.hint) return null;
  if (c.hintUntil && now() > c.hintUntil) { c.hint = null; if (c.active !== "gas") c.active = null; return null; }
  return c.hint();
}
function hint(kind: Coach["active"], text: () => string, seconds: number): void {
  const c = app.coach!;
  c.active = kind;
  c.hint = text;
  c.hintUntil = seconds ? now() + seconds : 0;
}
function clearHint(): void { const c = app.coach!; c.active = null; c.hint = null; }
function onInput(input: { throttle: number; brake: number; tilt: number }): void {
  const c = app.coach;
  if (!c) return;
  if (input.throttle) {
    c.throttled = true;
    if (c.active === "gas" || c.active === "idle") clearHint();
    if (c.highlight === "throttle") c.highlight = null;
  }
  if (input.tilt) {
    c.tilted = true;
    if (c.active === "air") clearHint();
    if (c.highlight === "tiltR") c.highlight = null;
  }
  if (input.brake && c.highlight === "brake") c.highlight = null;
}
function coach(state: State, input: { throttle: number; tilt: number }): void {
  const c = app.coach, v = state.vehicle;
  if (!c || app.phase !== "active") return;
  if (c.hint && c.hintUntil && now() > c.hintUntil) { c.hint = null; c.active = null; }
  const fresh = (progress().runsPlayed || 0) < 6 || app.meta?.kind === "learn";
  // Stopped with no throttle for a second and a half: remind how to move.
  if (c.throttled && v.grounded && Math.abs(v.vx) < 0.5 && !input.throttle) {
    c.idle++;
    if (c.idle === 90 && !c.active) hint("idle", () => T("{verb} to get going", { verb: gasVerb() }), 2.5);
  } else c.idle = 0;
  if (fresh && !c.airHint && !v.grounded && state.airTime > 0.35 && !input.tilt && (!c.active || c.active === "idle")) {
    c.airHint = true;
    hint("air", () => (touchOnly() ? T("In the air: TILT ◀ ▶ to match the slope") : T("In the air: {tiltL} {tiltR} tilt to match the slope", { tiltL: keysFor("tilt_back", "/"), tiltR: keysFor("tilt_forward", "/") })), 2.5);
  }
  if (!c.fuelHint && v.fuel < (v.fuelMax || 100) * 0.25 && c.active !== "gas") {
    c.fuelHint = true;
    hint("fuel", () => T("Fuel low: ease off downhill and grab the yellow cans"), 3);
  }
}

// ------------------------------------------------------------------ the step
let lastInput = { throttle: 0, brake: 0, tilt: 0 };
function readInput(): { throttle: number; brake: number; tilt: number } {
  const l = pedalHeld("tiltL") ? 1 : 0, r = pedalHeld("tiltR") ? 1 : 0;
  return {
    throttle: pedalHeld("throttle") ? 1000 : 0,
    brake: pedalHeld("brake") ? 1000 : 0,
    tilt: (l - r) * 1000, // tilt back = negative pitch change
  };
}
function stepRun(): void {
  const s = app.session!;
  const input = readInput();
  if (input.throttle !== lastInput.throttle || input.brake !== lastInput.brake || input.tilt !== lastInput.tilt) onInput(input);
  lastInput = input;
  app.prevVehicle = { ...s.state.vehicle };
  // Practice undo snapshot every 2 sim-seconds.
  if (app.meta?.kind === "practice" && s.state.tick % 120 === 0) s.pushUndoSnapshot();
  const st = s.state;
  const before = { cans: st.cansCollected, cp: st.nextCheckpoint, smooth: st.smoothLandings, grounded: st.vehicle.grounded, terminal: st.terminalReason };
  s.apply({ id: s.nextCommandId(), type: "input", throttle: input.throttle, brake: input.brake, tilt: input.tilt });
  fireEvents(before);
  if (s.finished()) resolve();
  else coach(s.state, input);
  if (s.state.tick % 30 === 0) app.mirror = T("{kmh} km/h · cans {n}", { kmh: Math.abs(s.state.vehicle.vx * 3.6).toFixed(0), n: s.state.cansCollected });
}
/** game.js _fireEvents: a sound, an announcement and the camera's shake per rules event. */
function fireEvents(before: { cans: number; cp: number; smooth: number; grounded: boolean; terminal: string | null }): void {
  const s = app.session!.state;
  if (s.cansCollected > before.cans) audio.event("can", { variant: s.cansCollected });
  if (s.nextCheckpoint > before.cp) { audio.event("checkpoint"); announce(T("Checkpoint {n} of {total}", { n: s.nextCheckpoint, total: s.checkpoints.length })); }
  if (s.smoothLandings > before.smooth) audio.event("land_smooth");
  if (s.vehicle.grounded && !before.grounded && s.smoothLandings === before.smooth) {
    audio.event("land_hard");
    render.addShake(0.25);
  }
  if (before.grounded && !s.vehicle.grounded) audio.event("airborne");
  if (s.terminalReason && !before.terminal) {
    if (s.terminalReason === "crashed") { audio.event("crash"); render.addShake(0.9); }
    if (s.terminalReason === "out_of_fuel") audio.event("dry");
  }
}

// ------------------------------------------------------------------ resolving / results / progression
function resolve(): void {
  const s = app.session!;
  app.phase = "resolving";
  audio.setEngine(false);
  audio.stopMusic();
  audio.stopAmbience();
  const result = s.result();
  const won = result.terminalReason === "finished";
  if (won) audio.event("finish");
  const p = progress();
  streak = won ? streak + 1 : 0;
  p.totalDistance = (p.totalDistance || 0) + Math.floor(s.state.vehicle.x);
  p.runsPlayed = (p.runsPlayed || 0) + 1;
  if (app.coach) app.coach.hint = null;
  const m = app.meta!;
  if (m.kind === "journey" && won) {
    p.stagesCompleted[m.id] = Math.max(p.stagesCompleted[m.id] || 0, result.breakdown.total);
    p.lastStage = Math.min(m.index + 1, Content.STAGES.length - 1);
  }
  if (m.kind === "learn") {
    // A lesson counts as learned only when every requirement it states was met.
    const req = Content.TUTORIALS[m.index]!.requires || {};
    const met = s.state.vehicle.x >= (req.minX || 0) && s.state.cansCollected >= (req.cans || 0);
    if (met && !p.tutorialDone.includes(m.id)) p.tutorialDone.push(m.id);
  }
  // Achievements (idempotent).
  const ctx = {
    finished: won, smoothLandings: s.state.smoothLandings, streak,
    stagesCompleted: Object.keys(p.stagesCompleted).length, totalDistance: p.totalDistance,
  };
  const newAch: string[] = [];
  for (const a of ACHIEVEMENTS) {
    if (!p.achievements.includes(a.key) && a.check(ctx)) {
      p.achievements.push(a.key);
      newAch.push(a.name);
      audio.event("achievement");
      announce(T("Achievement unlocked: {name}", { name: T(a.name) }), true);
    }
  }
  // Daily: the player's best per date is kept in the progress (the guest's leaderboard).
  if (m.kind === "daily") p.dailyBest[m.id] = Math.max(p.dailyBest[m.id] || 0, result.breakdown.total);
  platform.saveNow();

  let nextLabel: string | null = null;
  if (m.kind === "journey" && m.index + 1 < Content.STAGES.length) nextLabel = N("Next stage");
  else if (m.kind === "learn") nextLabel = m.index + 1 < Content.TUTORIALS.length ? N("Next lesson") : N("Start the Journey");
  // Losing a stage offers "Next" only where progress already allows it; losing a lesson still lets you move on.
  if (!won && m.kind === "journey") nextLabel = null;
  app.results = { result, breakdown: result.breakdown, won, newAchievements: newAch, nextLabel, stageName: m.name, isDaily: m.kind === "daily" };
  app.phase = "results";
  app.openedFrame = frame().frame;
  app.focusNext = nextLabel ? "btn-next" : "btn-retry";
  ui.setFocus(null);
  announce(`${won ? T("Finished!") : T("Run over")} ${T("Total")} ${result.breakdown.total}`, true);
  if (m.kind !== "learn") postToLeaderboard(result.breakdown.total);
}
/** Signed in only: post the run total and show the player's board rank. */
function postToLeaderboard(total: number): void {
  if (!platform.signedIn()) return;
  app.lb = "posting";
  const s = app.session;
  void platform.postLeaderboard(total).then((r) => { if (app.session === s) app.lb = r; });
}
export function leaderboardLine(): string | null {
  const r = app.lb;
  if (!r) return null;
  const t = account();
  if (r === "posting") return t.lbPosting;
  return !r.posted ? t.lbNotPosted : r.rank ? t.lbRank.replace("{rank}", String(r.rank)) : t.lbPosted;
}

// ------------------------------------------------------------------ boot and lifecycle
let lookKey = "";
function applyLook(): void {
  const f = frame();
  const k = `${f.quality}:${f.levelIndex}`;
  if (k === lookKey) return;
  lookKey = k;
  render.applyLook(lookFor(f.quality, f.levelIndex));
}

onStart(() => {
  setFixedRate(Rules.TICK_RATE);
  initStyles();
  platform.initPlatform();
  audio.loadSfx();
  render.setReducedMotion(preferences().reducedMotion);
  applyLook();
  render.setActive(true);
  render.showSky();
  showTitle();
});
onPreferencesChange((p) => render.setReducedMotion(p.reducedMotion));
onSessionEnded(() => toast(() => account().signedOut));
let hidden = false;
onSuspend(() => {
  hidden = true;
  // Backgrounding pauses solo simulation.
  if (app.phase === "active") pauseRun();
  audio.setSuspended(true);
  platform.flush();
});
onResume(() => {
  hidden = false;
  if (app.phase !== "paused") audio.setSuspended(false);
});

onFixedUpdate(() => {
  const s = app.session;
  if (hidden || !s || app.screen !== "game") return;
  if (app.phase === "countdown") {
    if (--app.countdown.ticks > 0) return;
    if (app.countdown.n > 1) beginCountdown(app.countdown.n - 1);
    else go();
    return;
  }
  if (app.phase === "active" && !s.finished()) stepRun();
});

let frameDt = 0;
onUpdate((dt) => {
  frameDt = dt;
  // Driving keys must not also walk the UI focus over the HUD (arrows move focus when nothing has it).
  if (app.screen === "game" && (app.phase === "active" || app.phase === "countdown") && PEDALS.some((p) => keyHeld(p))) ui.setFocus(null);
  applyLook();
  applyContrast(ui.preferences().highContrast);
  const s = app.session;
  if (s && app.phase === "active") {
    const v = s.state.vehicle;
    audio.setEngine(!s.state.terminalReason, v.vx, lastInput.throttle / 1000);
  }
  audio.update();
  if (app.toast && app.toast.until < now()) app.toast = null;
});
onRender((alpha) => {
  pedalRects.clear();
  drawScreens();
  const s = app.session;
  const a = app.phase === "active" ? Math.min(1, Math.max(0, alpha)) : 1;
  render.update(app.prevVehicle, s ? s.state.vehicle : null, a, s ? s.state : null, frameDt);
});
