// Unit tests for the pure graphics quality model (gfx.js) and its string catalogue.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { detectPreset, detectLevel, presetForLevel, resolve, presetTier, choosePreset, describe, clampScale, CATEGORIES, PRESETS, LEVELS, BUDGETS, budgetFor } from '../gfx.js';
import { GFX_LOCALES, pickLocale } from '../gfx-i18n.js';
// gpu-level.js is a classic script in the page (window.StarHermitGpu); in Node it exports the same API.
globalThis.StarHermitGpu = createRequire(import.meta.url)('../gpu-level.js');

const DESK = { cores: 8, memoryGb: 8 };
const PHONE = { mobile: true, cores: 8, memoryGb: 8 };

test('hardware level picks the Auto preset (Low 0, Balanced 4, High 10, Ultra 17)', () => {
	assert.equal(detectPreset('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)', DESK), 'low');
	assert.equal(detectLevel('llvmpipe (LLVM 15.0.7, 256 bits)', DESK), 0);
	assert.equal(detectPreset('ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', DESK), 'low');
	assert.equal(detectPreset('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11)', DESK), 'low');
	assert.equal(detectPreset('ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11)', DESK), 'balanced');
	assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce GTX 1070 Direct3D11 vs_5_0 ps_5_0)', DESK), 'high');
	assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 Direct3D11 vs_5_0 ps_5_0)', DESK), 'ultra');
	assert.equal(detectLevel('ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 Direct3D11 vs_5_0 ps_5_0)', DESK), 20);
	assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 Direct3D11 vs_5_0 ps_5_0)', DESK), 'ultra');
	for (const [p, lv] of Object.entries(LEVELS)) assert.equal(presetForLevel(lv), p);
	assert.equal(presetForLevel(3), 'low');
	assert.equal(presetForLevel(16), 'high');
});

test('phones and tablets are Balanced at most; software GPUs stay Low', () => {
	assert.equal(detectPreset('Adreno (TM) 740', PHONE), 'balanced');
	assert.ok(detectLevel('Adreno (TM) 740', PHONE) <= 9);
	assert.equal(detectPreset('NVIDIA GeForce RTX 5090', PHONE), 'balanced');
	assert.equal(detectPreset('SwiftShader', PHONE), 'low');
});

test('per-preset budgets are explicit, grow from Low to Ultra and scale with the level', () => {
	const keys = ['material', 'trees', 'treeShadows', 'segments', 'tufts', 'particles', 'bloomRes', 'aoRes'];
	for (const p of PRESETS) for (const k of keys) assert.ok(BUDGETS[p][k] != null, `${p}.${k}`);
	for (let i = 1; i < PRESETS.length; i++) {
		for (const k of keys) if (typeof BUDGETS.low[k] === 'number') assert.ok(BUDGETS[PRESETS[i]][k] >= BUDGETS[PRESETS[i - 1]][k], `${PRESETS[i]}.${k}`);
	}
	assert.deepEqual(PRESETS.map((p) => BUDGETS[p].material), ['lambert', 'standard', 'physical', 'physical']);
	assert.deepEqual(resolve({ preset: 'high' }, 'low', 10).budget, { ...BUDGETS.high }, 'floor level = the tuned budget');
	assert.deepEqual(resolve({ preset: 'ultra' }, 'low', 0).budget, resolve({ preset: 'ultra' }, 'ultra', 17).budget, 'manual Ultra on a weak GPU keeps the Ultra floor budget');
	assert.ok(budgetFor('balanced', 9).trees > budgetFor('balanced', 4).trees, 'counts scale up within the preset');
	assert.ok(budgetFor('ultra', 20).particles <= BUDGETS.ultra.particles * 2);
	assert.equal(budgetFor('high', 10, 'off').particles, 0);
});

test('resolve: Auto uses the detected preset', () => {
	const r = resolve({}, 'low');
	assert.equal(r.preset, 'low');
	assert.equal(r.auto, true);
	assert.equal(r.shadows, 'off');
	assert.equal(r.post, false, 'Low renders without post-processing');
	assert.equal(r.cap, 1);
	assert.equal(resolve({ preset: 'bogus' }, 'high').preset, 'high');
	assert.equal(resolve({}, undefined).preset, 'balanced');
});

test('resolve: explicit preset and per-category overrides', () => {
	const r = resolve({ preset: 'high', bloom: 'off', particles: 'low' }, 'low');
	assert.equal(r.preset, 'high');
	assert.equal(r.auto, false);
	assert.equal(r.shadows, presetTier('high', 'shadows'));
	assert.equal(r.bloom, 'off');
	assert.equal(r.particles, 'low');
	// Invalid tiers fall back to the preset's tier.
	assert.equal(resolve({ preset: 'high', shadows: 'huge' }, 'low').shadows, 'medium');
	for (const p of PRESETS) for (const cat of Object.keys(CATEGORIES)) {
		assert.ok(CATEGORIES[cat].includes(presetTier(p, cat)), `${p}.${cat}`);
	}
});

test('resolve: render scale clamps to 50–200 % and multiplies the preset scale', () => {
	assert.equal(resolve({ preset: 'high', render_scale: 5 }, 'low').scale, 2);
	assert.equal(resolve({ preset: 'high', render_scale: 0.1 }, 'low').scale, 0.5);
	assert.equal(resolve({ preset: 'ultra', render_scale: 1 }, 'low').scale, 1.25);
	assert.equal(resolve({ preset: 'high', render_scale: 'x' }, 'low').scale, 1);
	assert.equal(clampScale(1.5), 1.5);
});

test('resolve: adaptive defaults on, frame-rate readout defaults off', () => {
	const r = resolve({}, 'balanced');
	assert.equal(r.adaptive, true);
	assert.equal(r.showFps, false);
	const s = resolve({ adaptive: false, show_fps: true }, 'balanced');
	assert.equal(s.adaptive, false);
	assert.equal(s.showFps, true);
});

test('choosing a preset clears overrides but keeps scale/adaptive/fps', () => {
	const saved = { preset: 'high', bloom: 'off', shadows: 'high', render_scale: 1.5, adaptive: false, show_fps: true };
	const next = choosePreset(saved, 'low');
	assert.deepEqual(next, { preset: 'low', render_scale: 1.5, adaptive: false, show_fps: true });
	assert.equal(choosePreset(saved, 'auto').preset, 'auto');
	assert.equal(resolve(choosePreset(saved, 'ultra'), 'low').bloom, 'on');
});

test('describe summarises cost', () => {
	assert.equal(describe(resolve({ preset: 'low' }, 'low'), [800, 600]), 'no shadows · no anti-aliasing · 800×600 px');
	assert.match(describe(resolve({ preset: 'high' }, 'low')), /2048² shadows · ambient occlusion · bloom · SMAA/);
});

test('graphics strings exist in every required locale', () => {
	const required = ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT'];
	const en = GFX_LOCALES['en-US'];
	for (const loc of required) {
		const t = GFX_LOCALES[loc];
		assert.ok(t, loc);
		for (const k of Object.keys(en)) assert.ok(t[k], `${loc}.${k}`);
		for (const cat of Object.keys(CATEGORIES)) assert.ok(t.cat[cat], `${loc}.cat.${cat}`);
		for (const tiers of Object.values(CATEGORIES)) for (const tier of tiers) assert.ok(t.tier[tier], `${loc}.tier.${tier}`);
		for (const p of PRESETS) assert.ok(t.tier[p], `${loc}.tier.${p}`);
		for (const k of Object.keys(en.words)) assert.ok(t.words[k], `${loc}.words.${k}`);
	}
	assert.equal(pickLocale(['es-MX']), 'es-419');
	assert.equal(pickLocale(['es-ES']), 'es-ES');
	assert.equal(pickLocale(['fr-CA']), 'fr-CA');
	assert.equal(pickLocale(['fr-BE']), 'fr-FR');
	assert.equal(pickLocale(['en-GB']), 'en-GB');
	assert.equal(pickLocale(['ja-JP', 'de-AT']), 'de-DE');
	assert.equal(pickLocale(['ja-JP']), 'en-US');
});
