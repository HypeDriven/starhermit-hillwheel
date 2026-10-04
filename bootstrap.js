// Hillwheel bootstrap: StarHermit init, capability detection, asset manifest, lifecycle.

import { createGame } from './game.js';

export const BOOTSTRAP_SCHEMA_VERSION = 2;

// Asset manifest: everything loads locally; core rules/UI first, scenic lazily.
export const ASSET_MANIFEST = {
	core: ['./three.module.min.js', './three.core.min.js', './style.css'],
	scenic: ['./assets/keyart.webp'], // title key art; everything else in the scene is procedural
};

export function detectCapabilities() {
	const canvas = document.createElement('canvas');
	const webgl = !!(canvas.getContext('webgl2') || canvas.getContext('webgl'));
	return {
		webgl,
		touch: 'ontouchstart' in window || navigator.maxTouchPoints > 0,
		gamepad: 'getGamepads' in navigator,
		dpr: window.devicePixelRatio || 1,
		reducedMotion: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || false,
	};
}

// StarHermit: starhermit-sdk.js (a classic script loaded before this module)
// reads the launch token from #game_token= / #access_token=, strips it from the
// URL and keeps it renewed. Initialise it before anything else touches the URL.
function initStarHermit() {
	const sh = typeof window !== 'undefined' ? window.StarHermit : null;
	if (sh) sh.init();
	return sh || null;
}

export function bootstrap(rootEl) {
	const root = rootEl || document.getElementById('app');
	const sdk = initStarHermit();
	const caps = detectCapabilities();
	const game = createGame(root, {
		capabilities: caps,
		platform: { baseUrl: '', sdk }, // same-origin /api when hosted
	});
	game.start();
	return game;
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
	const start = () => { if (document.getElementById('app')) window.__hillwheel = bootstrap(); };
	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
	else start();
}

export default bootstrap;
