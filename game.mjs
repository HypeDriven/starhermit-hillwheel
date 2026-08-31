// Hillwheel game orchestrator: state machine, fixed-timestep loop, input mapping.
// boot → title → profile-ready → mode-select → preparing → countdown →
// active ↔ paused → resolving → results → progression.

import * as rules from './rules.mjs';
import * as content from './content.mjs';
import { createSession, verifyReplay } from './session.mjs';
import { createRender } from './render.mjs';
import { createUi, loadSettings, saveSettings, loadProgress, saveProgress, STRINGS } from './ui.mjs';
import { createAudio } from './audio.mjs';
import { createPlatform } from './platform.mjs';

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

		this.platform = createPlatform(env.platform || {});
		this.platform.telemetryConsent = !!this.settings.telemetryConsent;
		if (env.launchToken) this.platform.setLaunchToken(env.launchToken);

		this.ui = createUi(root, (a, p) => this._onAction(a, p), this.settings);
		this.audio = createAudio({ volumes: this.settings.volumes });
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

	_showTitle() {
		this._setPhase('title', 'show_title');
		const done = Object.keys(this.progress.stagesCompleted).length;
		this.ui.showScreen('title', this.ui.buildTitle({
			dailyInfo: this._dailyInfo || null,
			journeyProgress: `${done}/${content.STAGES.length} stages`,
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
			case 'quick-play': return this._startJourneyLevel(this.progress.lastStage || 0);
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
		});
		this.ui.showHud();
		this._resize();
		this._countdown(3);
	}

	_countdown(n) {
		this._setPhase('countdown', 'count_' + n);
		if (n <= 0) {
			this.ui.showCountdown('');
			this.audio.event('go');
			this._setPhase('active', 'countdown_done');
			this.audio.startMusic();
			this.ui.announce('Go!');
			return;
		}
		this.ui.showCountdown(n === 3 ? (this.levelMeta.intro || String(n)) : String(n));
		this.audio.event('countdown');
		setTimeout(() => { if (this.phase === 'countdown') this._countdown(n - 1); }, this.levelMeta.intro && n === 3 ? 1600 : 900);
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
		return this._showTitle();
	}

	_quitToTitle() {
		if (this.session && !this.session.finished()) {
			this.session.apply({ id: this.session.nextCommandId(), type: 'abandon' });
		}
		this.audio.setEngine(false);
		this.audio.stopMusic();
		this.session?.close();
		this.session = null;
		this.render.unloadLevel();
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

	_updateSettings(patch) {
		Object.assign(this.settings, patch);
		this.ui.applySettings(this.settings);
		this.audio.setMuted(!!this.settings.muted);
		for (const bus of ['music', 'sfx', 'ambience', 'voice']) this.audio.setVolume(bus, this.settings.volumes[bus]);
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
	}

	_bindGlobalInput() {
		this.keys = {};
		const map = {
			ArrowUp: 'throttle', KeyW: 'throttle',
			ArrowDown: 'brake', KeyS: 'brake',
			ArrowLeft: 'tiltL', KeyA: 'tiltL',
			ArrowRight: 'tiltR', KeyD: 'tiltR',
		};
		window.addEventListener('keydown', (e) => {
			if (e.repeat) return;
			const k = map[e.code];
			if (k) {
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
			if (k) { this.keys[k] = false; this._syncInput(); e.preventDefault(); }
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
		if (s.terminalReason && !before.terminal) {
			if (s.terminalReason === 'crashed') { this.audio.event('crash'); this.render.addShake(0.9); }
		}
	}

	// --- Resolving / results / progression ------------------------------------------------

	async _resolve() {
		this._setPhase('resolving', 'terminal_' + this.session.state.terminalReason);
		this.audio.setEngine(false);
		this.audio.stopMusic();
		const result = this.session.result();
		const won = result.terminalReason === 'finished';
		if (won) this.audio.event('finish');
		this.platform.track('round_end', { mode: this.mode, result: result.terminalReason });
		this.streak = won ? this.streak + 1 : 0;
		this.totalDistance += Math.floor(this.session.state.vehicle.x);
		this.progress.totalDistance = this.totalDistance;

		// Progression persistence.
		const m = this.levelMeta;
		if (m?.kind === 'journey' && won) {
			const prev = this.progress.stagesCompleted[m.id] || 0;
			this.progress.stagesCompleted[m.id] = Math.max(prev, result.breakdown.total);
			this.progress.lastStage = Math.min(m.index + 1, content.STAGES.length - 1);
		}
		if (m?.kind === 'learn' && this.session.state.vehicle.x >= (content.TUTORIALS[m.index].requires.minX || 0)) {
			if (!this.progress.tutorialDone.includes(m.id)) this.progress.tutorialDone.push(m.id);
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
		const hasNext = (m?.kind === 'journey' && m.index + 1 < content.STAGES.length) || (m?.kind === 'learn' && m.index + 1 < content.TUTORIALS.length);
		this.ui.showScreen('results', this.ui.buildResults({
			result, breakdown: result.breakdown, won,
			isDaily: m?.kind === 'daily', newAchievements: newAch,
			nextLabel: hasNext ? STRINGS.next : null,
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
