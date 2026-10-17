// Graphics benchmark hook for tools/gfx-bench.mjs (dev-only): picks a preset in Settings → Graphics,
// starts Journey stage 1 and drives it with real key presses (throttle feathered like a player, brake
// on steep drops, tilt in the air — the same autopilot as tests/e2e.mjs, which reads the session only to
// decide which key to hold), restarting from the results screen. The camera scrolls along the course,
// so terrain, trees, cans, flags, dust and the post chain are all in motion.
export const presets = ['low', 'balanced', 'high', 'ultra'];
export const levels = { low: 0, balanced: 4, high: 10, ultra: 17 };

export async function setPreset(page, preset) {
  await page.waitForFunction(() => window.__hillwheel?.phase === 'title', null, { timeout: 20000 });
  await page.click('.hw-panel button:has-text("Settings")');
  await page.waitForSelector('#hw-gfx');
  await page.locator('#hw-gfx-preset').scrollIntoViewIfNeeded();
  await page.selectOption('#hw-gfx-preset', preset);
  await page.waitForFunction((p) => document.querySelector('#hw-canvas').dataset.gfxPreset === p, preset);
  await page.click('button:has-text("← Back")');
  await page.waitForFunction(() => window.__hillwheel?.phase === 'title');
}

export async function start(page) {
  await page.click('.hw-panel .hw-btn-mode:has-text("Journey")');
  await page.locator('.hw-level-list button').first().click();
  await page.waitForFunction(() => window.__hillwheel?.phase === 'active', null, { timeout: 15000 });
  const held = { ArrowUp: false, ArrowDown: false, ArrowLeft: false, ArrowRight: false };
  const setKey = async (key, want) => {
    if (held[key] === want) return;
    held[key] = want;
    if (want) await page.keyboard.down(key); else await page.keyboard.up(key);
  };
  let open = true;
  page.once('close', () => { open = false; });
  const t0 = Date.now();
  (async () => {
    while (open) {
      try {
        const s = await page.evaluate(() => {
          const g = window.__hillwheel;
          if (!g || !g.session || g.phase !== 'active') return { phase: g && g.phase };
          const st = g.session.state, v = st.vehicle;
          if (st.terminalReason) return { phase: 'done' };
          let throttle = 0, brake = false, tiltL = false, tiltR = false;
          if (v.grounded) {
            const slope = st.terrain.slope(v.x);
            const ahead = st.terrain.slope(v.x + Math.max(6, v.vx * 0.8));
            const drop = st.terrain.height(v.x) - st.terrain.height(v.x + Math.max(8, v.vx * 1.2));
            throttle = slope < 0.35 ? 800 : 400;
            if (((drop > 7 || ahead < -0.6) && v.vx > 9) || (slope < -0.25 && v.vx > 10) || v.vx > 12) { brake = true; throttle = 0; }
          } else {
            const tilt = (st.terrain.slope(v.x + v.vx * 0.4) - v.angle) * 1200 - v.av * 200;
            if (tilt < -60) tiltL = true; else if (tilt > 60) tiltR = true;
          }
          return { phase: 'active', throttle, brake, tiltL, tiltR };
        });
        if (s.phase === 'active') {
          const duty = s.throttle > 0 && ((Date.now() - t0) % 250) < (250 * s.throttle) / 1000;
          await setKey('ArrowUp', duty);
          await setKey('ArrowDown', s.brake);
          await setKey('ArrowLeft', s.tiltL);
          await setKey('ArrowRight', s.tiltR);
        } else {
          for (const k of Object.keys(held)) await setKey(k, false);
          const again = page.locator('button:has-text("Try again"), button:has-text("Restart")').filter({ visible: true }).first();
          if (await again.count()) await again.click({ timeout: 3000 });
        }
      } catch (e) { if (!open) return; if (process.env.BENCH_DEBUG) console.error(e.message); }
      await page.waitForTimeout(40).catch(() => {});
    }
  })();
  await page.waitForTimeout(1500);
}
