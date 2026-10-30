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
| Platforms | The StarHermit engine 1.28.0 (host API 1.30): natively in the StarHermit client and in browsers through the engine's web runtime; desktop (keyboard, mouse, gamepad) and mobile (touch pedals), portrait and landscape |
| Rendering | `starhermit:scene` (three.js-like scene graph) for the hills; `starhermit:ui` (immediate mode) for every screen and the HUD |
| Simulation | Fixed 60 Hz integer-quantized step on the runtime's fixed steps, seeded, replayable |

### File map

| Path | Responsibility |
|---|---|
| `starhermit.txt` | Manifest: `launch=index.html`, `engine.entry=native/main.ts`, `engine.version=1.28.0`, `engine.minor=30`, capabilities `platform,storage,clipboard`, the `control.*` actions and their `engine.gamepad.*` defaults |
| `index.html`, `starhermit-files.json` | The engine's web loader and file index, written by `npm run package` (`starhermit package --web .`); never edited by hand |
| `native/main.ts` | Entry: phase machine, fixed-step loop, countdown, input (actions, pedals by touch/mouse, hold or toggle), coaching, undo, achievements, progression, results, leaderboard posting, lifecycle |
| `native/screens.ts` | Every screen, the HUD, pedal tray, countdown, pause and results panels, toast (`starhermit:ui`) |
| `native/render.ts` | The 3D scene (`starhermit:scene`): terrain, ridges, sky, clouds, stars, buggy, cans, flags, arch, trees, rocks, tufts, particles, camera, lights, post effects |
| `native/quality.ts` | The old presets and budgets per runtime quality tier and level |
| `native/audio.ts` | One-shots, wind bed, motif and engine hum on `starhermit:audio` |
| `native/platform.ts` | Progress save (device + cloud, conflict merge, old-save migration), game options, player/avatar/invite, server clock, leaderboard read and posting |
| `native/i18n.ts`, `native/style.ts`, `native/game.ts` | Language, the converted style sheet and high-contrast tokens, typed facade over the pure modules |
| `rules.js`, `content.js`, `session.js` | Pure rules, content and session, unchanged from the browser build (ES modules, imported with `allowJs`) |
| `progress.js` | Progress document: defaults, normalise, two-device merge, reading the browser build's cloud save |
| `strings.js`, `account-strings.js` | Translation tables (nine locales) and the account strings |
| `score-script.js` | StarHermit platform script (`server=`): range-checks a finished run's total and posts it to the `high-score` board |
| `server.js` | Local dev server: static serving + `/api/v1/*`, replay-validated scores (exercised by `test.js` only; not packaged) |
| `tools/ui-style.css` → `assets/ui-style.json` | The style sheet, class-based, converted by `npm run css` (`starhermit css`) |
| `tools/package-web.mjs`, `tools/css.mjs`, `tools/browser-play.mjs` | Packaging, CSS conversion, the GPU-Chrome browser play check |
| `test.js`, `tests/*.test.mjs`, `tests/native.mjs`, `tests/native/*.play` | Rules/server suite, i18n and progress unit tests, engine checks and scripted plays |
| `sfx/`, `assets/keyart.webp` | 17 Opus clips + manifests; title key art |
| `cover.jpg`, `coverart.png`, `icon.png` | Platform art |
| `data/` | Dev-server stores (gitignored, not packaged) |

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
instead of "3", the GAS pedal pulses (the lesson's pedal), and the run begins with the persistent
hint *"Hold ↑ or W to drive"* / *"Hold GAS to drive"* on touch-only devices. The hint clears the
instant the player actually presses the throttle — never on a timer. The remaining lessons
introduce one rule each: brake before a drop, tilt to match the slope, fuel is finite, then all
four together. Returning players get *"Quick play — Stage N"* and resume the Journey.

**Coaching after the lessons** (`main.ts` `coach`, at most once per run each): standing still with no
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
  are the only terrain queries; `native/render.ts` samples the same functions, so the visible ground
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
(`seed ^ 0xcafe`), decoration (`seed ^ 0xdec0`, in `native/render.ts` and never read by rules). Journey
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

**Achievements** (`native/main.ts`, idempotent, stored in progress): First Finish, Smooth Operator
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
| Gas (`throttle`) | `↑` / `W` | GAS pedal | Right trigger |
| Brake (`brake`) | `↓` / `S` | BRAKE pedal | Left trigger |
| Tilt back / forward (`tilt_back`, `tilt_forward`) | `←`/`A`, `→`/`D` | ◀ TILT / TILT ▶ pedals | Left stick X, D-pad left/right |
| Pause / resume (`pause`) | `Esc`, `P` | HUD pause button | Start |
| Undo, Practice (`undo`) | `U` | Pause-panel button | West (X) |
| Re-centre camera (`recenter`) | `C` | — | Right stick press |

Players rebind keys and pads in the runtime's Options (the action names changed from the browser build's
`tiltL`/`tiltR`, so a browser-build rebinding of the tilts is not carried over). Labels in the HUD,
help, coaching and the title's control strip come from the effective bindings (`↑ / W`).

- **Input locking.** Driving actions are read only while the run is on screen (countdown and active),
  never while a runtime text field captures keys; held driving keys clear the UI focus so arrows do
  not walk the HUD. Triggers count above 0.2, the stick above 0.3 (binary, as before).
- **Pedals.** Each finger is tracked separately (`onTouch`), so GAS and TILT can be held together; a
  finger sliding off its pedal releases it. The mouse can hold a pedal too. On touch-first or
  phone-sized windows the wording switches to the pedals ("Hold GAS").
- **Hold vs toggle.** "Hold to drive" is the default; turning it off makes each pedal press toggle.
- **Left-handed pedals** swap the two pedal groups.
- **Feedback for every input.** Pedal or driving key press → the `input` cue and the pedal lit;
  illegal undo → buzz + assertive announcement; checkpoint → chime + announcement; takeoff → whoosh;
  hard landing → thud + 0.25 shake; crash → crunch + 0.9 shake; finish → fanfare.

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

**Layout** (picked by the window's logical size, `native/screens.ts`). Desktop ≥1024 px: panel up to
616 px, roomier HUD padding, pedals up to 200 px wide. Portrait ≤640 px: panels are bottom sheets
(at most 85 % of the height, scrolling inside), pedals 72 px tall, the speed line is hidden.
Landscape ≤500 px tall: slim status bar, no key hints on the pedals, 48 px pedals. Large screens are
scaled by the runtime's interface size. The toast sits at the bottom on desktop and at the top on
phones and short landscape. Pause and results are modal panels over the dimmed scene.

**Safe areas.** Layout happens inside `frame().safeArea`; long panels scroll rather than clip.

---

## 8. Art direction

**Palette (from `tools/ui-style.css` and `content.js`).**

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

**Shape language.** Low-poly with soft, rounded pieces: the course is a ribbon whose track band
(|z| ≤ 2.5) follows the rules' height profile exactly, edged by a lighter dirt track, grass
shoulders and a dark soil cut face in front; behind it the ground rolls away into a hazy valley,
with two fog-tinted backdrop ridges that rise with the course. The buggy is a clear-coated rounded
chassis with a roll cage, helmeted driver, spoked wheels that roll with distance travelled, and
glowing head/tail lights. Trees are two-tier instanced pines with per-tree colour variation,
rocks use the theme rock colour, fuel cans are glossy jerry cans with a soft halo, flags are cloth
that waves, and the goal has a chequered finish arch. The only textures are generated in code
(chequer, halo); silhouette and colour still carry all meaning.

**Typography.** The engine's UI font, weight and size only — no display face. The title is the one
oversized element; HUD labels are 0.65 rem letter-spaced caps.

**Motion.** Critically damped camera follow (`k = 1 − e^{−4Δt}`, frame-rate independent) with a
look-ahead of 8 units; camera shake is additive and decays at 2/s; cans bob and spin; dust puffs
from a bounded pool (the level's particle budget) when grounded above 4 u/s.

**Hero of the screen.** The vehicle at the crest of a hill, with the next slope visible ahead —
the camera is framed so the landing you are about to choose is always on screen.

**Reduced motion** (the runtime's option): camera snaps instead of damping, shake is suppressed,
cans stop bobbing and spinning, dust stops emitting, the sky and flags hold still and the pedal
pulse stops.

**Graphics.** ACES filmic tone mapping with sRGB output; a warm key sun with PCF shadows whose
shadow follows the vehicle (the page's ±30 m `shadow.camera` box, texel-snapped);
a hemisphere fill tinted by the theme sky and ground. The sky is a gradient dome framed for the
gameplay camera, with a sun (a pale moon on dark themes) whose HDR core blooms, drifting low-poly
clouds, and twinkling stars on dark themes. Image-based lighting comes from a `PMREMGenerator` +
`RoomEnvironment` map: `scene.environment` at a subtle intensity for diffuse fill, plus a stronger
per-material env map on glossy pieces (paint, rims, cage, visor, cans, poles). With detailed
terrain the ground shader adds world-space value noise so large surfaces are never flat. Post
(the renderer's chain, by level): GTAO (sky, clouds, ridges and
halos excluded from its pre-pass) → UnrealBloom (threshold 0.92, raised on snow so only lights,
cans, flags, the sun and sparkles glow) → output → colour grade (display space: (gentle S-curve, +7 %
saturation, warm highlights/cool shadows, vignette) → SMAA, FXAA or MSAA. Particles are soft camera-facing billboards: dust while driving, a puff on every landing, and a
sparkle burst when a can is collected. Clouds, star twinkle and flag waves stop with reduced
motion or on the Low level (still sky).

**Graphics levels.** The runtime's Options › Graphics owns Auto/level choice, render scale,
adaptive resolution, the frame-rate limit and readout. `native/quality.ts` maps its quality tier
(`frame().quality`) to the browser build's presets and its level (`frame().levelIndex`) scales tree
and particle counts within the tier (at most 2×):

| | Low | Balanced | High | Ultra |
|---|---|---|---|---|
| Shadows | off | 1024² | 2048² | 4096² |
| Ambient occlusion | off | off | on | high |
| Bloom, grade, reflections | off | on | on | on |
| Anti-aliasing | off | FXAA | SMAA | MSAA |
| Trees and rocks | off | 60 % of 11 / 100 m | 14.3 / 100 m | 20 / 100 m |
| Particles | off | 48 | 192 | 320 |
| Sky | still | animated | animated | animated |
| Terrain | plain (2.0 u, 8 rows) | detailed (0.7 u, 17 rows, noise, tufts) | detailed | detailed |
| Prop materials | Lambert | Standard | clear-coat Physical | clear-coat Physical |

A level change applies at once (shadow, post and environment settings; asset changes rebuild the
level's views from the same seed). The old per-effect overrides are not offered. The track profile and
everything the vehicle touches are identical on every level.

**Engine port notes.** Light intensities are three.js r185's (minor 23+); the sky and the billboard particles
(dust, sparkles, stars: an instanced quad turned to the camera, size/alpha in `instanceCustom`) are
WGSL `ShaderMaterial`s; the terrain noise is a WGSL surface hook; the post chain is `renderer.ao`
(GTAO), `bloom` (threshold 0.92, 2.2 on snow), `grade` (display space) and `antialias`; the shadow
follows the vehicle in the page's ±30 m `shadow.camera` box.

**Visual assets the design calls for:** title key art (§15) and the platform cover; everything in
the play scene is procedural by design, so no in-game textures or sprites are shipped.

---

## 9. Audio direction

**Mix philosophy.** The engine is the instrument the player plays: its pitch and filter track
speed and throttle continuously, so the mix tells you how fast you are going without looking.
One-shots sit above it; music and wind sit under it. No cue is audio-only — every one has a
visual counterpart (HUD number, flag colour, shake, banner).

**Buses.** The runtime's `music`, `effects` and `interface` buses (Options › Audio: volumes, mute,
voice limit). Music → music, effects and the wind bed → effects, the menu click → interface; the old
default levels (music 70 %, effects 80 %, ambience 60 %) are folded into each sound's gain. Sound
holds while paused or the window is hidden. Clips load one at a time once the mixer runs (in a
browser after the first press).

**Music.** A quiet six-note triangle motif on the `music` bus, started at "go" and stopped when
the run resolves. **Ambience.** `wind-ambience.opus` loops on the `ambience` bus for the whole
active run.

**Clip policy.** Every one-shot plays its authored Opus clip; a clip still loading is silent (the
browser build's synthesized stand-ins are not ported: a live synthesis graph makes clip loads fail
on the web runtime). The can pickup picks its variant from the run's can count.

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

Engine hum: one period-exact loop of a low-passed 50 Hz sawtooth is rendered once (`createClip`) and
played looping; each frame its pitch follows `55 + |vx|·4 + throttle·40` Hz and its level
`0.05 + throttle·0.06` (the filter cutoff moves with the pitch rather than separately). The motif's
notes are rendered clips too.

---

## 10. Localization

Nine locales ship: **en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR, it-IT**. Every
player-facing string — title, mode cards, setup lists, HUD (objective, fuel, score, speed line,
pedal labels and aria-labels), coaching lines, countdown, pause, settings, help, results, end
reasons, leaderboards, toasts and live-region announcements, plus the content names (lessons and
their intros, challenges, "Stage n"/"Mastery n", "Daily <date>", achievements) — is an English
key in `strings.js` with es-419, de-DE, fr-FR, pt-BR and it-IT translations; en-GB, es-ES and fr-CA
carry only their differences (fr-CA "Pointage"). The account strings (`account-strings.js`) keep their own nine-locale table and follow the same
language.
"Hillwheel" and "StarHermit" are not translated; distances and scores are plain integers.

- **Language** is the runtime's Options › Language (the player's choice, else the account's
  preferred language, else the device's), mapped to the nearest shipped locale (`es-MX → es-419`,
  `en-AU → en-GB`). Every string is drawn through `T()` each frame, so a change shows on the next
  frame without touching the run.
- **Layout:** buttons wrap, long labels become paragraphs, the HUD objective is cut with an ellipsis.

## 11. Accessibility

- **Keyboard and gamepad path.** Every screen is `starhermit:ui` widgets in reading order: Tab /
  arrows / D-pad reach everything, Enter/Space/South activate; a whole run plays on keys or a pad.
- **Focus.** Each screen focuses its first useful button (Quick play, Resume, Next).
- **Announcements.** `ui.announce` reads checkpoints, undo, the countdown, pause and results
  (achievements and rejected undo assertively). The fuel bar and course track are meters with names;
  the pause button and pedals are named buttons.
- **Captions for audio.** Every sound has a visible counterpart (flag colour, fuel bar, results).
- **Contrast.** Body text `#f0f4ee` on `#223028` ≈ 12:1; muted `#b8c8bc` ≈ 8:1. The runtime's high
  contrast option swaps the style tokens to black panels, white text and borders, dark-green active.
- **Colour is never the only channel.** Three colour-vision palettes recolour the fuel bar (a palette
  colour replaces the low-fuel red, as in the browser build).
- **Reduced motion** (runtime option) snaps the camera, stops shake, can bob, dust, clouds, stars,
  flag waves and the pedal pulse.
- **Larger text and interface size** are the runtime's.
- **Target sizes.** Pedals ≥72 px tall in portrait, ≥48 px in landscape; buttons ≥44 px.

## 12. StarHermit integration

Through `starhermit:platform` / `starhermit:storage` (`native/platform.ts`):

- **Player** — signed in or a guest. Signed in, the title shows the avatar and `name · sync state`.
  A guest sees **Sign in with StarHermit** (the runtime's account dialog). A session ending (signed
  out elsewhere, expired) shows the "Signed out" toast and play continues as a guest.
- **Progress save** — `saves` (schema 1) on the device and, signed in, in the cloud slot. A conflict
  merges both copies (`progress.js merge`: higher score per stage and Daily, union of lessons and
  achievements, furthest stage, larger distance and run counts). The browser build's cloud save
  (`game:<slug>`, `{ schemaVersion, savedAt, progress, settings }`) appears as foreign: its progress
  is merged, its options adopted, and it is replaced once (`replaceForeign`). Guests' old browser
  `localStorage` progress does not migrate.
- **Game options** — left-handed pedals, hold to drive, colour palette and telemetry consent are
  `settings` (`game.<key>`, synced). The browser build's settings-KV keys are imported once (the
  game's options) and removed. Volumes, graphics, language and accessibility are the runtime's.
- **Server time** — `serverTime()`/`serverNow()` give the Daily's UTC date; offline the device clock.
- **Invite** — **Invite a friend** (signed in) copies `inviteLink()` to the clipboard with a toast.
- **Leaderboard posting** — signed in, every finished run except Learn lessons posts its total
  through `score-script.js` (a practice session whose socket sends `{ type: 'result', scores }`; the
  script range-checks 0–20,000 into `high-score`), and the results show "Leaderboard rank: #N" (or
  posted / not posted). Guests post nothing.
- **Leaderboards screen** — signed in, the `high-score` board's top 20; a guest sees their own best
  Daily scores (local), as standalone did.
- **Reports and crashes** — the runtime's Options (Report a problem) and crash capture.
- **Telemetry consent** — a stored option; the client sends nothing in any mode.

**Results policy.** Solo scores stay client totals range-checked by `score-script.js` (user decision
for this port); there is no multiplayer, so nothing else is recorded. Achievements and Daily bests
stay in the progress save.

---

## 13. Technical architecture

- **Layering.** `rules.js` has no imports; `content.js` depends on rules; `session.js` wraps rules
  with a command log; `native/game.ts` types them; `native/main.ts` is the only module that knows
  render, screens, audio and platform.
- **Determinism and replay.** Unchanged: quantized inputs, FNV-1a state hashes, `verifyReplay`.
- **State schema.** `SCHEMA_VERSION = 2`; terrain is rebuilt from the seed.
- **Loop.** `setFixedRate(60)`: one rules step per fixed step while active; the countdown counts
  steps (54 a beat, 96 for a lesson's text). `onRender` draws the vehicle interpolated between the
  last two steps; the speed line refreshes every 30 ticks. Practice snapshots every 120 ticks.
- **Performance budgets.** One mesh for the terrain, two for the ridges, instanced trees, rocks,
  tufts, clouds, stars and particles; the buggy is ~30 small meshes. Level build is synchronous.

---

## 14. Testing and acceptance criteria

**`npm test`** runs `test:unit` then `test:native`.

- `test:unit`: `test.js` (30 checks: legality, terminal states, scoring, quantization, serialization,
  hashing, commands, replays, fuzz, undo, content validation, and a `server.js` API smoke on a free
  loopback port), `tests/i18n.test.mjs` (every key used in `native/*.ts` and content translated in all
  locales, placeholders intact, no unused rows; account strings complete) and
  `tests/progress.test.mjs` (normalise, symmetric merge, old cloud-save and settings migration).
- `test:native` (`tests/native.mjs`): the web index matches the files, `tsc` (no skipLibCheck),
  `starhermit check .` with zero warnings, and every `tests/native/*.play` as a guest render check:
  `menus` (every page and mode list), `lesson-1` (Quick play → lesson → Next lesson → pause → quit),
  `journey-stage-1` (finish, First Finish, Next stage, pause/resume, title offers Stage 2),
  `lesson-3-crash` (crash explained, Try again), `practice-undo`, `challenge-sprinter`, `daily`.
- `npm run test:browser` (`tools/browser-play.mjs`): the packaged loader in Chrome on the AMD GPU
  (`~/games/tools/gpu-chrome.mjs`) at 1366×768, 390×844 @3 and 844×390 @3: keys drive lesson 1 to its
  results on the desktop; on the phones two fingers hold GAS and TILT ▶ at once and the HUD pause
  button is tapped; no console errors. `~/games/tools/engine-web-smoke.mjs` checks the start.

**QA bar (`agents/qa.md`) as checkable statements.**

1. Every implemented feature is reachable by visible UI — all five modes,
   settings, help, leaderboards, pause, undo, restart, next.
2. A first-time player is taught: the primary button starts a lesson, and the coaching lines cover
   gas, tilt and fuel the first time each matters.
3. No console errors or warnings during a full playthrough at either viewport.
4. No text or control is cut off at 1280×800, 390×844 portrait or 844×390 landscape; long panels
   scroll inside themselves and respect safe-area insets.
5. A run is completable end-to-end by automation driving the real UI, on both desktop keys and
   mobile pedals.
6. `tsc` passes and `starhermit check .` reports no warnings.

---

## 15. Asset inventory

| Path | Purpose | Source | Status |
|---|---|---|---|
| `assets/keyart.webp` | Title-screen backdrop (1280×720, 29 KB) | FLUX.2 klein, seed 4711 | generated in this pass; wired as the title screen background |
| `coverart.png` | Platform cover art, 1200×675 | FLUX.2 klein, seed 4711 (same render, rescaled + palettized to 267 KB) | regenerated in this pass, replacing a generic placeholder |
| `icon.png` | Platform icon | authored | shipped |
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
| Terrain, vehicle, flags, cans, trees, rocks, clouds, particles | Play-scene geometry | procedural in `native/render.ts` | by design, no files |

No 3D model or character animation is shipped: the buggy is an authored primitive assembly, and a
GLTF loader is not vendored, so importing a generated model would be a renderer change rather
than a wiring change.

---

## 16. Known limitations

- **Ranked daily submission is not refereed**: runs post their client total through `score-script.js`
  (range-checked); the replay-validated endpoint in `server.js` is exercised only by `test.js`.
- **The engine hum** is a pitched loop of a filtered sawtooth; its filter does not track speed
  separately from its pitch.
- **Clips still loading are silent** (no synthesized stand-ins on the engine).
- **Trees and rocks are decoration only**; **no suspension model** (wheels can clip a sharp crest).
- **Browser-build rebindings of the tilt keys** (old action names `tiltL`/`tiltR`) and guests' old
  `localStorage` progress do not carry over; signed-in cloud progress does.
- **Signed-in paths** (foreign-save migration, legacy settings, score posting) are not live-tested
  here; their logic is covered by `tests/progress.test.mjs`.
- **`package.json` cannot declare `"type": "module"`** while `server.js` is CommonJS, so node prints a
  module-type warning in the unit tests.

## 17. Design intent not yet implemented

1. **A recorded engine loop** replacing the synthesized hum, cross-faded by RPM band.
2. **Ghost replays** — the replay envelope already carries everything needed to render a previous
   run's vehicle alongside the live one on the Daily; nothing draws it yet.
3. **Per-wheel suspension** so the chassis reads terrain detail the current slope-alignment misses.
