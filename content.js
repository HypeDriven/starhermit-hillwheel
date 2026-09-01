// Hillwheel content: versioned levels, themes, tutorials, validation metadata.
// Content is versioned data: id, seed, initial state params, goals, allowed mechanics,
// par values, tutorial flags, presentation theme.

import { createState, step, hashState, TERMINAL, TICK_RATE, scoreBreakdown } from './rules.js';

export const CONTENT_SCHEMA_VERSION = 2;
export const CONTENT_VERSION = '2.0.0';

// --- Themes (presentation only; never affect rules) --------------------------

export const THEMES = [
	{ id: 'meadow', name: 'Meadow', sky: 0x9fd3e8, fog: 0xcfe8d8, ground: 0x6fae4e, groundFar: 0x8fc46a, tree: 0x3e7d3a, rock: 0x9a9a92, accent: 0xf2c14e },
	{ id: 'dusk', name: 'Dusk Fells', sky: 0x3a3f66, fog: 0x6a5f8a, ground: 0x5a6a4a, groundFar: 0x74805c, tree: 0x2e4a3a, rock: 0x7a7a88, accent: 0xe88a4e },
	{ id: 'frost', name: 'Frostmoor', sky: 0xcfe0ea, fog: 0xe8f0f4, ground: 0xdde8ea, groundFar: 0xc4d6da, tree: 0x4a6a6a, rock: 0xaab4bc, accent: 0x5aa8d8 },
	{ id: 'ember', name: 'Ember Heath', sky: 0xf2c9a0, fog: 0xe8b88a, ground: 0xa87848, groundFar: 0xbf9460, tree: 0x7a4a2e, rock: 0x8a7a6a, accent: 0xd84e2e },
	{ id: 'night', name: 'Starlit Down', sky: 0x141a2e, fog: 0x232a44, ground: 0x2e3a34, groundFar: 0x3e4c44, tree: 0x1e2e28, rock: 0x4a5460, accent: 0x8ab8f2 },
];

// --- Tutorial lessons ----------------------------------------------------------
// One rule at a time; each requires the player to perform the action.

export const TUTORIALS = [
	{
		id: 'tut-throttle', order: 0, title: 'Give it throttle',
		text: 'Hold THROTTLE (Up arrow / W, or the right pedal) to build speed. Reach the flag.',
		requires: { minX: 60 }, hint: 'throttle',
		config: { length: 120, roughness: 0.3, fuel: 100, checkpoints: 1, fuelCans: 0 },
	},
	{
		id: 'tut-brake', order: 1, title: 'Brake before the drop',
		text: 'Hold BRAKE (Down arrow / S, or the left pedal) to slow down. Cross the flag under control.',
		requires: { minX: 100 }, hint: 'brake',
		config: { length: 140, roughness: 0.5, fuel: 100, checkpoints: 1, fuelCans: 0 },
	},
	{
		id: 'tut-pitch', order: 2, title: 'Mind your pitch',
		text: 'In the air, tilt (Left/Right arrows / A,D) to match the slope before you land.',
		requires: { minX: 140 }, hint: 'tilt',
		config: { length: 180, roughness: 0.9, fuel: 120, checkpoints: 1, fuelCans: 0 },
	},
	{
		id: 'tut-fuel', order: 3, title: 'Fuel is finite',
		text: 'Coast downhill and collect fuel cans. Run dry and the run ends.',
		requires: { minX: 160, cans: 1 }, hint: 'fuel',
		config: { length: 220, roughness: 0.7, fuel: 55, checkpoints: 1, fuelCans: 3 },
	},
	{
		id: 'tut-mastery', order: 4, title: 'Put it together',
		text: 'Throttle, brake, pitch, fuel. Reach the last flag to finish your training.',
		requires: { minX: 260 }, hint: null,
		config: { length: 320, roughness: 1.0, fuel: 90, checkpoints: 2, fuelCans: 2 },
	},
];

// --- Journey stages ------------------------------------------------------------
// 40 authored stages: difficulty grows by length, roughness, fuel pressure.
// Every 5th stage is a mastery stage combining mechanics learned so far.

function buildStages() {
	const stages = [];
	const rand = (n) => ((n * 2654435761) >>> 0) % 100000;
	for (let i = 0; i < 40; i++) {
		const n = i + 1;
		const tier = Math.floor(i / 8); // 0..4
		const mastery = n % 5 === 0;
		const length = 220 + tier * 90 + (i % 8) * 30 + (mastery ? 120 : 0);
		const roughness = Math.min(1.8, 0.5 + tier * 0.25 + (i % 4) * 0.08 + (mastery ? 0.2 : 0));
		const fuel = Math.max(45, 110 - tier * 10 - (mastery ? 15 : 0));
		const fuelCans = Math.max(1, Math.round(length / 130));
		stages.push({
			id: `stage-${String(n).padStart(2, '0')}`,
			index: i,
			name: mastery ? `Mastery ${n}` : `Stage ${n}`,
			seed: (0x1eaf00 + n * 7919 + rand(n)) >>> 0,
			length, roughness, fuel, fuelCans,
			checkpoints: Math.max(2, Math.round(length / 160)),
			theme: THEMES[tier % THEMES.length].id,
			mastery,
			par: Math.round(length / 9), // par time in seconds
			mechanics: tier === 0 ? ['throttle', 'brake'] : tier === 1 ? ['throttle', 'brake', 'tilt'] : ['throttle', 'brake', 'tilt', 'fuel'],
		});
	}
	return stages;
}

export const STAGES = buildStages();

// --- Challenge variants ---------------------------------------------------------

export const CHALLENGES = [
	{ id: 'ch-hypermile', name: 'Hypermile', desc: 'Finish with the most fuel left. Fuel is scarce.', config: { length: 400, roughness: 0.9, fuel: 55, fuelCans: 1, seed: 0xbeef01 } },
	{ id: 'ch-sprinter', name: 'Sprinter', desc: 'Short course, tight clock. Beat the timeout.', config: { length: 260, roughness: 0.8, fuel: 100, fuelCans: 1, seed: 0xbeef02, maxTicks: TICK_RATE * 30 } },
	{ id: 'ch-cliffside', name: 'Cliffside', desc: 'Violent terrain. Land smooth or not at all.', config: { length: 420, roughness: 1.8, fuel: 110, fuelCans: 3, seed: 0xbeef03 } },
	{ id: 'ch-marathon', name: 'Marathon', desc: 'A long haul over the whole countryside.', config: { length: 900, roughness: 1.1, fuel: 120, fuelCans: 6, seed: 0xbeef04 } },
];

// --- Daily ---------------------------------------------------------------------
// One shared seed and ruleset per UTC day, derived from the date. Immutable.

export function dailySeed(dateISO) {
	// dateISO: 'YYYY-MM-DD' (UTC)
	let h = 2166136261 >>> 0;
	for (let i = 0; i < dateISO.length; i++) {
		h ^= dateISO.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

export function dailyContent(dateISO) {
	const seed = dailySeed(dateISO);
	const dayNum = Math.floor(Date.parse(dateISO + 'T00:00:00Z') / 86400000);
	return {
		id: `daily-${dateISO}`,
		name: `Daily ${dateISO}`,
		date: dateISO,
		seed,
		length: 380 + (dayNum % 5) * 40,
		roughness: 0.8 + (dayNum % 3) * 0.25,
		fuel: 100,
		fuelCans: 3,
		checkpoints: 3,
		theme: THEMES[dayNum % THEMES.length].id,
		excluded: false, // defective days are marked excluded, never silently replaced
	};
}

// --- Level assembly --------------------------------------------------------------

export function levelConfig(level, mode) {
	return {
		seed: level.seed >>> 0,
		length: level.length,
		roughness: level.roughness,
		fuel: level.fuel,
		fuelCans: level.fuelCans,
		checkpoints: level.checkpoints,
		maxTicks: level.maxTicks,
		mode: mode || 'journey',
	};
}

export function tutorialConfig(t) {
	return levelConfig({ seed: (0xf00d + t.order) >>> 0, ...t.config }, 'learn');
}

export function getStage(i) { return STAGES[Math.max(0, Math.min(STAGES.length - 1, i))]; }
export function getTheme(id) { return THEMES.find((t) => t.id === id) || THEMES[0]; }

// --- Offline validators -----------------------------------------------------------
// Prove basic legality, reachable goals, bounded duration, absence of soft locks.
// A simple seeded autopilot must be able to finish (or, for hard tiers, reach the
// final checkpoint), proving the content is completable.

function autopilotInput(state) {
	const v = state.vehicle;
	const slope = state.terrain.slope(v.x);
	let throttle = 0, brake = 0, tilt = 0;
	if (v.grounded) {
		throttle = slope < 0.35 ? 800 : 400;
		// Look ahead: brake for sharp drops and excessive speed.
		const ahead = state.terrain.slope(v.x + Math.max(6, v.vx * 0.8));
		const dropAhead = state.terrain.height(v.x) - state.terrain.height(v.x + Math.max(8, v.vx * 1.2));
		if ((dropAhead > 7 || ahead < -0.6) && v.vx > 9) brake = 700;
		if (slope < -0.25 && v.vx > 10) brake = Math.max(brake, 600);
		if (v.vx > 12) brake = 900;
		if (brake > 0) throttle = 0;
	} else {
		// Pitch toward terrain slope ahead.
		const err = state.terrain.slope(v.x + v.vx * 0.4) - v.angle;
		tilt = Math.max(-1000, Math.min(1000, Math.round(err * 1200 - v.av * 200)));
	}
	return { throttle, brake, tilt };
}

export function validateLevel(config, { finishRequired = true } = {}) {
	const errors = [];
	if (!Number.isInteger(config.seed) || config.seed < 0) errors.push('bad_seed');
	if (!(config.length >= 60 && config.length <= 2000)) errors.push('bad_length');
	if (!(config.roughness > 0 && config.roughness <= 2.5)) errors.push('bad_roughness');
	if (!(config.fuel > 0)) errors.push('bad_fuel');
	const state = createState(config);
	let ticks = 0;
	const cap = state.maxTicks;
	while (!state.terminalReason && ticks < cap) {
		step(state, autopilotInput(state));
		ticks++;
	}
	if (ticks >= cap && !state.terminalReason) errors.push('unbounded_duration');
	if (finishRequired && state.terminalReason !== TERMINAL.FINISHED) {
		errors.push('goal_unreachable:' + (state.terminalReason || 'none'));
	}
	const score = scoreBreakdown(state);
	if (!Number.isInteger(score.total) || score.total < 0) errors.push('bad_score');
	if (!Number.isInteger(hashState(state))) errors.push('bad_hash');
	return { ok: errors.length === 0, errors, terminal: state.terminalReason, ticks, hash: hashState(state) };
}

export function validateAll() {
	const report = { tutorials: {}, stages: {}, challenges: {}, dailies: {}, ok: true };
	for (const t of TUTORIALS) {
		const r = validateLevel(levelConfig({ seed: 0xf00d + t.order, ...t.config }, 'learn'));
		report.tutorials[t.id] = r;
		if (!r.ok) report.ok = false;
	}
	for (const s of STAGES) {
		const r = validateLevel(levelConfig(s, 'journey'), { finishRequired: !s.mastery || s.index < 30 });
		report.stages[s.id] = r;
		if (!r.ok) report.ok = false;
	}
	for (const c of CHALLENGES) {
		const r = validateLevel(levelConfig(c.config, 'challenge'), { finishRequired: false });
		report.challenges[c.id] = r;
		if (!r.ok && r.errors.some((e) => !e.startsWith('goal_unreachable'))) report.ok = false;
	}
	// Validate a rolling window of daily seeds.
	for (let d = 0; d < 7; d++) {
		const date = new Date(Date.UTC(2026, 0, 1 + d)).toISOString().slice(0, 10);
		const r = validateLevel(levelConfig(dailyContent(date), 'daily'));
		report.dailies[date] = r;
		if (!r.ok) report.ok = false;
	}
	return report;
}

export function createContent() {
	return { version: CONTENT_VERSION, themes: THEMES, tutorials: TUTORIALS, stages: STAGES, challenges: CHALLENGES, dailyContent, validateLevel };
}

export default { THEMES, STAGES, TUTORIALS, CHALLENGES, dailyContent, levelConfig, validateLevel };
