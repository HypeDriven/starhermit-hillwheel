// Hillwheel game orchestrator: state machine, fixed-timestep loop, input mapping.
// boot → title → profile-ready → mode-select → preparing → countdown →
// active ↔ paused → resolving → results → progression.

import * as rules from './rules.js';
import * as content from './content.js';
import { createSession } from './session.js';
import { createRender } from './render.js';
import { createUi, loadSettings, saveSettings, loadProgress, saveProgress, STRINGS } from './ui.js';
import { createAudio } from './audio.js';
import { createPlatform } from './platform.js';

export const GAME_SCHEMA_VERSION = 2;
export const BUILD_VERSION = '1.0.0';

const ACHIEVEMENTS = [
	{ key: 'first_finish', name: 'First Finish', check: (c) => c.finished },
	{ key: 'smooth_operator', name: 'Smooth Operator', check: (c) => c.smoothLandings >= 3 },
	{ key: 'streak_3', name: 'Hat Trick', check: (c) => c.streak >= 3 },
	{ key: 'mastery_20', name: 'Hill Veteran', check: (c) => c.stagesCompleted >= 20 },
	{ key: 'long_haul', name: 'Long Haul', check: (c) => c.totalDistance >= 50000 },
];

export class Game {
	constructor(root, env = {}) {
		this.root = root;
		this.env = env;
		this.settings = loadSettings();
		this.progress = loadProgress();
		this.phase = 'boot';
		this.session = null;
		this.levelMeta = null;
		this.mode = null;
		this.input = { throttle: 0, brake: 0, tilt: 0 };
		this.pedals = { throttle: false, brake: false, tiltL: false, tiltR: false };
		this.acc = 0;
		this.lastTime = 0;
		this.prevVehicle = null;
		this.streak = 0;
		this.totalDistance = this.progress.totalDistance || 0;
		this._raf = null;
		this._undoTimer = 0;
		this._countdownToken = 0;
		this.coach = null; // per-run coaching state (see _coach)
		// Pure-touch devices (no hover, coarse pointer) get pedal-only wording; everything
		// else also gets keyboard hints, since a touch laptop still has keys.
		const caps = env.capabilities || {};
		this.touchOnly = !!caps.touch && !!(window.matchMedia?.('(hover: none) and (pointer: coarse)').matches);

		this.platform = createPlatform(env.platform || {});
		this.platform.telemetryConsent = !!this.settings.telemetryConsent;
		if (env.launchToken) this.platform.setLaunchToken(env.launchToken);

		this.ui = createUi(root, (a, p) => this._onAction(a, p), this.settings);
		this.audio = createAudio({ volumes: this._busVolumes() });
		this.render = null; // created lazily when WebGL confirmed
		this._bindGlobalInput();
		this._bindLifecycle();
	}

	// --- Phase machine ------------------------------------------------------------

	_setPhase(phase, reason) {
		this.phase = phase;
		this.phaseReason = reason;
	}

	async start() {
		// boot: capability detection + host handshake
		if (!this.ui.canvas.getContext('webgl2') && !this.ui.canvas.getContext('webgl')) {
			this._showCompatibility();
			return;
		}
		try {
			this.render = createRender(this.ui.canvas, { tier: this.settings.tier, reducedMotion: this.settings.reducedMotion });
		} catch {
			this._showCompatibility();
			return;
		}
		this.platform.syncTime().then(() => this._refreshDaily());
		this.platform.startActivity();
		this._setPhase('title', 'boot_complete');
		this._showTitle();
		this._resize();
		this._loop(0);
	}

	_showCompatibility() {
		this.ui.screenLayer.innerHTML = '';
		const s = document.createElement('section');
		s.className = 'hw-panel';
		s.innerHTML = '<h1>Hillwheel</h1><p>This game needs WebGL, which your browser or device has disabled. Your settings and progress are saved and will be here when WebGL is available.</p>';
		this.ui.screenLayer.appendChild(s);
		this.ui.screenLayer.classList.remove('hidden');
		this._setPhase('title', 'no_webgl');
	}

	// A player who has never finished a lesson or a stage is sent to the first
	// lesson by Quick play; everyone else resumes the Journey where they left off.
	_isFirstRun() {
		return this.progress.tutorialDone.length === 0 && Object.keys(this.progress.stagesCompleted).length === 0;
	}

	_showTitle() {
		this._setPhase('title', 'show_title');
		const done = Object.keys(this.progress.stagesCompleted).length;
		const stage = content.getStage(this.progress.lastStage || 0);
		this.ui.showScreen('title', this.ui.buildTitle({
			dailyInfo: this._dailyInfo || null,
			journeyProgress: `${done}/${content.STAGES.length} stages`,
			firstRun: this._isFirstRun(),
			resumeLabel: stage.name,
			touch: this.touchOnly,
		}));
	}

	async _refreshDaily() {
		const date = this.platform.todayUTC();
		this._daily = content.dailyContent(date);
		this._dailyInfo = date;
		if (this.phase === 'title') this._showTitle();
	}

	// --- Mode selection -------------------------------------------------------------

	_onAction(action, payload) {
		this.audio.ensureContext();
		this.audio.event('click');
		switch (action) {
			case 'click': return;
			case 'quick-play': return this._isFirstRun() ? this._startTutorial(0) : this._startJourneyLevel(this.progress.lastStage || 0);
			case 'back-title': case 'quit': return this._quitToTitle();
			case 'mode': return this._showModeSetup(payload);
			case 'leaderboard': return this._showLeaderboard();
			case 'settings': return this.ui.showScreen('settings', this.ui.buildSettings({ settings: this.settings, onSettings: (p) => this._updateSettings(p) }));
			case 'help': return this.ui.showScreen('help', this.ui.buildHelp());
			case 'resume': return this._resume();
			case 'restart': return this._restartLevel();
			case 'undo': return this._undo();
			case 'next': return this._nextLevel();
		}
	}

	_showModeSetup(mode) {
		this._setPhase('mode-select', 'pick_' + mode);
		const done = this.progress.stagesCompleted;
		const tutDone = this.progress.tutorialDone;
		if (mode === 'journey') {
			const levels = content.STAGES.map((s, i) => ({
				label: `${s.name}${s.mastery ? ' ★' : ''}${done[s.id] ? ` ✓ ${done[s.id]}` : ''}`,
				done: !!done[s.id], locked: i > 0 && !done[content.STAGES[i - 1].id] && i > (this.progress.lastStage || 0) + 1,
			}));
			this.ui.showScreen('setup', this.ui.buildModeSetup({
				mode, levels, ranked: false,
				onPick: (i) => this._startJourneyLevel(i),
			}));
		} else if (mode === 'learn') {
			const levels = content.TUTORIALS.map((t) => ({
				label: `${t.title}${tutDone.includes(t.id) ? ' ✓' : ''}`, done: tutDone.includes(t.id),
			}));
			this.ui.showScreen('setup', this.ui.buildModeSetup({
				mode, levels, ranked: false,
				onPick: (i) => this._startTutorial(i),
			}));
		} else if (mode === 'daily') {
			const d = this._daily || content.dailyContent(new Date().toISOString().slice(0, 10));
			this.ui.showScreen('setup', this.ui.buildModeSetup({
				mode, levels: [{ label: `${d.name} — ranked` }], ranked: true,
				onPick: () => this._startDaily(d),
			}));
		} else if (mode === 'practice') {
			const levels = ['Easy hills', 'Rolling hills', 'Steep hills', 'Wild hills'].map((label, i) => ({ label }));
			this.ui.showScreen('setup', this.ui.buildModeSetup({
				mode, levels, ranked: false,
				onPick: (i) => this._startPractice(i),
			}));
		} else if (mode === 'challenge') {
			const levels = content.CHALLENGES.map((c) => ({ label: `${c.name} — ${c.desc}` }));
			this.ui.showScreen('setup', this.ui.buildModeSetup({
				mode, levels, ranked: false,
				onPick: (i) => this._startChallenge(i),
			}));
		}
	}

	// --- Level start ------------------------------------------------------------------

	_prepare(levelConfig, meta) {
		this._setPhase('preparing', 'load_level');
		this.session = createSession(levelConfig);
		this.levelMeta = meta;
		this.mode = levelConfig.mode;
		this.prevVehicle = { ...this.session.state.vehicle };
		this.render.setReducedMotion(!!this.settings.reducedMotion);
		this.render.loadLevel(this.session.state, meta.theme || 'meadow', levelConfig.seed);
		this.ui.buildHud({
			leftHanded: !!this.settings.leftHanded,
			onPedal: (key, down) => this._onPedal(key, down),
			onPause: () => this._pause(),
			showKeys: !this.touchOnly,
			checkpoints: this.session.state.checkpoints,
			goalX: this.session.state.goalX,
		});
		this.coach = { throttled: false, tilted: false, active: null, airHint: false, fuelHint: false, idle: 0 };
		const hintKey = { throttle: 'throttle', brake: 'brake', tilt: 'tiltR', fuel: null }[meta.tutorial?.hint] || null;
		this.coach.highlight = hintKey;
		this.ui.highlightPedal(hintKey);
		this.ui.showHud();
		this._resize();
		this._countdown(3);
	}

	// token guards against a stale countdown chain from a previous level
	// (restart/quit during the count) resuming the new one early.
	_countdown(n, token) {
		if (token === undefined) token = ++this._countdownToken;
		else if (token !== this._countdownToken) return;
		this._setPhase('countdown', 'count_' + n);
		if (n <= 0) {
			this.ui.showCountdown('');
			this.audio.event('go');
			this._setPhase('active', 'countdown_done');
			this.audio.startMusic();
			this.audio.startAmbience();
			this.ui.announce('Go! ' + this._gasVerb() + ' to drive.');
			// Keep the "how do I move" prompt up until the first press of the throttle.
			this.coach.active = 'gas';
			this.ui.showHint(this._gasVerb() + ' to drive');
			return;
		}
		this.ui.showCountdown(n === 3 ? (this.levelMeta.intro || String(n)) : String(n), 'Get ready: ' + this._gasVerb().replace(/^./, (ch) => ch.toLowerCase()) + ' to drive');
		this.audio.event('countdown');
		setTimeout(() => { if (this.phase === 'countdown') this._countdown(n - 1, token); }, this.levelMeta.intro && n === 3 ? 1600 : 900);
	}

	_startJourneyLevel(i) {
		const s = content.getStage(i);
		this.progress.lastStage = i;
		saveProgress(this.progress);
		this._prepare(content.levelConfig(s, 'journey'), { kind: 'journey', index: i, id: s.id, theme: s.theme, name: s.name });
	}

	_startTutorial(i) {
		const t = content.TUTORIALS[i];
		this._prepare(content.tutorialConfig(t), { kind: 'learn', index: i, id: t.id, theme: 'meadow', name: t.title, intro: t.text, tutorial: t });
	}

	_startDaily(d) {
		this._prepare(content.levelConfig(d, 'daily'), { kind: 'daily', id: d.id, theme: d.theme, name: d.name });
	}

	_startPractice(i) {
		const cfg = { seed: (0x9ac0 + i * 977) >>> 0, length: 300 + i * 120, roughness: 0.5 + i * 0.35, fuel: 100, fuelCans: 2 + i, checkpoints: 2, mode: 'practice' };
		this._prepare(cfg, { kind: 'practice', index: i, id: 'practice-' + i, theme: content.THEMES[i % content.THEMES.length].id, name: 'Practice' });
	}

	_startChallenge(i) {
		const c = content.CHALLENGES[i];
		this._prepare(content.levelConfig(c.config, 'challenge'), { kind: 'challenge', id: c.id, theme: 'ember', name: c.name });
	}

	_restartLevel() {
		if (!this.levelMeta) return this._showTitle();
		const m = this.levelMeta;
		if (m.kind === 'journey') return this._startJourneyLevel(m.index);
		if (m.kind === 'learn') return this._startTutorial(m.index);
		if (m.kind === 'daily') return this._startDaily(this._daily || content.dailyContent(new Date().toISOString().slice(0, 10)));
		if (m.kind === 'practice') return this._startPractice(m.index);
		if (m.kind === 'challenge') return this._startChallenge(content.CHALLENGES.findIndex((c) => c.id === m.id));
	}

	_nextLevel() {
		const m = this.levelMeta;
		if (m?.kind === 'journey' && m.index + 1 < content.STAGES.length) return this._startJourneyLevel(m.index + 1);
		if (m?.kind === 'learn' && m.index + 1 < content.TUTORIALS.length) return this._startTutorial(m.index + 1);
		if (m?.kind === 'learn') return this._startJourneyLevel(0); // training done: straight into the Journey
		return this._showTitle();
	}

	_quitToTitle() {
		if (this.session && !this.session.finished()) {
			this.session.apply({ id: this.session.nextCommandId(), type: 'abandon' });
		}
		this.audio.setEngine(false);
		this.audio.stopMusic();
		this.audio.stopAmbience();
		this.session?.close();
		this.session = null;
		this.render?.unloadLevel();
		this._showTitle();
	}

	// --- Pause / resume --------------------------------------------------------------

	_pause() {
		if (this.phase !== 'active') return;
		this._setPhase('paused', 'user_pause');
		this.audio.setEngine(false);
		this.ui.showScreen('pause', this.ui.buildPause({
			settings: this.settings,
			canUndo: this.mode === 'practice' && this.session.snapshots.length > 0,
			onSettings: (p) => this._updateSettings(p),
		}));
	}

	_resume() {
		if (!this.session) return this._showTitle();
		this._setPhase('active', 'resume');
		this.audio.startAmbience();
		this.ui.showHud();
		this.acc = 0;
		this.lastTime = performance.now();
	}

	_undo() {
		if (this.mode !== 'practice' || !this.session) return;
		const res = this.session.undo();
		if (res.ok) {
			this.prevVehicle = { ...this.session.state.vehicle };
			this.ui.announce('Undone');
			this._resume();
		} else {
			this.ui.announce('Nothing to undo', true);
			this.audio.event('invalid');
		}
	}

	// Settings sliders are 0–100; the audio module's gain domain is 0–1.
	_busVolumes() {
		const out = {};
		for (const bus of ['music', 'sfx', 'ambience', 'voice']) out[bus] = (this.settings.volumes?.[bus] ?? 80) / 100;
		return out;
	}

	_updateSettings(patch) {
		Object.assign(this.settings, patch);
		saveSettings(this.settings);
		this.ui.applySettings(this.settings);
		this.audio.setMuted(!!this.settings.muted);
		for (const bus of ['music', 'sfx', 'ambience', 'voice']) this.audio.setVolume(bus, this._busVolumes()[bus]);
		this.render?.setTier(this.settings.tier);
		this.render?.setReducedMotion(!!this.settings.reducedMotion);
		this.platform.telemetryConsent = !!this.settings.telemetryConsent;
		if (this.phase === 'paused') {
			this.ui.showScreen('pause', this.ui.buildPause({
				settings: this.settings, canUndo: this.mode === 'practice',
				onSettings: (p) => this._updateSettings(p),
			}));
		}
		this.platform.track('settings_change');
	}

	async _showLeaderboard() {
		this.ui.showScreen('leaderboard', this.ui.buildLeaderboard({ loading: true }));
		const res = await this.platform.getLeaderboard('global', this._daily?.id);
		this.ui.showScreen('leaderboard', this.ui.buildLeaderboard({
			entries: res.ok ? res.data.entries : null,
			error: res.ok ? null : res.error,
		}));
	}

	// --- Input --------------------------------------------------------------------------

	_onPedal(key, down) {
		this.audio.ensureContext();
		if (this.settings.holdToDrive === false && down) {
			// toggle mode
			this.pedals[key] = !this.pedals[key];
		} else if (this.settings.holdToDrive !== false) {
			this.pedals[key] = down;
		} else if (!down) {
			return; // toggle mode: ignore releases
		}
		if (down) this.audio.event('input');
		this._syncInput();
	}

	_syncInput() {
		const p = this.pedals, k = this.keys || {};
		this.input.throttle = (p.throttle || k.throttle) ? 1000 : 0;
		this.input.brake = (p.brake || k.brake) ? 1000 : 0;
		const l = (p.tiltL || k.tiltL) ? 1 : 0, r = (p.tiltR || k.tiltR) ? 1 : 0;
		this.input.tilt = (l - r) * 1000; // tilt back = negative pitch change
		const c = this.coach;
		if (c) {
			if (this.input.throttle) {
				c.throttled = true;
				if (c.active === 'gas' || c.active === 'idle') this._clearHint();
				if (c.highlight === 'throttle') this._clearHighlight();
			}
			if (this.input.tilt) {
				c.tilted = true;
				if (c.active === 'air') this._clearHint();
				if (c.highlight === 'tiltR') this._clearHighlight();
			}
			if (this.input.brake && c.highlight === 'brake') this._clearHighlight();
		}
	}

	// --- Coaching -------------------------------------------------------------------------
	// Short, single-line prompts that name the next useful action. Each fires at most once
	// per run; the throttle prompt stays until the player actually presses it.

	_gasVerb() {
		const hold = this.settings.holdToDrive !== false;
		if (this.touchOnly) return hold ? 'Hold GAS' : 'Tap GAS';
		return hold ? 'Hold ↑ or W' : 'Tap ↑ or W';
	}

	_clearHint() { this.coach.active = null; this.ui.showHint(null); }
	_clearHighlight() { this.coach.highlight = null; this.ui.highlightPedal(null); }

	_hint(kind, text, ms) {
		this.coach.active = kind;
		this.ui.showHint(text, ms);
		if (ms) setTimeout(() => { if (this.coach && this.coach.active === kind) this.coach.active = null; }, ms);
	}

	_coach(state) {
		const c = this.coach, v = state.vehicle;
		if (!c || this.phase !== 'active') return;
		const fresh = (this.progress.runsPlayed || 0) < 6 || this.mode === 'learn';
		// Stopped with no throttle for a second and a half: remind how to move.
		if (c.throttled && v.grounded && Math.abs(v.vx) < 0.5 && !this.input.throttle) {
			c.idle++;
			if (c.idle === 90 && !c.active) this._hint('idle', this._gasVerb() + ' to get going', 2500);
		} else c.idle = 0;
		if (fresh && !c.airHint && !v.grounded && state.airTime > 0.35 && !this.input.tilt && (!c.active || c.active === 'idle')) {
			c.airHint = true;
			this._hint('air', (this.touchOnly ? 'In the air: TILT ◀ ▶' : 'In the air: ← → tilt') + ' to match the slope', 2500);
		}
		if (!c.fuelHint && v.fuel < (v.fuelMax || 100) * 0.25 && c.active !== 'gas') {
			c.fuelHint = true;
			this._hint('fuel', 'Fuel low: ease off downhill and grab the yellow cans', 3000);
		}
	}

	_bindGlobalInput() {
		this.keys = {};
		const map = {
			ArrowUp: 'throttle', KeyW: 'throttle',
			ArrowDown: 'brake', KeyS: 'brake',
			ArrowLeft: 'tiltL', KeyA: 'tiltL',
			ArrowRight: 'tiltR', KeyD: 'tiltR',
		};
		// Driving keys are only captured while a run is on screen, and never while a
		// form control has focus, so arrow keys keep working in the settings sliders,
		// the quality select and for scrolling menus.
		const isFormControl = (t) => !!t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' ||
			t.tagName === 'TEXTAREA' || t.isContentEditable);
		const driving = () => this.phase === 'active' || this.phase === 'countdown' || this.phase === 'paused';
		window.addEventListener('keydown', (e) => {
			if (e.repeat) return;
			const k = map[e.code];
			if (k) {
				if (!driving() || isFormControl(e.target)) return;
				this.keys[k] = true;
				this.audio.ensureContext();
				this.audio.event('input');
				this._syncInput();
				e.preventDefault();
			} else if (e.code === 'Escape' || e.code === 'KeyP') {
				if (this.phase === 'active') this._pause();
				else if (this.phase === 'paused') this._resume();
			} else if (e.code === 'KeyU' && this.mode === 'practice' && (this.phase === 'active' || this.phase === 'paused')) {
				this._undo();
			} else if (e.code === 'KeyC') {
				if (this.render) this.render._camInit = false;
			}
		});
		window.addEventListener('keyup', (e) => {
			const k = map[e.code];
			// Always clear the held state (a key released after focus moved must not stick).
			if (k) { this.keys[k] = false; this._syncInput(); if (driving() && !isFormControl(e.target)) e.preventDefault(); }
		});
		// Gamepad: standard mapping — RT throttle, LT brake, left stick tilt, start pause.
		this._gamepadPrev = {};
	}

	_pollGamepad() {
		const pads = navigator.getGamepads ? navigator.getGamepads() : [];
		const gp = pads && pads[0];
		if (!gp) return;
		const t = gp.buttons[7]?.value > 0.2;
		const b = gp.buttons[6]?.value > 0.2;
		const ax = gp.axes[0] || 0;
		const l = ax < -0.3, r = ax > 0.3;
		const pause = !!gp.buttons[9]?.pressed;
		const prev = this._gamepadPrev;
		if (pause && !prev.pause) { if (this.phase === 'active') this._pause(); else if (this.phase === 'paused') this._resume(); }
		if (t !== prev.t) this.keys.throttle = t;
		if (b !== prev.b) this.keys.brake = b;
		if (l !== prev.l) this.keys.tiltL = l;
		if (r !== prev.r) this.keys.tiltR = r;
		if (t !== prev.t || b !== prev.b || l !== prev.l || r !== prev.r) this._syncInput();
		this._gamepadPrev = { t, b, l, r, pause };
	}

	_bindLifecycle() {
		window.addEventListener('resize', () => this._resize());
		document.addEventListener('visibilitychange', () => {
			if (document.hidden) {
				// Backgrounding pauses solo simulation.
				if (this.phase === 'active') this._pause();
				this.audio.setBackgrounded(true);
			} else {
				this.audio.setBackgrounded(false);
			}
		});
		window.addEventListener('beforeunload', () => this.platform.endActivity());
	}

	_resize() {
		if (!this.render) return;
		const wrap = this.ui.canvasWrap;
		this.render.resize(wrap.clientWidth || window.innerWidth, wrap.clientHeight || window.innerHeight);
	}

	// --- Main loop -----------------------------------------------------------------------

	_loop(t) {
		this._raf = requestAnimationFrame((tt) => this._loop(tt));
		const dtReal = Math.min(0.1, (t - this.lastTime) / 1000 || 0.016);
		this.lastTime = t;
		this._pollGamepad();
		if (!this.session || !this.render) { this.render?.render(); return; }

		if (this.phase === 'active' && !this.session.finished()) {
			this.acc += dtReal;
			const stepDt = rules.DT;
			let steps = 0;
			while (this.acc >= stepDt && steps < 5 && !this.session.finished()) {
				this.prevVehicle = { ...this.session.state.vehicle };
				// Practice undo snapshot every 2 sim-seconds.
				if (this.mode === 'practice' && this.session.state.tick % 120 === 0) this.session.pushUndoSnapshot();
				const before = this._snapshotEvents();
				this.session.apply({
					id: this.session.nextCommandId(), type: 'input',
					throttle: this.input.throttle, brake: this.input.brake, tilt: this.input.tilt,
				});
				this._fireEvents(before);
				this.acc -= stepDt;
				steps++;
			}
			if (this.session.finished()) this._resolve();
			else this._coach(this.session.state);
		}

		const state = this.session.state;
		const alpha = this.phase === 'active' ? Math.min(1, this.acc / rules.DT) : 1;
		this.render.update(this.prevVehicle, state.vehicle, alpha, state, null, dtReal);
		this.render.render();

		if (this.phase === 'active' || this.phase === 'paused') {
			const breakdown = rules.scoreBreakdown(state);
			this.ui.updateHud(state, breakdown, state.goalX);
			if (state.tick % 30 === 0) this.ui.updateMirror(state, breakdown);
			this.audio.setEngine(this.phase === 'active' && !state.terminalReason, state.vehicle.vx, this.input.throttle / 1000);
		}
	}

	_snapshotEvents() {
		const s = this.session.state;
		return {
			cans: s.cansCollected, cp: s.nextCheckpoint, smooth: s.smoothLandings,
			grounded: s.vehicle.grounded, terminal: s.terminalReason,
		};
	}

	_fireEvents(before) {
		const s = this.session.state;
		if (s.cansCollected > before.cans) this.audio.event('can', { variant: s.cansCollected });
		if (s.nextCheckpoint > before.cp) { this.audio.event('checkpoint'); this.ui.announce(`Checkpoint ${s.nextCheckpoint} of ${s.checkpoints.length}`); }
		if (s.smoothLandings > before.smooth) this.audio.event('land_smooth');
		if (!s.vehicle.grounded !== !before.grounded && s.vehicle.grounded && s.smoothLandings === before.smooth) {
			this.audio.event('land_hard');
			this.render.addShake(0.25);
		}
		if (before.grounded && !s.vehicle.grounded) this.audio.event('airborne');
		if (s.terminalReason && !before.terminal) {
			if (s.terminalReason === 'crashed') { this.audio.event('crash'); this.render.addShake(0.9); }
			if (s.terminalReason === 'out_of_fuel') this.audio.event('dry');
		}
	}

	// --- Resolving / results / progression ------------------------------------------------

	async _resolve() {
		this._setPhase('resolving', 'terminal_' + this.session.state.terminalReason);
		this.audio.setEngine(false);
		this.audio.stopMusic();
		this.audio.stopAmbience();
		const result = this.session.result();
		const won = result.terminalReason === 'finished';
		if (won) this.audio.event('finish');
		this.platform.track('round_end', { mode: this.mode, result: result.terminalReason });
		this.streak = won ? this.streak + 1 : 0;
		this.totalDistance += Math.floor(this.session.state.vehicle.x);
		this.progress.totalDistance = this.totalDistance;
		this.progress.runsPlayed = (this.progress.runsPlayed || 0) + 1;
		this.ui.showHint(null);

		// Progression persistence.
		const m = this.levelMeta;
		if (m?.kind === 'journey' && won) {
			const prev = this.progress.stagesCompleted[m.id] || 0;
			this.progress.stagesCompleted[m.id] = Math.max(prev, result.breakdown.total);
			this.progress.lastStage = Math.min(m.index + 1, content.STAGES.length - 1);
		}
		if (m?.kind === 'learn') {
			// A lesson counts as learned only when every requirement it states was met.
			const req = content.TUTORIALS[m.index].requires || {};
			const met = this.session.state.vehicle.x >= (req.minX || 0) &&
				this.session.state.cansCollected >= (req.cans || 0);
			if (met && !this.progress.tutorialDone.includes(m.id)) this.progress.tutorialDone.push(m.id);
		}

		// Achievements (idempotent).
		const ctx = {
			finished: won, smoothLandings: this.session.state.smoothLandings,
			streak: this.streak, stagesCompleted: Object.keys(this.progress.stagesCompleted).length,
			totalDistance: this.totalDistance,
		};
		const newAch = [];
		for (const a of ACHIEVEMENTS) {
			if (!this.progress.achievements.includes(a.key) && a.check(ctx)) {
				this.progress.achievements.push(a.key);
				newAch.push(a.name);
				this.audio.event('achievement');
				this.ui.announce(`Achievement unlocked: ${a.name}`, true);
				this.platform.unlockAchievement(a.key, this.session.id);
			}
		}
		saveProgress(this.progress);

		// Daily / ranked submission with replay log for server validation.
		if (m?.kind === 'daily') {
			const replay = this.session.exportReplay();
			this.platform.submitScore({
				mode: 'daily', contentId: m.id, seed: replay.seed,
				ruleset: rules.SCHEMA_VERSION, contentVersion: replay.contentVersion,
				assists: { reducedMotion: !!this.settings.reducedMotion },
				durationTicks: result.ticks, breakdown: result.breakdown,
				commands: replay.commands, hashLog: replay.hashLog,
				initialHash: replay.initialHash, config: replay.config,
				sessionId: this.session.id, terminalHash: result.hash,
				terminalReason: result.terminalReason,
			});
		}

		this._setPhase('results', 'show_results');
		let nextLabel = null;
		if (m?.kind === 'journey' && m.index + 1 < content.STAGES.length) nextLabel = STRINGS.next;
		else if (m?.kind === 'learn') nextLabel = m.index + 1 < content.TUTORIALS.length ? STRINGS.nextLesson : STRINGS.startJourney;
		// Losing a stage offers "Next" only where progress already allows it; losing a lesson still lets you move on.
		if (!won && m?.kind === 'journey') nextLabel = null;
		this.ui.showScreen('results', this.ui.buildResults({
			result, breakdown: result.breakdown, won,
			isDaily: m?.kind === 'daily', newAchievements: newAch,
			stageName: m?.name, nextLabel,
		}));
		this._setPhase('progression', 'saved');
	}

	dispose() {
		cancelAnimationFrame(this._raf);
		this.platform.endActivity();
		this.audio.dispose();
		this.render?.dispose();
	}
}

export function createGame(root, env) { return new Game(root, env); }
export default Game;
