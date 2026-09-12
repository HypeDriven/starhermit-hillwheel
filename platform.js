// Hillwheel platform: StarHermit REST adapter, retries, rate-limit handling,
// server-time sync, launch-token lifecycle, cloud saves, read-only leaderboards,
// telemetry consent. Uses same-origin /api routes when hosted.
// Never persists access or launch tokens. Degrades gracefully offline.
// Hosted mode activates iff a launch token was read; everything else runs
// against the local dev server (server.js) or not at all.

export const PLATFORM_SCHEMA_VERSION = 3;

const RETRY_DELAYS = [300, 900, 2700];
const MAX_BODY = 64 * 1024;
const TOKEN_REFRESH_MS = 45 * 60 * 1000;  // re-mint scoped tokens before the 60-min lifetime
const TOKEN_REFRESH_RETRY_MS = 60 * 1000;
const SAVE_DEBOUNCE_MS = 2000;
const SAVE_RETRY_MS = 30000;

// Minimal ZIP writer/reader (stored entries only, no compression).
const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();
function crc32(bytes) {
	let c = 0xffffffff;
	for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}
function zipStore(name, dataBytes) {
	const enc = new TextEncoder();
	const nameB = enc.encode(name);
	const crc = crc32(dataBytes);
	const out = [];
	const u16 = (v) => out.push(v & 0xff, (v >> 8) & 0xff);
	const u32 = (v) => out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
	u32(0x04034b50); u16(20); u16(0); u16(0); u16(0); u16(0);
	u32(crc); u32(dataBytes.length); u32(dataBytes.length);
	u16(nameB.length); u16(0);
	const local = out.length;
	const head = new Uint8Array(out);
	const cd = [];
	const c16 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff);
	const c32 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
	c32(0x02014b50); c16(20); c16(20); c16(0); c16(0); c16(0); c16(0);
	c32(crc); c32(dataBytes.length); c32(dataBytes.length);
	c16(nameB.length); c16(0); c16(0); c16(0); c16(0); c32(0); c32(0); // attrs + local-header offset
	const cdHead = new Uint8Array(cd);
	const cdOff = head.length + nameB.length + dataBytes.length;
	const parts = [head, nameB, dataBytes, cdHead, nameB];
	const eocd = [];
	const e32 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
	const e16 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff);
	e32(0x06054b50); e16(0); e16(0); e16(1); e16(1);
	e32(cdHead.length + nameB.length); e32(cdOff); e16(0);
	parts.push(new Uint8Array(eocd));
	const total = parts.reduce((n, p) => n + p.length, 0);
	const buf = new Uint8Array(total);
	let o = 0;
	for (const p of parts) { buf.set(p, o); o += p.length; }
	return buf;
}
function unzipFirstEntry(zipBytes) {
	// Stored single-entry reader: scan local headers for compression 0.
	const dv = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
	let off = 0;
	while (off + 30 <= zipBytes.length && dv.getUint32(off, true) === 0x04034b50) {
		const method = dv.getUint16(off + 8, true);
		const size = dv.getUint32(off + 18, true);
		const nameLen = dv.getUint16(off + 26, true);
		const extraLen = dv.getUint16(off + 28, true);
		const dataOff = off + 30 + nameLen + extraLen;
		if (method !== 0) throw new Error('unsupported zip entry');
		return zipBytes.slice(dataOff, dataOff + size);
	}
	throw new Error('bad zip');
}
function bytesToBase64(bytes) {
	let s = '';
	for (let i = 0; i < bytes.length; i += 0x8000)
		s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
	return btoa(s);
}
function base64ToBytes(b64) {
	const s = atob(b64);
	const b = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
	return b;
}

function decodeJwtPayload(token) {
	const part = String(token || '').split('.')[1];
	if (!part) return null;
	try {
		const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
		return JSON.parse(atob(b64 + '='.repeat((4 - b64.length % 4) % 4)));
	} catch { return null; }
}

export class PlatformModule {
	constructor({ baseUrl = '', fetchImpl } = {}) {
		this.baseUrl = baseUrl;
		this.fetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
		this.launchToken = null;   // short-lived, in-memory only
		this.userId = null;        // JWT sub
		this.gameScope = null;     // JWT game_scope (the game slug)
		this.nickname = null;      // platform profile nickname, once loaded
		this.syncState = 'offline';// offline | syncing | saving | synced | error
		this.onChange = null;      // ui callback: nickname/sync state changed
		this.timeOffsetMs = 0;     // server time minus local time
		this.online = false;
		this.hosted = false;       // true once a launch token has been read
		this.telemetryConsent = false;
		this.sessionId = `anon-${Math.random().toString(36).slice(2, 10)}`;
		this._presenceTimer = null;
		this._refreshTimer = null;
		this._refreshing = false;
		this._saveTimer = null;
		this._saveInflight = false;
		this._pendingDoc = null;
		this._nameCache = new Map();
		this._gameInfo = null;     // cached GET /api/v1/games/{slug}
		this._devUnavailable = false; // true after a dev route 404s (no own server here)
	}

	// --- Launch token -------------------------------------------------------------
	// The host passes the token in the URL fragment (see bootstrap.js); it is held
	// in memory only, sent as a Bearer header on every REST call, and re-minted
	// periodically before its 60-minute lifetime expires.

	setLaunchToken(token) {
		this.launchToken = token || null;
		this.userId = null;
		this.gameScope = null;
		if (!token) { this.hosted = false; this._setSync('offline'); return; }
		const payload = decodeJwtPayload(token);
		this.userId = (payload && payload.sub) || null;
		this.gameScope = (payload && (payload.game_scope || payload.scope || payload.game)) || null;
		this.hosted = true;
		this._setSync('syncing');
		this._scheduleTokenRefresh();
	}

	_scheduleTokenRefresh() {
		if (this._refreshTimer) { clearTimeout(this._refreshTimer); this._refreshTimer = null; }
		if (!this.launchToken || !this.gameScope) return;
		this._refreshTimer = setTimeout(() => this._refreshToken(), TOKEN_REFRESH_MS);
	}

	async _refreshToken() {
		if (this._refreshTimer) { clearTimeout(this._refreshTimer); this._refreshTimer = null; }
		if (!this.launchToken || !this.gameScope || this._refreshing) return;
		this._refreshing = true;
		try {
			const res = await this._request(`/api/v1/games/${encodeURIComponent(this.gameScope)}/launch-token`, { method: 'POST', retries: 0 });
			if (res.ok && res.data && typeof res.data.token === 'string' && res.data.token) {
				this.launchToken = res.data.token; // swap in the re-minted scoped token
				this._scheduleTokenRefresh();
			} else {
				this._refreshTimer = setTimeout(() => this._refreshToken(), TOKEN_REFRESH_RETRY_MS);
			}
		} catch {
			this._refreshTimer = setTimeout(() => this._refreshToken(), TOKEN_REFRESH_RETRY_MS);
		} finally {
			this._refreshing = false;
		}
	}

	// --- Profile ------------------------------------------------------------------
	// Nickname comes from the user profile route only; never /api/v1/me, never
	// usernames. Falls back to "Player " + id8 when the fetch fails.

	_fallbackName(userId) { return 'Player ' + String(userId || '?').slice(0, 8); }

	async loadProfile() {
		if (!this.launchToken || !this.userId) return { ok: false, error: 'offline', recoverable: true };
		const res = await this._request(`/api/v1/users/${encodeURIComponent(this.userId)}/profile`, { retries: 1 });
		const nick = res.ok && res.data && typeof res.data.nickname === 'string' && res.data.nickname.trim()
			? res.data.nickname : null;
		this.nickname = nick || this._fallbackName(this.userId);
		this._notify();
		return { ok: res.ok, nickname: this.nickname };
	}

	async nicknameFor(userId) {
		const key = String(userId);
		if (this._nameCache.has(key)) return this._nameCache.get(key);
		const fallback = this._fallbackName(key);
		const name = await this._profileNickname(key, fallback);
		this._nameCache.set(key, name);
		return name;
	}

	async _profileNickname(userId, fallback) {
		if (!this.launchToken) return fallback;
		try {
			const res = await this._request(`/api/v1/users/${encodeURIComponent(userId)}/profile`, { retries: 0 });
			if (res.ok && res.data && typeof res.data.nickname === 'string' && res.data.nickname.trim()) return res.data.nickname;
		} catch { /* fall through to the id-based fallback */ }
		return fallback;
	}

	// --- Core request plumbing --------------------------------------------------------

	async _request(path, { method = 'GET', body, retries = 2, binary = false, keepalive = false } = {}) {
		if (!this.fetch) return { ok: false, error: 'offline', recoverable: true };
		const headers = { 'Content-Type': 'application/json' };
		if (this.launchToken) headers['Authorization'] = `Bearer ${this.launchToken}`;
		for (let attempt = 0; attempt <= retries; attempt++) {
			try {
				const res = await this.fetch(this.baseUrl + path, {
					method, headers, keepalive,
					body: body ? JSON.stringify(body).slice(0, MAX_BODY) : undefined,
				});
				if (binary) {
					if (res.status === 404) return { ok: true, status: 404, data: null };
					if (!res.ok) return { ok: false, error: `http_${res.status}`, recoverable: res.status >= 500 };
					this.online = true;
					return { ok: true, status: res.status, data: new Uint8Array(await res.arrayBuffer()) };
				}
				let data = null;
				try { data = await res.json(); } catch { data = null; }
				if (res.status === 429) {
					// Structured rate limit: recoverable UI state.
					const wait = Number(res.headers.get('Retry-After')) * 1000 || RETRY_DELAYS[Math.min(attempt, 2)];
					if (attempt < retries) { await sleep(wait); continue; }
					return { ok: false, error: 'rate_limited', recoverable: true };
				}
				if (res.status === 401) {
					// Token may have expired between refreshes: re-mint early, once.
					if (this.launchToken && !this._refreshing) this._refreshToken();
					return { ok: false, error: 'unauthorized', recoverable: true };
				}
				if (!res.ok) return { ok: false, error: (data && data.error) || `http_${res.status}`, recoverable: res.status >= 500 };
				this.online = true;
				return { ok: true, data };
			} catch (err) {
				if (attempt < retries) { await sleep(RETRY_DELAYS[Math.min(attempt, 2)]); continue; }
				this.online = false;
				return { ok: false, error: 'offline', recoverable: true };
			}
		}
		return { ok: false, error: 'offline', recoverable: true };
	}

	// Synchronize clock with the platform: round-trip-adjusted offset, plus the
	// UTC date the Daily is derived from.
	async syncTime() {
		const t0 = Date.now();
		const res = await this._request('/api/v1/time', { retries: 1 });
		if (!res.ok) return res;
		const t1 = Date.now();
		const rtt = t1 - t0;
		const serverNow = res.data.serverTime + rtt / 2;
		this.timeOffsetMs = serverNow - t1;
		this.serverDate = res.data.date;
		return { ok: true, offsetMs: this.timeOffsetMs, date: res.data.date, rtt };
	}

	now() { return Date.now() + this.timeOffsetMs; }
	todayUTC() {
		if (this.serverDate) return this.serverDate;
		return new Date(this.now()).toISOString().slice(0, 10);
	}

	// --- Leaderboards (read-only on the platform) ------------------------------------
	// Clients can never submit to a game leaderboard; the daily ranked board is
	// script-owned. Hosted reads go through the game info route; without a
	// leaderboardId there is simply nothing to show. In local dev the game's own
	// server (server.js) serves the replay-validated board.

	async getLeaderboard(board = 'global', contentId = null) {
		if (!this.hosted) return this._devLeaderboard(board, contentId);
		if (!this.launchToken || !this.gameScope) return { ok: false, error: 'offline', recoverable: true };
		const info = await this._gameInfoFetch();
		if (!info.ok) return { ok: false, error: info.error, recoverable: info.recoverable };
		const leaderboardId = info.data && info.data.leaderboardId;
		if (!leaderboardId) return { ok: false, error: 'unavailable', recoverable: false };
		const res = await this._request(
			`/api/v1/leaderboards/${encodeURIComponent(leaderboardId)}/entries?pageSize=20`, { retries: 1 });
		if (!res.ok) return { ok: false, error: res.error, recoverable: res.recoverable };
		const raw = (res.data && Array.isArray(res.data.entries) ? res.data.entries : []).slice(0, 20);
		const entries = [];
		for (const e of raw) {
			const userId = e.userId ?? e.user_id ?? e.player ?? null;
			entries.push({
				name: userId != null ? await this.nicknameFor(userId) : (e.name || 'player'),
				score: e.score ?? e.total ?? 0,
			});
		}
		return { ok: true, data: { entries } };
	}

	async _gameInfoFetch() {
		if (this._gameInfo) return { ok: true, data: this._gameInfo };
		const res = await this._request(`/api/v1/games/${encodeURIComponent(this.gameScope)}`, { retries: 1 });
		if (!res.ok) return res;
		this._gameInfo = res.data || {};
		return { ok: true, data: this._gameInfo };
	}

	async _devLeaderboard(board, contentId) {
		// Local dev only: the repo's server.js validates and stores entries. The
		// first read doubles as the dev-server probe; a 404 means "no dev server
		// here" and is remembered so we never repeat a request that cannot work.
		if (this._devUnavailable) return { ok: false, error: 'offline', recoverable: true };
		try {
			const q = new URLSearchParams({ board: board || 'global' });
			if (contentId) q.set('content', contentId);
			const res = await this._request(`/api/v1/leaderboard?${q}`, { retries: 0 });
			if (!res.ok) {
				if (res.error === 'not_found' || res.error === 'http_404') this._devUnavailable = true;
				return { ok: false, error: res.error, recoverable: res.recoverable };
			}
			const entries = (res.data.entries || []).slice(0, 20)
				.map((e) => ({ name: e.name || e.player || 'player', score: e.score ?? e.total ?? 0 }));
			return { ok: true, data: { entries } };
		} catch {
			return { ok: false, error: 'offline', recoverable: true };
		}
	}

	// --- Scores ----------------------------------------------------------------------
	// Ranked daily submission is script-owned and this game ships no platform
	// script, so on-platform the submission is a graceful local no-op. The
	// replay-validated endpoint lives on the local dev server only.

	async submitScore(payload) {
		if (this.hosted) return { ok: false, error: 'unsupported', recoverable: false };
		if (this._devUnavailable) return { ok: false, error: 'offline', recoverable: true };
		try {
			const res = await this._request('/api/v1/scores', { method: 'POST', body: payload, retries: 1 });
			if (!res.ok && (res.error === 'not_found' || res.error === 'http_404')) this._devUnavailable = true;
			return res;
		} catch {
			return { ok: false, error: 'offline', recoverable: true };
		}
	}

	// --- Daily content -----------------------------------------------------------------
	// Generated deterministically in content.js from the UTC date; no network needed.

	async getDaily() { return { ok: false, error: 'offline', recoverable: true }; }

	// --- Achievements (local) -----------------------------------------------------------
	// Pure browser game with no platform script: unlocks stay in the progress doc,
	// mirrored by the cloud save. No platform achievement route is ever called.

	async unlockAchievement(key, sessionId) {
		return { ok: true, local: true, key };
	}

	async getAchievements() { return { ok: true, data: { achievements: [] } }; }

	// --- Cloud saves (one slot, zip+base64) ----------------------------------------------
	// localStorage remains the offline cache written by ui.js; the cloud slot is a
	// mirror, loaded remote-first at boot and pushed debounced + on pagehide.

	async loadSave() {
		if (!this.launchToken || !this.gameScope) return { ok: false, error: 'offline', recoverable: true };
		this._setSync('syncing');
		const res = await this._request(`/api/v1/me/cloud-saves/${encodeURIComponent(this.gameScope)}`, { retries: 1, binary: true });
		if (!res.ok) { this._setSync('error'); return { ok: false, error: res.error, recoverable: res.recoverable }; }
		if (res.status === 404 || !res.data) { this._setSync('synced'); return { ok: true, doc: null }; }
		try {
			const doc = JSON.parse(new TextDecoder().decode(unzipFirstEntry(res.data)));
			this._setSync('synced');
			return { ok: true, doc };
		} catch {
			this._setSync('error');
			return { ok: false, error: 'bad_save', recoverable: true };
		}
	}

	async storeSave(doc) {
		if (!this.launchToken || !this.gameScope) return { ok: false, error: 'offline', recoverable: true };
		const json = new TextEncoder().encode(JSON.stringify(doc));
		const dataBase64 = bytesToBase64(zipStore('save.json', json));
		return this._request(`/api/v1/me/cloud-saves/${encodeURIComponent(this.gameScope)}`, {
			method: 'PUT', body: { dataBase64 }, retries: 1,
		});
	}

	// Debounced mirror: callers write localStorage themselves, then queue the cloud
	// push here (~2 s of quiet, drained on pagehide/visibilitychange).
	queueSave(doc) {
		this._pendingDoc = doc;
		if (!this.launchToken || !this.gameScope) return; // local-only play
		this._setSync('saving');
		if (this._saveInflight) return; // the in-flight push drains the newest doc after
		if (this._saveTimer) clearTimeout(this._saveTimer);
		this._saveTimer = setTimeout(() => this._pushSave(false), SAVE_DEBOUNCE_MS);
	}

	async _pushSave(keepalive) {
		if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
		if (this._saveInflight || !this._pendingDoc) return;
		if (!this.launchToken || !this.gameScope) return;
		const doc = this._pendingDoc;
		this._saveInflight = true;
		let res;
		try {
			const json = new TextEncoder().encode(JSON.stringify(doc));
			const dataBase64 = bytesToBase64(zipStore('save.json', json));
			res = await this._request(`/api/v1/me/cloud-saves/${encodeURIComponent(this.gameScope)}`, {
				method: 'PUT', body: { dataBase64 }, retries: 0, keepalive: !!keepalive,
			});
		} catch {
			res = { ok: false, error: 'offline', recoverable: true };
		}
		this._saveInflight = false;
		if (res.ok) {
			if (this._pendingDoc === doc) this._pendingDoc = null;
			this._setSync('synced');
		} else {
			this._setSync('error');
			if (this._pendingDoc && !this._saveTimer) {
				this._saveTimer = setTimeout(() => this._pushSave(false), SAVE_RETRY_MS);
			}
		}
		if (this._pendingDoc && !this._saveTimer && !this._saveInflight) {
			this._saveTimer = setTimeout(() => this._pushSave(false), SAVE_DEBOUNCE_MS);
		}
	}

	flushSave() { this._pushSave(true); }

	// --- Presence + activity ------------------------------------------------------------
	// The platform serves no per-game presence/activity routes and the client
	// keeps these local everywhere: no request is ever issued.

	startActivity() { return { ok: true }; }
	endActivity() {
		this.stopPresence();
		return { ok: true };
	}
	startPresence() { this.stopPresence(); }
	stopPresence() { if (this._presenceTimer) { clearInterval(this._presenceTimer); this._presenceTimer = null; } }

	// --- Telemetry (anonymous funnel only, consent gated) ---------------------------------
	// No telemetry route exists on-platform and the client sends nothing in dev
	// either; events are filtered by the allow-list below and counted in-memory.

	track(event, props = {}) {
		if (!this.telemetryConsent) return;
		const allowed = ['start', 'tutorial_step', 'round_end', 'retry', 'settings_change', 'error'];
		if (!allowed.includes(event)) return;
	}

	// --- Sync status ------------------------------------------------------------------------

	_setSync(state) {
		if (this.syncState === state) return;
		this.syncState = state;
		this._notify();
	}
	_notify() { if (this.onChange) this.onChange(); }

	dispose() {
		this.stopPresence();
		if (this._refreshTimer) { clearTimeout(this._refreshTimer); this._refreshTimer = null; }
		if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
		this._pendingDoc = null;
	}
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

export function createPlatform(env) { return new PlatformModule(env); }
export function disposePlatform(platform) { platform?.dispose(); }
export default PlatformModule;
