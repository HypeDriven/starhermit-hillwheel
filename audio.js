// Hillwheel audio: buses, event mapping, focus/background behavior, decode and memory policy.
// One-shots prefer authored clips from sfx/ (see sfx/manifest.json); synthesized
// transients are the fallback while a clip loads or if it is missing.
// Seeded pitch variants keep replays consistent. No audio-only gameplay:
// every cue has a visual counterpart in the UI.

export const AUDIO_SCHEMA_VERSION = 2;

const BUS_NAMES = ['music', 'sfx', 'ambience', 'voice'];

// Logical event -> authored sample basenames (sfx/<name>.opus).
// Events with multiple clips select by the event's variant seed.
const EVENT_SAMPLES = {
	input: ['input-tick'],
	invalid: ['invalid-buzz'],
	can: ['can-pickup-low', 'can-pickup-mid', 'can-pickup-high'],
	checkpoint: ['checkpoint-chime'],
	land_smooth: ['soft-landing'],
	land_hard: ['hard-landing'],
	crash: ['vehicle-crash'],
	finish: ['finish-fanfare'],
	click: ['ui-click'],
	countdown: ['countdown-beep'],
	go: ['go-horn'],
};

export class AudioModule {
	constructor(settings = {}) {
		this.ctx = null;
		this.buses = {};
		this.volumes = { music: 0.5, sfx: 0.8, ambience: 0.4, voice: 0.8 };
		Object.assign(this.volumes, settings.volumes || {});
		this.muted = false;
		this._engine = null;
		this._music = null;
		this._started = false;
		this._variantSeed = 1;
		this._sampleBuffers = new Map(); // clip name -> decoded AudioBuffer
		this._sampleLoads = new Map();   // clip name -> in-flight/finished load promise
	}

	// Must be called from a user gesture (browser autoplay policy).
	ensureContext() {
		if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return true; }
		try {
			const AC = window.AudioContext || window.webkitAudioContext;
			if (!AC) return false;
			this.ctx = new AC();
			this.master = this.ctx.createGain();
			this.master.connect(this.ctx.destination);
			for (const name of BUS_NAMES) {
				const g = this.ctx.createGain();
				g.gain.value = this.volumes[name];
				g.connect(this.master);
				this.buses[name] = g;
			}
			return true;
		} catch { return false; }
	}

	setVolume(bus, v) {
		this.volumes[bus] = Math.max(0, Math.min(1, v));
		if (this.buses[bus]) this.buses[bus].gain.value = this.volumes[bus];
	}
	setMuted(m) {
		this.muted = m;
		if (this.master) this.master.gain.value = m ? 0 : 1;
	}

	// Short synthesized transient. variant seed nudges pitch deterministically.
	_blip(bus, { freq = 440, dur = 0.12, type = 'sine', gain = 0.3, slide = 0, variant = 0 }) {
		if (!this.ctx || this.muted) return;
		const t0 = this.ctx.currentTime;
		const detune = variant ? ((variant % 7) - 3) * 12 : 0;
		const osc = this.ctx.createOscillator();
		osc.type = type;
		osc.frequency.setValueAtTime(freq * Math.pow(2, detune / 1200), t0);
		if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t0 + dur);
		const g = this.ctx.createGain();
		g.gain.setValueAtTime(gain, t0);
		g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
		osc.connect(g); g.connect(this.buses[bus] || this.master);
		osc.start(t0); osc.stop(t0 + dur + 0.02);
	}

	_noise(bus, { dur = 0.2, gain = 0.25, freq = 800 }) {
		if (!this.ctx || this.muted) return;
		const t0 = this.ctx.currentTime;
		const len = Math.floor(this.ctx.sampleRate * dur);
		const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
		const data = buf.getChannelData(0);
		for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
		const src = this.ctx.createBufferSource();
		src.buffer = buf;
		const f = this.ctx.createBiquadFilter();
		f.type = 'lowpass'; f.frequency.value = freq;
		const g = this.ctx.createGain(); g.gain.value = gain;
		src.connect(f); f.connect(g); g.connect(this.buses[bus] || this.master);
		src.start(t0);
	}

	// Lazy fetch/decode/cache of sfx/<clip>.opus, played through the sfx bus.
	// Only reachable after the user-gesture unlock (ctx exists). Returns true
	// when a decoded clip was played; otherwise kicks off the load and returns
	// false so the caller falls back to synthesis for this event.
	_playSample(clip) {
		if (!this.ctx || this.muted) return false;
		const buf = this._sampleBuffers.get(clip);
		if (buf) {
			const src = this.ctx.createBufferSource();
			src.buffer = buf;
			src.connect(this.buses.sfx || this.master);
			src.start();
			return true;
		}
		if (this._sampleLoads.has(clip)) return false; // already loading or failed
		this._sampleLoads.set(clip,
			fetch(`sfx/${clip}.opus`)
				.then((r) => { if (!r.ok) throw new Error('sfx_missing'); return r.arrayBuffer(); })
				.then((ab) => this.ctx.decodeAudioData(ab))
				.then((decoded) => { this._sampleBuffers.set(clip, decoded); })
				.catch(() => { /* permanent fallback to synthesis for this clip */ })
		);
		return false;
	}

	// Logical event -> sound mapping (event hierarchy tiers).
	event(name, opts = {}) {
		if (!this.ctx) return;
		const v = opts.variant || 0;
		const clips = EVENT_SAMPLES[name];
		if (clips && clips.length && this._playSample(clips[Math.abs(v) % clips.length])) return;
		switch (name) {
			case 'input': this._blip('sfx', { freq: 700, dur: 0.03, gain: 0.06, type: 'square' }); break;
			case 'invalid': this._blip('sfx', { freq: 180, dur: 0.12, gain: 0.15, type: 'sawtooth' }); break;
			case 'can': this._blip('sfx', { freq: 880, dur: 0.15, gain: 0.25, slide: 440, variant: v }); break;
			case 'checkpoint': this._blip('sfx', { freq: 660, dur: 0.12, gain: 0.25 }); this._blip('sfx', { freq: 990, dur: 0.18, gain: 0.2 }); break;
			case 'land_smooth': this._blip('sfx', { freq: 520, dur: 0.1, gain: 0.15, type: 'triangle' }); break;
			case 'land_hard': this._noise('sfx', { dur: 0.12, gain: 0.2, freq: 500 }); break;
			case 'crash': this._noise('sfx', { dur: 0.5, gain: 0.4, freq: 900 }); this._blip('sfx', { freq: 120, dur: 0.4, gain: 0.3, type: 'sawtooth', slide: -60 }); break;
			case 'finish': [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => this._blip('sfx', { freq: f, dur: 0.25, gain: 0.25 }), i * 90)); break;
			case 'click': this._blip('sfx', { freq: 600, dur: 0.04, gain: 0.1, type: 'square' }); break;
			case 'countdown': this._blip('sfx', { freq: 440, dur: 0.1, gain: 0.2 }); break;
			case 'go': this._blip('sfx', { freq: 880, dur: 0.2, gain: 0.25 }); break;
		}
	}

	// Engine hum tied to simulation state (speed/throttle), adaptive loop.
	setEngine(active, speed = 0, throttle = 0) {
		if (!this.ctx) return;
		if (active && !this._engine) {
			const osc = this.ctx.createOscillator();
			osc.type = 'sawtooth';
			const g = this.ctx.createGain(); g.gain.value = 0;
			const f = this.ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 500;
			osc.connect(f); f.connect(g); g.connect(this.buses.sfx);
			osc.start();
			this._engine = { osc, g, f };
		}
		if (this._engine) {
			if (!active || this.muted) {
				this._engine.g.gain.setTargetAtTime(0, this.ctx.currentTime, 0.1);
				if (!active) { const e = this._engine; setTimeout(() => { try { e.osc.stop(); } catch {} }, 300); this._engine = null; }
			} else {
				this._engine.osc.frequency.setTargetAtTime(55 + Math.abs(speed) * 4 + throttle * 40, this.ctx.currentTime, 0.05);
				this._engine.g.gain.setTargetAtTime(0.05 + throttle * 0.06, this.ctx.currentTime, 0.08);
				this._engine.f.frequency.setTargetAtTime(300 + Math.abs(speed) * 40, this.ctx.currentTime, 0.1);
			}
		}
	}

	// Quiet generative ambience + simple music stem.
	startMusic() {
		if (!this.ctx || this._music) return;
		const notes = [262, 330, 392, 494, 392, 330];
		let i = 0;
		this._music = setInterval(() => {
			if (this.muted || document.hidden) return;
			this._blip('music', { freq: notes[i % notes.length], dur: 0.5, gain: 0.06, type: 'triangle' });
			i++;
		}, 800);
	}
	stopMusic() { if (this._music) { clearInterval(this._music); this._music = null; } }

	// Background tabs: silence everything but keep nodes for fast resume.
	setBackgrounded(bg) {
		if (!this.ctx) return;
		if (bg) { this.setEngine(false); } else { this.ctx.resume(); }
	}

	dispose() {
		this.stopMusic();
		this.setEngine(false);
		if (this.ctx) { this.ctx.close().catch(() => {}); this.ctx = null; }
	}
}

export function createAudio(settings) { return new AudioModule(settings); }
export function disposeAudio(audio) { audio?.dispose(); }
export default AudioModule;
