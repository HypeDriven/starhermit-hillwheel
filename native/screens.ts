// The browser build's DOM shell (ui.js + style.css) as starhermit:ui, built
// every frame over the hills: the title (key art, name and tagline, the
// signed-in profile line with avatar and sync status, Quick play with its
// note, the five mode buttons with their one-line descriptions, the controls
// strip, Leaderboards / Settings / How to play / Invite / Sign in), the mode
// setup lists, Settings, How to play, Leaderboards; the run's HUD (pause
// button, objective and course track, speed and cans, the fuel meter, the
// score), the coaching banner, the four-pedal tray (left-handed mirrors it,
// the lesson's pedal pulses), the 3-2-1 countdown, the pause and results
// panels, and the account toast. The browser's media queries are layouts
// picked by the window's logical size: desktop (≥ 1024 px: a wider panel,
// roomier HUD), portrait phone (≤ 640 px wide: bottom-sheet panels, taller
// pedals, no speed line), short landscape (≤ 500 px tall: slim HUD, no key
// hints on the pedals).
import { frame, openMenu } from "starhermit:engine";
import { requestRebind } from "starhermit:input";
import * as draw from "starhermit:draw";
import * as ui from "starhermit:ui";
import { Content, Rules } from "./game.ts";
import { account, N, T } from "./i18n.ts";
import * as platform from "./platform.ts";
import { PALETTES, type Palette } from "./platform.ts";
import {
  app, backToTitle, canUndo, click, coachHint, copyInvite, countdownText, dailyContent, dailyLabel, gasVerb, isFirstRun, keysFor, leaderboardLine,
  nextLevel, openPage, pauseRun, pedalRects, pedalShown, progress, quickPlay, quitToTitle, restartLevel, resumeRun, settings,
  showLeaderboard, showSetup, signIn, stageLabel, startChallenge, startDaily, startJourneyLevel, startPractice, startTutorial, touchOnly, undo,
  type Mode, type Pedal,
} from "./main.ts";

// ------------------------------------------------------------------ layout
interface Layout { lw: number; lh: number; sc: number; desktop: boolean; phone: boolean; shortLand: boolean }
function layoutNow(): Layout {
  const f = frame();
  const sc = ui.preferences().scale;
  const sa = f.safeArea;
  const lw = Math.max(1, (f.width - sa.left - sa.right) / sc), lh = Math.max(1, (f.height - sa.top - sa.bottom) / sc);
  const shortLand = lw > lh && lh <= 500;
  return { lw, lh, sc, desktop: lw >= 1024, phone: !shortLand && lw <= 640 && lh >= lw, shortLand };
}
const lastSize = new Map<string, number>();
const prefs = (): ui.UiPreferences => ui.preferences();
function textWidth(text: string, style: string | readonly string[], kind?: "button" | "heading"): number {
  return ui.measureText(text, { ...(kind ? { kind } : {}), style: typeof style === "string" ? style : [...style] }).width / prefs().scale;
}
interface Btn { id: string; text: string; style?: string; disabled?: boolean; act: () => void }
const buttonWidth = (text: string, style: string): number => textWidth(text, style, "button") + 4;
/** A button `width` wide (null: its text's); a label too long for it wraps inside. */
function button(b: Btn, width: number | null = null): void {
  const style = b.style ?? "btn";
  const opts: ui.ButtonOptions = {};
  if (b.disabled) opts.disabled = true;
  const s: ui.Style = width != null ? { width } : {};
  if (width != null && buttonWidth(b.text, style) > width) {
    const inner = Math.max(20, width - 40);
    const align = style === "btn-primary" || style === "btn-small" ? "center" : "start";
    opts.content = () => { ui.style({ text: { align } }).paragraph(b.text, inner); };
  }
  if (ui.style(style, s).id(b.id).button(b.text, opts)) b.act();
}
/** Buttons at their own widths in rows that wrap at `width` (CSS flex-wrap). */
function flow(label: string, list: Btn[], width: number, gap = 8, align: "start" | "center" = "start"): void {
  const rows: Btn[][] = [[]];
  let used = 0;
  for (const b of list) {
    const bw = Math.min(width, buttonWidth(b.text, b.style ?? "btn"));
    if (rows[rows.length - 1]!.length && used + gap + bw > width) { rows.push([]); used = 0; }
    used += (rows[rows.length - 1]!.length ? gap : 0) + bw;
    rows[rows.length - 1]!.push(b);
  }
  ui.column(label, () => {
    rows.forEach((row, ri) => ui.row(`${label}-r${ri}`, () => {
      for (const b of row) button(b, buttonWidth(b.text, b.style ?? "btn") > width ? width : null);
    }, { spacing: gap, align: "center" }));
  }, { spacing: gap, align, width });
}
/** Text up to `width` wide: one label when it fits, else a paragraph. */
function para(text: string, width: number, cls = "body", id?: string, center = false): void {
  if (!text) return;
  const styles: (string | ui.Style)[] = [cls];
  if (center) styles.push({ text: { align: "center" } });
  let u = ui.style(...styles);
  if (id) u = u.id(id);
  if (ui.measureText(text, { style: styles }).width / prefs().scale <= width) u.label(text);
  else u.paragraph(text, width);
}
function heading(cls: string, text: string, width: number, id?: string): void {
  if (ui.measureText(text, { kind: "heading", style: [cls] }).width / prefs().scale <= width) (id ? ui.id(id) : ui).style(cls).heading(text);
  else ui.style(cls).paragraph(text, width);
}
/** A two-column definition list (ui.js dl.hw-score-table): label left, value right. */
function dl(id: string, rows: [string, string, boolean?][], w: number): void {
  ui.column(id, () => rows.forEach(([k, v, total], i) => ui.row(`${id}-${i}`, () => {
    para(k, w - 80, total ? "total" : "dt");
    ui.spacer();
    ui.style(total ? "total" : "dd").id(`${id}-${i}-v`).label(v);
  }, { width: w, align: "center", ...(total ? { style: "total-row" } : {}) })), { spacing: 4, width: w });
}

// ------------------------------------------------------------------ the frame
export function drawScreens(): void {
  const L = layoutNow();
  const f = frame();
  if (app.screen === "title") {
    // style.css .hw-screen-layer[data-screen="title"]: the key art under a dark gradient.
    draw.box(0, 0, f.width, f.height, "keyart");
    draw.box(0, 0, f.width, f.height, "keyart-shade");
  } else if (app.screen !== "game") draw.box(0, 0, f.width, f.height, "screen-shade");
  switch (app.screen) {
    case "title": page("title", L, titleScreen); break;
    case "setup": page("setup", L, setupScreen); break;
    case "settings": page("settings", L, settingsScreen); break;
    case "help": page("help", L, helpScreen); break;
    case "leaderboard": page("leaderboard", L, leaderboardScreen); break;
    case "game": gameScreen(L); break;
  }
  toast(L);
  if (app.focusNext) {
    const age = f.frame - app.openedFrame;
    if (age >= 1) ui.setFocus(app.focusNext);
    if (age >= 3) app.focusNext = null;
  }
}

/** A panel (style.css .hw-panel): centred, at most 560 px wide (70ch on desktop); on a portrait phone a
 * bottom sheet at most 85 % of the height; scrolling inside when taller than the room. */
function page(key: string, L: Layout, build: (w: number, L: Layout) => void): void {
  const pad = L.phone ? 20 : 24;
  const outer = L.phone ? L.lw - 32 : Math.min(L.desktop ? 616 : 560, L.lw - 32);
  const avail = Math.max(80, L.phone ? L.lh * 0.85 : L.lh - 32);
  const h = lastSize.get(key) ?? 0;
  const scroll = h > avail;
  const inner = outer - 2 * pad - (scroll ? 14 : 0);
  const fresh = frame().frame - app.openedFrame <= 5;
  const at = L.phone ? { anchor: "bottom" as const, y: 8 } : "center" as const;
  ui.place(`page-${key}`, at, () => {
    const body = (): void => {
      const r = ui.column(`${key}-col`, () => build(inner, L), { style: L.phone ? "sheet" : "panel", width: outer - (scroll ? 14 : 0), spacing: 12, padding: pad });
      lastSize.set(key, r.height / L.sc);
    };
    if (scroll) ui.scrollArea(`${key}-scroll`, { width: outer, height: avail }, body, fresh ? { scrollTo: { top: 0 } } : undefined);
    else body();
  });
}
function backButton(w: number): void { flow("back-row", [{ id: "btn-back", text: T("← Back"), style: "btn-small", act: backToTitle }], w); }

// ------------------------------------------------------------------ title
const MODE_DESCRIPTIONS: Record<Mode, string> = {
  journey: N("40 stages, easy to wild. Your progress is saved."),
  learn: N("Five short lessons, one control at a time."),
  daily: N("One shared course per day — the same hills for everyone."),
  practice: N("Pick a hill type. Undo is allowed."),
  challenge: N("Special rules: fuel-starved, timed, cliffs, marathon."),
};
const SYNC_LABELS: Record<string, string> = { syncing: N("syncing…"), saving: N("saving…"), synced: N("synced"), offline: N("offline") };
function titleScreen(w: number): void {
  heading(w < 360 ? "title-small" : "title", "Hillwheel", w, "title-h");
  para(T("Hold the gas to climb, tilt in the air, land on both wheels. Reach the green flag before the fuel runs out."), w, "tagline", "tagline");
  if (platform.signedIn()) {
    const sync = platform.syncState();
    const line = `${platform.displayName() || "…"} · ${SYNC_LABELS[sync] ? T(SYNC_LABELS[sync]!) : sync}`;
    ui.row("profile-row", () => {
      const av = platform.avatarBitmap();
      if (av) {
        ui.widget("", {
          role: "image", size: { width: 22, height: 22 },
          draw: (r) => draw.image(av, r.x, r.y, r.width, r.height),
        });
      }
      para(line, w - 30, "profile", "profile-line");
    }, { spacing: 8, align: "center" });
  }
  const first = isFirstRun();
  const resume = stageLabel(Content.getStage(progress().lastStage || 0))();
  button({ id: "btn-quick", text: first ? T("Quick play — learn the basics") : T("Quick play — {stage}", { stage: resume }), style: "btn-primary", act: quickPlay }, w);
  const done = Object.keys(progress().stagesCompleted).length;
  para(first ? T("Your first run is a two-minute lesson. Skip it any time from Journey below.")
    : T("Journey: {progress}", { progress: T("{done}/{total} stages", { done, total: Content.STAGES.length }) }), w, "note", "primary-note", true);
  const daily = dailyContent();
  const modes: [Mode, string][] = [
    ["journey", T("Journey")], ["learn", T("Learn")], ["daily", T("Daily — {date}", { date: daily.date })],
    ["practice", T("Practice")], ["challenge", T("Challenge")],
  ];
  ui.column("modes", () => {
    for (const [mode, label] of modes) {
      const desc = T(MODE_DESCRIPTIONS[mode]);
      if (ui.style("btn-mode", { width: w }).id(`mode-${mode}`).button(`${label}. ${desc}`, {
        content: () => ui.column(`mode-${mode}-face`, () => {
          para(label, w - 32, "mode-label");
          para(desc, w - 32, "mode-desc");
        }, { spacing: 2, width: w - 32 }),
      })) showSetup(mode);
    }
  }, { spacing: 8, width: w });
  ui.column("controls-strip", () => {
    para(touchOnly() ? T("Controls: on-screen pedals — GAS, BRAKE, and TILT ◀ ▶ for the air.")
      : T("Controls: {gas} gas · {brake} brake · {tiltL} {tiltR} tilt in the air · {pause} pause", {
        gas: keysFor("throttle", "/"), brake: keysFor("brake", "/"), tiltL: keysFor("tilt_back", "/"), tiltR: keysFor("tilt_forward", "/"), pause: keysFor("pause", "/"),
      }), w, "strip-text", "controls-text");
  }, { style: "strip", width: w });
  const t = account();
  const row: Btn[] = [
    { id: "btn-leaderboards", text: T("Leaderboards"), style: "btn-small", act: showLeaderboard },
    { id: "btn-settings", text: T("Settings"), style: "btn-small", act: () => openPage("settings") },
    { id: "btn-help", text: T("How to play"), style: "btn-small", act: () => openPage("help") },
  ];
  if (platform.inviteLink()) row.push({ id: "btn-invite", text: t.invite, style: "btn-small", act: copyInvite });
  if (!platform.signedIn()) row.push({ id: "btn-signin", text: t.signIn, style: "btn-small", act: signIn });
  flow("title-row", row, w);
}

// ------------------------------------------------------------------ mode setup
const MODE_TITLES: Record<Mode, string> = { journey: N("Journey"), learn: N("Learn"), daily: N("Daily challenge"), practice: N("Practice"), challenge: N("Challenge") };
interface Level { label: string; done?: boolean; locked?: boolean; act: () => void }
function levelsFor(mode: Mode): Level[] {
  const p = progress();
  const done = p.stagesCompleted;
  switch (mode) {
    case "journey": return Content.STAGES.map((s, i) => ({
      label: `${stageLabel(s)()}${s.mastery ? " ★" : ""}${done[s.id] ? ` ✓ ${done[s.id]}` : ""}`,
      done: !!done[s.id], locked: i > 0 && !done[Content.STAGES[i - 1]!.id] && i > (p.lastStage || 0) + 1,
      act: () => startJourneyLevel(i),
    }));
    case "learn": return Content.TUTORIALS.map((t, i) => ({
      label: `${T(t.title)}${p.tutorialDone.includes(t.id) ? " ✓" : ""}`, done: p.tutorialDone.includes(t.id), act: () => startTutorial(i),
    }));
    case "daily": {
      const d = dailyContent();
      return [{ label: T("{name} — ranked", { name: dailyLabel(d)() }), act: () => startDaily(d) }];
    }
    case "practice": return [N("Easy hills"), N("Rolling hills"), N("Steep hills"), N("Wild hills")].map((label, i) => ({ label: T(label), act: () => startPractice(i) }));
    case "challenge": return Content.CHALLENGES.map((c, i) => ({ label: T("{name} — {desc}", { name: T(c.name), desc: T(c.desc) }), act: () => startChallenge(i) }));
  }
}
function setupScreen(w: number, L: Layout): void {
  const mode = app.setupMode;
  heading("h1", T(MODE_TITLES[mode]), w, "setup-h");
  if (mode === "daily") para(T("One shared course per day — the same hills for everyone."), w, "tagline", "setup-sub");
  const levels = levelsFor(mode);
  const list = (): void => {
    const r = ui.column("level-list", () => levels.forEach((lv, i) => {
      const text = lv.locked ? T("{label} 🔒", { label: lv.label }) : lv.label;
      button({ id: `level-${i}`, text, style: lv.done ? "btn-done" : "btn", disabled: !!lv.locked, act: () => { if (frame().frame !== app.openedFrame) lv.act(); } }, w - (tall ? 14 : 0));
    }), { spacing: 6, width: w - (tall ? 14 : 0) });
    lastSize.set("level-list", r.height / L.sc);
  };
  // The list scrolls inside at most half the window (style.css .hw-level-list max-height: 50vh).
  const maxH = Math.max(120, L.lh * 0.5);
  const tall = (lastSize.get("level-list") ?? 0) > maxH;
  if (tall) ui.scrollArea("level-scroll", { width: w, height: maxH }, list, frame().frame - app.openedFrame <= 5 ? { scrollTo: { top: 0 } } : undefined);
  else list();
  backButton(w);
}

// ------------------------------------------------------------------ settings and help
function check(key: "leftHanded" | "holdToDrive" | "telemetryConsent", label: string): void {
  const cur = !!settings[key];
  const next = ui.id(`set-${key}`).checkbox(label, cur);
  if (next !== cur) { platform.setSetting(key, next); click(); }
}
const PALETTE_NAMES: Record<Palette, string> = { default: N("Default"), deuteranopia: N("Deuteranopia"), protanopia: N("Protanopia"), tritanopia: N("Tritanopia") };
/** ui.js settingsForm: the game's own options; sound, graphics, language and the accessibility toggles are the runtime's. */
function settingsForm(w: number): void {
  ui.column("settings-form", () => {
    const cur = Math.max(0, PALETTES.indexOf(settings.palette));
    ui.row("palette-row", () => {
      para(T("Colour palette"), Math.max(80, w * 0.45), "body");
      ui.spacer();
      const next = ui.style({ width: Math.min(200, w * 0.5) }).id("set-palette").select(T("Colour palette"), cur, PALETTES.map((p) => T(PALETTE_NAMES[p])));
      if (next !== cur) platform.setSetting("palette", PALETTES[next]!);
    }, { width: w, align: "center", spacing: 10 });
    check("leftHanded", T("Left-handed pedals"));
    check("holdToDrive", T("Hold to drive (off = toggle)"));
    check("telemetryConsent", T("Share anonymous telemetry"));
    para(T("Sound, graphics, language, reduced motion, high contrast and larger text are in the StarHermit Options."), w, "gfx-note", "options-note");
    flow("options-btns", [
      { id: "btn-options", text: T("Open Options"), style: "btn-small", act: () => openMenu() },
      { id: "btn-rebind", text: T("Keyboard bindings"), style: "btn-small", act: () => requestRebind() },
    ], w);
  }, { style: "section", width: w, spacing: 8 });
}
function settingsScreen(w: number): void {
  heading("h1", T("Settings"), w, "settings-h");
  settingsForm(w);
  backButton(w);
}
function helpScreen(w: number): void {
  heading("h1", T("How to play"), w, "help-title");
  const or = " " + T("or") + " ";
  const cards: [string, string][] = [
    [T("Drive"), T("Hold {gas} or the GAS pedal to accelerate. {brake} or BRAKE slows you down. Coast downhill to save fuel.", { gas: keysFor("throttle"), brake: keysFor("brake") })],
    [T("Balance"), T("Only works in the air: {tiltL} tilts the nose up, {tiltR} tilts it down. Match the slope you are landing on.", { tiltL: keysFor("tilt_back"), tiltR: keysFor("tilt_forward") })],
    [T("Crashing"), T("Landing nose-first, on the roof, or too hard ends the run. Land on both wheels for a smooth-landing bonus.")],
    [T("Goal"), T("Reach the green flag before the fuel runs out. Yellow flags are checkpoints; yellow cans refill fuel.")],
    [T("Score"), T("Distance, checkpoints, smooth landings, cans, leftover fuel and time all add up.")],
    [T("Pause"), T("{pause} pauses. Practice mode allows undo with {undo}. {recenter} re-centres the camera.", { pause: keysFor("pause", or), undo: keysFor("undo", or), recenter: keysFor("recenter", or) })],
  ];
  const gap = 10;
  const cols = Math.max(1, Math.floor((w + gap) / (200 + gap)));
  const cw = (w - gap * (cols - 1)) / cols;
  ui.grid("help-cards", () => {
    cards.forEach(([title, body], i) => ui.column(`help-${i}`, () => {
      para(title, cw - 24, "help-h");
      para(body, cw - 24, "help-p");
    }, { style: "help-card", width: cw, spacing: 6 }));
  }, { columns: cols, gap, width: w, align: "stretch" });
  backButton(w);
}
function leaderboardScreen(w: number): void {
  heading("h1", T("Leaderboards"), w, "lb-h");
  const b = app.board;
  if (!b || b.loading) para(T("Loading…"), w, "note", "lb-note");
  else if (!b.entries) para(T("Leaderboard is unavailable right now."), w, "note", "lb-note");
  else if (!b.entries.length) para(T("No scores yet — be the first."), w, "note", "lb-note");
  else {
    ui.column("lb-list", () => b.entries!.forEach((e, i) => {
      const name = (e as { daily?: boolean }).daily ? T("Daily {date}", { date: e.name }) : e.name || T("player");
      para(`${i + 1}. ${name} — ${e.score}`, w - 8, e.me ? "board-me" : "board", `lb-${i}`);
    }), { spacing: 4, width: w });
  }
  backButton(w);
}

// ------------------------------------------------------------------ the HUD
const PEDAL_LABELS: Record<Pedal, { label: () => string; aria: string; action: string }> = {
  throttle: { label: () => T("GAS"), aria: N("Gas"), action: "throttle" },
  brake: { label: () => T("BRAKE"), aria: N("Brake"), action: "brake" },
  tiltL: { label: () => "◀ " + T("TILT"), aria: N("Tilt back"), action: "tilt_back" },
  tiltR: { label: () => T("TILT") + " ▶", aria: N("Tilt forward"), action: "tilt_forward" },
};
const FUEL_COLORS: Record<Palette, string> = { default: "#f2c14e", deuteranopia: "#5aa8d8", protanopia: "#d8c85a", tritanopia: "#d85a8a" };

function gameScreen(L: Layout): void {
  const s = app.session;
  if (!s) return;
  if (app.phase === "paused") { pausePanel(L); return; }
  if (app.phase === "results" || app.phase === "resolving") { if (app.results) resultsPanel(L); return; }
  hudTop(L);
  const trayH = tray(L);
  const hint = coachHint();
  if (hint) {
    const w = Math.min(L.lw * 0.9, 640);
    ui.place("hint", { anchor: "bottom", y: trayH + (L.phone ? 8 : 4) }, () => ui.column("hint-col", () => {
      para(hint, w - 40, "hint-text", "hint-text", true);
    }, { style: "hint-banner", align: "center" }));
  }
  const cd = countdownText();
  if (cd) {
    const long = cd.length > 3;
    const maxW = Math.min(L.lw - 32, long ? 560 : 420);
    ui.place("countdown", { anchor: "top", y: Math.max(80, L.lh * 0.3 - 50) }, () => ui.column("countdown-col", () => {
      para(cd, maxW - 56, long ? "countdown-long" : "countdown-main", "countdown-text", true);
      para(T("Get ready: {verb} to drive", { verb: gasVerb() }), maxW - 56, "countdown-hint", "countdown-hint", true);
    }, { style: "countdown", align: "center", spacing: 8 }));
  }
}

/** ui.js buildHud top bar: pause, objective + course track, speed line, fuel meter, score. */
function hudTop(L: Layout): void {
  const s = app.session!;
  const st = s.state;
  const f = frame();
  const padX = L.desktop ? 24 : L.shortLand ? 10 : 12;
  const padY = L.desktop ? 12 : L.shortLand ? 4 : 8;
  const barH = (padY * 2 + 44) * L.sc + f.safeArea.top;
  draw.box(0, 0, f.width, barH * 1.3, "hud-top");
  const gap = L.phone ? 8 : 12;
  const fuelW = L.phone ? 56 : 90;
  const score = String(Rules.scoreBreakdown(st).total);
  const scoreW = Math.max(36, textWidth(score, "hud-score"), textWidth(T("SCORE"), "hud-label"));
  const fuelColW = Math.max(fuelW, textWidth(T("FUEL"), "hud-label"));
  const showMirror = !L.phone && !L.shortLand && !!app.mirror;
  const mirrorW = showMirror ? textWidth(app.mirror, "hud-mirror") : 0;
  const objW = Math.max(60, L.lw - 2 * padX - 44 - fuelColW - scoreW - (showMirror ? mirrorW + gap : 0) - 3 * gap);
  const x = Math.max(0, Math.floor(st.vehicle.x));
  const left = Math.max(0, Math.ceil(st.goalX - x));
  const obj = T("{m} m to the flag · ⚑ {cp}/{total}", { m: left, cp: st.nextCheckpoint, total: st.checkpoints.length });
  ui.place("hud-top", { anchor: "top-start", x: padX, y: padY }, () => ui.row("hud-row", () => {
    pauseButton();
    ui.column("hud-objective", () => {
      const cls = textWidth(obj, "hud-obj") <= objW ? "hud-obj" : "hud-obj-small";
      ui.style(cls).id("hud-objective-text").label(fitText(obj, cls, objW));
      courseTrack(Math.min(320, objW - 8));
    }, { spacing: 4, width: objW });
    if (showMirror) ui.style("hud-mirror").id("hud-mirror").label(app.mirror);
    ui.column("hud-fuel", () => {
      ui.style("hud-label").label(T("FUEL"));
      fuelMeter(fuelW);
    }, { spacing: 3, align: "end", width: fuelColW });
    ui.column("hud-score", () => {
      ui.style("hud-label").label(T("SCORE"));
      ui.style("hud-score").id("hud-score-value").label(score);
    }, { spacing: 3, align: "end", width: scoreW });
  }, { spacing: gap, align: "center", width: L.lw - 2 * padX }));
}
/** Cuts a text to fit `width` with an ellipsis (style.css text-overflow: ellipsis). */
function fitText(text: string, cls: string, width: number): string {
  if (textWidth(text, cls) <= width) return text;
  let t = text;
  while (t.length > 1 && textWidth(t + "…", cls) > width) t = t.slice(0, -1);
  return t + "…";
}
function pauseButton(): void {
  // The ❚❚ button (ui.js buildHud): two drawn bars, named "Pause".
  const r = ui.id("btn-pause").widget(T("Pause"), {
    role: "button", size: { width: 44, height: 44 }, style: "hud-btn",
    draw: (rect, st) => {
      const k = st.scale, cx = rect.x + rect.width / 2, cy = rect.y + rect.height / 2;
      draw.rect(cx - 6 * k, cy - 7 * k, 4 * k, 14 * k, st.colors.text);
      draw.rect(cx + 2 * k, cy - 7 * k, 4 * k, 14 * k, st.colors.text);
    },
  });
  if (r.activated) { ui.setFocus(null); pauseRun(); }
}
/** The course from start to the green flag: checkpoint ticks and the position marker. */
function courseTrack(w: number): void {
  const st = app.session!.state;
  const x = Math.max(0, Math.floor(st.vehicle.x));
  const frac = Math.min(1, x / st.goalX);
  ui.widget(T("Course progress"), {
    role: "meter", size: { width: w, height: 14 }, value: Math.round(frac * 100), min: 0, max: 100,
    draw: (r, ws) => {
      const k = ws.scale, cy = r.y + r.height / 2, tw = r.width - 7 * k, x0 = r.x + 7 * k * 0.5;
      draw.roundRect(x0, cy - 3 * k, tw, 6 * k, 3, ws.highContrast ? "#ffffff66" : "#ffffff38");
      for (const cx of st.checkpoints) draw.rect(x0 + tw * (cx / st.goalX) - 1 * k, cy - 6 * k, 2 * k, 12 * k, "#f2c14e");
      draw.rect(x0 + tw - 2 * k, cy - 6 * k, 4 * k, 12 * k, "#4ed88a");
      const mx = x0 + tw * frac;
      draw.circle(mx, cy, 8 * k, "#ffffff80");
      draw.circle(mx, cy, 7 * k, "#1c2a22");
      draw.circle(mx, cy, 5 * k, "#f0f4ee");
    },
  });
}
/** The FUEL bar (role meter), red under 25 %; a colour-vision palette recolours it (style.css). */
function fuelMeter(w: number): void {
  const v = app.session!.state.vehicle;
  const pct = Math.max(0, Math.min(1, v.fuel / (v.fuelMax || 100)));
  const color = settings.palette !== "default" ? FUEL_COLORS[settings.palette] : pct < 0.25 ? "#d84e2e" : FUEL_COLORS.default;
  ui.widget(T("Fuel"), {
    role: "meter", size: { width: w, height: 14 }, value: Math.round(pct * 100), min: 0, max: 100,
    draw: (r) => {
      draw.roundRect(r.x, r.y, r.width, r.height, 7, "#6a7a6e");
      const k = r.height / 14;
      draw.roundRect(r.x + k, r.y + k, r.width - 2 * k, r.height - 2 * k, 6, "#16201a");
      if (pct > 0) draw.roundRect(r.x + k, r.y + k, Math.max(2 * k, (r.width - 2 * k) * pct), r.height - 2 * k, 6, color);
    },
  });
}

/** The pedal tray (ui.js buildHud): ◀ TILT and BRAKE at one side, GAS and TILT ▶ at the other (left-handed
 * swaps them); each pedal shows its keys on keyboard devices. Returns its height in logical px. */
function tray(L: Layout): number {
  const showKeys = !touchOnly() && !L.shortLand;
  const h = L.phone ? 72 : L.shortLand ? 48 : 64;
  const pad = L.desktop ? 24 : L.shortLand ? 10 : 12;
  const maxW = L.desktop ? 200 : 160;
  const groups: [Pedal, Pedal][] = settings.leftHanded ? [["throttle", "tiltR"], ["tiltL", "brake"]] : [["tiltL", "brake"], ["throttle", "tiltR"]];
  const highlight = app.coach?.highlight ?? null;
  const t = frame().time;
  const build = (list: Pedal[]): void => {
    for (const p of list) {
      const def = PEDAL_LABELS[p];
      const label = def.label();
      const keys = showKeys ? keysFor(def.action) : "";
      const w = Math.min(maxW, Math.max(L.shortLand ? 48 : 64, textWidth(label, "pedal-label") + 20, keys ? textWidth(keys, "pedal-keys") + 20 : 0));
      const on = pedalShown(p);
      const hint = highlight === p && !on;
      const r = ui.id(`pedal-${p}`).widget(T(def.aria), {
        role: "button", size: { width: w, height: h }, style: on ? "pedal-on" : hint ? "pedal-hint" : "pedal",
        draw: (rect, st) => {
          const k = st.scale, cx = rect.x + rect.width / 2;
          if (hint && !st.reducedMotion) {
            // style.css hw-pulse: a ring growing to 10 px and fading every 1.1 s.
            const ph = (t % 1.1) / 1.1, grow = (ph < 0.5 ? ph * 2 : 2 - ph * 2) * 10 * k;
            draw.strokeRoundRect(rect.x - grow, rect.y - grow, rect.width + 2 * grow, rect.height + 2 * grow, 14 + grow / k, `rgba(242,193,78,${(0.6 * (1 - grow / (10 * k))).toFixed(3)})`, 3);
          }
          const ls = 17.6 * k * ui.preferences().textScale * (L.phone ? 16 / 17.6 : 1);
          const ks = 12 * k * ui.preferences().textScale;
          const total = ls + (keys ? ks + 3 * k : 0);
          let y = rect.y + (rect.height - total) / 2;
          draw.text(label, cx, y, { size: ls, color: st.colors.text, align: "center", weight: "600" });
          y += ls + 3 * k;
          if (keys) draw.text(keys, cx, y, { size: ks, color: st.highContrast ? "#ffffff" : "#b8c8bc", align: "center" });
        },
      });
      pedalRects.set(p, { x: r.x, y: r.y, width: r.width, height: r.height });
    }
  };
  ui.place("tray-left", { anchor: "bottom-start", x: pad, y: pad }, () => ui.row("tray-left-row", () => build(groups[0]), { spacing: 8 }));
  ui.place("tray-right", { anchor: "bottom-end", x: pad, y: pad }, () => ui.row("tray-right-row", () => build(groups[1]), { spacing: 8 }));
  return h + pad;
}

// ------------------------------------------------------------------ pause and results
/** A centred panel over the run (the old screen layer), scrolling when taller than the window. */
function overlay(key: string, L: Layout, build: (w: number) => void, onClose: () => void): void {
  const pad = L.phone ? 20 : 24;
  const outer = L.phone ? L.lw - 32 : Math.min(L.desktop ? 616 : 560, L.lw - 32);
  const w = outer - 2 * pad;
  const avail = Math.max(80, L.lh * 0.92 - 2 * pad);
  const h = lastSize.get(`dlg-${key}`) ?? 0;
  const body = (): void => {
    const r = ui.column(`${key}-body`, () => build(w - (h > avail ? 14 : 0)), { spacing: 12, width: w - (h > avail ? 14 : 0) });
    lastSize.set(`dlg-${key}`, r.height / L.sc);
  };
  const fresh = frame().frame - app.openedFrame <= 4;
  const open = ui.dialog(key, "", true, () => {
    if (h > avail) ui.scrollArea(`${key}-scroll`, { width: w, height: avail }, body, fresh ? { scrollTo: { top: 0 } } : undefined);
    else body();
  });
  // The Escape that opened it must not close it the same frame.
  if (!open && frame().frame !== app.openedFrame) onClose();
}
function pausePanel(L: Layout): void {
  overlay(T("Paused"), L, (w) => {
    heading("h1", T("Paused"), w, "pause-h");
    ui.column("pause-btns", () => {
      button({ id: "btn-resume", text: T("Resume"), style: "btn-primary", act: resumeRun }, w);
      button({ id: "btn-restart", text: T("Restart"), act: restartLevel }, w);
      if (canUndo()) button({ id: "btn-undo", text: T("Undo"), act: undo }, w);
      button({ id: "btn-quit", text: T("Quit to title"), style: "btn-danger", act: () => quitToTitle() }, w);
    }, { spacing: 8, width: w });
    settingsForm(w);
  }, resumeRun);
}
const END_REASONS: Record<string, { title: string; text: string | null }> = {
  crashed: { title: N("Crashed"), text: N("You landed nose-first or too hard. In the air, tilt to match the slope you are about to land on.") },
  out_of_fuel: { title: N("Out of fuel"), text: N("The tank ran dry. Ease off the gas on descents and grab the yellow fuel cans.") },
  timeout: { title: N("Out of time"), text: N("The clock ran out before the flag. Keep the gas down on the flats.") },
  abandoned: { title: N("Run abandoned"), text: null },
};
function resultsPanel(L: Layout): void {
  const r = app.results!;
  overlay(T("Results"), L, (w) => {
    heading("h1", r.won ? T("Finished!") : T("Run over"), w, "results-h");
    if (r.isDaily) para(T("Daily challenge"), w, "tagline", "results-sub");
    if (r.won) para(T("{stage} complete", { stage: r.stageName() }), w, "note", "results-stage");
    const bd = r.breakdown;
    dl("score-table", [
      [T("Distance"), String(bd.distance)],
      [T("Checkpoints"), String(bd.checkpointBonus)],
      [T("Finish bonus"), String(bd.finishBonus)],
      [T("Smooth landings"), String(bd.landingBonus)],
      [T("Fuel cans"), String(bd.canBonus)],
      [T("Fuel bonus"), String(bd.fuelBonus)],
      [T("Time bonus"), String(bd.timeBonus)],
      [T("Total"), String(bd.total), true],
    ], w);
    if (r.newAchievements.length) para(T("Achievements: {names}", { names: r.newAchievements.map((n) => T(n)).join(", ") }), w, "achievements", "results-ach");
    const lb = leaderboardLine();
    if (lb) para(lb, w, "note", "results-lb");
    if (!r.won && r.result.terminalReason) {
      const e = END_REASONS[r.result.terminalReason];
      ui.column("end-reason", () => {
        para(e ? T(e.title) : r.result.terminalReason.replace(/_/g, " "), w - 26, "end-title", "end-title");
        if (e?.text) para(T(e.text), w - 26, "end-text", "end-text");
      }, { style: "end-reason", width: w, spacing: 4 });
    }
    const row: Btn[] = [];
    if (r.nextLabel) row.push({ id: "btn-next", text: T(r.nextLabel), style: "btn-primary", act: nextLevel });
    row.push({ id: "btn-retry", text: r.won ? T("Restart") : T("Try again"), style: r.nextLabel ? "btn" : "btn-primary", act: restartLevel });
    row.push({ id: "btn-quit", text: T("Quit to title"), style: "btn-danger", act: () => quitToTitle() });
    flow("results-btns", row, w);
  }, () => { app.openedFrame = frame().frame; /* the results stay until a choice is made */ });
}

// ------------------------------------------------------------------ the toast
function toast(L: Layout): void {
  const t = app.toast;
  if (!t) return;
  const w = Math.min(L.lw - 32, 520);
  const top = L.phone || L.shortLand;
  const text = t.text();
  ui.place("toast", { anchor: top ? "top" : "bottom", y: 16 }, () => ui.column("toast-col", () => para(text, w - 32, "toast-text", "toast-text", true), { style: "toast", align: "center" }));
}
