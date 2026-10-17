// Hillwheel graphics quality model: presets, per-category overrides, hardware-level detection,
// per-preset budgets, cost summary.
// Pure (no three.js, no DOM) so the Settings panel, the renderer and the unit tests agree on
// what a setting means.

export const PRESETS = ['low', 'balanced', 'high', 'ultra'];

// Category → allowed tiers, cheapest first.
export const CATEGORIES = {
	shadows: ['off', 'low', 'medium', 'high'],
	ao: ['off', 'on', 'high'],
	bloom: ['off', 'on'],
	grade: ['off', 'on'],
	antialias: ['off', 'fxaa', 'smaa', 'msaa'],
	reflections: ['off', 'on'],
	particles: ['off', 'low', 'high'],
	foliage: ['off', 'some', 'full'],
	background: ['static', 'animated'],
	detail: ['plain', 'detailed'],
};

// Each preset is a row of tiers, a device-pixel-ratio cap and a render scale.
// Low matches the game's original cheapest tier: DPR 1, no shadows, no trees, no particles,
// coarse terrain, no anti-aliasing and no post-processing.
const TABLE = {
	low: { cap: 1, scale: 1, shadows: 'off', ao: 'off', bloom: 'off', grade: 'off', antialias: 'off', reflections: 'off', particles: 'off', foliage: 'off', background: 'static', detail: 'plain' },
	balanced: { cap: 1.5, scale: 1, shadows: 'low', ao: 'off', bloom: 'on', grade: 'on', antialias: 'fxaa', reflections: 'on', particles: 'low', foliage: 'some', background: 'animated', detail: 'detailed' },
	high: { cap: 2, scale: 1, shadows: 'medium', ao: 'on', bloom: 'on', grade: 'on', antialias: 'smaa', reflections: 'on', particles: 'high', foliage: 'full', background: 'animated', detail: 'detailed' },
	ultra: { cap: 2, scale: 1.25, shadows: 'high', ao: 'high', bloom: 'on', grade: 'on', antialias: 'msaa', reflections: 'on', particles: 'high', foliage: 'full', background: 'animated', detail: 'detailed' },
};

export const SHADOW_MAP = { off: 0, low: 1024, medium: 2048, high: 4096 };
export const PARTICLE_POOL = { off: 0, low: 64, high: 192 };
export const FOLIAGE_DENSITY = { off: 0, some: 0.6, full: 1 };

// Auto picks the preset from the StarHermit hardware level (0 = Galaxy S20 / Intel UHD or weaker, 20 = RTX
// 5090; gpu-level.js → window.StarHermitGpu, a classic script loaded before bootstrap.js): Low from 0,
// Balanced from 4, High from 10, Ultra from 17. Phones, tablets and ≤ 4 GB machines are capped at level 9.
export const LEVELS = { low: 0, balanced: 4, high: 10, ultra: 17 };

const gpuApi = () => globalThis.StarHermitGpu;

/** Hardware level 0–20 for an unmasked renderer string plus StarHermitGpu.detectSystem() facts. */
export function detectLevel(gpu, system) {
	const G = gpuApi();
	if (!G) return LEVELS.balanced;
	return G.detectLevel({ webgl: true, webgl2: true, ...(system || {}), gpu: String(gpu || '') });
}

/** The preset Auto starts from for a hardware level. */
export function presetForLevel(level) {
	const G = gpuApi();
	return G ? G.presetForLevel(level, LEVELS) : PRESETS.filter((p) => LEVELS[p] <= level).pop() || 'low';
}

/** Best preset for this GPU (the hardware level already caps phones/tablets at Balanced). */
export function detectPreset(gpu, system) {
	return presetForLevel(detectLevel(gpu, system));
}

/*
 * Per-preset asset and effect budget. Each preset is tuned to hold 60 FPS on the weakest GPU Auto gives
 * it (Low → level 0, Balanced → 4, High → 10, Ultra → 17; measured with tests/gfx-bench.mjs). Gameplay is
 * identical on every preset — the rules' track profile never changes, only the scenery around it.
 *   material     props (vehicle, cans, flags, arch, trees, rocks): 'lambert' | 'standard'; clear-coated
 *                'physical' paint and cans on High+
 *   trees        tree count per 100 m of course at Foliage "full" (some: 60 %), scaled with the level
 *   treeShadows  trees and rocks cast shadows (else only the vehicle, cans, flags and arch)
 *   segments     round-geometry LOD multiplier (trees, wheels, cans, poles; min 5)
 *   tufts        grass tufts per metre of track (Terrain detail: detailed)
 *   particles    dust/spark pool at Particles "high" (low: a third), scaled with the level
 *   bloomRes / aoRes  bloom and GTAO resolution as a fraction of the frame
 */
export const BUDGETS = {
	low: { material: 'lambert', trees: 8, treeShadows: false, segments: 0.5, tufts: 0.8, particles: 96, bloomRes: 0.5, aoRes: 0.5 },
	balanced: { material: 'standard', trees: 11, treeShadows: false, segments: 0.75, tufts: 1.2, particles: 144, bloomRes: 0.5, aoRes: 0.5 },
	high: { material: 'physical', trees: 14.3, treeShadows: true, segments: 1, tufts: 2.2, particles: 192, bloomRes: 0.5, aoRes: 0.5 },
	ultra: { material: 'physical', trees: 20, treeShadows: true, segments: 1.5, tufts: 3.2, particles: 320, bloomRes: 1, aoRes: 1 },
};
const PARTICLE_SHARE = { off: 0, low: 1 / 3, high: 1 };

/** A preset's concrete budget for a hardware level and Particles tier (counts scale ≤ 2× within the preset). */
export function budgetFor(preset, level, particles = 'high') {
	const b = { ...(BUDGETS[preset] || BUDGETS.balanced) };
	const G = gpuApi(), floor = LEVELS[preset] || 0;
	const lv = Math.max(Number.isFinite(level) ? level : floor, floor);
	const k = G ? Math.min(2, G.scaleBudget(1, lv, floor)) : 1;
	b.trees = Math.round(b.trees * k * 10) / 10;
	b.particles = Math.round(b.particles * k * (PARTICLE_SHARE[particles] ?? 1));
	return b;
}

/**
 * Resolve saved settings into concrete tiers.
 * `saved`: { preset: 'auto'|preset, render_scale, adaptive, show_fps, <category>: 'preset'|tier }.
 */
export function resolve(saved, detected, level) {
	const s = saved || {};
	const auto = !PRESETS.includes(s.preset);
	const preset = auto ? (PRESETS.includes(detected) ? detected : 'balanced') : s.preset;
	const row = TABLE[preset];
	const out = { preset, auto, cap: row.cap, scale: row.scale * clampScale(s.render_scale) };
	for (const [cat, tiers] of Object.entries(CATEGORIES)) {
		out[cat] = tiers.includes(s[cat]) ? s[cat] : row[cat];
	}
	out.level = Number.isFinite(level) ? level : LEVELS[preset];
	out.budget = budgetFor(preset, out.level, out.particles);
	out.adaptive = s.adaptive !== false;
	out.showFps = !!s.show_fps;
	// The composer runs only when something needs it; otherwise the scene renders directly.
	out.post = out.ao !== 'off' || out.bloom === 'on' || out.grade === 'on' || out.antialias !== 'off';
	return out;
}

/** Clamp a render-scale multiplier to 50–200 %. */
export function clampScale(v) {
	const n = Number(v);
	return Number.isFinite(n) && n > 0 ? Math.min(2, Math.max(0.5, n)) : 1;
}

/** Choosing a preset clears every per-category override (scale/adaptive/fps are kept). */
export function choosePreset(saved, preset) {
	const out = { preset: PRESETS.includes(preset) ? preset : 'auto' };
	for (const k of ['render_scale', 'adaptive', 'show_fps']) if (saved && k in saved) out[k] = saved[k];
	return out;
}

/** The preset's own tier for a category (for "From preset (…)" labels). */
export function presetTier(preset, cat) {
	return TABLE[preset]?.[cat];
}

const EN = {
	noShadows: 'no shadows', shadows: '{n}² shadows', ao: 'ambient occlusion', aoHigh: 'full ambient occlusion',
	bloom: 'bloom', noAa: 'no anti-aliasing', px: '{w}×{h} px',
};

/** One-line cost summary. `words` localizes the fragments (English by default). */
export function describe(r, pixels, words = EN) {
	const w = { ...EN, ...words };
	const parts = [
		r.shadows === 'off' ? w.noShadows : w.shadows.replace('{n}', SHADOW_MAP[r.shadows]),
		r.ao === 'off' ? null : r.ao === 'high' ? w.aoHigh : w.ao,
		r.bloom === 'on' ? w.bloom : null,
		r.antialias === 'off' ? w.noAa : r.antialias.toUpperCase(),
		pixels ? w.px.replace('{w}', pixels[0]).replace('{h}', pixels[1]) : null,
	];
	return parts.filter(Boolean).join(' · ');
}
