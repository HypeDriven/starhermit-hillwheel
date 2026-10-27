// The progress document the native client saves (progress.js): normalising
// anything read, the two-device merge (the browser build's saveconflict merge,
// symmetric), and migrating the browser build's cloud save
// ({ schemaVersion, savedAt, progress, settings } under game:<slug>) and its
// account settings. The signed-in paths can't be live-tested here, so their
// logic is covered by these pure functions. Run: node --test tests/progress.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PROGRESS, DEFAULT_SETTINGS, merge, normalize, pickSettings, readForeign } from '../progress.js';

test('normalize fills defaults and drops invalid fields', () => {
	assert.deepEqual(normalize(null), DEFAULT_PROGRESS);
	const n = normalize({ stagesCompleted: { 'stage-01': '1377', bad: 'x' }, tutorialDone: ['tut-throttle', 3, 'tut-throttle'], lastStage: 99, totalDistance: -5, runsPlayed: 2.7 });
	assert.deepEqual(n.stagesCompleted, { 'stage-01': 1377 });
	assert.deepEqual(n.tutorialDone, ['tut-throttle']);
	assert.equal(n.lastStage, 39);
	assert.equal(n.totalDistance, 0);
	assert.equal(n.runsPlayed, 2);
	assert.deepEqual(n.dailyBest, {});
});

test('merge keeps the best of both devices', () => {
	const a = { stagesCompleted: { 'stage-01': 1300, 'stage-02': 900 }, tutorialDone: ['tut-throttle'], achievements: ['first_finish'], lastStage: 2, totalDistance: 900, runsPlayed: 4, dailyBest: { 'daily-2026-10-27': 1200 } };
	const b = { stagesCompleted: { 'stage-01': 1400, 'stage-03': 800 }, tutorialDone: ['tut-brake'], achievements: ['first_finish', 'streak_3'], lastStage: 1, totalDistance: 1200, runsPlayed: 3, dailyBest: { 'daily-2026-10-27': 1100, 'daily-2026-10-26': 1000 } };
	const m = merge(a, b);
	assert.deepEqual(m.stagesCompleted, { 'stage-01': 1400, 'stage-02': 900, 'stage-03': 800 });
	assert.deepEqual(m.tutorialDone.sort(), ['tut-brake', 'tut-throttle']);
	assert.deepEqual(m.achievements.sort(), ['first_finish', 'streak_3']);
	assert.equal(m.lastStage, 2);
	assert.equal(m.totalDistance, 1200);
	assert.equal(m.runsPlayed, 4);
	assert.deepEqual(m.dailyBest, { 'daily-2026-10-27': 1200, 'daily-2026-10-26': 1000 });
	assert.deepEqual(merge(b, a), m, 'symmetric');
	assert.deepEqual(merge(a, null), normalize(a), 'nothing remote');
});

test('the browser build cloud save migrates its progress and options', () => {
	const old = JSON.stringify({
		schemaVersion: 1, savedAt: 1760000000000,
		progress: { stagesCompleted: { 'stage-01': 1377 }, tutorialDone: [], achievements: ['first_finish'], lastStage: 1, totalDistance: 220, runsPlayed: 1 },
		settings: { volumes: { music: 70 }, graphics: {}, leftHanded: true, holdToDrive: false, palette: 'tritanopia', telemetryConsent: true, muted: false, reducedMotion: true },
	});
	const doc = readForeign(old);
	assert.deepEqual(doc.progress.stagesCompleted, { 'stage-01': 1377 });
	assert.equal(doc.progress.lastStage, 1);
	assert.deepEqual(doc.settings, { leftHanded: true, holdToDrive: false, telemetryConsent: true, palette: 'tritanopia' });
	assert.equal(readForeign('not json'), null);
	assert.equal(readForeign(JSON.stringify({ v: 1 })), null);
	assert.equal(readForeign(null), null);
});

test('old account settings: only the game options with valid values carry over', () => {
	assert.deepEqual(pickSettings({ leftHanded: 'yes', palette: 'sepia', holdToDrive: true }), { holdToDrive: true });
	assert.deepEqual(pickSettings(null), {});
	assert.deepEqual(DEFAULT_SETTINGS, { leftHanded: false, holdToDrive: true, palette: 'default', telemetryConsent: false });
});
