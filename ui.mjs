// Hillwheel ui: responsive DOM shell, focus, localization, settings, overlays,
// accessibility mirror. UI state is separate from simulation state.

export const UI_SCHEMA_VERSION = 2;

const SETTINGS_KEY = 'hillwheel-settings-v2';
const PROGRESS_KEY = 'hillwheel-progress-v2';

export const DEFAULT_SETTINGS = {
	volumes: { music: 0.5, sfx: 0.8, ambience: 0.4, voice: 0.8 },
	muted: false,
	tier: 'medium',
	reducedMotion: false,
	highContrast: false,
	largeText: false,
	leftHanded: false,
	holdToDrive: true,     // hold vs toggle pedals
	colorPalette: 'default', // default | deuteranopia | protanopia | tritanopia
	cameraFollow: true,
	telemetryConsent: false,
};

export const DEFAULT_PROGRESS = {
	version: 2,
	tutorialDone: [],
	stagesCompleted: {},   // stageId -> best score
	masteryStars: 0,
	bestDaily: {},
	achievements: [],
	lastStage: 0,
};

export function loadSettings() {
	try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; }
	catch { return { ...DEFAULT_SETTINGS }; }
}
export function saveSettings(s) { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch {} }
export function loadProgress() {
	try { return { ...DEFAULT_PROGRESS, ...JSON.parse(localStorage.getItem(PROGRESS_KEY) || '{}') }; }
	catch { return { ...DEFAULT_PROGRESS }; }
}
export function saveProgress(p) { try { localStorage.setItem(PROGRESS_KEY, JSON.stringify(p)); } catch {} }

// Minimal localization table (en). All labels are data-driven for translation.
export const STRINGS = {
	title: 'Hillwheel', play: 'Play', journey: 'Journey', daily: 'Daily Challenge',
	practice: 'Practice', challenge: 'Challenge', learn: 'Learn', settings: 'Settings',
	help: 'How to Play', resume: 'Resume', restart: 'Restart', quit: 'Quit to Title',
	paused: 'Paused', results: 'Results', score: 'Score', distance: 'Distance',
	fuel: 'Fuel', next: 'Next', retry: 'Retry', back: 'Back', leaderboard: 'Leaderboard',
	objective: 'Reach the finish flag', throttle: 'Throttle', brake: 'Brake',
	tiltLeft: 'Tilt back', tiltRight: 'Tilt forward', undo: 'Undo', cameraReset: 'Camera',
};

function el(tag, cls, text) {
	const e = document.createElement(tag);
	if (cls) e.className = cls;
	if (text !== undefined) e.textContent = text;
	return e;
}

export class UiModule {
	constructor(root, actions, settings) {
		this.root = root;
		this.actions = actions;   // (name, payload) => void, owned by game orchestrator
		this.settings = settings;
		this.progress = loadProgress();
		this.screen = null;
		this._modalFocus = null;
		this._lastFocus = null;

		root.innerHTML = '';
		root.className = 'hw-root';

		// Canvas host + DOM shell. The canvas is never the only UI.
		this.canvasWrap = el('div', 'hw-canvas-wrap');
		this.canvas = document.createElement('canvas');
		this.canvas.id = 'hw-canvas';
		this.canvas.setAttribute('aria-hidden', 'true');
		this.canvasWrap.appendChild(this.canvas);

		this.hud = el('div', 'hw-hud hidden');
		this.hud.setAttribute('role', 'region');
		this.hud.setAttribute('aria-label', 'Play HUD');

		this.screenLayer = el('div', 'hw-screen-layer');
		this.live = el('div', 'hw-live sr-only');
		this.live.setAttribute('aria-live', 'polite');
		this.live.setAttribute('role', 'status');
		this.liveAssert = el('div', 'hw-live-assert sr-only');
		this.liveAssert.setAttribute('aria-live', 'assertive');
		this.mirror = el('div', 'hw-mirror sr-only');
		this.mirror.setAttribute('aria-label', 'Board state summary');

		root.append(this.canvasWrap, this.hud, this.screenLayer, this.live, this.liveAssert, this.mirror);
		this.applySettings(settings);
	}

	// --- Settings -----------------------------------------------------------------

	applySettings(s) {
		this.settings = s;
		const r = this.root;
		r.classList.toggle('reduced-motion', !!s.reducedMotion);
		r.classList.toggle('high-contrast', !!s.highContrast);
		r.classList.toggle('large-text', !!s.largeText);
		r.classList.toggle('left-handed', !!s.leftHanded);
		r.dataset.palette = s.colorPalette || 'default';
		saveSettings(s);
	}

	// --- Screen management ----------------------------------------------------------

	showScreen(name, builder) {
		this.screenLayer.innerHTML = '';
		this.screenLayer.classList.remove('hidden');
		this.hud.classList.add('hidden');
		this.screen = name;
		if (builder) {
			const node = builder();
			this.screenLayer.appendChild(node);
			const first = node.querySelector('button, [href], input, select, [tabindex]');
			if (first) { this._lastFocus = first; first.focus(); }
		} else {
			this.screenLayer.classList.add('hidden');
		}
	}

	showHud() {
		this.screenLayer.innerHTML = '';
		this.screenLayer.classList.add('hidden');
		this.hud.classList.remove('hidden');
		this.screen = 'hud';
	}

	announce(msg, assertive = false) {
		const target = assertive ? this.liveAssert : this.live;
		target.textContent = '';
		requestAnimationFrame(() => { target.textContent = msg; });
	}

	// --- Title / home -----------------------------------------------------------------

	buildTitle({ dailyInfo, journeyProgress }) {
		return () => {
			const s = el('section', 'hw-panel hw-title');
			s.setAttribute('aria-labelledby', 'hw-title-h');
			const h = el('h1', '', STRINGS.title); h.id = 'hw-title-h';
			const sub = el('p', 'hw-tagline', 'Throttle, brake, and balance your way over the hills.');
			const play = el('button', 'hw-btn hw-btn-primary', STRINGS.play);
			play.onclick = () => this.actions('quick-play');
			const row = el('div', 'hw-btn-col');
			const modes = [
				['journey', `${STRINGS.journey} — ${journeyProgress}`],
				['daily', `${STRINGS.daily}${dailyInfo ? ` — ${dailyInfo}` : ''}`],
				['learn', STRINGS.learn],
				['practice', STRINGS.practice],
				['challenge', STRINGS.challenge],
			];
			for (const [mode, label] of modes) {
				const b = el('button', 'hw-btn', label);
				b.onclick = () => this.actions('mode', mode);
				row.appendChild(b);
			}
			const foot = el('div', 'hw-btn-row');
			for (const [a, label] of [['leaderboard', STRINGS.leaderboard], ['settings', STRINGS.settings], ['help', STRINGS.help]]) {
				const b = el('button', 'hw-btn hw-btn-small', label);
				b.onclick = () => this.actions(a);
				foot.appendChild(b);
			}
			s.append(h, sub, play, row, foot);
			return s;
		};
	}

	// --- Mode setup ----------------------------------------------------------------------

	buildModeSetup({ mode, levels, onPick, ranked }) {
		return () => {
			const s = el('section', 'hw-panel');
			const h = el('h2', '', STRINGS[mode] || mode);
			s.appendChild(h);
			if (ranked !== undefined) {
				s.appendChild(el('p', 'hw-ranked-note', ranked ? 'This result is ranked and validated.' : 'Unranked: no effect on competitive rating.'));
			}
			const list = el('div', 'hw-level-list');
			list.setAttribute('role', 'list');
			levels.forEach((lv, i) => {
				const b = el('button', 'hw-btn hw-level-btn', lv.label);
				b.setAttribute('role', 'listitem');
				if (lv.done) b.classList.add('done');
				if (lv.locked) { b.disabled = true; b.setAttribute('aria-disabled', 'true'); }
				b.onclick = () => { this.actions('click'); onPick(i); };
				list.appendChild(b);
			});
			const back = el('button', 'hw-btn hw-btn-small', STRINGS.back);
			back.onclick = () => this.actions('back-title');
			s.append(list, back);
			return s;
		};
	}

	// --- HUD ------------------------------------------------------------------------------

	buildHud({ onPedal, onPause, leftHanded }) {
		this.hud.innerHTML = '';
		const top = el('div', 'hw-hud-top');
		this.hudObjective = el('div', 'hw-hud-objective', STRINGS.objective);
		this.hudObjective.setAttribute('role', 'heading');
		this.hudObjective.setAttribute('aria-level', '2');
		this.hudScore = el('div', 'hw-hud-score', '0');
		this.hudFuel = el('div', 'hw-hud-fuel');
		this.hudFuelBar = el('div', 'hw-hud-fuel-bar');
		this.hudFuel.appendChild(this.hudFuelBar);
		const pauseBtn = el('button', 'hw-btn hw-btn-icon', '⏸');
		pauseBtn.setAttribute('aria-label', 'Pause');
		pauseBtn.onclick = onPause;
		top.append(this.hudObjective, this.hudScore, this.hudFuel, pauseBtn);

		// Thumb-zone pedals. Pointer capture; cancel safely on lost capture.
		const tray = el('div', 'hw-hud-tray');
		const mkPedal = (id, label, key) => {
			const b = el('button', 'hw-pedal', label);
			b.id = `hw-pedal-${id}`;
			b.setAttribute('aria-label', label);
			b.dataset.key = key;
			const press = (e) => { e.preventDefault(); try { b.setPointerCapture?.(e.pointerId); } catch {} b.classList.add('active'); onPedal(key, true); };
			const release = (e) => { b.classList.remove('active'); onPedal(key, false); };
			b.addEventListener('pointerdown', press);
			b.addEventListener('pointerup', release);
			b.addEventListener('pointercancel', release);
			b.addEventListener('lostpointercapture', release);
			return b;
		};
		const brake = mkPedal('brake', '◀ ' + STRINGS.brake, 'brake');
		const tiltL = mkPedal('tiltL', '⟲', 'tiltL');
		const tiltR = mkPedal('tiltR', '⟳', 'tiltR');
		const throttle = mkPedal('throttle', STRINGS.throttle + ' ▶', 'throttle');
		tiltL.setAttribute('aria-label', STRINGS.tiltLeft);
		tiltR.setAttribute('aria-label', STRINGS.tiltRight);
		if (leftHanded) tray.append(throttle, tiltL, tiltR, brake);
		else tray.append(brake, tiltL, tiltR, throttle);
		this.hud.append(top, tray);
	}

	updateHud(state, breakdown, distanceGoal) {
		if (!this.hudScore) return;
		const v = state.vehicle;
		this.hudScore.textContent = String(breakdown.total);
		const pct = Math.round((v.fuel / v.fuelMax) * 100);
		this.hudFuelBar.style.width = pct + '%';
		this.hudFuelBar.dataset.pct = pct < 25 ? 'low' : 'ok';
		this.hudFuel.setAttribute('aria-label', `${STRINGS.fuel} ${pct}%`);
		const dist = Math.max(0, Math.floor(v.x));
		this.hudObjective.textContent = `${STRINGS.objective} — ${dist} / ${distanceGoal} m`;
	}

	// Screen-reader friendly board summary (concise, not decorative).
	updateMirror(state, breakdown) {
		const v = state.vehicle;
		this.mirror.textContent =
			`Position ${Math.floor(v.x)} of ${state.goalX} meters. ` +
			`Speed ${Math.abs(v.vx).toFixed(0)}. Fuel ${Math.round(v.fuel)}. ` +
			`${v.grounded ? 'On the ground' : 'Airborne'}. ` +
			`Checkpoint ${state.nextCheckpoint} of ${state.checkpoints.length}. Score ${breakdown.total}.`;
	}

	showCountdown(text) {
		let cd = this.hud.querySelector('.hw-countdown');
		if (!cd) { cd = el('div', 'hw-countdown'); this.hud.appendChild(cd); }
		cd.textContent = text;
		this.announce(text, true);
		if (!text) cd.remove();
	}

	// --- Pause / settings ------------------------------------------------------------

	buildPause({ settings, onSettings, canUndo }) {
		return () => {
			const s = el('section', 'hw-panel');
			s.setAttribute('role', 'dialog');
			s.setAttribute('aria-label', STRINGS.paused);
			s.appendChild(el('h2', '', STRINGS.paused));
			const resume = el('button', 'hw-btn hw-btn-primary', STRINGS.resume);
			resume.onclick = () => this.actions('resume');
			const restart = el('button', 'hw-btn', STRINGS.restart);
			restart.onclick = () => this.actions('restart');
			const col = el('div', 'hw-btn-col');
			col.append(resume, restart);
			if (canUndo) {
				const undo = el('button', 'hw-btn', STRINGS.undo);
				undo.onclick = () => this.actions('undo');
				col.appendChild(undo);
			}
			s.appendChild(col);
			s.appendChild(this._buildSettingsForm(settings, onSettings));
			const quit = el('button', 'hw-btn hw-btn-small hw-danger', STRINGS.quit);
			quit.onclick = () => this.actions('quit');
			s.appendChild(quit);
			return s;
		};
	}

	_buildSettingsForm(settings, onSettings) {
		const form = el('div', 'hw-settings');
		form.appendChild(el('h3', '', STRINGS.settings));
		const mkSlider = (label, bus, val) => {
			const wrap = el('label', 'hw-field');
			wrap.appendChild(el('span', '', label));
			const input = document.createElement('input');
			input.type = 'range'; input.min = '0'; input.max = '1'; input.step = '0.05'; input.value = String(val);
			input.oninput = () => onSettings({ volumes: { ...settings.volumes, [bus]: Number(input.value) } });
			wrap.appendChild(input);
			return wrap;
		};
		form.append(
			mkSlider('Music', 'music', settings.volumes.music),
			mkSlider('Effects', 'sfx', settings.volumes.sfx),
			mkSlider('Ambience', 'ambience', settings.volumes.ambience),
			mkSlider('Voice', 'voice', settings.volumes.voice),
		);
		const mkToggle = (label, key) => {
			const wrap = el('label', 'hw-field hw-check');
			const input = document.createElement('input');
			input.type = 'checkbox'; input.checked = !!settings[key];
			input.onchange = () => onSettings({ [key]: input.checked });
			wrap.append(input, el('span', '', label));
			return wrap;
		};
		form.append(
			mkToggle('Mute all', 'muted'),
			mkToggle('Reduced motion', 'reducedMotion'),
			mkToggle('High contrast', 'highContrast'),
			mkToggle('Larger text', 'largeText'),
			mkToggle('Left-handed controls', 'leftHanded'),
			mkToggle('Hold pedals to drive (off = toggle)', 'holdToDrive'),
			mkToggle('Anonymous usage stats', 'telemetryConsent'),
		);
		const tierWrap = el('label', 'hw-field');
		tierWrap.appendChild(el('span', '', 'Graphics quality'));
		const sel = document.createElement('select');
		for (const t of ['low', 'medium', 'high']) {
			const o = document.createElement('option');
			o.value = t; o.textContent = t; if (settings.tier === t) o.selected = true;
			sel.appendChild(o);
		}
		sel.onchange = () => onSettings({ tier: sel.value });
		tierWrap.appendChild(sel);
		form.appendChild(tierWrap);
		const palWrap = el('label', 'hw-field');
		palWrap.appendChild(el('span', '', 'Color palette'));
		const psel = document.createElement('select');
		for (const p of ['default', 'deuteranopia', 'protanopia', 'tritanopia']) {
			const o = document.createElement('option');
			o.value = p; o.textContent = p; if (settings.colorPalette === p) o.selected = true;
			psel.appendChild(o);
		}
		psel.onchange = () => onSettings({ colorPalette: psel.value });
		palWrap.appendChild(psel);
		form.appendChild(palWrap);
		return form;
	}

	buildSettings({ settings, onSettings }) {
		return () => {
			const s = el('section', 'hw-panel');
			s.appendChild(el('h2', '', STRINGS.settings));
			s.appendChild(this._buildSettingsForm(settings, onSettings));
			const back = el('button', 'hw-btn hw-btn-small', STRINGS.back);
			back.onclick = () => this.actions('back-title');
			s.appendChild(back);
			return s;
		};
	}

	// --- Results ----------------------------------------------------------------------

	buildResults({ result, breakdown, won, isDaily, newAchievements, nextLabel }) {
		return () => {
			const s = el('section', 'hw-panel hw-results');
			s.setAttribute('role', 'dialog');
			s.setAttribute('aria-label', STRINGS.results);
			const headline = won ? 'Finished!' : result.terminalReason === 'out_of_fuel' ? 'Out of fuel' : result.terminalReason === 'crashed' ? 'Crashed' : result.terminalReason === 'timeout' ? 'Time up' : 'Run over';
			s.appendChild(el('h2', '', headline));
			const table = el('dl', 'hw-score-table');
			const rows = [
				[STRINGS.distance, breakdown.distance],
				['Checkpoints', breakdown.checkpointBonus],
				['Finish bonus', breakdown.finishBonus],
				['Smooth landings', breakdown.landingBonus],
				['Fuel cans', breakdown.canBonus],
				['Fuel remaining', breakdown.fuelBonus],
				['Time bonus', breakdown.timeBonus],
			];
			for (const [k, v] of rows) {
				table.append(el('dt', '', k), el('dd', '', String(v)));
			}
			table.append(el('dt', 'hw-total', STRINGS.score), el('dd', 'hw-total', String(breakdown.total)));
			s.appendChild(table);
			if (isDaily) s.appendChild(el('p', 'hw-note', 'Daily score submitted for validation.'));
			if (newAchievements?.length) {
				const ul = el('ul', 'hw-achievements');
				for (const a of newAchievements) ul.appendChild(el('li', '', `Achievement: ${a}`));
				s.appendChild(ul);
			}
			const row = el('div', 'hw-btn-col');
			if (nextLabel) {
				const next = el('button', 'hw-btn hw-btn-primary', nextLabel);
				next.onclick = () => this.actions('next');
				row.appendChild(next);
			}
			const retry = el('button', 'hw-btn', STRINGS.retry);
			retry.onclick = () => this.actions('restart');
			const quit = el('button', 'hw-btn hw-btn-small', STRINGS.quit);
			quit.onclick = () => this.actions('quit');
			row.append(retry, quit);
			s.appendChild(row);
			return s;
		};
	}

	// --- Help (rule cards from current control mappings) -------------------------------

	buildHelp() {
		return () => {
			const s = el('section', 'hw-panel hw-help');
			s.appendChild(el('h2', '', STRINGS.help));
			const cards = [
				['Throttle', 'Up arrow / W / right pedal. Burns fuel. Coast downhill to save it.'],
				['Brake', 'Down arrow / S / left pedal. Slow before crests and drops.'],
				['Pitch', 'Left/Right arrows or A/D while airborne. Match the slope before you land.'],
				['Fuel cans', 'Glowing cans refill your tank. Running dry ends the run.'],
				['Landing', 'Land wheels-down, aligned with the slope. Smooth landings score bonus points.'],
				['Checkpoints', 'Pass every flag, then reach the green finish flag.'],
				['Pause', 'Esc or P. Undo (U) is available in Practice. Camera resets with C.'],
			];
			const grid = el('div', 'hw-help-grid');
			for (const [t, d] of cards) {
				const card = el('div', 'hw-help-card');
				card.append(el('h3', '', t), el('p', '', d));
				grid.appendChild(card);
			}
			s.appendChild(grid);
			const back = el('button', 'hw-btn hw-btn-small', STRINGS.back);
			back.onclick = () => this.actions('back-title');
			s.appendChild(back);
			return s;
		};
	}

	// --- Leaderboard -------------------------------------------------------------------

	buildLeaderboard({ entries, board, loading, error }) {
		return () => {
			const s = el('section', 'hw-panel');
			s.appendChild(el('h2', '', STRINGS.leaderboard));
			if (loading) s.appendChild(el('p', '', 'Loading…'));
			else if (error) s.appendChild(el('p', 'hw-note', `Unavailable: ${error}. Local play is unaffected.`));
			else if (!entries?.length) s.appendChild(el('p', '', 'No scores yet. Be the first.'));
			else {
				const ol = el('ol', 'hw-board');
				for (const e of entries.slice(0, 20)) {
					ol.appendChild(el('li', '', `${e.name || 'Driver'} — ${e.score}${e.you ? ' (you)' : ''}`));
				}
				s.appendChild(ol);
			}
			const back = el('button', 'hw-btn hw-btn-small', STRINGS.back);
			back.onclick = () => this.actions('back-title');
			s.appendChild(back);
			return s;
		};
	}

	// Focus restoration helper for modals.
	restoreFocus() {
		if (this._lastFocus && document.contains(this._lastFocus)) this._lastFocus.focus();
	}
}

export function createUi(root, actions, settings) { return new UiModule(root, actions, settings || loadSettings()); }
export function disposeUi(ui) { ui?.root && (ui.root.innerHTML = ''); }
export default UiModule;
