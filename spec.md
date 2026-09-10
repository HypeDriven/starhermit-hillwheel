# Hillwheel — game design document (running spec)

Hillwheel is shipped. This document describes what the game does today, in present tense.
Anything the design wants but the code does not yet do is confined to
"Design intent not yet implemented" at the end.

---

## 1. Overview

**Pitch.** Hold the gas, crest the hill, tilt in the air, land on both wheels — and reach the
green flag before the tank runs dry.

| | |
|---|---|
| Genre | Side-on physics hill-climb driving, single player |
| Players | 1, local; ranked comparison is asynchronous via the Daily |
| Session length | 25–90 s per run; 5–10 min per sitting |
| Platforms | Browsers on desktop (keyboard, mouse, gamepad) and mobile (touch pedals), portrait and landscape |
| Rendering | Three.js (`three.module.min.js`, ES-module importmap) on one WebGL canvas; all DOM chrome on top, no three.js in the UI layer |
| Simulation | Fixed 60 Hz integer-quantized step, seeded, replayable |

### File map

| Path | Responsibility |
|---|---|
| `index.html` | Entry point; importmap for `three`, mounts `#app`, loads `bootstrap.js` as a module |
| `bootstrap.js` | Capability detection (WebGL/touch/gamepad/DPR/reduced-motion), launch-token read, asset manifest, `createGame` |
| `game.js` | Orchestrator: phase machine, fixed-timestep loop, input mapping, coaching, achievements, progression, results |
| `rules.js` | Pure rules: terrain, physics step, legality, scoring, hashing, commands, terminal states. No DOM, no timers |
| `content.js` | Versioned content: 5 themes, 5 lessons, 40 journey stages, 4 challenges, daily derivation, offline validators |
| `session.js` | One rules state plus an ordered idempotent command log, undo snapshots, replay export and verification |
| `render.js` | Three.js scene graph, terrain strip, vehicle, flags, cans, trees, dust, camera, quality tiers |
| `ui.js` | DOM shell: screens, HUD, pedals, settings/progress persistence, live region, strings |
| `audio.js` | Web Audio buses, clip playback with synth fallback, engine hum, music, wind ambience |
| `platform.js` | StarHermit REST adapter: time sync probe, retries/rate limits, telemetry consent |
| `server.js` | Optional authoritative StarHermit game script: static serving + `/api/v1/*`, replay-validated scores |
| `style.css` | All presentation: palette, layout, responsive breakpoints, a11y variants |
| `test.js` | Rules/replay/fuzz/content/server suite — `npm test` |
| `tests/e2e.mjs` | Playwright-core playthrough of the real UI, desktop + mobile — `npm run test:e2e` |
| `tests/review-fixes.mjs` | Regression checks for settings persistence and countdown/restart |
| `smoke.js` | Legacy browser smoke test against `server.js` (superseded by `tests/e2e.mjs`) |
| `sfx/` | 17 Opus clips + `manifest.txt` (canonical), `manifest.json` (regeneration), `manifest.md` |
| `assets/keyart.webp` | Title-screen key art |
| `coverart.png`, `icon.png`, `favicon.svg` | Platform art |
| `data/` | Server-side JSON stores (gitignored) |
| `starhermit.txt` | Platform manifest (`name`, `launch`, `owner`, `server`, `cover`) |

---

## 2. Vision and design pillars

**1. The hill is the opponent, not a rival car.**
Every run is one vehicle against a heightfield. Rules in: seeded terrain that is the same for
everyone on a given seed, a course that is finished or not finished. Rules out: AI racers,
rubber-banding, overtaking mechanics, lap counting.

**2. Four inputs, no hidden state.**
Gas, brake, tilt left, tilt right. Everything the physics does follows from those and the
slope under the wheels. Rules in: binary held inputs that read identically on keyboard, pedals
and gamepad. Rules out: gear boxes, boost meters, upgrade trees, tuning screens — anything
that would make two players with the same inputs get different results.

**3. Fuel is the clock.**
Pressure comes from a burning tank, not a countdown. Rules in: coasting downhill as a real
strategy, fuel cans as the only pickup, "out of fuel" as a distinct, explained ending. Rules
out: timers on the HUD in normal modes (only the Sprinter challenge caps ticks), health bars,
damage models.

**4. A crash is a verdict on one decision.**
Landing is graded on pitch error against the slope you touch down on and on impact speed. Rules
in: readable air time long enough to correct, a results line that names what went wrong. Rules
out: random failure, invisible fragility, crashes from ground contact alone.

**5. Determinism is a feature the player can feel.**
Same seed plus same commands produce the same hashes, so the Daily is a fair shared course and a
run can be validated server-side. Rules in: quantized inputs, seeded RNG streams, replay
envelopes. Rules out: frame-rate-dependent physics, `Math.random()` anywhere in `rules.js`,
cosmetic randomness leaking into the sim.

---

## 3. Player experience

**Target player.** Someone who wants a complete, legible run in under a minute, on a phone or in
a browser tab, and who enjoys the small skill of reading a slope before landing on it.

**First 60 seconds.** A fresh profile (no lessons, no stages) sees the primary button read
*"Quick play — learn the basics"* with a note that the first run is a two-minute lesson.
Pressing it starts lesson 1 (`tut-throttle`): the countdown's first beat shows the lesson text
instead of "3", the GAS pedal pulses (`highlightPedal`), and the run begins with the persistent
hint *"Hold ↑ or W to drive"* / *"Hold GAS to drive"* on touch-only devices. The hint clears the
instant the player actually presses the throttle — never on a timer. The remaining lessons
introduce one rule each: brake before a drop, tilt to match the slope, fuel is finite, then all
four together. Returning players get *"Quick play — Stage N"* and resume the Journey.

**Coaching after the lessons** (`Game._coach`, at most once per run each): standing still with no
throttle for 90 ticks re-shows the gas prompt; the first long airtime with no tilt input shows
*"In the air: ← → tilt to match the slope"* (first six runs, or any lesson); fuel below 25 %
shows *"Fuel low: ease off downhill and grab the yellow cans"*.

**Session shape.** Title → mode → 3-2-1 countdown → 25–90 s run → results with a score
breakdown and, on failure, a one-sentence diagnosis → *Next stage* / *Try again*.

**Emotional beat.** The half second at the top of a crest, when the wheels leave the ground and
the only thing left to do is choose the landing angle.

---

## 4. Core loop and rules contract

All of §4 is implemented in `rules.js` unless noted.

### Board and entities

- **Terrain** (`createTerrain`): 5 sine octaves seeded from `seed ^ 0x51ed`, wavelengths
  `160 / 2^i` plus jitter, amplitude proportional to wavelength × `roughness`; a start ramp
  (`min(1, x/30)`) flattens the spawn. `height(x)` and `slope(x)` (central difference, ε = 0.25)
  are the only terrain queries; `render.js` samples the same functions, so the visible ground
  *is* the collision ground.
- **Vehicle**: `{x, y, vx, vy, angle, av, grounded, fuel, fuelMax}`, riding 0.9 units above the
  heightfield.
- **Fuel cans** (`placeContent`, stream `seed ^ 0xcafe`): `round(length/110)` by default, each
  `{x, taken}`, worth 30 fuel, collected inside a 2.4-unit radius of the can at `height(x)+1.2`.
- **Checkpoints**: evenly spaced at `length·i/(n+1)`, passed when `x` reaches them.
- **Goal**: `x >= goalX` (= course `length`).

### Legal actions

`legalActions(state)` returns `throttle` (needs fuel > 0), `brake` (needs `|vx| > 0.05` or
airborne), `tilt_left`, `tilt_right` (any live state), `pause` (always), each with a machine
reason (`round_over`, `no_fuel`, `already_stopped`). The same function backs hints and the UI.

### Resolution order per tick (`step`)

1. Quantize input to ±1000 (`quantizeInput`), clamp throttle/brake to 0…1000.
2. Burn fuel: `fuel -= throttle · 0.55 · dt · 10`.
3. Sample `height(x)` and `slope(x)`.
4. **Grounded**: project velocity onto the slope; `speed += (−22·sin(slope)·0.55 + throttle·14 −
   brake·26·sign(speed))·dt`; rolling drag 0.35; brake below 0.4 u/s snaps to 0; advance `x`,
   snap `y` to the surface; leave the ground when the slope drops by > 0.06 rad with speed > 3;
   align body angle toward the slope (gain 10, damping 6).
5. **Airborne**: gravity 22, air drag 0.02, tilt torque 5.2 with damping 1.6; on touchdown
   compute `impact` (normal-relative speed) and `angleErr = |angle − slope|`.
6. Collect cans; advance the checkpoint index.
7. Terminal checks (below), then `tick++`, then the tick cap.

### Terminal states

| Reason | Trigger |
|---|---|
| `finished` | `x >= goalX` |
| `crashed` | `angleErr > 0.85 rad` or `impact > 26` on touchdown; or a non-finite vehicle value |
| `out_of_fuel` | `fuel <= 0` while grounded and `|vx| < 0.3` |
| `timeout` | `tick >= maxTicks` (default 18 000 = 5 sim-minutes; Sprinter uses 1 800) |
| `abandoned` | Quit to title mid-run (`abandon`, via the `abandon` command) |

A terminated state is frozen: further `input` commands increment `invalidActions` and return
`round_over`.

### Scoring (`scoreBreakdown`, integers only)

```
distance        = floor(min(x, goalX))
checkpointBonus = checkpointsPassed × 100
finishBonus     = finished ? 500 : 0
landingBonus    = smoothLandings × 50      (angleErr < 0.18 rad after > 0.35 s of air)
canBonus        = cansCollected × 25
fuelBonus       = finished ? floor(fuel × 2) : floor(fuel)
timeBonus       = finished ? floor((maxTicks − tick) / 60) : 0
total           = sum of the above
```

**Worked example — Stage 1 driven by the reference autopilot** (`seed 2054560`, length 220,
2 checkpoints, 2 cans, 110 fuel, finished at tick 1208 with 64.3 fuel, 2 cans, 0 smooth
landings):
`220 + 200 + 500 + 0 + 50 + floor(64.3×2)=128 + floor((18000−1208)/60)=279 = **1377**`.

### Tie-breaks (`compareResults`)

Finished before unfinished → higher total → fewer `invalidActions` → fewer ticks →
lexicographic session id. Used by the leaderboard on the server.

### RNG and seeding

`mulberry32` only. Three disjoint streams: terrain (`seed ^ 0x51ed`), content placement
(`seed ^ 0xcafe`), decoration (`seed ^ 0xdec0`, in `render.js` and never read by rules). Journey
seeds are `0x1eaf00 + n·7919 + hash(n)`; the Daily seed is FNV-1a over the UTC date string.

### Undo and hints

Undo exists in Practice only: `session.pushUndoSnapshot()` every 120 ticks, ring of 8; `U` or the
pause-screen button restores the newest snapshot; with nothing to restore the UI announces
"Nothing to undo" and plays the `invalid` cue. Hints are the coaching lines in §3; there is no
solver or move suggestion.

---

## 5. Modes and progression

| Mode | Content | Ranked | Notes |
|---|---|---|---|
| Learn | 5 lessons (`TUTORIALS`), lengths 120–320, roughness 0.3–1.0 | no | Each states a `requires` gate (`minX`, `cans`); a lesson counts as learned only when the gate is met. Finishing the last lesson leads into Journey stage 1 |
| Journey | 40 stages (`STAGES`), 5 tiers of 8; every 5th is a Mastery stage (longer, rougher, less fuel) | no | Best total per stage is stored; stage `i` unlocks when stage `i−1` is complete or `i <= lastStage + 1` |
| Daily | One course per UTC date (`dailyContent`), length 380–540, roughness 0.8–1.3, 3 cans, 3 checkpoints, rotating theme | yes | Immutable per date; defective days are flagged `excluded`, never silently replaced |
| Practice | 4 hill types (Easy/Rolling/Steep/Wild), roughness 0.5→1.55, length 300→660 | no | The only mode with undo |
| Challenge | Hypermile (fuel 55, 1 can), Sprinter (30 s tick cap), Cliffside (roughness 1.8), Marathon (900 long) | no | Fixed seeds `0xbeef01`–`0xbeef04` |

**Difficulty curve.** Journey length grows `220 + tier·90 + (i mod 8)·30` (+120 on Mastery),
roughness `0.5 + tier·0.25 + (i mod 4)·0.08` capped at 1.8, fuel falls `110 − tier·10`
(−15 on Mastery) with a floor of 45. Mechanics widen by tier: throttle/brake → +tilt → +fuel.

**Achievements** (`game.js`, idempotent, stored in progress): First Finish, Smooth Operator
(3 smooth landings in a run), Hat Trick (3-run finish streak), Hill Veteran (20 stages),
Long Haul (50 000 cumulative metres).

**Content validation.** `validateLevel` runs a seeded autopilot over every lesson, stage,
challenge and a 7-day daily window, asserting bounded duration, a reachable goal (relaxed for
late Mastery stages and challenges), an integer score and a valid hash. `test.js` fails if any
shipped level regresses.

---

## 6. Controls and interaction

| Input | Desktop | Touch | Gamepad |
|---|---|---|---|
| Gas | `↑` / `W` | GAS pedal | RT (button 7) |
| Brake | `↓` / `S` | BRAKE pedal | LT (button 6) |
| Tilt back / forward | `←`/`A`, `→`/`D` | ◀ TILT / TILT ▶ pedals | Left stick X |
| Pause / resume | `Esc`, `P` | HUD ❚❚ button | Start (button 9) |
| Undo (Practice) | `U` | Pause-screen button | — |
| Re-centre camera | `C` | — | — |

- **Input locking.** Driving keys are captured only while the phase is `countdown`, `active` or
  `paused`, and never while focus is in an `input`/`select`/`textarea`/contenteditable — so the
  settings sliders and the quality select keep their arrow keys. `keyup` always clears the held
  state, even if focus moved, so nothing sticks.
- **Hold vs toggle.** "Hold to drive" is the default; turning it off makes each pedal press
  toggle, for players who cannot hold a control.
- **Left-handed pedals** mirror the tray order.
- **Feedback for every input.** Pedal press → `active` class + `input` click cue; illegal undo →
  buzz + assertive announcement; checkpoint → chime + announcement; takeoff → whoosh; hard
  landing → thud + 0.25 shake; crash → crunch + 0.9 shake; finish → fanfare.

---

## 7. Screens and UI flow

Phases (`Game._setPhase`): `boot → title → mode-select → preparing → countdown → active ↔
paused → resolving → results → progression`. Quit from any run returns to `title` after issuing
an `abandon` command.

| Screen | Contents |
|---|---|
| Title | Key art backdrop, name, tagline, primary Quick-play button, five mode buttons with one-line descriptions, control strip, Leaderboards / Settings / How to play |
| Mode setup | Level list with completion ticks, best scores, ★ for Mastery, 🔒 for locked; Back |
| Countdown | Full-screen 3-2-1 (or the lesson text on the first beat) plus a "get ready" hint line |
| HUD | Pause button, objective (`N m to the flag · ⚑ k/n`), progress track with checkpoint ticks and a position marker, speed/cans mirror, FUEL bar (`role="progressbar"`, red under 25 %), SCORE, coaching banner, 4-pedal tray |
| Pause | Resume / Restart / Undo (Practice) / Quit, with the full settings form inline |
| Results | Won/lost headline, per-line score table with total, new achievements, plain-language end-reason box, Next / Retry / Quit |
| Leaderboard | Top-20 list, or the offline "unavailable" note |
| Help | Six cards: Drive, Balance, Crashing, Goal, Score, Pause |
| Compatibility | Shown instead of the game when WebGL is unavailable, promising saved settings and progress |

**Layout.** Desktop ≥1024 px: centred panel capped at 70 ch, roomier HUD padding, pedals capped
at 200 px. Portrait ≤640 px: panels become bottom sheets (max 85 % height, scrollable inside),
pedals ≥72 px tall in the thumb zone, the speed mirror is hidden. Landscape ≤500 px tall: the
status rail shrinks, key hints are dropped, pedals stay ≥48 px.

**Safe areas.** The screen layer and HUD tray pad with `env(safe-area-inset-*)`; `viewport-fit=cover`
is set in `index.html`. Nothing that must never be cut off — the pedal tray, the fuel bar, the
score, the primary button on every panel — sits outside those insets, and long panels scroll
rather than clipping.

---

## 8. Art direction

**Palette (from `style.css` and `content.js`).**

| Role | Hex |
|---|---|
| Page ground / theme colour | `#1c2a22` |
| Panel | `#223028` with `#3a4a40` border |
| Text / muted text | `#f0f4ee` / `#b8c8bc` |
| Primary action | `#2e7d4e`, hover `#38925e`, border `#4ea872` |
| Success / goal flag | `#4ed88a` |
| Fuel, checkpoint flags, hint border | `#f2c14e` |
| Danger, low fuel, buggy body | `#d84e2e` |
| Themes (sky / fog / ground / accent) | Meadow `#9fd3e8`/`#cfe8d8`/`#6fae4e`/`#f2c14e`, Dusk Fells `#3a3f66`/`#6a5f8a`/`#5a6a4a`/`#e88a4e`, Frostmoor `#cfe0ea`/`#e8f0f4`/`#dde8ea`/`#5aa8d8`, Ember Heath `#f2c9a0`/`#e8b88a`/`#a87848`/`#d84e2e`, Starlit Down `#141a2e`/`#232a44`/`#2e3a34`/`#8ab8f2` |

**Shape language.** Flat-shaded low-poly: the terrain is a single two-row extruded strip with
near/far vertex colours, the buggy is boxes plus four cylinders, trees are cone-on-cylinder
instanced meshes, flags are a pole and a quad. Nothing is textured; silhouette and colour carry
all meaning.

**Typography.** System UI stack, weight and size only — no display face. The title is the one
oversized element; HUD labels are 0.65 rem letter-spaced caps.

**Motion.** Critically damped camera follow (`k = 1 − e^{−4Δt}`, frame-rate independent) with a
look-ahead of 8 units; camera shake is additive and decays at 2/s; cans bob and spin; dust puffs
from a bounded pool (60/160 points at medium/high) when grounded above 4 u/s.

**Hero of the screen.** The vehicle at the crest of a hill, with the next slope visible ahead —
the camera is framed so the landing you are about to choose is always on screen.

**Reduced motion** (setting or `prefers-reduced-motion`): camera snaps instead of damping, shake
is suppressed entirely, cans stop bobbing and spinning, dust stops emitting, and CSS transitions
and animations are disabled.

**Quality tiers.** low (DPR 1, no shadows, no trees, no particles, 2.0-unit terrain step, no AA),
medium (DPR 1.5, 60 % tree density, 60 particles, 1.2 step, AA), high (DPR 2, shadows, full
trees, 160 particles, 0.7 step, AA).

**Visual assets the design calls for:** title key art (§15) and the platform cover; everything in
the play scene is procedural by design, so no in-game textures or sprites are shipped.

---

## 9. Audio direction

**Mix philosophy.** The engine is the instrument the player plays: its pitch and filter track
speed and throttle continuously, so the mix tells you how fast you are going without looking.
One-shots sit above it; music and wind sit under it. No cue is audio-only — every one has a
visual counterpart (HUD number, flag colour, shake, banner).

**Buses** (`music`, `sfx`, `ambience`, `voice`), each an independently addressable gain under a
master gain, all sliders in Settings, plus a global mute. The context is created on the first
user gesture (autoplay policy) and silenced when the tab is hidden.

**Music.** A quiet six-note triangle motif on the `music` bus, started at "go" and stopped when
the run resolves. **Ambience.** `wind-ambience.opus` loops on the `ambience` bus for the whole
active run.

**Clip policy.** Every one-shot prefers its authored Opus clip; the clip is fetched, decoded and
cached on first use, and until then (or permanently, if it 404s) the event falls back to a
synthesized transient, so the game is never silent because of a missing file. Multi-clip events
pick a variant from the event's own counter, keeping replays consistent.

### SFX event table (source of truth for `sfx/manifest.txt`)

| event id | file | description | usage context |
|---|---|---|---|
| `input` | `input-tick.opus` | Soft plastic switch flick, dry | Any pedal press or driving key-down |
| `invalid` | `invalid-buzz.opus` | Short muted error buzz | Undo with nothing to undo; rejected actions |
| `can` | `can-pickup-low/mid/high.opus` | Three metallic can pings, rising pitch | Fuel can collected; variant by can count |
| `checkpoint` | `checkpoint-chime.opus` | Two-note ascending brass bell | Checkpoint flag crossed |
| `land_smooth` | `soft-landing.opus` | Cushioned suspension thump | Touchdown with pitch error < 0.18 rad after > 0.35 s of air |
| `land_hard` | `hard-landing.opus` | Bottom-out thud with metal creak | Survivable but ugly touchdown; adds 0.25 shake |
| `crash` | `vehicle-crash.opus` | Crumpling metal impact with debris | Terminal crash; adds 0.9 shake |
| `dry` | `engine-sputter.opus` | Petrol engine coughing and dying | Run ends `out_of_fuel` |
| `airborne` | `takeoff-whoosh.opus` | Airy whoosh with suspension rebound | Wheels leave the ground on a crest |
| `finish` | `finish-fanfare.opus` | Four-note rising brass fanfare | Run ends `finished` |
| `achievement` | `achievement-unlock.opus` | Three-note glockenspiel chime | Achievement unlocked on the results path |
| `click` | `ui-click.opus` | Clean handheld button click | Every menu/HUD action |
| `countdown` | `countdown-beep.opus` | Mid sine race-timer beep | Each 3-2-1 beat |
| `go` | `go-horn.opus` | Punchy toy air-horn | Countdown reaches zero |
| `ambience` | `wind-ambience.opus` | Breeze over grassy hills with distant birds | Looped on the ambience bus during a run |

Engine hum is synthesized, not sampled: a sawtooth through a low-pass whose frequency
(`55 + |vx|·4 + throttle·40`), gain and cutoff are `setTargetAtTime`-smoothed each frame.

---

## 10. Localization

**Ships today: en-US only.** All player-facing text is authored in English and lives in three
places: `STRINGS`, `MODE_DESCRIPTIONS`, `END_REASONS`, `PEDAL_LABELS` and the help/settings
builders in `ui.js`; the coaching lines and announcements in `game.js`; content names in
`content.js`. There is no locale selection, no message catalogue and no `lang` switching beyond
the static `lang="en"` on `<html>`.

**Design intent.** The required set is en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR,
it-IT, chosen from `navigator.languages` with an in-game override persisted in settings, falling
back within a language before falling back to en-US. Strings become keyed entries in a single
catalogue module with the English copy as the key set; formatting stays presentation-only
(distances and scores are integers, dates are ISO UTC, so no plural or number formatting is
needed beyond `Intl.NumberFormat`). Layout already tolerates expansion: every button and panel
wraps, none use fixed widths, and the pedals carry both a label and a glyph — budget +40 % over
English for German. This is not implemented (§17).

---

## 11. Accessibility

- **Keyboard-only path.** Every screen is native `<button>`/`<input>`/`<select>` in DOM order, so
  Tab reaches everything and Enter/Space activates it; a whole run is playable on the arrow keys
  or WASD; `Esc`/`P` pause, `U` undoes in Practice. No pointer-only affordance exists.
- **Focus.** Default focus rings are preserved (nothing sets `outline: none`); screens rebuild
  their contents so focus lands at the start of the new panel.
- **Announcements.** A polite `aria-live` region announces checkpoints, undo and coaching-relevant
  state; achievements and rejected actions use `assertive`. The fuel meter is a
  `role="progressbar"` with an `aria-label`; the canvas carries an `aria-label`; the pause button
  and each pedal carry text-free-safe `aria-label`s.
- **Captions for audio.** Every sound has a visible counterpart, so no cue is missable with sound
  off: checkpoints announce and recolour the flag, crashes show the results reason, fuel shows a
  bar that turns red, achievements are listed on the results screen.
- **Contrast.** Body text `#f0f4ee` on `#223028` is ≈ 12:1; the muted `#b8c8bc` on the same panel
  is ≈ 8:1. A High contrast setting switches panels, buttons and pedals to pure black/white with
  a dark-green active state.
- **Colour is never the only channel.** Passed checkpoints change colour *and* increment a
  counter; low fuel changes colour *and* triggers a worded hint. Three colour-vision palettes
  (deuteranopia/protanopia/tritanopia) restyle the fuel bar.
- **Reduced motion** honours the OS setting and a manual toggle (§8).
- **Target sizes.** Pedals are ≥72 px tall in portrait and ≥48 px in landscape; menu buttons are
  full-width rows; the pause button meets 44 px with padding.
- **Larger text** setting scales the whole shell to 1.25 rem.

---

## 12. StarHermit integration

Conventions from https://wiki.starhermit.com/. `starhermit.txt` declares `name=Hillwheel`,
`launch=index.html`, `owner`, `server=server.js`, `cover=coverart.png`.

**Used by the client (`platform.js`).**

- **Launch token** — read from `?launch_token` or `window.__STARHERMIT_LAUNCH_TOKEN__`, decoded
  for its scope, sent as a bearer header, held in memory only and never persisted.
- **Server time** — `GET /api/v1/time` is the one route the host guarantees; it sets the RTT-
  adjusted clock offset, the `hosted` flag, and the UTC date the Daily is derived from.
- **Telemetry consent** — off by default, a settings checkbox, and the event allow-list is
  fixed (`start`, `tutorial_step`, `round_end`, `retry`, `settings_change`, `error`).

**Deliberately local no-ops in the client**, because the production host serves no such route and
a request would 404: leaderboards, score submission, achievement unlocks, cloud saves, presence
and activity. Each returns `{ok: false, error: 'offline', recoverable: true}` without issuing a
request, and the UI shows its offline state (the leaderboard says "unavailable"). Progress,
settings and achievements persist in `localStorage`.

**Implemented by the game script (`server.js`)** for hosts that do run it: static serving with
`tests/`, `tools/` and dotfiles refused; `/api/v1/time`; `/api/v1/daily`; `/api/v1/scores` with
**server-side replay validation** (ruleset 2 and content version 2.0.0 enforced, the submitted
command log re-simulated, hashes and breakdown compared before an entry is accepted);
`/api/v1/leaderboard` ordered by `compareResults`; `/api/v1/achievements`; `/api/v1/save`;
presence/activity stubs; telemetry sink; per-IP token-bucket rate limiting; 256 KB body cap.

**Not used at all:** multiplayer sessions, matchmaking, chat, friends, in-game purchase.

---

## 13. Technical architecture

- **Layering.** `rules.js` has no imports and no side effects; `content.js` depends only on rules;
  `session.js` wraps rules with a command log; `render.js`, `ui.js`, `audio.js`, `platform.js` are
  leaves; `game.js` is the only module that knows about all of them. Nothing below `game.js`
  reaches into the DOM except `ui.js` and `render.js`.
- **Determinism and replay.** Inputs are quantized before they touch the sim; state is hashed with
  FNV-1a over a fixed integer projection; `Session` records every accepted command plus a hash
  every 60 ticks; `verifyReplay` re-runs an envelope and rejects on initial, intermediate or
  terminal hash mismatch. Cosmetic randomness (`Math.random` for dust and shake) lives only in
  `render.js`.
- **State schema and migration.** `SCHEMA_VERSION = 2`; `migrateState` upgrades v1 saves and
  throws on anything else. Terrain is never serialized — it is rebuilt from the seed.
- **Persistence.** `hillwheel-settings-v1` and `hillwheel-progress-v1` in `localStorage`, merged
  over defaults on read and written on every settings or progression change; all storage access is
  wrapped so a blocked-storage browser degrades to session-only play. Server stores are atomic
  temp-file renames under `data/`.
- **Loop.** One `requestAnimationFrame` drives everything: clamp Δt to 100 ms, poll the gamepad,
  accumulate into fixed 1/60 steps (max 5 per frame, so a stalled tab never fast-forwards), render
  the interpolated vehicle pose, then update the HUD; the score mirror refreshes every 30 ticks.
- **Performance budgets.** One draw call for the terrain strip, two instanced meshes for trees,
  one Points object for dust; ~10 draw calls in a typical frame. Level load is synchronous
  geometry generation (≈ 500–1500 quads), no network fetch. Target 60 fps at high on desktop and
  medium on a mid-range phone; `render.stats()` exposes draw calls and triangles.
- **Robustness.** WebGL context loss suspends rendering and resumes on restore; a missing WebGL
  context shows the compatibility screen instead of failing; `unloadLevel` disposes every geometry
  and material.
- **e2e drive path.** `tests/e2e.mjs` starts its own static `node:http` server (the repo's
  `server.js` is the authoritative host script and is not used), launches system Chrome via
  `playwright-core`, and clicks the real buttons; it reads the exposed session state each poll and
  holds the *real* keys (feathering the throttle with a duty cycle, because UI input is binary),
  which is the same autopilot shape the content validator uses.

---

## 14. Testing and acceptance criteria

**`npm test` (`test.js`, 30 checks).** Legality with reasons; terminal states for finish, crash,
fuel and timeout; scoring monotonicity and the breakdown identity; quantization; state
serialize/deserialize/migrate round-trips; hash stability; command idempotence and rejection of
malformed commands; deterministic replay of recorded sessions plus fuzzed input streams; undo
snapshots; content validation of all 5 lessons, 40 stages, 4 challenges and a 7-day daily window;
and a live `server.js` API smoke covering time, daily, score validation, leaderboard, achievements
and saves.

**`npm run test:e2e` (`tests/e2e.mjs`).** Desktop 1280×800 then a fresh mobile 390×844 touch
context: title visible, settings open/toggle/close, help round-trip, leaderboard degrades
gracefully offline, journey list shows 40 stages with the correct unlock state, a stage driven
countdown → active → results with a "Finished!" headline, progression persisted to
`localStorage`, next stage → pause → resume → quit, practice with undo available, and on mobile
the on-screen pedals actually moving the vehicle. **Any console error fails the run** (only
known GPU/swiftshader noise is filtered).

**`npm run test:review` (`tests/review-fixes.mjs`).** Settings survive a reload and are re-applied;
restart during the countdown keeps counting and still completes; no page or console errors.

**QA bar (`agents/qa.md`) as checkable statements.**

1. Every implemented feature is reachable in the browser by clicking visible UI — all five modes,
   settings, help, leaderboards, pause, undo, restart, next.
2. A first-time player is taught: the primary button starts a lesson, and the coaching lines cover
   gas, tilt and fuel the first time each matters.
3. No console errors or warnings during a full playthrough at either viewport.
4. No text or control is cut off at 1280×800, 390×844 portrait or 844×390 landscape; long panels
   scroll inside themselves and respect safe-area insets.
5. A run is completable end-to-end by automation driving the real UI, on both desktop keys and
   mobile pedals.
6. Every `.js`/`.mjs` file passes `node --check`.

---

## 15. Asset inventory

| Path | Purpose | Source | Status |
|---|---|---|---|
| `assets/keyart.webp` | Title-screen backdrop (1280×720, 29 KB) | FLUX.2 klein, seed 4711 | generated in this pass; wired as the title screen background |
| `coverart.png` | Platform cover art, 1200×675 | FLUX.2 klein, seed 4711 (same render, rescaled + palettized to 267 KB) | regenerated in this pass, replacing a generic placeholder |
| `icon.png`, `favicon.svg` | Platform icon and tab icon | authored | shipped |
| `sfx/input-tick.opus` | `input` cue | MOSS-SFX v2.0 | shipped |
| `sfx/invalid-buzz.opus` | `invalid` cue | MOSS-SFX v2.0 | shipped |
| `sfx/can-pickup-{low,mid,high}.opus` | `can` variants | MOSS-SFX v2.0 | shipped |
| `sfx/checkpoint-chime.opus` | `checkpoint` cue | MOSS-SFX v2.0 | shipped |
| `sfx/soft-landing.opus` | `land_smooth` cue | MOSS-SFX v2.0 | shipped |
| `sfx/hard-landing.opus` | `land_hard` cue | MOSS-SFX v2.0 | shipped |
| `sfx/vehicle-crash.opus` | `crash` cue | MOSS-SFX v2.0 | shipped |
| `sfx/finish-fanfare.opus` | `finish` cue | MOSS-SFX v2.0 | shipped |
| `sfx/ui-click.opus` | `click` cue | MOSS-SFX v2.0 | shipped |
| `sfx/countdown-beep.opus` | `countdown` cue | MOSS-SFX v2.0 | shipped |
| `sfx/go-horn.opus` | `go` cue | MOSS-SFX v2.0 | shipped |
| `sfx/engine-sputter.opus` | `dry` cue (out of fuel) | MOSS-SFX v2.0, 100 steps | generated in this pass; wired |
| `sfx/takeoff-whoosh.opus` | `airborne` cue | MOSS-SFX v2.0, 100 steps | generated in this pass; wired |
| `sfx/achievement-unlock.opus` | `achievement` cue | MOSS-SFX v2.0, 100 steps | generated in this pass; wired |
| `sfx/wind-ambience.opus` | Looping ambience bed | MOSS-SFX v2.0, 100 steps | generated in this pass; wired |
| `three.module.min.js`, `three.core.min.js` | Renderer (MIT, three.js r185) | vendored | shipped |
| Terrain, vehicle, flags, cans, trees, dust | Play-scene geometry | procedural in `render.js` | by design, no files |

No 3D model or character animation is shipped: the buggy is a five-primitive authored mesh, and a
GLTF loader is not vendored, so importing a generated model would be a renderer change rather
than a wiring change.

---

## 16. Known limitations

- **Localization is not implemented** — the game ships English only (§10).
- **Hosted platform features are client-side no-ops.** Leaderboards, cloud saves, achievements and
  presence work only against `server.js`; on the production host the leaderboard screen always
  shows "unavailable" and scores are never submitted.
- **The engine hum is synthesized**, not an authored loop, so it is thinner than the one-shots.
- **Trees and rocks are decoration only** — nothing off the centre line is collidable, and the
  theme "rock" colour is currently unused by the renderer.
- **The vehicle has no suspension model**: the body angle is aligned to the slope rather than
  simulated per wheel, so wheels can visually clip a sharp crest for a frame or two.
- **`smoke.js` at the repo root is legacy**, depends on the full `playwright` package and drives
  `server.js`; `tests/e2e.mjs` is the supported playthrough.
- **`package.json` cannot declare `"type": "module"`** while `server.js` is CommonJS, so running a
  root ES module directly through `node -e` prints a module-type warning (tests are unaffected).

---

## 17. Design intent not yet implemented

1. **Nine-locale text** with a catalogue module and a language setting (§10).
2. **A recorded engine loop** replacing the synthesized hum, cross-faded by RPM band.
3. **Ghost replays** — the replay envelope already carries everything needed to render a previous
   run's vehicle alongside the live one on the Daily; nothing draws it yet.
4. **Per-wheel suspension** so the chassis reads terrain detail the current slope-alignment misses.
