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
// offline (OfflineAudioContext) and played looping, its pitch (setPitch) following
// 55 + |vx|·4 + throttle·40 Hz and its level (fade) 0.05 + throttle·0.06.
// The motif's notes are rendered offline with the old oscillator envelope.
// The synthesized stand-ins the browser build played while a clip decoded
// are not ported, so a clip still loading is silent. Every clip loads and
// the notes and hum render at once in onStart; the bed, the hum and the motif
// wait for the mixer to run (in a browser, after the first press).
import { context, createClip, loadClip, OfflineAudioContext, play as playClip, type AudioClip, type Bus, type Sound } from "starhermit:audio";

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
let suspended = false;

/** Loads every clip at once (onStart); an event whose clip is still loading is silent. */
export function loadSfx(): void {
  for (const name of [...new Set(Object.values(EVENT_SAMPLES).flat()), AMBIENCE_CLIP]) {
    loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); }, (e: unknown) => console.warn(`sfx ${name}: ${String(e)}`));
  }
  renderClips();
}

/** audio.js event(): an event's sample (once loaded); `variant` picks among several. */
export function event(name: string, opts: { variant?: number } = {}): void {
  const list = EVENT_SAMPLES[name];
  if (!list || suspended) return;
  const file = list[Math.abs(opts.variant ?? 0) % list.length]!;
  const clip = clips.get(file);
  if (!clip) return;
  const bus: Bus = INTERFACE.has(name) ? "interface" : "effects";
  try { playClip(clip, { bus, gain: LEVEL.effects }); }
  catch { /* the mixer is full this frame: skip it */ }
}

// -- rendered clips -------------------------------------------------------------------
const RATE = 22050;
/** audio.js _blip(): a triangle, exponential from 1 to 0.001 at `dur`. */
async function renderNote(freq: number, dur: number): Promise<AudioClip> {
  const off = new OfflineAudioContext(1, Math.round((dur + 0.02) * RATE), RATE);
  const osc = off.createOscillator();
  osc.type = "triangle";
  osc.frequency.value = freq;
  const g = off.createGain();
  g.gain.setValueAtTime(1, 0);
  g.gain.exponentialRampToValueAtTime(0.001, dur);
  osc.connect(g).connect(off.destination);
  osc.start();
  osc.stop(dur);
  return createClip(await off.startRendering());
}
/** The hum's loop: a 50 Hz sawtooth (441 samples a period) through a low-pass near the old idle
 * cutoff (300 Hz at 55 Hz), settled, then whole periods so the loop is seamless, normalized. */
const HUM_BASE = 50;
/** Make-up to the old one-pole hum's level: its clip rms 0.565, this 12 dB/oct one's 0.451 at the same peak (measured). */
const HUM_MAKEUP = 1.25;
async function renderHum(): Promise<AudioClip> {
  const period = RATE / HUM_BASE;
  const periods = 20, warm = period * 10;
  const off = new OfflineAudioContext(1, warm + period * periods, RATE);
  const osc = off.createOscillator();
  osc.type = "sawtooth";
  osc.frequency.value = HUM_BASE;
  const lp = off.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 330;
  osc.connect(lp).connect(off.destination);
  osc.start();
  const out = (await off.startRendering()).getChannelData(0).slice(warm);
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

/** Renders the notes and the hum (from loadSfx). */
function renderClips(): void {
  const warn = (e: unknown): void => console.warn(`audio: ${String(e)}`);
  renderHum().then((c) => { hum = c; }, warn);
  for (const f of new Set(MOTIF)) renderNote(f, 0.5).then((c) => { notes.set(f, c); }, warn);
}

/** Each frame once the mixer runs and the hum is rendered: the bed and the hum by state, then the motif's notes by mixer time. */
export function update(): void {
  if (context.state !== "running" || !hum) return;
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
        engineSound.fade((0.05 + engine.throttle * 0.06) * LEVEL.effects * HUM_MAKEUP, 0.08);
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
