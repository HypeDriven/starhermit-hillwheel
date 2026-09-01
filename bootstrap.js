// Hillwheel bootstrap: host handshake, capability detection, asset manifest, lifecycle.

import { createGame } from './game.js';

export const BOOTSTRAP_SCHEMA_VERSION = 2;

// Asset manifest: everything loads locally; core rules/UI first, scenic lazily.
export const ASSET_MANIFEST = {
	core: ['./three.module.min.js', './three.core.min.js', './style.css'],
	scenic: [], // scenic assets are procedural; nothing external to fetch
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

function readLaunchToken() {
	// The host shell may inject a short-lived launch token via query param or global.
	const params = new URLSearchParams(location.search);
	return params.get('launch_token') || window.__STARHERMIT_LAUNCH_TOKEN__ || null;
}

export function bootstrap(rootEl) {
	const root = rootEl || document.getElementById('app');
	const caps = detectCapabilities();
	const game = createGame(root, {
		launchToken: readLaunchToken(),
		capabilities: caps,
		platform: { baseUrl: '' }, // same-origin /api when hosted
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
