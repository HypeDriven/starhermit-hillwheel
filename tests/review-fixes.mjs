// Targeted browser checks for this review's UI fixes.
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const PORT = 19077, base = `http://127.0.0.1:${PORT}`;
const server = spawn(process.execPath, ['server.js'], { cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: String(PORT) }, stdio: 'pipe' });
await new Promise((res, rej) => { const t0 = Date.now(); const poll = async () => { try { const r = await fetch(base + '/api/v1/time'); if (r.ok) return res(); } catch {} if (Date.now() - t0 > 8000) return rej(new Error('no server')); setTimeout(poll, 150); }; poll(); });

let failed = 0;
const check = (n, ok, extra = '') => { console.log(ok ? '  ok' : 'FAIL', n, extra); if (!ok) failed++; };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto(base + '/index.html', { waitUntil: 'networkidle' });
await page.waitForSelector('.hw-title');

// Settings persistence
await page.click('.hw-panel button:has-text("Settings")');
await page.waitForSelector('.hw-settings');
await page.locator('.hw-settings .hw-check', { hasText: 'High contrast' }).click();
const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('hillwheel-settings-v1') || 'null'));
check('settings written to localStorage', !!stored && stored.highContrast === true, JSON.stringify(stored && stored.highContrast));

// Palette selector reaches the DOM palette hook
await page.selectOption('.hw-settings .hw-field:has-text("Colour palette") select', 'deuteranopia');
const pal = await page.evaluate(() => document.querySelector('.hw-root').dataset.palette);
check('palette select applies data-palette', pal === 'deuteranopia', pal);

// Arrow keys must reach the volume slider, not the driving controls
const slider = page.locator('.hw-settings .hw-field:has-text("Music") input[type=range]');
await slider.focus();
const before = Number(await slider.inputValue());
await page.keyboard.press('ArrowLeft');
await page.keyboard.press('ArrowLeft');
const after = Number(await slider.inputValue());
check('arrow keys adjust volume slider', after < before, `${before} -> ${after}`);

// Reload: settings survive
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('.hw-title');
const survived = await page.evaluate(() => ({
	hc: window.__hillwheel.settings.highContrast,
	pal: window.__hillwheel.settings.palette,
	music: window.__hillwheel.settings.volumes.music,
	cls: document.querySelector('.hw-root').classList.contains('high-contrast'),
}));
check('settings survive reload and are applied', survived.hc === true && survived.pal === 'deuteranopia' && survived.music < before && survived.cls, JSON.stringify(survived));

// Countdown restart guard: restart during countdown must not skip the count
await page.click('.hw-panel button:has-text("Quick play")');
await page.waitForFunction(() => window.__hillwheel?.phase === 'countdown');
await page.waitForTimeout(2000);
await page.evaluate(() => window.__hillwheel._restartLevel());
await page.waitForTimeout(2000);
const stillCounting = await page.evaluate(() => window.__hillwheel.phase);
check('restart during countdown keeps counting', stillCounting === 'countdown', stillCounting);
await page.waitForFunction(() => window.__hillwheel?.phase === 'active', null, { timeout: 8000 });
check('countdown still completes after restart', true);

check('no page/console errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
server.kill();
console.log(failed ? `\n${failed} checks FAILED` : '\nAll targeted checks passed');
process.exit(failed ? 1 : 0);
