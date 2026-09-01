// Hillwheel UI layer: DOM shell, screens, HUD, settings/progress persistence.
// Pure DOM — no three.js here; the 3D scene lives in render.js on the canvas.

export const STRINGS = {
	title: 'Hillwheel',
	tagline: 'Balance the wheel over the hills. Reach the flag with fuel to spare.',
	next: 'Next stage',
	back: '← Back',
};

const SETTINGS_KEY = 'hillwheel-settings-v1';
const PROGRESS_KEY = 'hillwheel-progress-v1';

const DEFAULT_SETTINGS = {
	volumes: { music: 70, sfx: 80, ambience: 60, voice: 80 },
	tier: 'high',
	reducedMotion: false,
	leftHanded: false,
	holdToDrive: true,
	muted: false,
	telemetryConsent: false,
	largeText: false,
	highContrast: false,
	palette: 'default',
};

const DEFAULT_PROGRESS = {
	stagesCompleted: {},
	tutorialDone: [],
	achievements: [],
	lastStage: 0,
	totalDistance: 0,
};

function readJson(key, fallback) {
	try {
		const raw = localStorage.getItem(key);
		if (!raw) return structuredClone(fallback);
		return Object.assign(structuredClone(fallback), JSON.parse(raw));
	} catch {
		return structuredClone(fallback);
	}
}
function writeJson(key, value) {
	try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage may be unavailable */ }
}

export function loadSettings() {
	const s = readJson(SETTINGS_KEY, DEFAULT_SETTINGS);
	s.volumes = Object.assign(structuredClone(DEFAULT_SETTINGS.volumes), s.volumes || {});
	return s;
}
export function saveSettings(settings) { writeJson(SETTINGS_KEY, settings); }
export function loadProgress() { return readJson(PROGRESS_KEY, DEFAULT_PROGRESS); }
export function saveProgress(progress) { writeJson(PROGRESS_KEY, progress); }

function el(tag, className, text) {
	const n = document.createElement(tag);
	if (className) n.className = className;
	if (text !== undefined) n.textContent = text;
	return n;
}

function button(label, className, onClick) {
	const b = el('button', 'hw-btn' + (className ? ' ' + className : ''), label);
	b.type = 'button';
	if (onClick) b.addEventListener('click', onClick);
	return b;
}

export function createUi(root, onAction, settings) {
	root.classList.add('hw-root');

	const canvasWrap = el('div', 'hw-canvas-wrap');
	const canvas = document.createElement('canvas');
	canvas.setAttribute('aria-label', 'Hillwheel 3D scene');
	canvasWrap.appendChild(canvas);

	const hud = el('div', 'hw-hud hidden');
	const screenLayer = el('div', 'hw-screen-layer');
	const countdownEl = el('div', 'hw-countdown hidden');
	const liveRegion = el('div', 'sr-only');
	liveRegion.setAttribute('aria-live', 'polite');

	root.append(canvasWrap, hud, screenLayer, countdownEl, liveRegion);

	const ui = {
		canvas, canvasWrap, screenLayer, hud,
		showScreen, buildTitle, buildModeSetup, buildSettings, buildHelp,
		buildPause, buildLeaderboard, buildResults,
		buildHud, showHud, updateHud, updateMirror,
		showCountdown, announce, applySettings,
	};

	let pedalHandlers = null;

	function showScreen(_name, node) {
		screenLayer.innerHTML = '';
		if (node) screenLayer.appendChild(node);
		screenLayer.classList.toggle('hidden', !node);
		hud.classList.add('hidden');
	}

	function showHud() {
		screenLayer.classList.add('hidden');
		hud.classList.remove('hidden');
	}

	function announce(text, assertive) {
		liveRegion.setAttribute('aria-live', assertive ? 'assertive' : 'polite');
		liveRegion.textContent = '';
		// re-set on the next tick so repeated messages are announced
		setTimeout(() => { liveRegion.textContent = text; }, 30);
	}

	function showCountdown(text) {
		countdownEl.textContent = text || '';
		countdownEl.classList.toggle('hidden', !text);
	}

	function applySettings(s) {
		root.classList.toggle('large-text', !!s.largeText);
		root.classList.toggle('high-contrast', !!s.highContrast);
		root.classList.toggle('reduced-motion', !!s.reducedMotion);
		root.dataset.palette = s.palette || 'default';
	}

	function panel(titleText, subtitle) {
		const p = el('section', 'hw-panel');
		if (titleText) p.appendChild(el('h1', null, titleText));
		if (subtitle) p.appendChild(el('p', 'hw-tagline', subtitle));
		return p;
	}

	// --- Screens -------------------------------------------------------------

	function buildTitle({ dailyInfo, journeyProgress } = {}) {
		const p = panel(STRINGS.title, STRINGS.tagline);
		const col = el('div', 'hw-btn-col');
		col.appendChild(button('Quick play' + (journeyProgress ? ` (${journeyProgress})` : ''), 'hw-btn-primary', () => onAction('quick-play')));
		for (const [mode, label] of [
			['journey', 'Journey'],
			['learn', 'Learn'],
			['daily', dailyInfo ? `Daily — ${dailyInfo}` : 'Daily'],
			['practice', 'Practice'],
			['challenge', 'Challenge'],
		]) {
			col.appendChild(button(label, null, () => onAction('mode', mode)));
		}
		p.appendChild(col);
		const row = el('div', 'hw-btn-row');
		row.appendChild(button('Leaderboards', 'hw-btn-small', () => onAction('leaderboard')));
		row.appendChild(button('Settings', 'hw-btn-small', () => onAction('settings')));
		row.appendChild(button('How to play', 'hw-btn-small', () => onAction('help')));
		p.appendChild(row);
		return p;
	}

	const MODE_TITLES = {
		journey: 'Journey', learn: 'Learn', daily: 'Daily challenge',
		practice: 'Practice', challenge: 'Challenge',
	};

	function buildModeSetup({ mode, levels = [], ranked, onPick } = {}) {
		const p = panel(MODE_TITLES[mode] || 'Select', ranked ? 'Ranked — one shared run for everyone.' : null);
		const list = el('div', 'hw-level-list');
		levels.forEach((lv, i) => {
			const b = button(lv.label, lv.done ? 'done' : null, () => onPick(i));
			if (lv.locked) { b.disabled = true; b.textContent += ' 🔒'; }
			list.appendChild(b);
		});
		p.appendChild(list);
		p.appendChild(button(STRINGS.back, 'hw-btn-small', () => onAction('back-title')));
		return p;
	}

	function settingsForm(s, onSettings) {
		const wrap = el('div', 'hw-settings');
		const mkRange = (label, value, onInput) => {
			const f = el('label', 'hw-field');
			f.appendChild(el('span', null, label));
			const input = document.createElement('input');
			input.type = 'range'; input.min = '0'; input.max = '100'; input.value = String(value ?? 0);
			input.addEventListener('input', () => onInput(Number(input.value)));
			f.appendChild(input);
			return f;
		};
		const mkCheck = (label, checked, onChange) => {
			const f = el('label', 'hw-field hw-check');
			const input = document.createElement('input');
			input.type = 'checkbox'; input.checked = !!checked;
			input.addEventListener('change', () => onChange(input.checked));
			f.appendChild(input);
			f.appendChild(el('span', null, label));
			return f;
		};
		wrap.appendChild(mkCheck('Mute all', s.muted, (v) => onSettings({ muted: v })));
		for (const bus of ['music', 'sfx', 'ambience', 'voice']) {
			wrap.appendChild(mkRange(bus[0].toUpperCase() + bus.slice(1), s.volumes?.[bus], (v) => onSettings({ volumes: { ...s.volumes, [bus]: v } })));
		}
		const tierField = el('label', 'hw-field');
		tierField.appendChild(el('span', null, 'Quality'));
		const tier = document.createElement('select');
		for (const t of ['low', 'medium', 'high']) {
			const o = document.createElement('option');
			o.value = t; o.textContent = t; o.selected = s.tier === t;
			tier.appendChild(o);
		}
		tier.addEventListener('change', () => onSettings({ tier: tier.value }));
		tierField.appendChild(tier);
		wrap.appendChild(tierField);
		wrap.appendChild(mkCheck('Reduced motion', s.reducedMotion, (v) => onSettings({ reducedMotion: v })));
		wrap.appendChild(mkCheck('Left-handed pedals', s.leftHanded, (v) => onSettings({ leftHanded: v })));
		wrap.appendChild(mkCheck('Hold to drive (off = toggle)', s.holdToDrive !== false, (v) => onSettings({ holdToDrive: v })));
		wrap.appendChild(mkCheck('Larger text', s.largeText, (v) => onSettings({ largeText: v })));
		wrap.appendChild(mkCheck('High contrast', s.highContrast, (v) => onSettings({ highContrast: v })));
		wrap.appendChild(mkCheck('Share anonymous telemetry', s.telemetryConsent, (v) => onSettings({ telemetryConsent: v })));
		return wrap;
	}

	function buildSettings({ settings: s, onSettings } = {}) {
		const p = panel('Settings');
		p.appendChild(settingsForm(s, onSettings));
		p.appendChild(button(STRINGS.back, 'hw-btn-small', () => onAction('back-title')));
		return p;
	}

	function buildHelp() {
		const p = panel('How to play');
		const grid = el('div', 'hw-help-grid');
		for (const [h, t] of [
			['Drive', 'Hold ↑ / W or the GAS pedal to accelerate. ↓ / S or BRAKE slows down.'],
			['Balance', '← / A tilts back, → / D tilts forward. Land on both wheels for a smooth-landing bonus.'],
			['Goal', 'Reach the flag before the fuel runs out. Checkpoints and fuel cans boost your score.'],
			['Pause', 'Esc or P pauses. Practice mode allows undo with U.'],
		]) {
			const c = el('div', 'hw-help-card');
			c.appendChild(el('h3', null, h));
			c.appendChild(el('p', null, t));
			grid.appendChild(c);
		}
		p.appendChild(grid);
		p.appendChild(button(STRINGS.back, 'hw-btn-small', () => onAction('back-title')));
		return p;
	}

	function buildPause({ settings: s, canUndo, onSettings } = {}) {
		const p = panel('Paused');
		const col = el('div', 'hw-btn-col');
		col.appendChild(button('Resume', 'hw-btn-primary', () => onAction('resume')));
		col.appendChild(button('Restart', null, () => onAction('restart')));
		if (canUndo) col.appendChild(button('Undo', null, () => onAction('undo')));
		col.appendChild(button('Quit to title', 'hw-danger', () => onAction('quit')));
		p.appendChild(col);
		p.appendChild(settingsForm(s, onSettings));
		return p;
	}

	function buildLeaderboard({ loading, entries, error } = {}) {
		const p = panel('Leaderboards');
		if (loading) {
			p.appendChild(el('p', 'hw-note', 'Loading…'));
		} else if (error || !entries) {
			p.appendChild(el('p', 'hw-note', 'Leaderboard is unavailable right now.'));
		} else if (!entries.length) {
			p.appendChild(el('p', 'hw-note', 'No scores yet — be the first.'));
		} else {
			const ol = el('ol', 'hw-board');
			entries.slice(0, 20).forEach((e2) => {
				ol.appendChild(el('li', null, `${e2.name || e2.player || 'player'} — ${e2.score ?? e2.total ?? 0}`));
			});
			p.appendChild(ol);
		}
		p.appendChild(button(STRINGS.back, 'hw-btn-small', () => onAction('back-title')));
		return p;
	}

	function buildResults({ result, breakdown, won, isDaily, newAchievements, nextLabel } = {}) {
		const p = panel(won ? 'Finished!' : 'Run over', isDaily ? 'Daily challenge — ranked' : null);
		const table = el('dl', 'hw-score-table');
		const rows = [
			['Distance', breakdown?.distance],
			['Checkpoints', breakdown?.checkpointBonus],
			['Finish bonus', breakdown?.finishBonus],
			['Smooth landings', breakdown?.landingBonus],
			['Fuel cans', breakdown?.canBonus],
			['Fuel bonus', breakdown?.fuelBonus],
			['Time bonus', breakdown?.timeBonus],
		];
		for (const [k, v] of rows) {
			if (v === undefined) continue;
			table.appendChild(el('dt', null, k));
			table.appendChild(el('dd', null, String(v)));
		}
		table.appendChild(el('dt', 'hw-total', 'Total'));
		table.appendChild(el('dd', 'hw-total', String(breakdown?.total ?? 0)));
		p.appendChild(table);
		if (newAchievements && newAchievements.length) {
			p.appendChild(el('p', 'hw-achievements', 'Achievements: ' + newAchievements.join(', ')));
		}
		if (!won && result?.terminalReason) {
			p.appendChild(el('p', 'hw-note', 'Reason: ' + String(result.terminalReason).replace(/_/g, ' ')));
		}
		const row = el('div', 'hw-btn-row');
		if (nextLabel) row.appendChild(button(nextLabel, 'hw-btn-primary', () => onAction('next')));
		row.appendChild(button('Restart', null, () => onAction('restart')));
		row.appendChild(button('Quit to title', 'hw-danger', () => onAction('quit')));
		p.appendChild(row);
		return p;
	}

	// --- HUD -----------------------------------------------------------------

	let hudEls = null;

	function buildHud({ leftHanded, onPedal, onPause } = {}) {
		pedalHandlers = onPedal;
		hud.innerHTML = '';
		const top = el('div', 'hw-hud-top');
		const pauseBtn = button('❚❚', 'hw-btn-icon hw-btn-small', () => onPause && onPause());
		pauseBtn.setAttribute('aria-label', 'Pause');
		const objective = el('div', 'hw-hud-objective', '');
		const mirror = el('div', 'hw-note', '');
		const fuel = el('div', 'hw-hud-fuel');
		const fuelBar = el('div', 'hw-hud-fuel-bar');
		fuel.appendChild(fuelBar);
		const score = el('div', 'hw-hud-score', '0');
		top.append(pauseBtn, objective, mirror, fuel, score);

		const tray = el('div', 'hw-hud-tray');
		const mkPedal = (key, label) => {
			const b = el('button', 'hw-pedal', label);
			b.type = 'button';
			const down = (e) => { e.preventDefault(); b.classList.add('active'); onPedal && onPedal(key, true); };
			const up = () => { b.classList.remove('active'); onPedal && onPedal(key, false); };
			b.addEventListener('pointerdown', down);
			b.addEventListener('pointerup', up);
			b.addEventListener('pointercancel', up);
			b.addEventListener('pointerleave', up);
			b.addEventListener('contextmenu', (e) => e.preventDefault());
			return b;
		};
		const left = [mkPedal('tiltL', '◀ TILT'), mkPedal('brake', 'BRAKE')];
		const right = [mkPedal('throttle', 'GAS'), mkPedal('tiltR', 'TILT ▶')];
		const order = leftHanded ? [...right, ...left] : [...left, ...right];
		const leftGroup = el('div', 'hw-btn-row');
		const rightGroup = el('div', 'hw-btn-row');
		leftGroup.style.marginTop = '0'; rightGroup.style.marginTop = '0';
		order.slice(0, 2).forEach((b) => leftGroup.appendChild(b));
		order.slice(2).forEach((b) => rightGroup.appendChild(b));
		tray.append(leftGroup, rightGroup);

		hud.append(top, tray);
		hudEls = { objective, mirror, fuelBar, score };
	}

	function updateHud(state, breakdown, goalX) {
		if (!hudEls) return;
		const x = Math.max(0, Math.floor(state.vehicle.x));
		hudEls.objective.textContent = `${x} / ${Math.floor(goalX)} m · checkpoint ${state.nextCheckpoint}/${state.checkpoints.length}`;
		hudEls.score.textContent = String(breakdown?.total ?? 0);
		const pct = Math.max(0, Math.min(100, (state.vehicle.fuel / (state.vehicle.fuelMax || 100)) * 100));
		hudEls.fuelBar.style.width = pct + '%';
		if (pct < 25) hudEls.fuelBar.dataset.pct = 'low'; else delete hudEls.fuelBar.dataset.pct;
	}

	function updateMirror(state) {
		if (!hudEls) return;
		const kmh = Math.abs(state.vehicle.vx * 3.6).toFixed(0);
		hudEls.mirror.textContent = `${kmh} km/h · cans ${state.cansCollected}`;
	}

	applySettings(settings || {});
	return ui;
}
