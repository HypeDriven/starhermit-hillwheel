// The game's data and the StarHermit platform, on the runtime's modules:
// - progress (progress.js: completed stages and their best totals, finished
//   lessons, achievements, the furthest stage, distance and run counts, the
//   best Daily per date) is the game's save (starhermit:storage `saves`) on
//   the device and in the player's cloud slot; two devices' copies merge on a
//   conflict (progress.js merge: the best of each, as the browser build's
//   saveconflict merge). The slot the browser build wrote (the JS SDK's
//   saveJSON of { schemaVersion, savedAt, progress, settings } under
//   game:<slug>) shows as foreign: it is merged in and replaced once;
// - the game's own options (left-handed pedals, hold to drive, the fuel bar's
//   colour palette, telemetry consent) are `settings` (game.<key>, synced
//   with the account); the browser build's values (its cloud doc's settings
//   and its account settings KV) are migrated, then the KV keys removed.
//   Volumes, mute, graphics, language, reduced motion, high contrast, larger
//   text and key bindings are the runtime's Options;
// - the player (signed in or a guest) and their avatar, the invite link, the
//   platform's clock for the Daily, the leaderboard read for the
//   Leaderboards screen, and posting a finished run's total through
//   score-script.js (a practice session whose socket carries
//   { type: 'result', scores }, as the JS SDK's submitScores did) with the
//   rank on the high-score board.
import type { JsonValue } from "starhermit:engine";
import {
  avatar as fetchAvatar, connectGame, inviteLink as fetchInviteLink, leaderboards, onPlayerChange, player, serverNow, serverTime, sessions,
  type Leaderboard,
} from "starhermit:platform";
import { saves, settings as store } from "starhermit:storage";
import type { ImageBitmap } from "starhermit:canvas";
import * as P from "../progress.js";

export interface Progress {
  stagesCompleted: Record<string, number>;
  tutorialDone: string[];
  achievements: string[];
  lastStage: number;
  totalDistance: number;
  runsPlayed: number;
  dailyBest: Record<string, number>;
}
export type Palette = "default" | "deuteranopia" | "protanopia" | "tritanopia";
export interface Settings { leftHanded: boolean; holdToDrive: boolean; palette: Palette; telemetryConsent: boolean }
const Prog = P as unknown as {
  normalize(raw: unknown): Progress;
  merge(a: unknown, b: unknown): Progress;
  pickSettings(raw: unknown): Partial<Settings>;
  readForeign(text: string | null): { progress: Progress; settings: Partial<Settings> } | null;
  PALETTES: Palette[];
  DEFAULT_SETTINGS: Settings;
};
export const PALETTES = Prog.PALETTES;

// --- the progress save ------------------------------------------------------------------
let live: Progress = Prog.normalize(null);
let lastSavedAt = 0;
const mergedListeners = new Set<() => void>();
/** fn() after progress from the account (another device, the browser build) was merged in. */
export function onProgressMerged(fn: () => void): void { mergedListeners.add(fn); }
function merged(): void { for (const fn of mergedListeners) fn(); }

/** The live progress document (runs update it in place, then saveNow()). */
export function progress(): Progress { return live; }
/** Saves the progress (device at once, the account debounced by the runtime). */
export function saveNow(opts: { replaceForeign?: boolean } = {}): void {
  try { saves.save(live as unknown as JsonValue, { schema: 1, ...opts }); }
  catch (e) { console.warn(`save: ${String(e)}`); }
}
/** Merges another copy into the live document (and saves); whether anything changed. */
function adopt(other: unknown): boolean {
  const next = Prog.merge(live, other);
  if (JSON.stringify(next) === JSON.stringify(live)) return false;
  for (const k of Object.keys(live)) delete (live as unknown as Record<string, unknown>)[k];
  Object.assign(live, next);
  saveNow();
  return true;
}
saves.onConflict((local, remote) => ({ merged: Prog.merge(local?.data ?? null, remote.data) as unknown as JsonValue }));
saves.onStatus((_status, state) => {
  if (state === "foreign") { migrateForeign(); return; }
  // The account's save replaced the device's (another device saved last): merge it in.
  const cur = saves.load();
  if (cur && cur.savedAt !== lastSavedAt) {
    lastSavedAt = cur.savedAt;
    if (adopt(cur.data)) merged();
  }
});
/** The browser build's cloud save: its progress merged with this device's, its options adopted, saved over it once. */
function migrateForeign(): void {
  const old = saves.foreign();
  if (!old) return;
  const doc = Prog.readForeign(old.text);
  const changed = doc ? adopt(doc.progress) : false;
  if (doc) for (const [k, v] of Object.entries(doc.settings)) adoptSetting(k as Key, v);
  saveNow({ replaceForeign: true });
  if (changed) merged();
}

/** For the title's profile line: local (a guest) | saving | synced | offline | error. */
export function syncState(): "local" | "syncing" | "saving" | "synced" | "offline" {
  if (!player()) return "local";
  const st = saves.state();
  if (st === "error" || st === "read-blocked") return "offline";
  if (st === "loading" || st === "foreign") return "syncing";
  if (st === "uploading" || saves.status() === "pending") return "saving";
  return "synced";
}
export function flush(): void { void saves.flush().catch(() => undefined); }

// --- the game's options ---------------------------------------------------------------
export const settings: Settings = { ...Prog.DEFAULT_SETTINGS };
type Key = keyof Settings;
const KEYS: Key[] = ["leftHanded", "holdToDrive", "palette", "telemetryConsent"];
const settingsListeners = new Set<() => void>();
export function onSettingsChange(fn: () => void): void { settingsListeners.add(fn); }
function settingsChanged(): void { for (const fn of settingsListeners) fn(); }
function check(key: Key, v: unknown): boolean | string | undefined {
  return (Prog.pickSettings({ [key]: v }) as Record<string, boolean | string>)[key];
}
function readSetting(key: Key): void {
  let v: JsonValue | undefined;
  try { v = store.get(key); } catch { return; }
  const ok = check(key, v);
  if (ok !== undefined) (settings as unknown as Record<string, unknown>)[key] = ok;
}
/** A migrated value, kept unless this game set the key since. */
function adoptSetting(key: Key, value: unknown): void {
  if (!KEYS.includes(key)) return;
  const v = check(key, value);
  if (v === undefined) return;
  try {
    if (store.get(key) !== undefined) return;
    store.set(key, v);
    (settings as unknown as Record<string, unknown>)[key] = v;
    settingsChanged();
  } catch { /* keep the device's */ }
}
/** Changes one of the game's options (device and account). */
export function setSetting<K extends Key>(key: K, value: Settings[K]): void {
  if (settings[key] === value) return;
  settings[key] = value;
  try { store.set(key, value as JsonValue); } catch (e) { console.warn(`setting ${key}: ${String(e)}`); }
  settingsChanged();
}
// The browser build mirrored its whole settings object into the account's
// settings KV (patchSettings, key by key) plus the language helper's
// ui.language: the game's options among them carry over (unless this game set
// them since), then all of them are removed.
export const BROWSER_KEYS = [
  "volumes", "graphics", "reducedMotion", "leftHanded", "holdToDrive", "muted", "telemetryConsent",
  "largeText", "highContrast", "palette", "ui.language",
];
function importLegacy(): void {
  const keys = store.legacyKeys();
  if (!keys) return;
  for (const key of keys) if ((KEYS as string[]).includes(key)) adoptSetting(key as Key, store.legacy(key));
  for (const key of keys) if (BROWSER_KEYS.includes(key)) store.removeLegacy(key);
}

/** Reads the device's save and the game's options (from onStart). */
export function initPlatform(): void {
  const cur = saves.load();
  lastSavedAt = cur?.savedAt ?? 0;
  live = Prog.normalize(cur?.data ?? null);
  for (const k of KEYS) readSetting(k);
  store.onChange((key) => {
    if (!(KEYS as string[]).includes(key)) return;
    readSetting(key as Key);
    settingsChanged();
  });
  store.onLegacy(importLegacy);
  importLegacy();
  if (saves.state() === "foreign") migrateForeign();
  settingsChanged();
  refreshPlayer();
  void serverTime().catch(() => undefined);
}

// --- the player, the avatar and the clock ------------------------------------------------
export function signedIn(): boolean { return !!player(); }
export function displayName(): string { return player()?.displayName ?? ""; }
let invite: string | null = null;
let avatarImage: ImageBitmap | null = null;
/** The invite link, fetched ahead so a button press can copy it at once. */
export function inviteLink(): string | null { return player() ? invite : null; }
/** The signed-in player's avatar once loaded, else null. */
export function avatarBitmap(): ImageBitmap | null { return player() ? avatarImage : null; }
function refreshPlayer(): void {
  invite = null;
  avatarImage = null;
  board = undefined;
  const me = player();
  if (!me) return;
  fetchInviteLink().then((u) => { invite = u; }, () => { invite = null; });
  fetchAvatar(me.userId).then((b) => { if (player()?.userId === me.userId) avatarImage = b; }, () => undefined);
}
onPlayerChange(() => refreshPlayer());

/** Now in ms by the platform's clock when it has answered, else the device's. */
export function nowMs(): number {
  try { return serverNow() ?? Date.now(); } catch { return Date.now(); }
}
/** Today's UTC date (YYYY-MM-DD) by the platform's clock (the Daily's date). */
export function todayUTC(): string { return new Date(nowMs()).toISOString().slice(0, 10); }

// --- leaderboards --------------------------------------------------------------------------
let board: Leaderboard | null | undefined;
async function highScoreBoard(): Promise<Leaderboard | null> {
  if (board !== undefined) return board;
  const list = await leaderboards.list();
  board = list.find((b) => b.key === "high-score") ?? list[0] ?? null;
  return board;
}
export interface BoardEntry { name: string; score: number; me: boolean }
/** The game's board, top 20 (guests read it too); null when there is none or it cannot be read. */
export async function readBoard(): Promise<BoardEntry[] | null> {
  try {
    const b = await highScoreBoard();
    if (!b) return null;
    const r = await leaderboards.entries(b.id, { pageSize: 20 });
    const meId = player()?.userId;
    return r.items.slice(0, 20).map((e) => ({ name: e.displayName || e.username, score: e.score ?? 0, me: !!meId && e.userId === meId }));
  } catch { return null; }
}

/** Signed in only: post a finished run's total through score-script.js; { posted, rank }. Never rejects. */
export async function postLeaderboard(total: number): Promise<{ posted: boolean; rank: number | null }> {
  const me = player();
  if (!me) return { posted: false, rank: null };
  const score = Math.max(0, Math.round(total));
  let accepted: string[] = [];
  try {
    const sessionId = await sessions.practice();
    accepted = await new Promise<string[]>((resolve) => {
      const socket = connectGame(sessionId);
      let done = false;
      const finish = (list: string[]): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.close();
        resolve(list);
      };
      const timer = setTimeout(() => finish([]), 15000);
      socket.on("open", () => { socket.sendCommand({ type: "result", scores: { "high-score": score } }); });
      socket.on("game", (data) => {
        const d = data as { type?: string; accepted?: string[] } | null;
        if (d && d.type === "result-ack") finish(Array.isArray(d.accepted) ? d.accepted : []);
      });
      socket.on("error", () => finish([]));
      socket.on("stopped", () => finish([]));
      socket.on("abandoned", () => finish([]));
    });
  } catch { return { posted: false, rank: null }; }
  if (!accepted.includes("high-score")) return { posted: false, rank: null };
  try {
    const b = await highScoreBoard();
    if (!b) return { posted: true, rank: null };
    const r = await leaderboards.entries(b.id, { pageSize: 100 });
    const mine = r.items.find((e) => e.userId === me.userId);
    return { posted: true, rank: mine ? mine.rank : null };
  } catch { return { posted: true, rank: null }; }
}
