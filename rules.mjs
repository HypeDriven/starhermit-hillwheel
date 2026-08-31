// Hillwheel rules: pure deterministic state transitions, legality, scoring, seeded random stream.
// No rendering, no DOM, no timers. Fixed simulation step. All randomness flows through
// seeded mulberry32 streams. State is plain serializable data.

export const SCHEMA_VERSION = 2;
export const TICK_RATE = 60;                 // fixed simulation steps per second
export const DT = 1 / TICK_RATE;             // fixed step (s)
export const INPUT_QUANT = 1000;             // inputs are quantized to 1/1000

// Physics constants (game units; 1 unit = 1 meter of terrain).
export const GRAVITY = 22;
export const ENGINE_ACCEL = 14;
export const BRAKE_DECEL = 26;
export const ROLLING_DRAG = 0.35;
export const AIR_DRAG = 0.02;
export const TILT_TORQUE = 5.2;
export const GROUND_ALIGN = 10;
export const FUEL_BURN = 0.55;               // fuel per second at full throttle
export const FUEL_CAN_VALUE = 30;
export const COLLECT_RADIUS = 2.4;
export const MAX_SAFE_LANDING_ANGLE = 0.85;  // rad vs slope
export const MAX_SAFE_IMPACT = 26;           // normal velocity on touchdown
export const MAX_TICKS = TICK_RATE * 300;    // bounded duration: 5 sim-minutes

export const TERMINAL = {
	FINISHED: 'finished',
	OUT_OF_FUEL: 'out_of_fuel',
	CRASHED: 'crashed',
	TIMEOUT: 'timeout',
	ABANDONED: 'abandoned',
};

export function mulberry32(seed) {
	let a = seed >>> 0;
	return function () {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function quantizeInput(v) {
	return Math.max(-INPUT_QUANT, Math.min(INPUT_QUANT, Math.round(v * INPUT_QUANT)));
}

// --- Terrain ----------------------------------------------------------------
// Deterministic heightfield: seeded sum of sines. Same for rules and render.

export function createTerrain(seed, roughness = 1, length = 600) {
	const rand = mulberry32((seed ^ 0x51ed) >>> 0);
	const octaves = [];
	const n = 5;
	for (let i = 0; i < n; i++) {
		const wavelength = 160 / Math.pow(2, i) + rand() * 15;
		octaves.push({
			// fBm-style: amplitude proportional to wavelength keeps slopes sane.
			amp: roughness * wavelength * 0.055 * (0.8 + rand() * 0.4),
			freq: (Math.PI * 2) / wavelength,
			phase: rand() * Math.PI * 2,
		});
	}
	function height(x) {
		if (x <= 0) return heightRaw(0);
		if (x >= length) return heightRaw(length);
		return heightRaw(x);
	}
	function heightRaw(x) {
		let h = 0;
		for (let i = 0; i < octaves.length; i++) {
			const o = octaves[i];
			h += o.amp * Math.sin(o.freq * x + o.phase);
		}
		// Gentle start zone so spawn is flat-ish.
		const ramp = Math.min(1, x / 30);
		return h * (0.15 + 0.85 * ramp);
	}
	function slope(x) {
		const e = 0.25;
		return Math.atan2(height(x + e) - height(x - e), 2 * e);
	}
	return { height, slope, length, octaves };
}

// --- Content placement (deterministic from seed) ----------------------------

export function placeContent(seed, terrain, opts = {}) {
	const rand = mulberry32((seed ^ 0xcafe) >>> 0);
	const length = terrain.length;
	const checkpointCount = opts.checkpoints ?? Math.max(2, Math.round(length / 180));
	const checkpoints = [];
	for (let i = 1; i <= checkpointCount; i++) {
		checkpoints.push(Math.round((length * i) / (checkpointCount + 1)));
	}
	const cans = [];
	const canCount = opts.fuelCans ?? Math.round(length / 110);
	for (let i = 0; i < canCount; i++) {
		const x = Math.round(40 + rand() * (length - 90));
		cans.push({ x, taken: false });
	}
	cans.sort((a, b) => a.x - b.x);
	return { checkpoints, cans, goalX: length };
}

// --- State ------------------------------------------------------------------

export function createState(config) {
	const terrain = createTerrain(config.seed, config.roughness ?? 1, config.length ?? 600);
	const content = placeContent(config.seed, terrain, config);
	const startY = terrain.height(0);
	return {
		schema: SCHEMA_VERSION,
		seed: config.seed >>> 0,
		mode: config.mode || 'practice',
		roughness: config.roughness ?? 1,
		tick: 0,
		maxTicks: config.maxTicks ?? MAX_TICKS,
		terminalReason: null,
		invalidActions: 0,
		vehicle: {
			x: 0, y: startY + 0.9,
			vx: 0, vy: 0,
			angle: terrain.slope(0), av: 0,
			grounded: true,
			fuel: config.fuel ?? 100,
			fuelMax: config.fuel ?? 100,
		},
		terrain, // functions; excluded from serialization (rebuilt from seed)
		checkpoints: content.checkpoints,
		cans: content.cans,
		goalX: content.goalX,
		nextCheckpoint: 0,
		cansCollected: 0,
		smoothLandings: 0,
		wasAirborne: false,
		airTime: 0,
		input: { throttle: 0, brake: 0, tilt: 0 },
	};
}

export function serializeState(state) {
	const { terrain, ...rest } = state;
	return JSON.parse(JSON.stringify(rest));
}

export function deserializeState(data) {
	const state = migrateState(JSON.parse(JSON.stringify(data)));
	state.terrain = createTerrain(state.seed, state.roughness, state.goalX);
	return state;
}

export function migrateState(data) {
	if (!data || typeof data !== 'object') throw new Error('bad state');
	if (data.schema === SCHEMA_VERSION) return data;
	if (data.schema === 1) {
		// v1 -> v2: gain explicit schema/maxTicks; terrain rebuildable from seed.
		data.schema = SCHEMA_VERSION;
		if (typeof data.maxTicks !== 'number') data.maxTicks = MAX_TICKS;
		return data;
	}
	throw new Error('unsupported state schema ' + data.schema);
}

// FNV-1a over a stable numeric projection of the sim state.
export function hashState(state) {
	const v = state.vehicle;
	const nums = [
		state.seed, state.tick, state.invalidActions,
		Math.round(v.x * 1000), Math.round(v.y * 1000),
		Math.round(v.vx * 1000), Math.round(v.vy * 1000),
		Math.round(v.angle * 10000), Math.round(v.av * 1000),
		Math.round(v.fuel * 1000), v.grounded ? 1 : 0,
		state.nextCheckpoint, state.cansCollected, state.smoothLandings,
		state.terminalReason ? state.terminalReason.length : 0,
	];
	let h = 2166136261 >>> 0;
	for (let i = 0; i < nums.length; i++) {
		h ^= nums[i] >>> 0;
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

// --- Legality ----------------------------------------------------------------
// Tutorials and hints call this same API used by play.

export function legalActions(state) {
	const t = state.terminalReason;
	const v = state.vehicle;
	const dead = t !== null;
	const out = [
		{ action: 'throttle', legal: !dead && v.fuel > 0, reason: dead ? 'round_over' : v.fuel > 0 ? null : 'no_fuel' },
		{ action: 'brake', legal: !dead && (Math.abs(v.vx) > 0.05 || !v.grounded), reason: dead ? 'round_over' : (Math.abs(v.vx) > 0.05 || !v.grounded) ? null : 'already_stopped' },
		{ action: 'tilt_left', legal: !dead, reason: dead ? 'round_over' : null },
		{ action: 'tilt_right', legal: !dead, reason: dead ? 'round_over' : null },
		{ action: 'pause', legal: true, reason: null },
	];
	return out;
}

export function isLegal(state, action) {
	const entry = legalActions(state).find((a) => a.action === action);
	if (!entry) return { legal: false, reason: 'unknown_action' };
	return { legal: entry.legal, reason: entry.reason };
}

// --- Simulation step ----------------------------------------------------------
// input: { throttle, brake, tilt } each quantized -1000..1000 (tilt) or 0..1000.

export function step(state, rawInput) {
	if (state.terminalReason) return state;
	const input = {
		throttle: Math.max(0, Math.min(INPUT_QUANT, quantizeInput(rawInput?.throttle ?? 0))) / INPUT_QUANT,
		brake: Math.max(0, Math.min(INPUT_QUANT, quantizeInput(rawInput?.brake ?? 0))) / INPUT_QUANT,
		tilt: Math.max(-INPUT_QUANT, Math.min(INPUT_QUANT, quantizeInput(rawInput?.tilt ?? 0))) / INPUT_QUANT,
	};
	state.input = input;
	const v = state.vehicle;
	const T = state.terrain;
	const dt = DT;

	if (v.fuel > 0 && input.throttle > 0) {
		v.fuel = Math.max(0, v.fuel - input.throttle * FUEL_BURN * dt * 10);
	}

	const groundY = T.height(v.x);
	const slopeAng = T.slope(v.x);

	if (v.grounded) {
		// Drive along the slope.
		const cosS = Math.cos(slopeAng), sinS = Math.sin(slopeAng);
		let speed = v.vx * cosS + v.vy * sinS;
		const grade = -GRAVITY * sinS * 0.55; // gravity along slope
		speed += (grade + input.throttle * ENGINE_ACCEL - input.brake * BRAKE_DECEL * Math.sign(speed)) * dt;
		speed -= speed * ROLLING_DRAG * dt;
		if (input.brake > 0 && Math.abs(speed) < 0.4) speed = 0;
		v.vx = cosS * speed;
		v.vy = sinS * speed;
		v.x += v.vx * dt;
		v.y = T.height(v.x) + 0.9;
		// Wheels leave ground on crests.
		const newSlope = T.slope(v.x);
		if (v.y + v.vy * dt > T.height(v.x + v.vx * dt) + 0.9 + Math.abs(v.vx) * dt * Math.tan(0.12)) {
			if (newSlope < slopeAng - 0.06 && speed > 3) {
				v.grounded = false;
				state.wasAirborne = true;
				state.airTime = 0;
			}
		}
		// Align body to slope.
		const target = newSlope;
		let diff = target - v.angle;
		v.av += diff * GROUND_ALIGN * dt;
		v.av -= v.av * 6 * dt;
		v.angle += v.av * dt;
	} else {
		// Airborne: gravity + pitch control only.
		v.vy -= GRAVITY * dt;
		v.vx -= v.vx * AIR_DRAG * dt;
		v.av += input.tilt * TILT_TORQUE * dt;
		v.av -= v.av * 1.6 * dt;
		v.angle += v.av * dt;
		v.x += v.vx * dt;
		v.y += v.vy * dt;
		state.airTime += dt;
		const g = T.height(v.x) + 0.9;
		if (v.y <= g && v.vy <= 0) {
			// Touchdown: evaluate landing quality.
			const sAng = T.slope(v.x);
			const impact = Math.abs(v.vy * Math.cos(sAng) - v.vx * Math.sin(sAng));
			const angleErr = Math.abs(normalizeAngle(v.angle - sAng));
			v.y = g;
			v.grounded = true;
			if (angleErr > MAX_SAFE_LANDING_ANGLE || impact > MAX_SAFE_IMPACT) {
				return terminate(state, TERMINAL.CRASHED);
			}
			if (angleErr < 0.18 && state.airTime > 0.35) state.smoothLandings++;
			state.airTime = 0;
			v.av *= 0.3;
		}
	}

	// Collect fuel cans.
	for (let i = 0; i < state.cans.length; i++) {
		const c = state.cans[i];
		if (c.taken) continue;
		const cy = T.height(c.x) + 1.2;
		const dx = c.x - v.x, dy = cy - v.y;
		if (dx * dx + dy * dy < COLLECT_RADIUS * COLLECT_RADIUS) {
			c.taken = true;
			state.cansCollected++;
			v.fuel = Math.min(v.fuelMax, v.fuel + FUEL_CAN_VALUE);
		}
	}

	// Checkpoints.
	while (state.nextCheckpoint < state.checkpoints.length &&
		v.x >= state.checkpoints[state.nextCheckpoint]) {
		state.nextCheckpoint++;
	}

	// Terminal conditions.
	if (!isFinite(v.x) || !isFinite(v.y) || !isFinite(v.vx) || !isFinite(v.vy)) {
		return terminate(state, TERMINAL.CRASHED);
	}
	if (v.x >= state.goalX) return terminate(state, TERMINAL.FINISHED);
	if (v.fuel <= 0 && v.grounded && Math.abs(v.vx) < 0.3) return terminate(state, TERMINAL.OUT_OF_FUEL);
	state.tick++;
	if (state.tick >= state.maxTicks) return terminate(state, TERMINAL.TIMEOUT);
	return state;
}

function normalizeAngle(a) {
	while (a > Math.PI) a -= Math.PI * 2;
	while (a < -Math.PI) a += Math.PI * 2;
	return a;
}

function terminate(state, reason) {
	state.terminalReason = reason;
	state.tick++;
	return state;
}

export function abandon(state) {
	if (!state.terminalReason) terminate(state, TERMINAL.ABANDONED);
	return state;
}

// --- Scoring ------------------------------------------------------------------
// Integers everywhere; formatting is presentation-only.

export function scoreBreakdown(state) {
	const v = state.vehicle;
	const distance = Math.max(0, Math.floor(Math.min(v.x, state.goalX)));
	const finished = state.terminalReason === TERMINAL.FINISHED;
	const checkpointBonus = state.nextCheckpoint * 100;
	const finishBonus = finished ? 500 : 0;
	const landingBonus = state.smoothLandings * 50;
	const canBonus = state.cansCollected * 25;
	const fuelBonus = finished ? Math.floor(v.fuel * 2) : Math.floor(v.fuel);
	const timeBonus = finished ? Math.max(0, Math.floor((state.maxTicks - state.tick) / TICK_RATE)) : 0;
	const total = distance + checkpointBonus + finishBonus + landingBonus + canBonus + fuelBonus + timeBonus;
	return { distance, checkpointBonus, finishBonus, landingBonus, canBonus, fuelBonus, timeBonus, total };
}

// Tie-break order: objective completion, fewer invalid actions, lower elapsed ticks, session id.
export function compareResults(a, b) {
	const fa = a.state.terminalReason === TERMINAL.FINISHED ? 1 : 0;
	const fb = b.state.terminalReason === TERMINAL.FINISHED ? 1 : 0;
	if (fa !== fb) return fb - fa;
	const sa = scoreBreakdown(a.state).total, sb = scoreBreakdown(b.state).total;
	if (sa !== sb) return sb - sa;
	if (a.state.invalidActions !== b.state.invalidActions) return a.state.invalidActions - b.state.invalidActions;
	if (a.state.tick !== b.state.tick) return a.state.tick - b.state.tick;
	return String(a.sessionId).localeCompare(String(b.sessionId));
}

// --- Commands ------------------------------------------------------------------
// Every mutation goes through a validated command.

let cmdCounter = 0;
export function makeCommand(type, payload = {}, id) {
	return { id: id ?? `cmd-${++cmdCounter}-${Date.now().toString(36)}`, type, ...payload };
}

export function applyCommand(state, cmd) {
	if (!cmd || typeof cmd !== 'object' || !cmd.id) return { ok: false, reason: 'malformed_command' };
	switch (cmd.type) {
		case 'input': {
			if (state.terminalReason) { state.invalidActions++; return { ok: false, reason: 'round_over' }; }
			if (typeof cmd.throttle !== 'number' || typeof cmd.brake !== 'number' || typeof cmd.tilt !== 'number') {
				state.invalidActions++; return { ok: false, reason: 'malformed_input' };
			}
			step(state, cmd);
			return { ok: true };
		}
		case 'abandon':
			abandon(state);
			return { ok: true };
		default:
			state.invalidActions++;
			return { ok: false, reason: 'unknown_command' };
	}
}

export default { createState, step, legalActions, scoreBreakdown, hashState };
