// Hillwheel authoritative server (StarHermit game script).
// Serves the static distribution and same-origin /api routes used for:
// server time sync, daily sessions, replay-validated leaderboards,
// durable achievements, versioned cloud saves, presence/activity, telemetry.
// No external dependencies. Data persists under ./data/.

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const PORT = Number(process.env.PORT) || 8080;
const MAX_BODY = 256 * 1024;
const SERVER_VERSION = '1.0.0';
const ACCEPTED_RULESET = 2;
const ACCEPTED_CONTENT_VERSION = '2.0.0';

fs.mkdirSync(DATA_DIR, { recursive: true });

// --- persistence helpers --------------------------------------------------------

function loadJSON(name, fallback) {
	try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8')); }
	catch { return fallback; }
}
function storeJSON(name, data) {
	const tmp = path.join(DATA_DIR, name + '.tmp');
	fs.writeFileSync(tmp, JSON.stringify(data));
	fs.renameSync(tmp, path.join(DATA_DIR, name));
}

const db = {
	leaderboard: loadJSON('leaderboard.json', { entries: [] }),
	achievements: loadJSON('achievements.json', {}),   // playerId -> [keys]
	saves: loadJSON('saves.json', {}),                 // playerId -> doc
	dailyExclusions: loadJSON('daily-exclusions.json', {}),
};

// --- rules/content modules (ESM, loaded once) -------------------------------------

let rulesP = null, sessionP = null, contentP = null;
function mods() {
	if (!rulesP) {
		rulesP = import('./rules.mjs');
		sessionP = import('./session.mjs');
		contentP = import('./content.mjs');
	}
	return Promise.all([rulesP, sessionP, contentP]);
}

// --- rate limiting (per-IP token bucket) -------------------------------------------

const buckets = new Map();
function rateLimited(ip, cost = 1, capacity = 120, refillPerSec = 10) {
	const now = Date.now();
	let b = buckets.get(ip);
	if (!b) { b = { tokens: capacity, at: now }; buckets.set(ip, b); }
	b.tokens = Math.min(capacity, b.tokens + ((now - b.at) / 1000) * refillPerSec);
	b.at = now;
	if (b.tokens < cost) return true;
	b.tokens -= cost;
	return false;
}

// --- http helpers ---------------------------------------------------------------------

const MIME = {
	'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
	'.json': 'application/json', '.txt': 'text/plain; charset=utf-8',
	'.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
	'.opus': 'audio/ogg',
};

function send(res, status, data, headers = {}) {
	const body = typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data);
	res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
	res.end(body);
}
function sendError(res, status, error, headers) { send(res, status, { error }, headers); }

function readBody(req) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on('data', (c) => {
			size += c.length;
			if (size > MAX_BODY) { reject(new Error('payload_too_large')); req.destroy(); return; }
			chunks.push(c);
		});
		req.on('end', () => {
			try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
			catch { reject(new Error('invalid_json')); }
		});
		req.on('error', reject);
	});
}

function playerId(req, body) {
	// Identity is best-effort: header from host shell, else declared id, else anon hash of IP.
	return req.headers['x-player-id'] || (body && body.playerId) ||
		'anon-' + crypto.createHash('sha256').update(req.socket.remoteAddress || 'x').digest('hex').slice(0, 12);
}

// --- static files ---------------------------------------------------------------------

function serveStatic(req, res, urlPath) {
	let rel = decodeURIComponent(urlPath.split('?')[0]);
	if (rel === '/') rel = '/index.html';
	const file = path.normalize(path.join(ROOT, rel));
	if (!file.startsWith(ROOT) || file.includes('node_modules') || file.startsWith(DATA_DIR) ||
		path.basename(file).startsWith('.') || file.endsWith('.md') || file === __filename) {
		return sendError(res, 404, 'not_found');
	}
	fs.readFile(file, (err, data) => {
		if (err) return sendError(res, 404, 'not_found');
		const ext = path.extname(file).toLowerCase();
		const immutable = ext === '.js' || ext === '.mjs' || ext === '.css';
		res.writeHead(200, {
			'Content-Type': MIME[ext] || 'application/octet-stream',
			'Cache-Control': immutable ? 'public, max-age=3600' : 'no-cache',
		});
		res.end(data);
	});
}

// --- score validation ---------------------------------------------------------------------

const seenScoreIds = new Set();

async function validateScore(body) {
	// Structural validation: identity, bounds, payload shape.
	const errors = [];
	if (typeof body.sessionId !== 'string' || body.sessionId.length > 80) errors.push('bad_session');
	if (body.ruleset !== ACCEPTED_RULESET) errors.push('stale_ruleset');
	if (body.contentVersion !== ACCEPTED_CONTENT_VERSION) errors.push('stale_content_version');
	if (!Number.isInteger(body.seed) || body.seed < 0) errors.push('bad_seed');
	if (!body.breakdown || !Number.isInteger(body.breakdown.total)) errors.push('bad_breakdown');
	if (!Array.isArray(body.commands)) errors.push('bad_input_log');
	if (!body.config || typeof body.config !== 'object') errors.push('bad_config');
	if (!Number.isInteger(body.durationTicks) || body.durationTicks < 0 || body.durationTicks > 60 * 60 * 10) errors.push('bad_duration');
	if (errors.length) return { ok: false, errors };

	// Authoritative replay validation for competitive (daily) boards.
	if (body.mode === 'daily') {
		const [, sessionMod, contentMod] = await mods();
		const date = new Date().toISOString().slice(0, 10);
		const daily = contentMod.dailyContent(date);
		if (body.contentId !== daily.id) return { ok: false, errors: ['stale_daily'] };
		if (db.dailyExclusions[date]) return { ok: false, errors: ['daily_excluded'] };
		if ((body.seed >>> 0) !== daily.seed) return { ok: false, errors: ['seed_mismatch'] };
		const replay = {
			replaySchema: 2, contentVersion: body.contentVersion, rulesSchema: body.ruleset,
			seed: body.seed, config: body.config, initialHash: body.initialHash,
			commands: body.commands, hashLog: body.hashLog || [],
			terminal: { sessionId: body.sessionId, hash: body.terminalHash },
		};
		const check = sessionMod.verifyReplay(replay);
		if (!check.ok) return { ok: false, errors: ['replay_invalid:' + check.reason] };
		const serverTotal = check.result.breakdown.total;
		if (serverTotal !== body.breakdown.total) return { ok: false, errors: ['score_mismatch'] };
		if (check.result.terminalReason !== body.terminalReason) return { ok: false, errors: ['terminal_mismatch'] };
		return { ok: true, validated: true, breakdown: check.result.breakdown, ticks: check.result.ticks };
	}

	// Casual boards: plausibility + rate checks only; labeled casual.
	const plaus = body.breakdown;
	const maxPlausible = (body.config.length || 1000) + 2000 + (body.config.fuel || 100) * 2 + 5000;
	if (plaus.total < 0 || plaus.total > maxPlausible) return { ok: false, errors: ['implausible_score'] };
	return { ok: true, validated: false, breakdown: body.breakdown, ticks: body.durationTicks };
}

// --- API routes -------------------------------------------------------------------------

async function handleApi(req, res, urlPath, query) {
	const ip = req.socket.remoteAddress || 'unknown';
	if (rateLimited(ip)) return sendError(res, 429, 'rate_limited', { 'Retry-After': '2' });

	if (urlPath === '/api/v1/time' && req.method === 'GET') {
		return send(res, 200, { serverTime: Date.now(), date: new Date().toISOString().slice(0, 10), version: SERVER_VERSION });
	}

	if (urlPath === '/api/v1/daily' && req.method === 'GET') {
		const [, , contentMod] = await mods();
		const date = new Date().toISOString().slice(0, 10);
		const d = contentMod.dailyContent(date);
		d.excluded = !!db.dailyExclusions[date];
		return send(res, 200, d);
	}

	if (urlPath === '/api/v1/scores' && req.method === 'POST') {
		if (rateLimited(ip, 5)) return sendError(res, 429, 'rate_limited', { 'Retry-After': '5' });
		const body = await readBody(req);
		if (seenScoreIds.has(body.sessionId)) {
			return send(res, 200, { accepted: true, duplicate: true }); // idempotent
		}
		const v = await validateScore(body);
		if (!v.ok) return sendError(res, 422, 'rejected:' + v.errors.join(','));
		seenScoreIds.add(body.sessionId);
		const entry = {
			id: body.sessionId, player: playerId(req, body), name: body.name || 'Driver',
			contentId: body.contentId, mode: body.mode, seed: body.seed >>> 0,
			score: v.breakdown.total, breakdown: v.breakdown,
			finished: body.terminalReason === 'finished',
			invalidActions: body.breakdown.invalidActions || 0,
			durationTicks: v.ticks, ruleset: body.ruleset, contentVersion: body.contentVersion,
			assists: body.assists || {}, validated: v.validated, board: v.validated ? 'ranked' : 'casual',
			at: Date.now(),
		};
		db.leaderboard.entries.push(entry);
		if (db.leaderboard.entries.length > 5000) db.leaderboard.entries = db.leaderboard.entries.slice(-4000);
		storeJSON('leaderboard.json', db.leaderboard);
		return send(res, 200, { accepted: true, validated: v.validated, board: entry.board });
	}

	if (urlPath === '/api/v1/leaderboard' && req.method === 'GET') {
		const board = query.get('board') || 'global';
		const contentId = query.get('content');
		let entries = db.leaderboard.entries.filter((e) => !contentId || e.contentId === contentId);
		// Tie-break: completion, score, fewer invalid actions, lower time, stable id.
		entries.sort((a, b) =>
			(b.finished - a.finished) || (b.score - a.score) ||
			(a.invalidActions - b.invalidActions) || (a.durationTicks - b.durationTicks) ||
			String(a.id).localeCompare(String(b.id)));
		if (board === 'friends') {
			const friends = (query.get('friends') || '').split(',').filter(Boolean);
			entries = entries.filter((e) => friends.includes(e.player));
		}
		return send(res, 200, { entries: entries.slice(0, 100), casual: entries.some((e) => !e.validated) });
	}

	if (urlPath === '/api/v1/achievements' && req.method === 'POST') {
		const body = await readBody(req);
		const key = body.key;
		if (typeof key !== 'string' || !/^[a-z0-9_]{3,40}$/.test(key)) return sendError(res, 422, 'bad_key');
		const pid = playerId(req, body);
		const owned = db.achievements[pid] || (db.achievements[pid] = []);
		if (!owned.includes(key)) { owned.push(key); storeJSON('achievements.json', db.achievements); }
		return send(res, 200, { unlocked: true, duplicate: owned.includes(key) });
	}

	if (urlPath === '/api/v1/achievements' && req.method === 'GET') {
		const pid = playerId(req, null);
		return send(res, 200, { achievements: db.achievements[pid] || [] });
	}

	if (urlPath === '/api/v1/save' && req.method === 'GET') {
		const pid = playerId(req, null);
		return send(res, 200, { doc: db.saves[pid] || null });
	}

	if (urlPath === '/api/v1/save' && req.method === 'PUT') {
		const body = await readBody(req);
		const doc = body.doc || body;
		if (!doc || doc.version !== 2 || typeof doc.checksum !== 'string') return sendError(res, 422, 'bad_save_doc');
		const { checksum, ...rest } = doc;
		const expect = crypto.createHash('sha256').update(JSON.stringify(rest)).digest('hex');
		if (checksum !== expect) return sendError(res, 422, 'checksum_mismatch');
		const pid = playerId(req, body);
		const existing = db.saves[pid];
		// Conflict handling: keep both snapshots; strict descendant wins automatically.
		if (existing && existing.rev > doc.rev) {
			storeJSON('saves.json', db.saves);
			return send(res, 200, { stored: false, conflict: true, kept: 'server', server: existing });
		}
		db.saves[pid] = doc;
		storeJSON('saves.json', db.saves);
		return send(res, 200, { stored: true, conflict: false });
	}

	if (urlPath === '/api/v1/presence' && req.method === 'POST') { await readBody(req); return send(res, 200, { ok: true }); }
	if (urlPath === '/api/v1/activity/start' && req.method === 'POST') { await readBody(req); return send(res, 200, { ok: true, at: Date.now() }); }
	if (urlPath === '/api/v1/activity/end' && req.method === 'POST') { await readBody(req); return send(res, 200, { ok: true, at: Date.now() }); }

	if (urlPath === '/api/v1/telemetry' && req.method === 'POST') {
		if (rateLimited(ip, 3)) return sendError(res, 429, 'rate_limited', { 'Retry-After': '5' });
		const body = await readBody(req);
		const allowed = ['start', 'tutorial_step', 'round_end', 'retry', 'settings_change', 'error'];
		if (!allowed.includes(body.event)) return sendError(res, 422, 'bad_event');
		// Aggregate only; nothing raw is stored.
		const agg = loadJSON('telemetry.json', {});
		agg[body.event] = (agg[body.event] || 0) + 1;
		storeJSON('telemetry.json', agg);
		return send(res, 200, { ok: true });
	}

	return sendError(res, 404, 'not_found');
}

// --- server -------------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
	try {
		const u = new URL(req.url, 'http://localhost');
		if (u.pathname.startsWith('/api/')) return await handleApi(req, res, u.pathname, u.searchParams);
		if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 405, 'method_not_allowed');
		return serveStatic(req, res, u.pathname);
	} catch (err) {
		const msg = err && err.message === 'payload_too_large' ? 'payload_too_large'
			: err && err.message === 'invalid_json' ? 'invalid_json' : 'internal_error';
		return sendError(res, msg === 'internal_error' ? 500 : 400, msg);
	}
});

if (require.main === module) {
	server.listen(PORT, () => console.log(`Hillwheel server listening on :${PORT}`));
}

module.exports = { server, validateScore, rateLimited };
