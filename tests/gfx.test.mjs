// Unit tests for the pure graphics quality model (gfx.js) and its string catalogue.
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPreset, resolve, presetTier, choosePreset, describe, clampScale, CATEGORIES, PRESETS } from '../gfx.js';
import { GFX_LOCALES, pickLocale } from '../gfx-i18n.js';

test('detectPreset maps GPU strings to presets', () => {
	assert.equal(detectPreset('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)'), 'low');
	assert.equal(detectPreset('llvmpipe (LLVM 15.0.7, 256 bits)'), 'low');
	assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0)'), 'high');
	assert.equal(detectPreset('Apple M2 Pro'), 'high');
	assert.equal(detectPreset('ANGLE (AMD, AMD Radeon RX 6800 XT)'), 'high');
	assert.equal(detectPreset('ANGLE (Intel, Intel(R) UHD Graphics 620)'), 'balanced');
	assert.equal(detectPreset('Adreno (TM) 730'), 'balanced');
	assert.equal(detectPreset(''), 'balanced');
	// Touch/mobile devices cap Auto at balanced.
	assert.equal(detectPreset('Apple M2', { mobile: true }), 'balanced');
	assert.equal(detectPreset('SwiftShader', { mobile: true }), 'low');
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
