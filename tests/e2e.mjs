/**
 * Hillwheel — end-to-end QA playthrough (dev only, not shipped).
 *
 * Drives the real visible UI in headless Chrome (playwright-core + system
 * Chrome) through: title -> settings/help/leaderboard round-trips -> journey
 * stage select -> countdown -> active play (keyboard autopilot over real key
 * presses) -> results -> next stage -> pause/resume -> quit -> practice.
 * Ran twice: desktop 1280x800, then a fresh mobile context 390x844 w/ touch
 * (which also exercises the on-screen pedals).
 *
 * Server note: the repo's server.js is a StarHermit authoritative game
 * script, so it is NOT used here. This test embeds a minimal node:http static
 * server on an ephemeral port. No launch token is present, so the game runs
 * unhosted: it probes GET /api/v1/time (stubbed) and may best-effort call the
 * local-dev routes (leaderboard read; daily score submission after a daily
 * run), which the stub answers with 404 — a 404 on those optional capability
 * routes is the game's dev-server probe failing gracefully (it is remembered
 * and never retried), not a defect, so resource 404s under /api/v1/ are
 * filtered out of the console-error assertion below. Hosted-mode routes
 * (profile, cloud saves, platform leaderboards, token refresh) are only
 * exercised when a launch token exists, i.e. not in this harness.
 *
 * Run: npm run test:e2e
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOT = (stage, vp) => `/tmp/hillwheel-e2e-${stage}-${vp}.png`;

// Benign GPU/swiftshader console noise (from tools/production_game_audit.mjs).
const browserNoise = /GL Driver Message|GPU stall due to ReadPixels|Automatic fallback to software WebGL|EnableWebGLDeveloperExtensions/i;
// The game probes optional local-dev capability routes (e.g. its own leaderboard)
// which this stub answers with 404; that handled probe is not a page defect. Asset
// or module 404s outside /api/v1/ still fail the run.
const apiProbe404 = (m) => /Failed to load resource/.test(m.text()) && (m.location()?.url || '').includes('/api/v1/');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.wav': 'audio/wav', '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.glb': 'model/gltf-binary',
  '.woff2': 'font/woff2', '.ts': 'video/mp2t',
};

function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/v1/time') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ serverTime: Date.now(), date: new Date().toISOString().slice(0, 10), version: 'e2e' }));
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
      return;
    }
    let rel = decodeURIComponent(url.pathname.split('?')[0]);
    if (rel === '/') rel = '/index.html';
    const file = path.normalize(path.join(ROOT, rel));
    if (!file.startsWith(ROOT) || file.includes('node_modules')) {
      res.writeHead(404); res.end('not found'); return;
    }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// Read the exposed session state each poll and hold the matching real keys,
// mirroring the autopilot the game itself uses to prove levels completable.
// UI input is binary (key/pedal held = 1000, released = 0), so partial
// throttle is feathered with a duty cycle, like a player tapping the key.
async function driveToTerminal(page, { maxMs = 120000 } = {}) {
  const held = { ArrowUp: false, ArrowDown: false, ArrowLeft: false, ArrowRight: false };
  const setKey = async (key, want) => {
    if (held[key] === want) return;
    held[key] = want;
    if (want) await page.keyboard.down(key); else await page.keyboard.up(key);
  };
  const CYCLE = 250; // ms duty-cycle period for throttle feathering
  let throttleLevel = 0;
  const t0 = Date.now();
  let terminal = null;
  try {
    while (Date.now() - t0 < maxMs) {
      const s = await page.evaluate(() => {
        const g = window.__hillwheel;
        if (!g || !g.session) return { phase: g ? g.phase : 'boot' };
        const st = g.session.state, v = st.vehicle;
        if (st.terminalReason || g.phase !== 'active') {
          return { phase: g.phase, terminal: st.terminalReason, x: v.x, fuel: v.fuel };
        }
        let throttle = 0, brake = false, tiltL = false, tiltR = false;
        if (v.grounded) {
          const slope = st.terrain.slope(v.x);
          const ahead = st.terrain.slope(v.x + Math.max(6, v.vx * 0.8));
          const drop = st.terrain.height(v.x) - st.terrain.height(v.x + Math.max(8, v.vx * 1.2));
          throttle = slope < 0.35 ? 800 : 400;
          if ((drop > 7 || ahead < -0.6) && v.vx > 9) brake = true;
          if (slope < -0.25 && v.vx > 10) brake = true;
          if (v.vx > 12) brake = true;
          if (brake) throttle = 0;
        } else {
          const err = st.terrain.slope(v.x + v.vx * 0.4) - v.angle;
          const tilt = err * 1200 - v.av * 200;
          if (tilt < -60) tiltL = true; else if (tilt > 60) tiltR = true;
        }
        return { phase: g.phase, throttle, brake, tiltL, tiltR, x: v.x, fuel: v.fuel };
      });
      if (s.terminal || (s.phase !== 'active' && s.phase !== 'countdown' && s.phase !== 'preparing')) {
        terminal = s.terminal || s.phase;
        break;
      }
      if (s.phase === 'active') {
        if (typeof s.throttle === 'number') throttleLevel = s.throttle;
        const dutyOn = throttleLevel > 0 && ((Date.now() - t0) % CYCLE) < (CYCLE * throttleLevel) / 1000;
        await setKey('ArrowUp', dutyOn);
        await setKey('ArrowDown', !!s.brake);
        await setKey('ArrowLeft', !!s.tiltL);
        await setKey('ArrowRight', !!s.tiltR);
      }
      await page.waitForTimeout(50);
    }
  } finally {
    for (const k of Object.keys(held)) await setKey(k, false);
  }
  if (!terminal) throw new Error('driveToTerminal timed out without a terminal state');
  return terminal;
}

async function waitActive(page) {
  await page.waitForFunction(() => window.__hillwheel?.phase === 'active', null, { timeout: 15000 });
}

async function playRunToResults(page, vp) {
  await waitActive(page);
  await page.screenshot({ path: SHOT('play', vp) });
  const terminal = await driveToTerminal(page);
  console.log(`  terminal: ${terminal}`);
  await page.waitForSelector('.hw-panel .hw-score-table', { timeout: 10000 });
  const headline = await page.textContent('.hw-panel h1');
  const total = await page.textContent('.hw-score-table dd.hw-total');
  console.log(`  results: "${headline}" total=${total}`);
  if (!/Finished!|Run over/.test(headline || '')) throw new Error('unexpected results headline: ' + headline);
  if (!(Number(total) > 0)) throw new Error('results total not positive: ' + total);
  await page.screenshot({ path: SHOT('results', vp) });
  return terminal;
}

async function runPass(browser, base, vp) {
  const isMobile = vp === 'mobile';
  const context = await browser.newContext({
    viewport: isMobile ? { width: 390, height: 844 } : { width: 1280, height: 800 },
    hasTouch: isMobile,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if ((m.type() === 'error' || m.type() === 'warning') && !browserNoise.test(m.text()) && !apiProbe404(m)) errors.push(`console ${m.type()}: ${m.text()}`);
  });

  const step = async (name, fn) => { await fn(); console.log(`ok - [${vp}] ${name}`); };

  try {
    await step('load + title visible', async () => {
      await page.goto(base + '/index.html', { waitUntil: 'networkidle' });
      await page.waitForSelector('.hw-panel h1', { timeout: 10000 });
      const h1 = await page.textContent('.hw-panel h1');
      if (h1 !== 'Hillwheel') throw new Error('title h1: ' + h1);
      await page.waitForFunction(() => window.__hillwheel?.phase === 'title');
      if (!(await page.$('#app canvas'))) throw new Error('3D canvas missing');
      await page.screenshot({ path: SHOT('title', vp) });
    });

    await step('settings open/toggle/close', async () => {
      await page.click('button:has-text("Settings")');
      await page.waitForSelector('.hw-settings', { timeout: 5000 });
      await page.locator('.hw-settings .hw-check', { hasText: 'Mute all' }).click();
      const muted = await page.evaluate(() => window.__hillwheel.settings.muted);
      if (muted !== true) throw new Error('mute setting not applied');
      // Note: game.js never calls saveSettings, so settings are session-only
      // (localStorage 'hillwheel-settings-v1' is never written). Reported as a
      // game bug; not asserted here.
      const persisted = await page.evaluate(() => localStorage.getItem('hillwheel-settings-v1'));
      if (persisted === null) console.log('  note: settings are not persisted to localStorage (game bug: saveSettings never called)');
      await page.screenshot({ path: SHOT('settings', vp) });
      await page.locator('.hw-settings .hw-check', { hasText: 'Mute all' }).click();
      await page.click('button:has-text("← Back")');
      await page.waitForFunction(() => window.__hillwheel?.phase === 'title');
    });

    await step('help screen round-trip', async () => {
      await page.click('button:has-text("How to play")');
      await page.waitForSelector('.hw-help-grid', { timeout: 5000 });
      const cards = await page.locator('.hw-help-card').count();
      if (cards < 4) throw new Error('expected help cards, got ' + cards);
      await page.click('button:has-text("← Back")');
      await page.waitForFunction(() => window.__hillwheel?.phase === 'title');
    });

    await step('graphics settings: presets and overrides apply live, persist, fit', async () => {
      const preset = () => page.getAttribute('#hw-canvas', 'data-gfx-preset');
      // Headless Chrome uses a software GPU, so Auto resolves to Low.
      if ((await preset()) !== 'low') throw new Error('auto preset on software GPU: ' + (await preset()));
      await page.click('.hw-panel button:has-text("Settings")');
      await page.waitForSelector('#hw-gfx');
      await page.locator('#hw-gfx-preset').scrollIntoViewIfNeeded();
      if (!/Auto \(detected: Low\)/.test(await page.textContent('#hw-gfx-preset option[value="auto"]'))) throw new Error('auto label');
      await page.selectOption('#hw-gfx-preset', 'low');
      await page.waitForFunction(() => document.querySelector('#hw-canvas').dataset.gfxPreset === 'low');
      await page.selectOption('#hw-gfx-preset', 'ultra');
      await page.waitForFunction(() => document.querySelector('#hw-canvas').dataset.gfxPreset === 'ultra');
      await page.waitForTimeout(600); // a few frames with the full post chain
      await page.selectOption('#hw-gfx-preset', 'high');
      await page.waitForFunction(() => document.querySelector('#hw-canvas').dataset.gfxPreset === 'high');
      await page.waitForFunction(() => /2048² shadows/.test(document.querySelector('#hw-gfx-summary')?.textContent || ''));
      // One per-category override through the visible select.
      await page.locator('#hw-gfx-bloom').scrollIntoViewIfNeeded();
      const fromPreset = await page.textContent('#hw-gfx-bloom option[value="preset"]');
      if (!/From preset \(On\)/.test(fromPreset)) throw new Error('bloom preset label: ' + fromPreset);
      await page.selectOption('#hw-gfx-bloom', 'off');
      const applied = await page.evaluate(() => ({ r: window.__hillwheel.render.q.bloom, s: window.__hillwheel.settings.graphics.bloom }));
      if (applied.r !== 'off' || applied.s !== 'off') throw new Error('bloom override not applied: ' + JSON.stringify(applied));
      // Keyboard: the frame-rate toggle is reachable and flips with Space.
      await page.focus('#hw-gfx-fps');
      await page.keyboard.press('Space');
      await page.waitForFunction(() => document.getElementById('hw-fps') && !document.getElementById('hw-fps').hidden);
      // The section fits the viewport width (no horizontal cut-off).
      const vw = page.viewportSize().width;
      for (const sel of ['#hw-gfx', '#hw-gfx-preset', '#hw-gfx-scale', '#hw-gfx-antialias', '#hw-gfx-summary']) {
        await page.locator(sel).scrollIntoViewIfNeeded();
        const b = await page.locator(sel).boundingBox();
        if (!b || b.x < 0 || b.x + b.width > vw + 1) throw new Error(`${sel} cut off: ${b && JSON.stringify(b)}`);
      }
      await page.screenshot({ path: SHOT('graphics', vp) });
      // Survives a reload.
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForFunction(() => window.__hillwheel?.phase === 'title');
      if ((await preset()) !== 'high') throw new Error('preset not persisted: ' + (await preset()));
      await page.click('.hw-panel button:has-text("Settings")');
      await page.waitForSelector('#hw-gfx');
      if ((await page.inputValue('#hw-gfx-preset')) !== 'high') throw new Error('preset select after reload');
      if ((await page.inputValue('#hw-gfx-bloom')) !== 'off') throw new Error('override after reload');
      // Choosing a preset clears overrides; back to Auto keeps the rest of the run fast.
      await page.selectOption('#hw-gfx-preset', 'auto');
      if ((await page.inputValue('#hw-gfx-bloom')) !== 'preset') throw new Error('preset did not clear overrides');
      await page.locator('#hw-gfx-fps').uncheck();
      if ((await preset()) !== 'low') throw new Error('auto after reset: ' + (await preset()));
      await page.click('button:has-text("← Back")');
      await page.waitForFunction(() => window.__hillwheel?.phase === 'title');
    });

    await step('leaderboard degrades gracefully offline', async () => {
      await page.click('button:has-text("Leaderboards")');
      // The adapter resolves asynchronously (offline probe), so wait for the
      // settled note rather than the transient 'Loading…' state.
      await page.waitForFunction(() => /unavailable|No scores/.test(document.querySelector('.hw-panel .hw-note')?.textContent || ''), null, { timeout: 5000 });
      const note = await page.textContent('.hw-note');
      if (!/unavailable|No scores/.test(note || '')) throw new Error('unexpected leaderboard note: ' + note);
      await page.click('button:has-text("← Back")');
    });

    if (!isMobile) {
      await step('journey select lists 40 stages, first unlocked', async () => {
        await page.click('.hw-panel .hw-btn-mode:has-text("Journey")');
        await page.waitForSelector('.hw-level-list', { timeout: 5000 });
        const cells = await page.locator('.hw-level-list button').count();
        if (cells !== 40) throw new Error(`expected 40 stages, got ${cells}`);
        const locked = await page.locator('.hw-level-list button[disabled]').count();
        // Fresh profile unlock rule (game.js): stage 1 and 2 are open, rest locked.
        if (locked !== 38) throw new Error(`expected 38 locked, got ${locked}`);
        await page.screenshot({ path: SHOT('journey', vp) });
      });

      await step('journey stage 1: countdown -> active -> results', async () => {
        await page.locator('.hw-level-list button').first().click();
        await page.waitForFunction(() => window.__hillwheel?.phase === 'countdown');
        await page.screenshot({ path: SHOT('countdown', vp) });
        if ((await playRunToResults(page, vp)) !== 'finished') {
          console.log('  note: stage 1 did not finish cleanly (see terminal above)');
        }
      });

      await step('progression persisted', async () => {
        const prog = await page.evaluate(() => JSON.parse(localStorage.getItem('hillwheel-progress-v1')));
        if (!prog || typeof prog.lastStage !== 'number') throw new Error('progress not persisted');
        console.log('  stagesCompleted:', JSON.stringify(prog.stagesCompleted), 'lastStage:', prog.lastStage);
      });

      await step('next stage -> pause -> resume -> quit to title', async () => {
        await page.click('button:has-text("Next stage")');
        await waitActive(page);
        const stage = await page.evaluate(() => window.__hillwheel.levelMeta.id);
        if (stage !== 'stage-02') throw new Error('expected stage-02, got ' + stage);
        await page.keyboard.press('Escape');
        await page.waitForSelector('.hw-panel h1:text-is("Paused")', { timeout: 5000 });
        if (!(await page.$('.hw-panel #hw-gfx'))) throw new Error('Graphics section missing from pause');
        await page.screenshot({ path: SHOT('pause', vp) });
        await page.click('button:has-text("Resume")');
        await page.waitForFunction(() => window.__hillwheel?.phase === 'active');
        await page.keyboard.press('KeyP');
        await page.waitForSelector('.hw-panel h1:text-is("Paused")', { timeout: 5000 });
        await page.click('button:has-text("Quit to title")');
        await page.waitForFunction(() => window.__hillwheel?.phase === 'title');
      });

      await step('practice mode runs with undo available', async () => {
        await page.click('.hw-panel .hw-btn-mode:has-text("Practice")');
        await page.waitForSelector('.hw-level-list', { timeout: 5000 });
        await page.click('button:has-text("Easy hills")');
        await waitActive(page);
        if ((await page.evaluate(() => window.__hillwheel.mode)) !== 'practice') throw new Error('not in practice mode');
        await page.keyboard.down('ArrowUp');
        await page.waitForTimeout(2500);
        await page.keyboard.up('ArrowUp');
        const x = await page.evaluate(() => window.__hillwheel.session.state.vehicle.x);
        if (!(x > 2)) throw new Error('vehicle did not move under throttle, x=' + x);
        await page.screenshot({ path: SHOT('practice', vp) });
        await page.keyboard.press('Escape');
        await page.waitForSelector('.hw-panel h1:text-is("Paused")', { timeout: 5000 });
        await page.click('button:has-text("Quit to title")');
        await page.waitForFunction(() => window.__hillwheel?.phase === 'title');
      });
    } else {
      await step('quick play -> countdown -> active with pedals', async () => {
        await page.click('button:has-text("Quick play")');
        await waitActive(page);
        for (const label of ['GAS', 'BRAKE']) {
          const box = await page.locator('.hw-pedal', { hasText: label }).boundingBox();
          if (!box || box.width < 44 || box.height < 44) {
            throw new Error(`pedal ${label} target too small: ${box && `${Math.round(box.width)}x${Math.round(box.height)}`}`);
          }
        }
      });

      await step('touch GAS pedal drives vehicle', async () => {
        const pedal = page.locator('.hw-pedal', { hasText: 'GAS' });
        await pedal.dispatchEvent('pointerdown');
        await page.waitForTimeout(1500);
        await pedal.dispatchEvent('pointerup');
        const x = await page.evaluate(() => window.__hillwheel.session.state.vehicle.x);
        if (!(x > 0.5)) throw new Error('pedal did not drive vehicle, x=' + x);
      });

      await step('stage 1 driven to results on mobile', async () => {
        await playRunToResults(page, vp);
      });

      await step('pause via HUD button, resume, quit', async () => {
        await page.click('button:has-text("Restart")');
        await waitActive(page);
        await page.click('button[aria-label="Pause"]');
        await page.waitForSelector('.hw-panel h1:text-is("Paused")', { timeout: 5000 });
        await page.click('button:has-text("Resume")');
        await page.waitForFunction(() => window.__hillwheel?.phase === 'active');
        await page.click('button[aria-label="Pause"]');
        await page.click('button:has-text("Quit to title")');
        await page.waitForFunction(() => window.__hillwheel?.phase === 'title');
        await page.screenshot({ path: SHOT('back-to-title', vp) });
      });
    }
  } finally {
    if (errors.length) {
      console.log(`PAGE ERRORS (${vp}):\n` + errors.join('\n'));
      await context.close();
      throw new Error(`${errors.length} page error(s) during ${vp} pass`);
    }
    await context.close();
  }
}

const server = await startServer();
const base = `http://127.0.0.1:${server.address().port}`;
console.log('serving', ROOT, 'at', base);
const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
});

try {
  await runPass(browser, base, 'desktop');
  await runPass(browser, base, 'mobile');
  console.log('\nHILLWHEEL E2E PASS — desktop + mobile, no page errors');
} finally {
  await browser.close();
  server.close();
}
