// Hillwheel game orchestrator: state machine, fixed-timestep loop, input mapping.
// boot → title → profile-ready → mode-select → preparing → countdown →
// active ↔ paused → resolving → results → progression.

import * as rules from './rules.js';
import * as content from './content.js';
import { createSession } from './session.js';
import { createRender } from './render.js';
import { createUi, loadSettings, saveSettings, loadProgress, saveProgress, STRINGS, DEFAULT_BINDINGS, setBindings, keysFor, SH_TEXT } from './ui.js';
import { createAudio } from './audio.js';
import { createPlatform } from './platform.js';
import { T, L, bindText } from './i18n.js';

export const GAME_SCHEMA_VERSION = 2;
export const BUILD_VERSION = '1.0.0';

const ACHIEVEMENTS = [
	{ key: 'first_finish', name: L('First Finish'), check: (c) => c.finished },
	{ key: 'smooth_operator', name: L('Smooth Operator'), check: (c) => c.smoothLandings >= 3 },
	{ key: 'streak_3', name: L('Hat Trick'), check: (c) => c.streak >= 3 },
	{ key: 'mastery_20', name: L('Hill Veteran'), check: (c) => c.stagesCompleted >= 20 },
	{ key: 'long_haul', name: L('Long Haul'), check: (c) => c.totalDistance >= 50000 },
];

// Display names (messages) for content: "Stage n", "Mastery n", "Daily <date>",
// lesson titles, challenge names and descriptions are translation keys.
function stageLabel(s) {
	const m = /^(Stage|Mastery) (\d+)$/.exec(s.name || '');
	return m ? L(m[1] + ' {n}', { n: m[2] }) : L(s.name);
}
function dailyLabel(d) {
	const m = /^Daily (.+)$/.exec(d.name || '');
	return m ? L('Daily {date}', { date: m[1] }) : L(d.name);
}

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
		this.platform.onChange = () => this._onPlatformChange();
		this.platform.onAuth = (signedIn) => { if (!signedIn) this.ui?.toast(() => SH_TEXT.signedOut); };
		this.platform.onConflict = (doc) => this._mergeConflict(doc);
		this.bindings = structuredClone(DEFAULT_BINDINGS);
		this.platform.loadBindings(DEFAULT_BINDINGS).then((b) => {
			this.bindings = b;
			setBindings(b);
			if (this.phase === 'title') this._showTitle();
		});

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
			this.render = createRender(this.ui.canvas, {
				graphics: this.settings.graphics || {},
				reducedMotion: !!this.settings.reducedMotion,
				mobile: this.touchOnly,
				prefersReducedMotion: !!this.env.capabilities?.reducedMotion,
			});
		} catch {
			this._showCompatibility();
			return;
		}
		this.platform.syncTime().then(() => this._refreshDaily());
		this.platform.startActivity();
		this.platform.loadProfile();
		this._loadCloudSave().then(() => this._loadPlatformSettings());
		this._setPhase('title', 'boot_complete');
		this._showTitle();
		this._resize();
		this._loop(0);
	}

	_showCompatibility() {
		this.ui.screenLayer.innerHTML = '';
		const s = document.createElement('section');
		s.className = 'hw-panel';
		s.innerHTML = '<h1>Hillwheel</h1><p></p>';
		bindText(s.querySelector('p'), L('This game needs WebGL, which your browser or device has disabled. Your settings and progress are saved and will be here when WebGL is available.'));
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
			journeyProgress: L('{done}/{total} stages', { done, total: content.STAGES.length }),
			firstRun: this._isFirstRun(),
			resumeLabel: stageLabel(stage),
			touch: this.touchOnly,
			profile: this._profileStatus(),
			account: { invite: this.platform.hosted, signIn: this.platform.canSignIn() },
		}));
	}

	async _refreshDaily() {
		const date = this.platform.todayUTC();
		this._daily = content.dailyContent(date);
		this._dailyInfo = date;
		if (this.phase === 'title') this._showTitle();
	}

	// Cloud mirror: localStorage (ui.js) is the offline cache; the platform cloud
	// slot is loaded remote-first at boot and pushed debounced after every change.
	async _loadCloudSave() {
		const res = await this.platform.loadSave();
		if (!res.ok || !res.doc) return;
		const doc = res.doc;
		if (doc.progress && typeof doc.progress === 'object') {
			this.progress = Object.assign(structuredClone(this.progress), doc.progress);
			this.totalDistance = this.progress.totalDistance || 0;
			saveProgress(this.progress);
		}
		if (doc.settings && typeof doc.settings === 'object') {
			this.settings = Object.assign(structuredClone(this.settings), doc.settings);
			saveSettings(this.settings);
			this.ui.applySettings(this.settings);
			this.audio.setMuted(!!this.settings.muted);
			for (const bus of ['music', 'sfx', 'ambience', 'voice']) this.audio.setVolume(bus, this._busVolumes()[bus]);
			this.platform.telemetryConsent = !!this.settings.telemetryConsent;
			this.render?.setGraphics(this.settings.graphics || {});
		}
		if (this.phase === 'title') this._showTitle();
	}

	// Cloud-save conflict: another device saved since our load. Keep the best of
	// both — higher score per completed stage, union of lessons and achievements,
	// furthest stage reached, longer totals, best daily per date — keep this
	// device's settings and the run in progress, then save the merged doc.
	_mergeConflict(doc) {
		const r = doc && doc.progress;
		if (r && typeof r === 'object') {
			const p = this.progress;
			for (const [id, score] of Object.entries(r.stagesCompleted || {})) p.stagesCompleted[id] = Math.max(p.stagesCompleted[id] || 0, Number(score) || 0);
			for (const id of r.tutorialDone || []) if (!p.tutorialDone.includes(id)) p.tutorialDone.push(id);
			for (const k of r.achievements || []) if (!p.achievements.includes(k)) p.achievements.push(k);
			p.lastStage = Math.max(p.lastStage || 0, Number(r.lastStage) || 0);
			p.totalDistance = Math.max(p.totalDistance || 0, Number(r.totalDistance) || 0);
			p.runsPlayed = Math.max(p.runsPlayed || 0, Number(r.runsPlayed) || 0);
			if (r.dailyBest) {
				const best = p.dailyBest || (p.dailyBest = {});
				for (const [id, score] of Object.entries(r.dailyBest)) best[id] = Math.max(best[id] || 0, Number(score) || 0);
			}
			this.totalDistance = Math.max(this.totalDistance, p.totalDistance);
		}
		this._persistProgress();
		if (this.phase === 'title') this._showTitle();
	}

	// Per-player settings KV: platform values win over the local ones when signed in.
	async _loadPlatformSettings() {
		const remote = await this.platform.getSettings();
		if (!remote || typeof remote !== 'object' || !Object.keys(remote).length) return;
		this.settings = Object.assign(structuredClone(this.settings), remote);
		this._applySettingsQuiet();
		if (this.phase === 'title') this._showTitle();
	}

	_applySettingsQuiet() {
		saveSettings(this.settings);
		this.ui.applySettings(this.settings);
		this.audio.setMuted(!!this.settings.muted);
		for (const bus of ['music', 'sfx', 'ambience', 'voice']) this.audio.setVolume(bus, this._busVolumes()[bus]);
		this.platform.telemetryConsent = !!this.settings.telemetryConsent;
		this.render?.setGraphics(this.settings.graphics || {});
		this.render?.setReducedMotion(!!this.settings.reducedMotion);
	}

	// Debounced mirror of the settings object to the platform settings KV.
	_mirrorSettings() {
		if (!this.platform.hosted) return;
		clearTimeout(this._kvTimer);
		this._kvTimer = setTimeout(() => this.platform.patchSettings(this.settings), 600);
	}

	_inviteFriend() {
		const link = this.platform.inviteLink();
		if (!link) return;
		const done = (ok) => this.ui.toast(ok ? () => SH_TEXT.copied : () => SH_TEXT.copyFailed.replace('{link}', link));
		try { navigator.clipboard.writeText(link).then(() => done(true), () => done(false)); } catch { done(false); }
	}

	_saveDoc() {
		return { schemaVersion: 1, savedAt: Date.now(), progress: this.progress, settings: this.settings };
	}

	_persistProgress() {
		saveProgress(this.progress);
		this.platform.queueSave(this._saveDoc());
	}

	_profileStatus() {
		if (!this.platform.hosted) return null;
		return { name: this.platform.nickname || '…', sync: this.platform.syncState, avatar: this.platform.avatar };
	}

	_onPlatformChange() {
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
			case 'settings': return this.ui.showScreen('settings', this.ui.buildSettings({ settings: this.settings, onSettings: (p) => this._updateSettings(p), gfx: this._gfxApi() }));
			case 'help': return this.ui.showScreen('help', this.ui.buildHelp());
			case 'invite': return this._inviteFriend();
			case 'sign-in': return this.platform.signIn();
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
				label: () => `${stageLabel(s)()}${s.mastery ? ' ★' : ''}${done[s.id] ? ` ✓ ${done[s.id]}` : ''}`,
				done: !!done[s.id], locked: i > 0 && !done[content.STAGES[i - 1].id] && i > (this.progress.lastStage || 0) + 1,
			}));
			this.ui.showScreen('setup', this.ui.buildModeSetup({
				mode, levels, ranked: false,
				onPick: (i) => this._startJourneyLevel(i),
			}));
		} else if (mode === 'learn') {
			const levels = content.TUTORIALS.map((t) => ({
				label: () => `${T(t.title)}${tutDone.includes(t.id) ? ' ✓' : ''}`, done: tutDone.includes(t.id),
			}));
			this.ui.showScreen('setup', this.ui.buildModeSetup({
				mode, levels, ranked: false,
				onPick: (i) => this._startTutorial(i),
			}));
		} else if (mode === 'daily') {
			const d = this._daily || content.dailyContent(new Date().toISOString().slice(0, 10));
			this.ui.showScreen('setup', this.ui.buildModeSetup({
				mode, levels: [{ label: L('{name} — ranked', { name: dailyLabel(d) }) }], ranked: true,
				onPick: () => this._startDaily(d),
			}));
		} else if (mode === 'practice') {
			const levels = [L('Easy hills'), L('Rolling hills'), L('Steep hills'), L('Wild hills')].map((label) => ({ label }));
			this.ui.showScreen('setup', this.ui.buildModeSetup({
				mode, levels, ranked: false,
				onPick: (i) => this._startPractice(i),
			}));
		} else if (mode === 'challenge') {
			const levels = content.CHALLENGES.map((c) => ({ label: L('{name} — {desc}', { name: L(c.name), desc: L(c.desc) }) }));
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
			this.ui.announce(T('Go! {verb} to drive.', { verb: this._gasVerb() }));
			// Keep the "how do I move" prompt up until the first press of the throttle.
			this.coach.active = 'gas';
			this.ui.showHint(() => T('{verb} to drive', { verb: this._gasVerb() }));
			return;
		}
		this.ui.showCountdown(n === 3 && this.levelMeta.intro ? L(this.levelMeta.intro) : String(n), () => T('Get ready: {verb} to drive', { verb: this._gasVerb() }));
		this.audio.event('countdown');
		setTimeout(() => { if (this.phase === 'countdown') this._countdown(n - 1, token); }, this.levelMeta.intro && n === 3 ? 1600 : 900);
	}

	_startJourneyLevel(i) {
		const s = content.getStage(i);
		this.progress.lastStage = i;
		this._persistProgress();
		this._prepare(content.levelConfig(s, 'journey'), { kind: 'journey', index: i, id: s.id, theme: s.theme, name: stageLabel(s) });
	}

	_startTutorial(i) {
		const t = content.TUTORIALS[i];
		this._prepare(content.tutorialConfig(t), { kind: 'learn', index: i, id: t.id, theme: 'meadow', name: L(t.title), intro: t.text, tutorial: t });
	}

	_startDaily(d) {
		this._prepare(content.levelConfig(d, 'daily'), { kind: 'daily', id: d.id, theme: d.theme, name: dailyLabel(d) });
	}

	_startPractice(i) {
		const cfg = { seed: (0x9ac0 + i * 977) >>> 0, length: 300 + i * 120, roughness: 0.5 + i * 0.35, fuel: 100, fuelCans: 2 + i, checkpoints: 2, mode: 'practice' };
		this._prepare(cfg, { kind: 'practice', index: i, id: 'practice-' + i, theme: content.THEMES[i % content.THEMES.length].id, name: L('Practice') });
	}

	_startChallenge(i) {
		const c = content.CHALLENGES[i];
		this._prepare(content.levelConfig(c.config, 'challenge'), { kind: 'challenge', id: c.id, theme: 'ember', name: L(c.name) });
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
			gfx: this._gfxApi(),
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
			this.ui.announce(T('Undone'));
			this._resume();
		} else {
			this.ui.announce(T('Nothing to undo'), true);
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
		this.platform.queueSave(this._saveDoc());
		this.ui.applySettings(this.settings);
		this.audio.setMuted(!!this.settings.muted);
		for (const bus of ['music', 'sfx', 'ambience', 'voice']) this.audio.setVolume(bus, this._busVolumes()[bus]);
		this.render?.setGraphics(this.settings.graphics || {});
		this.render?.setReducedMotion(!!this.settings.reducedMotion);
		this.platform.telemetryConsent = !!this.settings.telemetryConsent;
		// The pause panel's controls already show the new values; it is not rebuilt,
		// so focus, scroll and the shared options sections mounted in it stay put.
		this.platform.track('settings_change');
		this._mirrorSettings();
	}

	// Graphics settings change in place (no panel rebuild) so the Settings scroll position and
	// focus survive; they persist with the other settings and in the cloud save.
	_gfxApi() {
		return {
			get: () => structuredClone(this.settings.graphics || {}),
			set: (g) => {
				this.settings.graphics = g;
				saveSettings(this.settings);
				this.platform.queueSave(this._saveDoc());
				this.render?.setGraphics(g);
				this.platform.track('settings_change');
				this._mirrorSettings();
			},
			info: (words) => this.render?.graphicsInfo(words) || null,
		};
	}

	// Standalone board: the player's own best Daily scores, newest dates first on ties.
	_localBoard() {
		const entries = Object.entries(this.progress.dailyBest || {})
			.map(([id, score]) => ({ date: id.replace(/^daily-/, ''), name: L('Daily {date}', { date: id.replace(/^daily-/, '') }), score }))
			.sort((x, y) => y.score - x.score || (x.date < y.date ? 1 : -1))
			.slice(0, 20);
		return { ok: true, data: { entries } };
	}

	async _showLeaderboard() {
		this.ui.showScreen('leaderboard', this.ui.buildLeaderboard({ loading: true }));
		const res = this.platform.hosted ? await this.platform.getLeaderboard() : this._localBoard();
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
		if (this.touchOnly) return hold ? T('Hold GAS') : T('Tap GAS');
		return T(hold ? 'Hold {keys}' : 'Tap {keys}', { keys: keysFor('throttle', ' ' + T('or') + ' ') });
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
			if (c.idle === 90 && !c.active) this._hint('idle', () => T('{verb} to get going', { verb: this._gasVerb() }), 2500);
		} else c.idle = 0;
		if (fresh && !c.airHint && !v.grounded && state.airTime > 0.35 && !this.input.tilt && (!c.active || c.active === 'idle')) {
			c.airHint = true;
			this._hint('air', () => (this.touchOnly ? T('In the air: TILT ◀ ▶ to match the slope') : T('In the air: {tiltL} {tiltR} tilt to match the slope', { tiltL: keysFor('tiltL', '/'), tiltR: keysFor('tiltR', '/') })), 2500);
		}
		if (!c.fuelHint && v.fuel < (v.fuelMax || 100) * 0.25 && c.active !== 'gas') {
			c.fuelHint = true;
			this._hint('fuel', L('Fuel low: ease off downhill and grab the yellow cans'), 3000);
		}
	}

	_bindGlobalInput() {
		this.keys = {};
		// Driving keys come from the (platform-resolved) bindings: code -> action.
		const DRIVE = ['throttle', 'brake', 'tiltL', 'tiltR'];
		const actionOf = (code) => {
			for (const a of Object.keys(this.bindings)) if (this.bindings[a].includes(code)) return a;
			return null;
		};
		const map = new Proxy({}, { get: (_, code) => { const a = actionOf(code); return DRIVE.includes(a) ? a : undefined; } });
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
			} else if (actionOf(e.code) === 'pause') {
				if (this.phase === 'active') this._pause();
				else if (this.phase === 'paused') this._resume();
			} else if (actionOf(e.code) === 'undo' && this.mode === 'practice' && (this.phase === 'active' || this.phase === 'paused')) {
				this._undo();
			} else if (actionOf(e.code) === 'recenter') {
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
				this.platform.flushSave();
			} else {
				this.audio.setBackgrounded(false);
			}
		});
		window.addEventListener('pagehide', () => this.platform.flushSave());
		window.addEventListener('beforeunload', () => { this.platform.flushSave(); this.platform.endActivity(); });
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
		if (s.nextCheckpoint > before.cp) { this.audio.event('checkpoint'); this.ui.announce(T('Checkpoint {n} of {total}', { n: s.nextCheckpoint, total: s.checkpoints.length })); }
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
				this.ui.announce(T('Achievement unlocked: {name}', { name: a.name }), true);
				this.platform.unlockAchievement(a.key);
			}
		}

		// Daily: the player's best per date is kept locally (the standalone board).
		if (m?.kind === 'daily') {
			const best = this.progress.dailyBest || (this.progress.dailyBest = {});
			best[m.id] = Math.max(best[m.id] || 0, result.breakdown.total);
		}
		this._persistProgress();

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
		if (m?.kind !== 'learn') this._postToLeaderboard(result.breakdown.total);
	}

	// Signed in only: post the run total and show the player's board rank.
	_postToLeaderboard(total) {
		if (!this.platform.hosted) return;
		const line = this.root.querySelector('.hw-results-lb');
		if (!line) return;
		line.hidden = false;
		bindText(line, () => SH_TEXT.lbPosting);
		this.platform.submitScore(total).then((r) => {
			bindText(line, () => (!r.posted ? SH_TEXT.lbNotPosted
				: r.rank ? SH_TEXT.lbRank.replace('{rank}', r.rank) : SH_TEXT.lbPosted));
		});
	}

	dispose() {
		cancelAnimationFrame(this._raf);
		this.platform.flushSave();
		this.platform.endActivity();
		this.audio.dispose();
		this.render?.dispose();
	}
}

export function createGame(root, env) { return new Game(root, env); }
export default Game;
