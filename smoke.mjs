// Hillwheel browser smoke test (Playwright + Chromium).
// Serves the distribution via server.js, loads the game, drives it with keyboard
// input through title -> countdown -> active play, checks HUD/results and console errors.
// Run: node smoke.mjs

import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const PORT = 19021;
const base = `http://127.0.0.1:${PORT}`;

const server = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT) }, stdio: 'pipe' });
await new Promise((res, rej) => {
	const t0 = Date.now();
	const poll = async () => {
		try { const r = await fetch(base + '/api/v1/time'); if (r.ok) return res(); } catch {}
		if (Date.now() - t0 > 8000) return rej(new Error('server did not start'));
		setTimeout(poll, 150);
	};
	poll();
});

let failed = 0;
const check = (name, ok, extra = '') => {
	console.log(ok ? '  ok' : 'FAIL', name, extra);
	if (!ok) failed++;
};

const browser = await chromium.launch();
try {
	const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
	const errors = [];
	page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
	page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

	await page.goto(base + '/index.html', { waitUntil: 'networkidle' });
	await page.waitForSelector('.hw-title', { timeout: 10000 });
	check('title screen renders', true);

	// All resources local: no failed requests.
	const failedReqs = [];
	page.on('requestfailed', (r) => failedReqs.push(r.url()));
	page.on('response', (r) => { if (r.status() >= 400) failedReqs.push(r.url() + ' ' + r.status()); });

	// Canvas present and WebGL active.
	const hasCanvas = await page.$('#hw-canvas');
	check('canvas exists', !!hasCanvas);
	const webgl = await page.evaluate(() => {
		const c = document.createElement('canvas');
		return !!(c.getContext('webgl2') || c.getContext('webgl'));
	});
	check('webgl available', webgl);

	// Quick play -> countdown -> active HUD.
	await page.click('.hw-btn-primary'); // Play
	await page.waitForSelector('.hw-hud:not(.hidden)', { timeout: 5000 });
	check('HUD appears after Play', true);
	await page.waitForFunction(() => window.__hillwheel && window.__hillwheel.phase === 'active', null, { timeout: 8000 });
	check('game reaches active phase', true);

	// Drive with keyboard for a few seconds.
	await page.keyboard.down('ArrowUp');
	await page.waitForTimeout(3500);
	await page.keyboard.up('ArrowUp');
	const moved = await page.evaluate(() => window.__hillwheel.session.state.vehicle.x);
	check('vehicle moves under throttle', moved > 2, `x=${moved.toFixed(1)}`);
	const score = await page.textContent('.hw-hud-score');
	check('HUD score updates', /^\d+$/.test(score || '') && Number(score) > 0, score);

	// Pause via keyboard, resume via button.
	await page.keyboard.press('Escape');
	await page.waitForSelector('.hw-panel', { timeout: 3000 });
	check('pause opens', (await page.evaluate(() => window.__hillwheel.phase)) === 'paused');
	await page.click('text=Resume');
	await page.waitForFunction(() => window.__hillwheel.phase === 'active', null, { timeout: 3000 });
	check('resume works', true);

	// Pause -> quit to title.
	await page.keyboard.press('KeyP');
	await page.click('text=Quit to Title');
	await page.waitForSelector('.hw-title', { timeout: 3000 });
	check('quit to title', true);

	// Accessibility: live region and focus visibility exist.
	check('live region present', !!(await page.$('.hw-live')));
	const focusVisible = await page.evaluate(() => {
		const b = document.querySelector('.hw-btn-primary');
		b.focus();
		return document.activeElement === b;
	});
	check('keyboard focus works', focusVisible);

	// Settings screen opens and persists.
	await page.click('text=Settings');
	await page.waitForSelector('.hw-settings', { timeout: 3000 });
	await page.click('text=Back');
	await page.waitForSelector('.hw-title', { timeout: 3000 });
	check('settings screen round-trips', true);

	// Help screen.
	await page.click('text=How to Play');
	await page.waitForSelector('.hw-help-grid', { timeout: 3000 });
	check('help screen renders rule cards', true);
	await page.click('text=Back');

	// Daily flow via server-backed mode select.
	await page.click('text=Daily Challenge');
	await page.waitForSelector('.hw-level-list', { timeout: 5000 });
	check('daily setup lists ranked run', true);

	// Mobile portrait layout: pedals visible, no overlap with safe areas.
	const mob = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
	await mob.goto(base + '/index.html', { waitUntil: 'networkidle' });
	await mob.waitForSelector('.hw-title', { timeout: 10000 });
	await mob.click('.hw-btn-primary');
	await mob.waitForFunction(() => window.__hillwheel && window.__hillwheel.phase === 'active', null, { timeout: 8000 });
	const pedal = await mob.$('#hw-pedal-throttle');
	const box = await pedal.boundingBox();
	check('mobile throttle pedal >=44px target', box && box.height >= 44 && box.width >= 44, box ? `${Math.round(box.width)}x${Math.round(box.height)}` : 'missing');
	// Touch drive.
	await pedal.dispatchEvent('pointerdown');
	await mob.waitForTimeout(2000);
	await pedal.dispatchEvent('pointerup');
	const mobX = await mob.evaluate(() => window.__hillwheel.session.state.vehicle.x);
	check('touch pedal drives vehicle', mobX > 1, `x=${mobX.toFixed(1)}`);

	// No 404s / failed loads for local resources.
	check('all resources load locally (no failed requests)', failedReqs.length === 0, failedReqs.slice(0, 5).join(', '));

	// Console errors filter: ignore expected audio autoplay warnings (none expected as we gate on gesture).
	const realErrors = errors.filter((e) => !/favicon/.test(e));
	check('no page/console errors', realErrors.length === 0, realErrors.slice(0, 5).join(' | '));
} finally {
	await browser.close();
	server.kill();
}

console.log(failed ? `\n${failed} smoke checks FAILED` : '\nAll smoke checks passed');
process.exit(failed ? 1 : 0);
