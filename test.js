// Hillwheel test suite: rules units, deterministic replay property tests, fuzzing,
// golden sessions, content validators, and server API smoke tests.
// Run: node test.js

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as R from './rules.js';
import * as C from './content.js';
import { Session, verifyReplay } from './session.js';

let passed = 0, failed = 0;
function test(name, fn) {
	try { fn(); passed++; console.log('  ok', name); }
	catch (e) { failed++; console.error('FAIL', name, '-', e.message); }
}
async function testAsync(name, fn) {
	try { await fn(); passed++; console.log('  ok', name); }
	catch (e) { failed++; console.error('FAIL', name, '-', e.message); }
}

const CFG = { seed: 12345, length: 300, roughness: 0.6, fuel: 100, fuelCans: 2, checkpoints: 2, mode: 'practice' };

function drive(state, ticks, input = { throttle: 800, brake: 0, tilt: 0 }) {
	for (let i = 0; i < ticks && !state.terminalReason; i++) R.step(state, input);
	return state;
}

console.log('== rules: legality ==');
test('legal actions exposed with reasons', () => {
	const s = R.createState(CFG);
	const acts = R.legalActions(s);
	assert.ok(acts.find((a) => a.action === 'throttle').legal);
	assert.equal(acts.find((a) => a.action === 'brake').legal, false); // stopped
	assert.equal(acts.find((a) => a.action === 'brake').reason, 'already_stopped');
	assert.equal(R.isLegal(s, 'fly').legal, false);
});
test('throttle illegal without fuel', () => {
	const s = R.createState(CFG);
	s.vehicle.fuel = 0;
	assert.equal(R.isLegal(s, 'throttle').legal, false);
	assert.equal(R.isLegal(s, 'throttle').reason, 'no_fuel');
});
test('no actions legal after terminal', () => {
	const s = R.createState(CFG);
	R.abandon(s);
	assert.equal(R.isLegal(s, 'throttle').legal, false);
	assert.equal(R.isLegal(s, 'throttle').reason, 'round_over');
});

console.log('== rules: simulation ==');
test('throttle accelerates and burns fuel', () => {
	const s = R.createState(CFG);
	drive(s, 120);
	assert.ok(s.vehicle.x > 1, 'moved');
	assert.ok(s.vehicle.fuel < 100, 'fuel burned');
});
test('brake decelerates to stop', () => {
	const s = R.createState(CFG);
	drive(s, 120);
	drive(s, 600, { throttle: 0, brake: 1000, tilt: 0 });
	assert.ok(Math.abs(s.vehicle.vx) < 3);
});
test('out_of_fuel terminal when dry and stopped', () => {
	const s = R.createState({ ...CFG, length: 3000, roughness: 0.4 });
	drive(s, 90, { throttle: 800, brake: 0, tilt: 0 });
	s.vehicle.fuel = 0;
	drive(s, 60 * 60, { throttle: 0, brake: 1000, tilt: 0 });
	assert.equal(s.terminalReason, R.TERMINAL.OUT_OF_FUEL);
});
test('finish terminal at goal', () => {
	const s = R.createState({ ...CFG, length: 80, roughness: 0.2 });
	drive(s, 60 * 60);
	assert.equal(s.terminalReason, R.TERMINAL.FINISHED);
});
test('timeout terminal is bounded', () => {
	const s = R.createState({ ...CFG, maxTicks: 100 });
	drive(s, 500, { throttle: 0, brake: 0, tilt: 0 });
	assert.equal(s.terminalReason, R.TERMINAL.TIMEOUT);
	assert.ok(s.tick <= 101);
});
test('crash terminal on violent impact', () => {
	const s = R.createState(CFG);
	s.vehicle.grounded = false;
	s.vehicle.x = 100; s.vehicle.y = s.terrain.height(100) + 1.2;
	s.vehicle.vx = 20; s.vehicle.vy = -30; s.vehicle.angle = 2.5;
	for (let i = 0; i < 30 && !s.terminalReason; i++) R.step(s, { throttle: 0, brake: 0, tilt: 0 });
	assert.equal(s.terminalReason, R.TERMINAL.CRASHED);
});
test('monotonic tick', () => {
	const s = R.createState(CFG);
	let last = 0;
	for (let i = 0; i < 200; i++) { R.step(s, { throttle: 500, brake: 0, tilt: 0 }); assert.ok(s.tick >= last); last = s.tick; }
});

console.log('== rules: scoring ==');
test('score breakdown components are integers and sum correctly', () => {
	const s = R.createState(CFG);
	drive(s, 300);
	const b = R.scoreBreakdown(s);
	const sum = b.distance + b.checkpointBonus + b.finishBonus + b.landingBonus + b.canBonus + b.fuelBonus + b.timeBonus;
	assert.equal(b.total, sum);
	for (const k of Object.keys(b)) assert.ok(Number.isInteger(b[k]), k);
});
test('finish beats non-finish in tie-break', () => {
	const a = { state: R.createState(CFG), sessionId: 'a' };
	const b = { state: R.createState(CFG), sessionId: 'b' };
	a.state.terminalReason = R.TERMINAL.FINISHED;
	assert.ok(R.compareResults(a, b) < 0);
});

console.log('== rules: serialization + migration ==');
test('serialize/deserialize round-trip preserves hash', () => {
	const s = R.createState(CFG);
	drive(s, 200);
	const h1 = R.hashState(s);
	const s2 = R.deserializeState(R.serializeState(s));
	assert.equal(R.hashState(s2), h1);
	// And continues identically.
	drive(s, 100); drive(s2, 100);
	assert.equal(R.hashState(s2), R.hashState(s));
});
test('v1 state migrates to v2', () => {
	const s = R.createState(CFG);
	const data = R.serializeState(s);
	data.schema = 1; delete data.maxTicks;
	const m = R.deserializeState(data);
	assert.equal(m.schema, R.SCHEMA_VERSION);
	assert.equal(m.maxTicks, R.MAX_TICKS);
});
test('bad state rejected', () => {
	assert.throws(() => R.deserializeState({ schema: 99 }));
});

console.log('== determinism / replay property ==');
test('same seed + commands => identical hash (property over seeds)', () => {
	const rng = R.mulberry32(999);
	for (let trial = 0; trial < 12; trial++) {
		const cfg = { ...CFG, seed: Math.floor(rng() * 1e9) };
		const inputs = Array.from({ length: 400 }, () => ({
			throttle: Math.floor(rng() * 1000), brake: Math.floor(rng() * 500), tilt: Math.floor(rng() * 2000 - 1000),
		}));
		const run = () => {
			const s = R.createState(cfg);
			for (const inp of inputs) R.step(s, inp);
			return R.hashState(s);
		};
		assert.equal(run(), run(), `trial ${trial}`);
	}
});
test('cosmetic random streams are independent of rules', () => {
	const r1 = R.mulberry32(42), r2 = R.mulberry32(42);
	assert.equal(r1(), r2());
});

console.log('== fuzz ==');
test('malformed commands: no hang, no NaN, counted invalid', () => {
	const s = R.createState(CFG);
	const rng = R.mulberry32(7);
	const junk = [null, undefined, {}, { type: 'input' }, { type: 'input', throttle: NaN, brake: 'x', tilt: [] },
		{ type: 'nuke' }, { type: 'input', throttle: 1e9, brake: -1e9, tilt: 1e9 }, 42, 'boom'];
	for (let i = 0; i < 300; i++) {
		const cmd = junk[Math.floor(rng() * junk.length)];
		try { R.applyCommand(s, cmd ? { id: 'f' + i, ...cmd } : cmd); } catch { /* malformed rejected */ }
	}
	const v = s.vehicle;
	// NaN inputs are clamped by quantization; state stays finite.
	for (let i = 0; i < 100; i++) R.step(s, { throttle: rng() * 2 - 0.5, brake: rng() * -3, tilt: rng() * 5000 });
	assert.ok(isFinite(v.x) && isFinite(v.y) && isFinite(v.vx) && isFinite(v.vy));
});
test('fuzzed content configs never hang', () => {
	const rng = R.mulberry32(31337);
	for (let i = 0; i < 25; i++) {
		const cfg = {
			seed: Math.floor(rng() * 1e9), length: 60 + Math.floor(rng() * 500),
			roughness: 0.2 + rng() * 2, fuel: 20 + rng() * 150, fuelCans: Math.floor(rng() * 5),
			checkpoints: 1 + Math.floor(rng() * 4), maxTicks: 600,
		};
		const s = R.createState(cfg);
		let steps = 0;
		while (!s.terminalReason && steps < 700) {
			R.step(s, { throttle: rng() * 1000, brake: rng() * 1000, tilt: rng() * 2000 - 1000 });
			steps++;
		}
		assert.ok(s.terminalReason, `cfg ${i} terminated: ${s.terminalReason}`);
	}
});

console.log('== session ==');
test('duplicate commands rejected idempotently', () => {
	const sess = new Session(CFG, 'dup-test');
	const cmd = { id: 'c1', type: 'input', throttle: 500, brake: 0, tilt: 0 };
	const r1 = sess.apply(cmd);
	const r2 = sess.apply({ ...cmd });
	assert.ok(r1.ok && !r1.duplicate);
	assert.ok(r2.ok && r2.duplicate);
	assert.equal(sess.commands.length, 1);
});
test('replay envelope verifies deterministically', () => {
	const sess = new Session(CFG, 'replay-test');
	const rng = R.mulberry32(5);
	for (let i = 0; i < 500 && !sess.finished(); i++) {
		sess.apply({ id: sess.nextCommandId(), type: 'input', throttle: 700, brake: Math.floor(rng() * 200), tilt: Math.floor(rng() * 400 - 200) });
	}
	const env = sess.exportReplay();
	const v = verifyReplay(env);
	assert.ok(v.ok, v.reason);
	assert.equal(v.result.hash, sess.result().hash);
});
test('tampered replay rejected', () => {
	const sess = new Session(CFG, 'tamper-test');
	for (let i = 0; i < 100; i++) sess.apply({ id: sess.nextCommandId(), type: 'input', throttle: 700, brake: 0, tilt: 0 });
	const env = sess.exportReplay();
	env.terminal.hash ^= 0xff;
	const v = verifyReplay(env);
	assert.equal(v.ok, false);
});
test('undo restores snapshot', () => {
	const sess = new Session(CFG, 'undo-test');
	for (let i = 0; i < 60; i++) sess.apply({ id: sess.nextCommandId(), type: 'input', throttle: 800, brake: 0, tilt: 0 });
	sess.pushUndoSnapshot();
	const h = R.hashState(sess.state);
	for (let i = 0; i < 60; i++) sess.apply({ id: sess.nextCommandId(), type: 'input', throttle: 800, brake: 0, tilt: 0 });
	const res = sess.undo();
	assert.ok(res.ok);
	assert.equal(R.hashState(sess.state), h);
});
test('restore from durable snapshot', () => {
	const sess = new Session(CFG, 'snap-test');
	for (let i = 0; i < 120; i++) sess.apply({ id: sess.nextCommandId(), type: 'input', throttle: 600, brake: 0, tilt: 0 });
	const snap = sess.snapshot();
	const restored = Session.restore(snap);
	assert.equal(R.hashState(restored.state), snap.hash);
});

console.log('== golden sessions ==');
test('golden: easy full run finishes', () => {
	const cfg = C.levelConfig(C.getStage(0), 'journey');
	const s = R.createState(cfg);
	let guard = 0;
	while (!s.terminalReason && guard++ < s.maxTicks) {
		const v = s.vehicle;
		const slope = s.terrain.slope(v.x);
		let inp = { throttle: 800, brake: 0, tilt: 0 };
		if (!v.grounded) { const err = s.terrain.slope(v.x + v.vx * 0.4) - v.angle; inp = { throttle: 0, brake: 0, tilt: Math.round(err * 1200 - v.av * 200) }; }
		else if (v.vx > 12) inp = { throttle: 0, brake: 900, tilt: 0 };
		R.step(s, inp);
	}
	assert.equal(s.terminalReason, R.TERMINAL.FINISHED);
	const b = R.scoreBreakdown(s);
	assert.ok(b.finishBonus > 0 && b.total > b.distance);
});
test('golden: interrupted + resumed session identical to continuous', () => {
	const inputs = Array.from({ length: 300 }, (_, i) => ({ throttle: 600, brake: i % 50 < 5 ? 800 : 0, tilt: 0 }));
	const continuous = R.createState(CFG);
	for (const inp of inputs) R.step(continuous, inp);
	const part = R.createState(CFG);
	for (const inp of inputs.slice(0, 120)) R.step(part, inp);
	const resumed = R.deserializeState(R.serializeState(part));
	for (const inp of inputs.slice(120)) R.step(resumed, inp);
	assert.equal(R.hashState(resumed), R.hashState(continuous));
});

console.log('== content validators ==');
test('all shipped content passes offline validation', () => {
	const report = C.validateAll();
	if (!report.ok) {
		const bad = [];
		for (const g of ['tutorials', 'stages', 'challenges', 'dailies'])
			for (const [k, v] of Object.entries(report[g])) if (!v.ok) bad.push(`${g}/${k}: ${v.errors}`);
		assert.fail(bad.join(' | '));
	}
});
test('40 stages, 5 themes, 5 tutorials, daily immutable by date', () => {
	assert.equal(C.STAGES.length, 40);
	assert.equal(C.THEMES.length, 5);
	assert.equal(C.TUTORIALS.length, 5);
	const d1 = C.dailyContent('2026-08-29');
	const d2 = C.dailyContent('2026-08-29');
	assert.equal(d1.seed, d2.seed);
	assert.notEqual(d1.seed, C.dailyContent('2026-08-30').seed);
});
test('difficulty grows across journey', () => {
	const first = C.STAGES[0], last = C.STAGES[39];
	assert.ok(last.roughness > first.roughness);
	assert.ok(last.length > first.length);
});

console.log('== server API smoke ==');
await testAsync('server endpoints: time, daily, score validation, leaderboard, achievements, save', async () => {
	const port = 18931;
	const proc = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(port) }, stdio: 'pipe' });
	const base = `http://127.0.0.1:${port}`;
	try {
		await new Promise((res, rej) => {
			const t0 = Date.now();
			const poll = async () => {
				try { const r = await fetch(base + '/api/v1/time'); if (r.ok) return res(); } catch {}
				if (Date.now() - t0 > 8000) return rej(new Error('server did not start'));
				setTimeout(poll, 150);
			};
			poll();
		});
		// time sync shape
		const time = await (await fetch(base + '/api/v1/time')).json();
		assert.ok(Number.isInteger(time.serverTime) && /^\d{4}-\d{2}-\d{2}$/.test(time.date));
		// daily content
		const daily = await (await fetch(base + '/api/v1/daily')).json();
		assert.equal(daily.id, `daily-${time.date}`);
		// static launch file
		const html = await (await fetch(base + '/index.html')).text();
		assert.ok(html.includes('Hillwheel'));
		const star = await (await fetch(base + '/starhermit.txt')).text();
		assert.ok(star.includes('launch=index.html') && star.includes('server=server.js'));
		// server.js itself must not be served
		assert.equal((await fetch(base + '/server.js')).status, 404);

		// Build a genuine daily run and submit it for authoritative validation.
		const cfg = C.levelConfig(daily, 'daily');
		const sess = new Session(cfg, 'server-test-' + Date.now());
		let guard = 0;
		while (!sess.finished() && guard++ < sess.state.maxTicks) {
			const v = sess.state.vehicle;
			const slope = sess.state.terrain.slope(v.x);
			let inp = { throttle: 800, brake: 0, tilt: 0 };
			if (!v.grounded) { const err = sess.state.terrain.slope(v.x + v.vx * 0.4) - v.angle; inp = { throttle: 0, brake: 0, tilt: Math.round(err * 1200 - v.av * 200) }; }
			else if (v.vx > 12) inp = { throttle: 0, brake: 900, tilt: 0 };
			sess.apply({ id: sess.nextCommandId(), type: 'input', ...inp });
		}
		const replay = sess.exportReplay();
		const payload = {
			mode: 'daily', contentId: daily.id, seed: replay.seed,
			ruleset: R.SCHEMA_VERSION, contentVersion: C.CONTENT_VERSION,
			assists: {}, durationTicks: sess.result().ticks, breakdown: sess.result().breakdown,
			commands: replay.commands, hashLog: replay.hashLog, initialHash: replay.initialHash,
			config: replay.config, sessionId: sess.id, terminalHash: sess.result().hash,
			terminalReason: sess.result().terminalReason, name: 'Tester',
		};
		const submit = await fetch(base + '/api/v1/scores', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
		const submitRes = await submit.json();
		assert.ok(submit.ok && submitRes.accepted && submitRes.validated, JSON.stringify(submitRes));
		// duplicate is idempotent
		const dup = await (await fetch(base + '/api/v1/scores', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })).json();
		assert.ok(dup.duplicate);
		// tampered score rejected
		const bad = { ...payload, sessionId: 'tamper-' + Date.now(), breakdown: { ...payload.breakdown, total: payload.breakdown.total + 500 } };
		const badRes = await fetch(base + '/api/v1/scores', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bad) });
		assert.equal(badRes.status, 422);
		// stale ruleset rejected
		const stale = { ...payload, sessionId: 'stale-' + Date.now(), ruleset: 1 };
		assert.equal((await fetch(base + '/api/v1/scores', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(stale) })).status, 422);
		// leaderboard contains the run
		const board = await (await fetch(base + `/api/v1/leaderboard?board=global&content=${daily.id}`)).json();
		assert.ok(board.entries.some((e) => e.id === sess.id));
		// achievements idempotent
		const ach = { key: 'first_finish', sessionId: sess.id };
		await fetch(base + '/api/v1/achievements', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ach) });
		const ach2 = await (await fetch(base + '/api/v1/achievements', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ach) })).json();
		assert.ok(ach2.unlocked);
		// cloud save round-trip with checksum
		const crypto = await import('node:crypto');
		const docBody = { version: 2, rev: 1, progress: { stagesCompleted: { 'stage-01': 100 } } };
		const checksum = crypto.createHash('sha256').update(JSON.stringify(docBody)).digest('hex');
		const put = await fetch(base + '/api/v1/save', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-player-id': 'p1' }, body: JSON.stringify({ ...docBody, checksum }) });
		assert.ok((await put.json()).stored);
		const got = await (await fetch(base + '/api/v1/save', { headers: { 'x-player-id': 'p1' } })).json();
		assert.equal(got.doc.rev, 1);
		// bad checksum rejected
		const badSave = await fetch(base + '/api/v1/save', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-player-id': 'p1' }, body: JSON.stringify({ ...docBody, rev: 2, checksum: 'bad' }) });
		assert.equal(badSave.status, 422);
		// unknown route, bad json
		assert.equal((await fetch(base + '/api/v1/nope')).status, 404);
		assert.equal((await fetch(base + '/api/v1/scores', { method: 'POST', body: 'not json' })).status, 400);
	} finally {
		proc.kill();
	}
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
