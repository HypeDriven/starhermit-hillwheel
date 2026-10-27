// Sound, as the browser build's audio.js: the authored one-shots
// (sfx/<name>.opus, sfx/manifest.json) per game event — the can pickup picks
// its low / mid / high variant from the run's can count, as before — the
// looping wind bed (wind-ambience.opus) for the length of a run, the quiet
// six-note triangle motif on the music bus, and the engine hum whose pitch
// and level follow speed and throttle every frame.
//
// The browser build's four buses become the runtime's (Options › Audio owns
// the volumes, the mute and the voice limit): music → "music", effects and
// ambience → "effects", the menu click → "interface"; the old default bus
// levels (music 70 %, effects 80 %, ambience 60 %) are folded into each
// sound's gain. The hum was a live sawtooth through a low-pass filter; here
// one period-exact loop of that filtered sawtooth is rendered once
// (createClip) and played looping, its pitch (setPitch) following
// 55 + |vx|·4 + throttle·40 Hz and its level (fade) 0.05 + throttle·0.06 — a
// live synthesis graph makes clip loads fail on the engine's web runtime.
// The motif's notes are rendered into clips with the old oscillator envelope.
// The synthesized stand-ins the browser build played while a clip decoded
// are not ported, so a clip still loading is silent. Clips load once the
// mixer runs (natively at once, in a browser after the first press), one at
// a time.
import { context, createClip, loadClip, play as playClip, type AudioClip, type Bus, type Sound } from "starhermit:audio";

const LEVEL = { music: 0.7, effects: 0.8, ambience: 0.6 };
const EVENT_SAMPLES: Record<string, string[]> = {
  input: ["input-tick"],
  invalid: ["invalid-buzz"],
  can: ["can-pickup-low", "can-pickup-mid", "can-pickup-high"],
  checkpoint: ["checkpoint-chime"],
  land_smooth: ["soft-landing"],
  land_hard: ["hard-landing"],
  crash: ["vehicle-crash"],
  finish: ["finish-fanfare"],
  click: ["ui-click"],
  countdown: ["countdown-beep"],
  go: ["go-horn"],
  dry: ["engine-sputter"],
  airborne: ["takeoff-whoosh"],
  achievement: ["achievement-unlock"],
};
const AMBIENCE_CLIP = "wind-ambience";
const INTERFACE = new Set(["click"]);

const clips = new Map<string, AudioClip>();
const queue: string[] = [];
let loading = false;
let wantClips = false;
let suspended = false;

function load(name: string): void { if (!queue.includes(name) && !clips.has(name)) queue.push(name); }
function pump(): void {
  if (loading || !queue.length) return;
  const name = queue.shift()!;
  loading = true;
  loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); loading = false; }, (e: unknown) => { console.warn(`sfx ${name}: ${String(e)}`); loading = false; });
}
/** Asks for the clips; they load once the mixer runs (see update). */
export function loadSfx(): void { wantClips = true; }

/** audio.js event(): an event's sample (once loaded); `variant` picks among several. */
export function event(name: string, opts: { variant?: number } = {}): void {
  const list = EVENT_SAMPLES[name];
  if (!list || suspended) return;
  const file = list[Math.abs(opts.variant ?? 0) % list.length]!;
  const clip = clips.get(file);
  if (!clip) return;
  const bus: Bus = INTERFACE.has(name) ? "interface" : "effects";
  try { playClip(clip, { bus, gain: LEVEL.effects }); }
  catch { clips.delete(file); load(file); } // a clip the mixer lost: load it again
}

// -- rendered clips -------------------------------------------------------------------
const RATE = 22050;
/** audio.js _blip(): an oscillator at `gain`, exponential to 0.001 at `dur`. */
function noteClip(freq: number, dur: number): AudioClip {
  const n = Math.round((dur + 0.02) * RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const ph = (freq * t) % 1;
    const osc = 1 - 4 * Math.abs(ph - 0.5); // triangle
    out[i] = t < dur ? osc * Math.pow(0.001, t / dur) : 0;
  }
  return createClip([out], RATE);
}
/** The hum's loop: a 50 Hz sawtooth (441 samples a period) through a one-pole low-pass near the old
 * idle cutoff (300 Hz at 55 Hz), settled, then whole periods so the loop is seamless. */
const HUM_BASE = 50;
function humClip(): AudioClip {
  const period = RATE / HUM_BASE;
  const periods = 20;
  const warm = period * 10;
  const a = 1 - Math.exp(-2 * Math.PI * 330 / RATE);
  const out = new Float32Array(period * periods);
  let y = 0;
  for (let i = 0; i < warm + out.length; i++) {
    const saw = 2 * ((i % period) / period) - 1;
    y += a * (saw - y);
    if (i >= warm) out[i - warm] = y;
  }
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  for (let i = 0; i < out.length; i++) out[i] = out[i]! / (peak || 1);
  return createClip([out], RATE);
}

// -- music, ambience and the engine hum ---------------------------------------------------
const MOTIF = [262, 330, 392, 494, 392, 330];
const notes = new Map<number, AudioClip>();
let hum: AudioClip | null = null;
let musicOn = false;
let motifStep = 0;
let nextNote = 0;
let ambienceOn = false;
let ambienceSound: Sound | null = null;
let engine = { on: false, speed: 0, throttle: 0 };
let engineSound: Sound | null = null;

/** The run's motif (audio.js startMusic: a note every 800 ms). */
export function startMusic(): void { if (!musicOn) { musicOn = true; motifStep = 0; nextNote = 0; } }
export function stopMusic(): void { musicOn = false; }
export function startAmbience(): void { ambienceOn = true; }
export function stopAmbience(): void { ambienceOn = false; }
/** audio.js setEngine(active, speed, throttle). */
export function setEngine(on: boolean, speed = 0, throttle = 0): void { engine = { on, speed, throttle }; }
/** Pause and a hidden window: the hum, the motif and the bed hold. */
export function setSuspended(on: boolean): void { suspended = on; }

/** Each frame: the clips once the mixer runs (one at a time), the notes and the hum rendered one a
 * frame after them, the bed and the hum by state, then the motif's notes by mixer time. */
export function update(): void {
  if (context.state !== "running") return;
  if (wantClips) {
    wantClips = false;
    for (const list of Object.values(EVENT_SAMPLES)) for (const name of list) load(name);
    load(AMBIENCE_CLIP);
    return;
  }
  pump();
  if (loading || queue.length) return;
  if (!hum) { hum = humClip(); return; }
  for (const f of new Set(MOTIF)) if (!notes.has(f)) { notes.set(f, noteClip(f, 0.5)); return; }
  try {
    const bed = ambienceOn && !suspended;
    if (bed && !ambienceSound) {
      const clip = clips.get(AMBIENCE_CLIP);
      if (clip) ambienceSound = playClip(clip, { bus: "effects", gain: 0.6 * LEVEL.ambience, loop: true });
    } else if (!bed && ambienceSound) { ambienceSound.stop(); ambienceSound = null; }
    const humOn = engine.on && !suspended;
    if (humOn && !engineSound) engineSound = playClip(hum, { bus: "effects", gain: 0, loop: true, pitch: 55 / HUM_BASE });
    if (engineSound) {
      if (!humOn) {
        const s = engineSound;
        engineSound = null;
        s.fade(0, 0.1);
        setTimeout(() => { try { s.stop(); } catch { /* gone */ } }, 300);
      } else {
        const freq = 55 + Math.abs(engine.speed) * 4 + engine.throttle * 40;
        engineSound.setPitch(Math.min(8, freq / HUM_BASE));
        engineSound.fade((0.05 + engine.throttle * 0.06) * LEVEL.effects, 0.08);
      }
    }
  } catch (e) { console.warn(`audio: ${String(e)}`); return; }
  if (!musicOn || suspended) return;
  const now = context.currentTime;
  if (now < nextNote) return;
  nextNote = Math.max(now, nextNote) + 0.8;
  const note = notes.get(MOTIF[motifStep % MOTIF.length]!);
  motifStep++;
  try { if (note) playClip(note, { bus: "music", gain: 0.06 * LEVEL.music }); } catch { /* the mixer is full */ }
}
