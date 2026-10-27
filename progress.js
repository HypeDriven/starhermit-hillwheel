// Hillwheel progress document: its defaults, normalisation, the two-device
// merge, and reading the browser build's cloud save. Pure (no engine, no
// DOM) so node tests check it and native/platform.ts uses it unchanged.
//
// The progress document is what the game saves (one per player):
//   { stagesCompleted: { stageId: best total }, tutorialDone: [lessonId],
//     achievements: [key], lastStage, totalDistance, runsPlayed,
//     dailyBest: { 'daily-YYYY-MM-DD': best total } }
// The browser build (game.js _saveDoc) kept it in its cloud slot as
//   { schemaVersion: 1, savedAt, progress, settings }
// and its settings there (and in the account's settings KV) carried the
// game's own options: leftHanded, holdToDrive, palette, telemetryConsent.

export const DEFAULT_PROGRESS = {
	stagesCompleted: {},
	tutorialDone: [],
	achievements: [],
	lastStage: 0,
	totalDistance: 0,
	runsPlayed: 0,
	dailyBest: {},
};

export const PALETTES = ['default', 'deuteranopia', 'protanopia', 'tritanopia'];
export const DEFAULT_SETTINGS = { leftHanded: false, holdToDrive: true, palette: 'default', telemetryConsent: false };

const num = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : 0);
const scores = (o) => {
	const out = {};
	if (o && typeof o === 'object' && !Array.isArray(o)) {
		for (const [k, v] of Object.entries(o)) if (typeof k === 'string' && Number.isFinite(Number(v))) out[k] = Math.max(0, Math.floor(Number(v)));
	}
	return out;
};
const ids = (a) => (Array.isArray(a) ? [...new Set(a.filter((x) => typeof x === 'string'))] : []);

/** A progress document from anything (a save, an old cloud doc's `progress`), with every field valid. */
export function normalize(raw) {
	const r = raw && typeof raw === 'object' ? raw : {};
	return {
		stagesCompleted: scores(r.stagesCompleted),
		tutorialDone: ids(r.tutorialDone),
		achievements: ids(r.achievements),
		lastStage: Math.min(39, Math.floor(num(r.lastStage))),
		totalDistance: Math.floor(num(r.totalDistance)),
		runsPlayed: Math.floor(num(r.runsPlayed)),
		dailyBest: scores(r.dailyBest),
	};
}

/** Two devices' progress: the higher score per completed stage and per Daily, the union of lessons and
 * achievements, the furthest stage, the larger distance and run counts (the browser build's
 * saveconflict merge, made symmetric). */
export function merge(a, b) {
	const x = normalize(a), y = normalize(b);
	const best = (p, q) => {
		const out = { ...p };
		for (const [k, v] of Object.entries(q)) out[k] = Math.max(out[k] ?? 0, v);
		return out;
	};
	return {
		stagesCompleted: best(x.stagesCompleted, y.stagesCompleted),
		tutorialDone: [...new Set([...x.tutorialDone, ...y.tutorialDone])],
		achievements: [...new Set([...x.achievements, ...y.achievements])],
		lastStage: Math.max(x.lastStage, y.lastStage),
		totalDistance: Math.max(x.totalDistance, y.totalDistance),
		runsPlayed: Math.max(x.runsPlayed, y.runsPlayed),
		dailyBest: best(x.dailyBest, y.dailyBest),
	};
}

/** The game's own options from an old settings object (cloud doc or settings KV): only valid values. */
export function pickSettings(raw) {
	const out = {};
	if (!raw || typeof raw !== 'object') return out;
	for (const k of ['leftHanded', 'holdToDrive', 'telemetryConsent']) if (typeof raw[k] === 'boolean') out[k] = raw[k];
	if (PALETTES.includes(raw.palette)) out.palette = raw.palette;
	return out;
}

/** The browser build's cloud save text → { progress, settings }, or null when it is not one. */
export function readForeign(text) {
	let doc;
	try { doc = typeof text === 'string' ? JSON.parse(text) : text; } catch { return null; }
	if (!doc || typeof doc !== 'object' || !doc.progress || typeof doc.progress !== 'object') return null;
	return { progress: normalize(doc.progress), settings: pickSettings(doc.settings) };
}
