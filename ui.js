// Hillwheel UI layer: DOM shell, screens, HUD, settings/progress persistence.
// Pure DOM — no three.js here; the 3D scene lives in render.js on the canvas.

import { PRESETS, CATEGORIES, presetTier, resolve, choosePreset, clampScale } from './gfx.js';
import { gfxStrings, pickLocale } from './gfx-i18n.js';
import { T, L, bindText, relabel, currentLang, text as msgText } from './i18n.js';

// Keyboard bindings: defaults mirror the control.* lines in starhermit.txt;
// game.js swaps in the player's StarHermit overrides via setBindings().
export const DEFAULT_BINDINGS = {
	throttle: ['ArrowUp', 'KeyW'], brake: ['ArrowDown', 'KeyS'],
	tiltL: ['ArrowLeft', 'KeyA'], tiltR: ['ArrowRight', 'KeyD'],
	pause: ['Escape', 'KeyP'], undo: ['KeyU'], recenter: ['KeyC'],
};
let BINDINGS = structuredClone(DEFAULT_BINDINGS);
export function setBindings(b) { BINDINGS = structuredClone(b); }
const KEY_GLYPHS = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Escape: 'Esc' };
/** Effective keys for an action, e.g. "↑ / W". */
export function keysFor(action, sep = ' / ') {
	return (BINDINGS[action] || []).map((c) => (c === 'Space' ? T('Space') : KEY_GLYPHS[c] || c.replace(/^Key/, '').replace(/^Digit/, ''))).join(sep);
}

// StarHermit account strings (sign-in, invite link, toasts) in the nine locales.
const SH_ALL = {
 "en-US": {
  "signIn": "Sign in with StarHermit",
  "invite": "Invite a friend",
  "copied": "Invite link copied to clipboard.",
  "copyFailed": "Could not copy the invite link: {link}",
  "signedOut": "Signed out of StarHermit. Progress keeps saving on this device.",
  "lbPosting": "Posting score to the leaderboard…",
  "lbRank": "Leaderboard rank: #{rank}",
  "lbPosted": "Score posted to the leaderboard.",
  "lbNotPosted": "Score not posted to the leaderboard."
 },
 "en-GB": {
  "signIn": "Sign in with StarHermit",
  "invite": "Invite a friend",
  "copied": "Invite link copied to clipboard.",
  "copyFailed": "Could not copy the invite link: {link}",
  "signedOut": "Signed out of StarHermit. Progress keeps saving on this device.",
  "lbPosting": "Posting score to the leaderboard…",
  "lbRank": "Leaderboard rank: #{rank}",
  "lbPosted": "Score posted to the leaderboard.",
  "lbNotPosted": "Score not posted to the leaderboard."
 },
 "es-419": {
  "signIn": "Iniciar sesión con StarHermit",
  "invite": "Invitar a un amigo",
  "copied": "Enlace de invitación copiado al portapapeles.",
  "copyFailed": "No se pudo copiar el enlace de invitación: {link}",
  "signedOut": "Sesión de StarHermit cerrada. El progreso se sigue guardando en este dispositivo.",
  "lbPosting": "Enviando la puntuación a la clasificación…",
  "lbRank": "Puesto en la clasificación: #{rank}",
  "lbPosted": "Puntuación enviada a la clasificación.",
  "lbNotPosted": "No se envió la puntuación a la clasificación."
 },
 "es-ES": {
  "signIn": "Iniciar sesión con StarHermit",
  "invite": "Invitar a un amigo",
  "copied": "Enlace de invitación copiado al portapapeles.",
  "copyFailed": "No se ha podido copiar el enlace de invitación: {link}",
  "signedOut": "Se ha cerrado la sesión de StarHermit. El progreso se sigue guardando en este dispositivo.",
  "lbPosting": "Enviando la puntuación a la clasificación…",
  "lbRank": "Puesto en la clasificación: #{rank}",
  "lbPosted": "Puntuación enviada a la clasificación.",
  "lbNotPosted": "No se ha enviado la puntuación a la clasificación."
 },
 "de-DE": {
  "signIn": "Mit StarHermit anmelden",
  "invite": "Freund einladen",
  "copied": "Einladungslink in die Zwischenablage kopiert.",
  "copyFailed": "Einladungslink konnte nicht kopiert werden: {link}",
  "signedOut": "Von StarHermit abgemeldet. Der Fortschritt wird weiter auf diesem Gerät gespeichert.",
  "lbPosting": "Punktzahl wird an die Bestenliste gesendet …",
  "lbRank": "Platz in der Bestenliste: #{rank}",
  "lbPosted": "Punktzahl an die Bestenliste gesendet.",
  "lbNotPosted": "Punktzahl nicht an die Bestenliste gesendet."
 },
 "fr-FR": {
  "signIn": "Se connecter avec StarHermit",
  "invite": "Inviter un ami",
  "copied": "Lien d’invitation copié dans le presse-papiers.",
  "copyFailed": "Impossible de copier le lien d’invitation : {link}",
  "signedOut": "Déconnecté de StarHermit. La progression reste enregistrée sur cet appareil.",
  "lbPosting": "Envoi du score au classement…",
  "lbRank": "Rang au classement : #{rank}",
  "lbPosted": "Score envoyé au classement.",
  "lbNotPosted": "Score non envoyé au classement."
 },
 "fr-CA": {
  "signIn": "Se connecter avec StarHermit",
  "invite": "Inviter un ami",
  "copied": "Lien d’invitation copié dans le presse-papiers.",
  "copyFailed": "Impossible de copier le lien d’invitation : {link}",
  "signedOut": "Déconnecté de StarHermit. La progression reste enregistrée sur cet appareil.",
  "lbPosting": "Envoi du pointage au classement…",
  "lbRank": "Rang au classement : #{rank}",
  "lbPosted": "Pointage envoyé au classement.",
  "lbNotPosted": "Pointage non envoyé au classement."
 },
 "pt-BR": {
  "signIn": "Entrar com StarHermit",
  "invite": "Convidar um amigo",
  "copied": "Link de convite copiado para a área de transferência.",
  "copyFailed": "Não foi possível copiar o link de convite: {link}",
  "signedOut": "Você saiu do StarHermit. O progresso continua salvo neste dispositivo.",
  "lbPosting": "Enviando a pontuação para o ranking…",
  "lbRank": "Posição no ranking: #{rank}",
  "lbPosted": "Pontuação enviada para o ranking.",
  "lbNotPosted": "A pontuação não foi enviada para o ranking."
 },
 "it-IT": {
  "signIn": "Accedi con StarHermit",
  "invite": "Invita un amico",
  "copied": "Link di invito copiato negli appunti.",
  "copyFailed": "Impossibile copiare il link di invito: {link}",
  "signedOut": "Disconnesso da StarHermit. I progressi restano salvati su questo dispositivo.",
  "lbPosting": "Invio del punteggio alla classifica…",
  "lbRank": "Posizione in classifica: #{rank}",
  "lbPosted": "Punteggio inviato alla classifica.",
  "lbNotPosted": "Punteggio non inviato alla classifica."
 }
};
// Read at use time: follows the game language (Settings → Language).
export const SH_TEXT = new Proxy({}, { get: (_, k) => (SH_ALL[currentLang()] || SH_ALL['en-US'])[k] });

// Deferred messages (functions): nodes built from them follow language changes.
export const STRINGS = {
	title: 'Hillwheel',
	tagline: L('Hold the gas to climb, tilt in the air, land on both wheels. Reach the green flag before the fuel runs out.'),
	next: L('Next stage'),
	nextLesson: L('Next lesson'),
	startJourney: L('Start the Journey'),
	back: L('← Back'),
};

// Plain-language explanations of how a run ended, with the one thing to try next.
export const END_REASONS = {
	crashed: { title: L('Crashed'), text: L('You landed nose-first or too hard. In the air, tilt to match the slope you are about to land on.') },
	out_of_fuel: { title: L('Out of fuel'), text: L('The tank ran dry. Ease off the gas on descents and grab the yellow fuel cans.') },
	timeout: { title: L('Out of time'), text: L('The clock ran out before the flag. Keep the gas down on the flats.') },
	abandoned: { title: L('Run abandoned'), text: null },
};

export const MODE_DESCRIPTIONS = {
	journey: L('40 stages, easy to wild. Your progress is saved.'),
	learn: L('Five short lessons, one control at a time.'),
	daily: L('One shared course per day — the same hills for everyone.'),
	practice: L('Pick a hill type. Undo is allowed.'),
	challenge: L('Special rules: fuel-starved, timed, cliffs, marathon.'),
};

// Human labels for each pedal, plus keyboard hints shown on non-touch devices.
export const PEDAL_LABELS = {
	throttle: { label: L('GAS'), aria: L('Gas'), get keys() { return keysFor('throttle'); } },
	brake: { label: L('BRAKE'), aria: L('Brake'), get keys() { return keysFor('brake'); } },
	tiltL: { label: () => '◀ ' + T('TILT'), aria: L('Tilt back'), get keys() { return keysFor('tiltL'); } },
	tiltR: { label: () => T('TILT') + ' ▶', aria: L('Tilt forward'), get keys() { return keysFor('tiltR'); } },
};

const SETTINGS_KEY = 'hillwheel-settings-v1';
const PROGRESS_KEY = 'hillwheel-progress-v1';

const DEFAULT_SETTINGS = {
	volumes: { music: 70, sfx: 80, ambience: 60, voice: 80 },
	graphics: {}, // gfx.js saved form; {} = Auto
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

// Text may be a string or a deferred message (function): messages follow the language.
function el(tag, className, text) {
	const n = document.createElement(tag);
	if (className) n.className = className;
	if (text !== undefined) bindText(n, text);
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
	bindText(canvas, L('Hillwheel 3D scene'), 'aria-label');
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
		showCountdown, announce, applySettings, toast,
	};

	let pedalHandlers = null;

	// Language change: bound text re-renders itself; refresh what is computed.
	document.addEventListener('hw-language', () => {
		relabel();
		if (hudEls) { hudEls.lastObj = ''; }
	});

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
		setTimeout(() => { liveRegion.textContent = typeof text === 'function' ? text() : text; }, 30);
	}

	function showCountdown(text, hint) {
		countdownEl.innerHTML = '';
		if (text) countdownEl.appendChild(el('div', 'hw-countdown-main' + (String(typeof text === 'function' ? text() : text).length > 3 ? ' hw-countdown-long' : ''), text));
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
		syncing: L('syncing…'), saving: L('saving…'), synced: L('synced'), offline: L('offline'), error: L('sync error'),
	};

	function buildTitle({ dailyInfo, journeyProgress, firstRun, resumeLabel, touch, profile, account } = {}) {
		const p = panel(STRINGS.title, STRINGS.tagline);
		p.querySelector('h1').classList.add('hw-title');
		if (profile) {
			const line = el('p', 'hw-note hw-profile');
			if (profile.avatar) {
				const img = el('img', 'hw-avatar');
				img.src = profile.avatar;
				img.alt = '';
				line.appendChild(img);
			}
			line.appendChild(el('span', null, () => `${profile.name || '…'} · ${SYNC_LABELS[profile.sync] ? SYNC_LABELS[profile.sync]() : profile.sync}`));
			p.appendChild(line);
		}
		const col = el('div', 'hw-btn-col');
		const primary = button(firstRun ? L('Quick play — learn the basics') : L('Quick play — {stage}', { stage: resumeLabel || L('continue') }), 'hw-btn-primary', () => onAction('quick-play'));
		col.appendChild(primary);
		const sub = el('p', 'hw-note hw-primary-note', firstRun
			? L('Your first run is a two-minute lesson. Skip it any time from Journey below.')
			: L('Journey: {progress}', { progress: journeyProgress || '' }));
		col.appendChild(sub);
		for (const [mode, label] of [
			['journey', L('Journey')],
			['learn', L('Learn')],
			['daily', dailyInfo ? L('Daily — {date}', { date: dailyInfo }) : L('Daily')],
			['practice', L('Practice')],
			['challenge', L('Challenge')],
		]) {
			col.appendChild(modeButton(label, MODE_DESCRIPTIONS[mode], () => onAction('mode', mode)));
		}
		p.appendChild(col);
		p.appendChild(el('p', 'hw-controls-strip', touch
			? L('Controls: on-screen pedals — GAS, BRAKE, and TILT ◀ ▶ for the air.')
			: () => T('Controls: {gas} gas · {brake} brake · {tiltL} {tiltR} tilt in the air · {pause} pause', { gas: keysFor('throttle', '/'), brake: keysFor('brake', '/'), tiltL: keysFor('tiltL', '/'), tiltR: keysFor('tiltR', '/'), pause: keysFor('pause', '/') })));
		const row = el('div', 'hw-btn-row');
		row.appendChild(button(L('Leaderboards'), 'hw-btn-small', () => onAction('leaderboard')));
		row.appendChild(button(L('Settings'), 'hw-btn-small', () => onAction('settings')));
		row.appendChild(button(L('How to play'), 'hw-btn-small', () => onAction('help')));
		if (account?.invite) {
			const b = button(() => SH_TEXT.invite, 'hw-btn-small', () => onAction('invite'));
			b.id = 'hw-invite';
			row.appendChild(b);
		}
		if (account?.signIn) {
			const b = button(() => SH_TEXT.signIn, 'hw-btn-small', () => onAction('sign-in'));
			b.id = 'hw-signin';
			row.appendChild(b);
		}
		p.appendChild(row);
		return p;
	}

	// Account toast (invite link copied, signed out) — visible over any screen.
	const toastEl = el('div', 'hw-toast');
	toastEl.setAttribute('role', 'status');
	toastEl.hidden = true;
	root.appendChild(toastEl);
	let toastTimer = 0;
	function toast(msg) {
		bindText(toastEl, msg);
		toastEl.hidden = false;
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => { toastEl.hidden = true; }, 3500);
	}

	const MODE_TITLES = {
		journey: L('Journey'), learn: L('Learn'), daily: L('Daily challenge'),
		practice: L('Practice'), challenge: L('Challenge'),
	};

	function buildModeSetup({ mode, levels = [], ranked, onPick } = {}) {
		const p = panel(MODE_TITLES[mode] || L('Select'),
			ranked ? L('One shared course per day — the same hills for everyone.') : null);
		const list = el('div', 'hw-level-list');
		levels.forEach((lv, i) => {
			const b = button(lv.locked ? () => T('{label} 🔒', { label: lv.label }) : lv.label, lv.done ? 'done' : null, () => onPick(i));
			if (lv.locked) { b.disabled = true; }
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
		wrap.appendChild(mkCheck(L('Mute all'), s.muted, (v) => onSettings({ muted: v })));
		const BUS_LABELS = { music: L('Music'), sfx: L('Sfx'), ambience: L('Ambience'), voice: L('Voice') };
		for (const bus of ['music', 'sfx', 'ambience', 'voice']) {
			wrap.appendChild(mkRange(BUS_LABELS[bus], s.volumes?.[bus], (v) => onSettings({ volumes: { ...s.volumes, [bus]: v } })));
		}
		const mkSelect = (label, options, value, onChange) => {
			const f = el('label', 'hw-field');
			f.appendChild(el('span', null, label));
			const sel = document.createElement('select');
			for (const [v, text] of options) {
				const o = document.createElement('option');
				o.value = v; bindText(o, text); o.selected = value === v;
				sel.appendChild(o);
			}
			sel.addEventListener('change', () => onChange(sel.value));
			f.appendChild(sel);
			return f;
		};
		wrap.appendChild(mkSelect(L('Colour palette'), [
			['default', L('Default')], ['deuteranopia', L('Deuteranopia')],
			['protanopia', L('Protanopia')], ['tritanopia', L('Tritanopia')],
		], s.palette || 'default', (v) => onSettings({ palette: v })));
		wrap.appendChild(mkCheck(L('Reduced motion'), s.reducedMotion, (v) => onSettings({ reducedMotion: v })));
		wrap.appendChild(mkCheck(L('Left-handed pedals'), s.leftHanded, (v) => onSettings({ leftHanded: v })));
		wrap.appendChild(mkCheck(L('Hold to drive (off = toggle)'), s.holdToDrive !== false, (v) => onSettings({ holdToDrive: v })));
		wrap.appendChild(mkCheck(L('Larger text'), s.largeText, (v) => onSettings({ largeText: v })));
		wrap.appendChild(mkCheck(L('High contrast'), s.highContrast, (v) => onSettings({ highContrast: v })));
		wrap.appendChild(mkCheck(L('Share anonymous telemetry'), s.telemetryConsent, (v) => onSettings({ telemetryConsent: v })));
		return wrap;
	}

	// Graphics section: quality preset, render scale, per-effect overrides, adaptive resolution,
	// frame-rate readout and a cost summary. Changes apply live and re-render only this section.
	function graphicsSection(gfx) {
		let t = gfxStrings([currentLang()]);
		const sec = el('section', 'hw-gfx');
		sec.id = 'hw-gfx';
		sec.setAttribute('aria-labelledby', 'hw-gfx-title');
		let timer = 0;
		const update = (next) => {
			gfx.set(next);
			draw();
			// Pixel size and post status settle after the next frame.
			requestAnimationFrame(() => requestAnimationFrame(() => sec.isConnected && drawSummary()));
		};
		const summaryEl = el('p', 'hw-note hw-gfx-summary');
		summaryEl.id = 'hw-gfx-summary';
		summaryEl.setAttribute('aria-live', 'polite');
		const noteEl = el('p', 'hw-note hw-gfx-note', () => t.postUnavailable);
		noteEl.id = 'hw-gfx-post-note';
		const drawSummary = () => {
			const info = gfx.info(t.words);
			if (!info) { summaryEl.textContent = ''; noteEl.hidden = true; return; }
			summaryEl.textContent = [info.gpu || t.unknownGpu, info.level != null ? t.level.replace('{n}', info.level) : null, info.summary].filter(Boolean).join(' · ');
			noteEl.hidden = !info.postFailed;
			sec.dataset.gfxPreset = info.resolved.preset;
		};
		const field = (labelText, control, id) => {
			const f = el('label', 'hw-field');
			f.htmlFor = id;
			f.appendChild(el('span', null, labelText));
			control.id = id;
			f.appendChild(control);
			return f;
		};
		const select = (options, value, onChange) => {
			const sel = document.createElement('select');
			for (const [v, text] of options) {
				const o = document.createElement('option');
				o.value = v; o.textContent = text; o.selected = value === v;
				sel.appendChild(o);
			}
			sel.addEventListener('change', () => onChange(sel.value));
			return sel;
		};
		const check = (labelText, checked, id, onChange) => {
			const f = el('label', 'hw-field hw-check');
			const input = document.createElement('input');
			input.type = 'checkbox'; input.checked = !!checked; input.id = id;
			input.addEventListener('change', () => onChange(input.checked));
			f.append(input, el('span', null, labelText));
			return f;
		};
		// This game's rows live in their own box: redrawing it (preset change,
		// language change) leaves the shared Sound / frame-rate / Language / Report
		// sections that game-options.js mounts in this section in place.
		const box = el('div', 'hw-gfx-box');
		sec.appendChild(box);
		function draw() {
			t = gfxStrings([currentLang()]);
			const focusId = box.contains(document.activeElement) ? document.activeElement.id : null;
			box.innerHTML = '';
			const saved = gfx.get();
			const info = gfx.info(t.words);
			const detected = info?.detected || 'balanced';
			const r = resolve(saved, detected, info?.level);
			const h = el('h2', 'hw-gfx-title', t.graphics);
			h.id = 'hw-gfx-title';
			box.appendChild(h);

			const presetSel = select([
				['auto', t.auto.replace('{tier}', t.tier[detected])],
				...PRESETS.map((pr) => [pr, t.tier[pr]]),
			], PRESETS.includes(saved.preset) ? saved.preset : 'auto', (v) => update(choosePreset(gfx.get(), v)));
			presetSel.dataset.gfx = 'preset';
			box.appendChild(field(t.quality, presetSel, 'hw-gfx-preset'));

			const scaleWrap = el('span', 'hw-gfx-range');
			const range = document.createElement('input');
			range.type = 'range'; range.min = '50'; range.max = '200'; range.step = '5';
			range.value = String(Math.round(clampScale(saved.render_scale) * 100));
			range.dataset.gfx = 'render_scale';
			const out = el('output', 'hw-gfx-value', range.value + '%');
			range.addEventListener('input', () => { out.textContent = range.value + '%'; });
			range.addEventListener('change', () => update({ ...gfx.get(), render_scale: Number(range.value) / 100 }));
			const scaleField = field(t.renderScale, range, 'hw-gfx-scale');
			scaleField.replaceChild(scaleWrap, range);
			scaleWrap.append(range, out);
			box.appendChild(scaleField);

			for (const [cat, tiers] of Object.entries(CATEGORIES)) {
				const cur = tiers.includes(saved[cat]) ? saved[cat] : 'preset';
				const sel = select([
					['preset', t.fromPreset.replace('{tier}', t.tier[presetTier(r.preset, cat)])],
					...tiers.map((tier) => [tier, t.tier[tier]]),
				], cur, (v) => {
					const next = gfx.get();
					if (v === 'preset') delete next[cat]; else next[cat] = v;
					update(next);
				});
				sel.dataset.gfxCat = cat;
				box.appendChild(field(t.cat[cat], sel, 'hw-gfx-' + cat));
			}
			box.appendChild(check(t.adaptive, saved.adaptive !== false, 'hw-gfx-adaptive', (v) => update({ ...gfx.get(), adaptive: v })));
			box.appendChild(check(t.showFps, !!saved.show_fps, 'hw-gfx-fps', (v) => update({ ...gfx.get(), show_fps: v })));
			box.append(summaryEl, noteEl);
			drawSummary();
			if (focusId) document.getElementById(focusId)?.focus();
		}
		draw();
		clearInterval(timer);
		timer = setInterval(() => { if (!sec.isConnected) clearInterval(timer); else drawSummary(); }, 1000);
		const onLanguage = () => { if (!sec.isConnected) document.removeEventListener('hw-language', onLanguage); else draw(); };
		document.addEventListener('hw-language', onLanguage);
		return sec;
	}

	function buildSettings({ settings: s, onSettings, gfx } = {}) {
		const p = panel(L('Settings'));
		p.appendChild(settingsForm(s, onSettings));
		if (gfx) p.appendChild(graphicsSection(gfx));
		p.appendChild(button(STRINGS.back, 'hw-btn-small', () => onAction('back-title')));
		return p;
	}

	function buildHelp() {
		const p = panel(L('How to play'));
		const grid = el('div', 'hw-help-grid');
		const or = () => ' ' + T('or') + ' ';
		for (const [h, t] of [
			[L('Drive'), () => T('Hold {gas} or the GAS pedal to accelerate. {brake} or BRAKE slows you down. Coast downhill to save fuel.', { gas: keysFor('throttle'), brake: keysFor('brake') })],
			[L('Balance'), () => T('Only works in the air: {tiltL} tilts the nose up, {tiltR} tilts it down. Match the slope you are landing on.', { tiltL: keysFor('tiltL'), tiltR: keysFor('tiltR') })],
			[L('Crashing'), L('Landing nose-first, on the roof, or too hard ends the run. Land on both wheels for a smooth-landing bonus.')],
			[L('Goal'), L('Reach the green flag before the fuel runs out. Yellow flags are checkpoints; yellow cans refill fuel.')],
			[L('Score'), L('Distance, checkpoints, smooth landings, cans, leftover fuel and time all add up.')],
			[L('Pause'), () => T('{pause} pauses. Practice mode allows undo with {undo}. {recenter} re-centres the camera.', { pause: keysFor('pause', or()), undo: keysFor('undo', or()), recenter: keysFor('recenter', or()) })],
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

	function buildPause({ settings: s, canUndo, onSettings, gfx } = {}) {
		const p = panel(L('Paused'));
		const col = el('div', 'hw-btn-col');
		col.appendChild(button(L('Resume'), 'hw-btn-primary', () => onAction('resume')));
		col.appendChild(button(L('Restart'), null, () => onAction('restart')));
		if (canUndo) col.appendChild(button(L('Undo'), null, () => onAction('undo')));
		col.appendChild(button(L('Quit to title'), 'hw-danger', () => onAction('quit')));
		p.appendChild(col);
		p.appendChild(settingsForm(s, onSettings));
		if (gfx) p.appendChild(graphicsSection(gfx));
		return p;
	}

	function buildLeaderboard({ loading, entries, error } = {}) {
		const p = panel(L('Leaderboards'));
		if (loading) {
			p.appendChild(el('p', 'hw-note', L('Loading…')));
		} else if (error || !entries) {
			p.appendChild(el('p', 'hw-note', L('Leaderboard is unavailable right now.')));
		} else if (!entries.length) {
			p.appendChild(el('p', 'hw-note', L('No scores yet — be the first.')));
		} else {
			const ol = el('ol', 'hw-board');
			entries.slice(0, 20).forEach((e2) => {
				ol.appendChild(el('li', null, () => `${e2.name ? msgText(e2.name) : e2.player || T('player')} — ${e2.score ?? e2.total ?? 0}`));
			});
			p.appendChild(ol);
		}
		p.appendChild(button(STRINGS.back, 'hw-btn-small', () => onAction('back-title')));
		return p;
	}

	function buildResults({ result, breakdown, won, isDaily, newAchievements, nextLabel, stageName } = {}) {
		const p = panel(won ? L('Finished!') : L('Run over'), isDaily ? L('Daily challenge') : null);
		if (won && stageName) p.appendChild(el('p', 'hw-note', L('{stage} complete', { stage: stageName })));
		const table = el('dl', 'hw-score-table');
		const rows = [
			[L('Distance'), breakdown?.distance],
			[L('Checkpoints'), breakdown?.checkpointBonus],
			[L('Finish bonus'), breakdown?.finishBonus],
			[L('Smooth landings'), breakdown?.landingBonus],
			[L('Fuel cans'), breakdown?.canBonus],
			[L('Fuel bonus'), breakdown?.fuelBonus],
			[L('Time bonus'), breakdown?.timeBonus],
		];
		for (const [k, v] of rows) {
			if (v === undefined) continue;
			table.appendChild(el('dt', null, k));
			table.appendChild(el('dd', null, String(v)));
		}
		table.appendChild(el('dt', 'hw-total', L('Total')));
		table.appendChild(el('dd', 'hw-total', String(breakdown?.total ?? 0)));
		p.appendChild(table);
		if (newAchievements && newAchievements.length) {
			p.appendChild(el('p', 'hw-achievements', () => T('Achievements: {names}', { names: newAchievements.map(msgText).join(', ') })));
		}
		// Leaderboard line (signed-in runs only; game.js fills it in).
		const lb = el('p', 'hw-note hw-results-lb', '');
		lb.hidden = true;
		p.appendChild(lb);
		if (!won && result?.terminalReason) {
			const r = END_REASONS[result.terminalReason];
			const box = el('div', 'hw-end-reason');
			box.appendChild(el('strong', null, r ? r.title : String(result.terminalReason).replace(/_/g, ' ')));   // r.* are messages
			if (r?.text) box.appendChild(el('p', null, r.text));
			p.appendChild(box);
		}
		const row = el('div', 'hw-btn-row');
		if (nextLabel) row.appendChild(button(nextLabel, 'hw-btn-primary', () => onAction('next')));
		row.appendChild(button(won ? L('Restart') : L('Try again'), nextLabel ? null : 'hw-btn-primary', () => onAction('restart')));
		row.appendChild(button(L('Quit to title'), 'hw-danger', () => onAction('quit')));
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
		bindText(pauseBtn, L('Pause'), 'aria-label');

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
		fuelWrap.appendChild(el('span', 'hw-hud-label', L('FUEL')));
		const fuel = el('div', 'hw-hud-fuel');
		fuel.setAttribute('role', 'progressbar');
		bindText(fuel, L('Fuel'), 'aria-label');
		const fuelBar = el('div', 'hw-hud-fuel-bar');
		fuel.appendChild(fuelBar);
		fuelWrap.appendChild(fuel);
		const scoreWrap = el('div', 'hw-hud-score-wrap');
		scoreWrap.appendChild(el('span', 'hw-hud-label', L('SCORE')));
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
			bindText(b, PEDAL_LABELS[key].aria, 'aria-label');
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
		bindText(hudEls.hint, text || '');
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
		const obj = T('{m} m to the flag · ⚑ {cp}/{total}', { m: left, cp: state.nextCheckpoint, total: state.checkpoints.length });
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
		hudEls.mirror.textContent = T('{kmh} km/h · cans {n}', { kmh, n: state.cansCollected });
	}

	applySettings(settings || {});
	return ui;
}
