// Hillwheel UI layer: DOM shell, screens, HUD, settings/progress persistence.
// Pure DOM — no three.js here; the 3D scene lives in render.js on the canvas.

export const STRINGS = {
	title: 'Hillwheel',
	tagline: 'Hold the gas to climb, tilt in the air, land on both wheels. Reach the green flag before the fuel runs out.',
	next: 'Next stage',
	nextLesson: 'Next lesson',
	startJourney: 'Start the Journey',
	back: '← Back',
};

// Plain-language explanations of how a run ended, with the one thing to try next.
export const END_REASONS = {
	crashed: { title: 'Crashed', text: 'You landed nose-first or too hard. In the air, tilt to match the slope you are about to land on.' },
	out_of_fuel: { title: 'Out of fuel', text: 'The tank ran dry. Ease off the gas on descents and grab the yellow fuel cans.' },
	timeout: { title: 'Out of time', text: 'The clock ran out before the flag. Keep the gas down on the flats.' },
	abandoned: { title: 'Run abandoned', text: null },
};

export const MODE_DESCRIPTIONS = {
	journey: '40 stages, easy to wild. Your progress is saved.',
	learn: 'Five short lessons, one control at a time.',
	daily: 'One shared course per day — the same hills for everyone.',
	practice: 'Pick a hill type. Undo is allowed.',
	challenge: 'Special rules: fuel-starved, timed, cliffs, marathon.',
};

// Human labels for each pedal, plus keyboard hints shown on non-touch devices.
export const PEDAL_LABELS = {
	throttle: { label: 'GAS', keys: '↑ / W' },
	brake: { label: 'BRAKE', keys: '↓ / S' },
	tiltL: { label: '◀ TILT', keys: '← / A' },
	tiltR: { label: 'TILT ▶', keys: '→ / D' },
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
	runsPlayed: 0,
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
	canvas.id = 'hw-canvas';
	canvas.setAttribute('aria-label', 'Hillwheel 3D scene');
	canvasWrap.appendChild(canvas);

	const hud = el('div', 'hw-hud hidden');
	const screenLayer = el('div', 'hw-screen-layer');
	const countdownEl = el('div', 'hw-countdown hidden');
	const liveRegion = el('div', 'hw-live sr-only');
	liveRegion.setAttribute('aria-live', 'polite');

	root.append(canvasWrap, hud, screenLayer, countdownEl, liveRegion);

	const ui = {
		canvas, canvasWrap, screenLayer, hud,
		showScreen, buildTitle, buildModeSetup, buildSettings, buildHelp,
		buildPause, buildLeaderboard, buildResults,
		buildHud, showHud, updateHud, updateMirror, showHint, highlightPedal,
		showCountdown, announce, applySettings,
	};

	let pedalHandlers = null;

	function showScreen(name, node) {
		screenLayer.innerHTML = '';
		// The title screen is the only one that shows the key art behind the panel.
		screenLayer.dataset.screen = name || '';
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

	function showCountdown(text, hint) {
		countdownEl.innerHTML = '';
		if (text) countdownEl.appendChild(el('div', 'hw-countdown-main' + (text.length > 3 ? ' hw-countdown-long' : ''), text));
		if (text && hint) countdownEl.appendChild(el('div', 'hw-countdown-hint', hint));
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

	function modeButton(label, desc, onClick) {
		const b = button('', 'hw-btn-mode', onClick);
		b.appendChild(el('span', 'hw-mode-label', label));
		if (desc) b.appendChild(el('span', 'hw-mode-desc', desc));
		return b;
	}

	const SYNC_LABELS = {
		syncing: 'syncing…', saving: 'saving…', synced: 'synced', offline: 'offline', error: 'sync error',
	};

	function buildTitle({ dailyInfo, journeyProgress, firstRun, resumeLabel, touch, profile } = {}) {
		const p = panel(STRINGS.title, STRINGS.tagline);
		p.querySelector('h1').classList.add('hw-title');
		if (profile) {
			p.appendChild(el('p', 'hw-note hw-profile',
				`${profile.name || '…'} · ${SYNC_LABELS[profile.sync] || profile.sync}`));
		}
		const col = el('div', 'hw-btn-col');
		const primary = button(firstRun ? 'Quick play — learn the basics' : `Quick play — ${resumeLabel || 'continue'}`, 'hw-btn-primary', () => onAction('quick-play'));
		col.appendChild(primary);
		const sub = el('p', 'hw-note hw-primary-note', firstRun
			? 'Your first run is a two-minute lesson. Skip it any time from Journey below.'
			: `Journey: ${journeyProgress || ''}`);
		col.appendChild(sub);
		for (const [mode, label] of [
			['journey', 'Journey'],
			['learn', 'Learn'],
			['daily', dailyInfo ? `Daily — ${dailyInfo}` : 'Daily'],
			['practice', 'Practice'],
			['challenge', 'Challenge'],
		]) {
			col.appendChild(modeButton(label, MODE_DESCRIPTIONS[mode], () => onAction('mode', mode)));
		}
		p.appendChild(col);
		p.appendChild(el('p', 'hw-controls-strip', touch
			? 'Controls: on-screen pedals — GAS, BRAKE, and TILT ◀ ▶ for the air.'
			: 'Controls: ↑ gas · ↓ brake · ← → tilt in the air · Esc pause'));
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
		const p = panel(MODE_TITLES[mode] || 'Select',
			ranked ? 'One shared course per day — the same hills for everyone.' : null);
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
		const mkSelect = (label, options, value, onChange) => {
			const f = el('label', 'hw-field');
			f.appendChild(el('span', null, label));
			const sel = document.createElement('select');
			for (const [v, text] of options) {
				const o = document.createElement('option');
				o.value = v; o.textContent = text; o.selected = value === v;
				sel.appendChild(o);
			}
			sel.addEventListener('change', () => onChange(sel.value));
			f.appendChild(sel);
			return f;
		};
		wrap.appendChild(mkSelect('Quality', [['low', 'low'], ['medium', 'medium'], ['high', 'high']],
			s.tier, (v) => onSettings({ tier: v })));
		wrap.appendChild(mkSelect('Colour palette', [
			['default', 'Default'], ['deuteranopia', 'Deuteranopia'],
			['protanopia', 'Protanopia'], ['tritanopia', 'Tritanopia'],
		], s.palette || 'default', (v) => onSettings({ palette: v })));
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
			['Drive', 'Hold ↑ / W or the GAS pedal to accelerate. ↓ / S or BRAKE slows you down. Coast downhill to save fuel.'],
			['Balance', 'Only works in the air: ← / A tilts the nose up, → / D tilts it down. Match the slope you are landing on.'],
			['Crashing', 'Landing nose-first, on the roof, or too hard ends the run. Land on both wheels for a smooth-landing bonus.'],
			['Goal', 'Reach the green flag before the fuel runs out. Yellow flags are checkpoints; yellow cans refill fuel.'],
			['Score', 'Distance, checkpoints, smooth landings, cans, leftover fuel and time all add up.'],
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

	function buildResults({ result, breakdown, won, isDaily, newAchievements, nextLabel, stageName } = {}) {
		const p = panel(won ? 'Finished!' : 'Run over', isDaily ? 'Daily challenge — ranked' : null);
		if (won && stageName) p.appendChild(el('p', 'hw-note', stageName + ' complete'));
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
			const r = END_REASONS[result.terminalReason];
			const box = el('div', 'hw-end-reason');
			box.appendChild(el('strong', null, r ? r.title : String(result.terminalReason).replace(/_/g, ' ')));
			if (r?.text) box.appendChild(el('p', null, r.text));
			p.appendChild(box);
		}
		const row = el('div', 'hw-btn-row');
		if (nextLabel) row.appendChild(button(nextLabel, 'hw-btn-primary', () => onAction('next')));
		row.appendChild(button(won ? 'Restart' : 'Try again', nextLabel ? null : 'hw-btn-primary', () => onAction('restart')));
		row.appendChild(button('Quit to title', 'hw-danger', () => onAction('quit')));
		p.appendChild(row);
		return p;
	}

	// --- HUD -----------------------------------------------------------------

	let hudEls = null;

	function buildHud({ leftHanded, onPedal, onPause, showKeys, checkpoints = [], goalX = 1 } = {}) {
		pedalHandlers = onPedal;
		hud.innerHTML = '';
		const top = el('div', 'hw-hud-top');
		const pauseBtn = button('❚❚', 'hw-btn-icon hw-btn-small', () => onPause && onPause());
		pauseBtn.setAttribute('aria-label', 'Pause');

		// Course progress: a track from start to the green flag with checkpoint ticks.
		const objective = el('div', 'hw-hud-objective');
		const objText = el('div', 'hw-hud-objective-text', '');
		const track = el('div', 'hw-hud-track');
		for (const cx of checkpoints) {
			const tick = el('div', 'hw-hud-tick');
			tick.style.left = (100 * cx / goalX) + '%';
			track.appendChild(tick);
		}
		const goalTick = el('div', 'hw-hud-tick hw-hud-tick-goal');
		goalTick.style.left = '100%';
		const marker = el('div', 'hw-hud-marker');
		track.append(goalTick, marker);
		objective.append(objText, track);

		const mirror = el('div', 'hw-note hw-hud-mirror', '');
		const fuelWrap = el('div', 'hw-hud-fuel-wrap');
		fuelWrap.appendChild(el('span', 'hw-hud-label', 'FUEL'));
		const fuel = el('div', 'hw-hud-fuel');
		fuel.setAttribute('role', 'progressbar');
		fuel.setAttribute('aria-label', 'Fuel');
		const fuelBar = el('div', 'hw-hud-fuel-bar');
		fuel.appendChild(fuelBar);
		fuelWrap.appendChild(fuel);
		const scoreWrap = el('div', 'hw-hud-score-wrap');
		scoreWrap.appendChild(el('span', 'hw-hud-label', 'SCORE'));
		const score = el('div', 'hw-hud-score', '0');
		scoreWrap.appendChild(score);
		top.append(pauseBtn, objective, mirror, fuelWrap, scoreWrap);

		// Coaching banner: one short line telling the player the next useful action.
		const hint = el('div', 'hw-hud-hint hidden');

		const tray = el('div', 'hw-hud-tray');
		const mkPedal = (key) => {
			const b = el('button', 'hw-pedal');
			b.type = 'button';
			b.id = 'hw-pedal-' + key;
			b.appendChild(el('span', 'hw-pedal-label', PEDAL_LABELS[key].label));
			if (showKeys) b.appendChild(el('span', 'hw-pedal-keys', PEDAL_LABELS[key].keys));
			b.setAttribute('aria-label', PEDAL_LABELS[key].label.replace(/[◀▶] ?/g, '').trim());
			const down = (e) => { e.preventDefault(); b.classList.add('active'); onPedal && onPedal(key, true); };
			const up = () => { b.classList.remove('active'); onPedal && onPedal(key, false); };
			b.addEventListener('pointerdown', down);
			b.addEventListener('pointerup', up);
			b.addEventListener('pointercancel', up);
			b.addEventListener('pointerleave', up);
			b.addEventListener('contextmenu', (e) => e.preventDefault());
			return b;
		};
		const pedals = { tiltL: mkPedal('tiltL'), brake: mkPedal('brake'), throttle: mkPedal('throttle'), tiltR: mkPedal('tiltR') };
		const left = [pedals.tiltL, pedals.brake];
		const right = [pedals.throttle, pedals.tiltR];
		const order = leftHanded ? [...right, ...left] : [...left, ...right];
		const leftGroup = el('div', 'hw-btn-row');
		const rightGroup = el('div', 'hw-btn-row');
		leftGroup.style.marginTop = '0'; rightGroup.style.marginTop = '0';
		order.slice(0, 2).forEach((b) => leftGroup.appendChild(b));
		order.slice(2).forEach((b) => rightGroup.appendChild(b));
		tray.append(leftGroup, rightGroup);

		hud.append(top, hint, tray);
		hudEls = { objText, marker, mirror, fuelBar, score, hint, pedals, hintTimer: 0, lastObj: '' };
	}

	// Show a coaching line in the HUD. `ms` auto-hides it; 0 keeps it until replaced or cleared.
	function showHint(text, ms = 0) {
		if (!hudEls) return;
		clearTimeout(hudEls.hintTimer);
		hudEls.hint.textContent = text || '';
		hudEls.hint.classList.toggle('hidden', !text);
		if (text && ms > 0) hudEls.hintTimer = setTimeout(() => showHint(null), ms);
	}

	// Pulse one pedal so a lesson can point at the control it teaches.
	function highlightPedal(key) {
		if (!hudEls) return;
		for (const k of Object.keys(hudEls.pedals)) hudEls.pedals[k].classList.toggle('hint', k === key);
	}

	function updateHud(state, breakdown, goalX) {
		if (!hudEls) return;
		const x = Math.max(0, Math.floor(state.vehicle.x));
		const left = Math.max(0, Math.ceil(goalX - x));
		const obj = `${left} m to the flag · ⚑ ${state.nextCheckpoint}/${state.checkpoints.length}`;
		if (obj !== hudEls.lastObj) { hudEls.objText.textContent = obj; hudEls.lastObj = obj; }
		hudEls.marker.style.left = Math.min(100, 100 * x / goalX) + '%';
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
