// Hillwheel graphics quality model: presets, per-category overrides, GPU detection, cost summary.
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

/** Best preset for this GPU, from the unmasked renderer string. Touch/mobile devices cap at balanced. */
export function detectPreset(gpu, { mobile = false } = {}) {
	const g = String(gpu || '').toLowerCase();
	let p = 'balanced';
	if (/swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/.test(g)) p = 'low';
	else if (/nvidia|geforce|rtx|gtx|quadro|radeon rx|radeon pro|amd radeon(?! graphics)|apple m\d/.test(g)) p = 'high';
	if (mobile && p === 'high') p = 'balanced';
	return p;
}

/**
 * Resolve saved settings into concrete tiers.
 * `saved`: { preset: 'auto'|preset, render_scale, adaptive, show_fps, <category>: 'preset'|tier }.
 */
export function resolve(saved, detected) {
	const s = saved || {};
	const auto = !PRESETS.includes(s.preset);
	const preset = auto ? (PRESETS.includes(detected) ? detected : 'balanced') : s.preset;
	const row = TABLE[preset];
	const out = { preset, auto, cap: row.cap, scale: row.scale * clampScale(s.render_scale) };
	for (const [cat, tiers] of Object.entries(CATEGORIES)) {
		out[cat] = tiers.includes(s[cat]) ? s[cat] : row[cat];
	}
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
