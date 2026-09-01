// Hillwheel platform: token-aware REST adapter, retries, rate-limit handling,
// server-time sync, telemetry consent. Uses same-origin /api routes when hosted.
// Never persists access or launch tokens. Degrades gracefully offline.

export const PLATFORM_SCHEMA_VERSION = 2;

const RETRY_DELAYS = [300, 900, 2700];
const MAX_BODY = 64 * 1024;

export class PlatformModule {
	constructor({ baseUrl = '', fetchImpl } = {}) {
		this.baseUrl = baseUrl;
		this.fetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
		this.launchToken = null;   // short-lived, in-memory only
		this.timeOffsetMs = 0;     // server time minus local time
		this.online = false;
		this.telemetryConsent = false;
		this.sessionId = `anon-${Math.random().toString(36).slice(2, 10)}`;
		this._presenceTimer = null;
	}

	// Host shell injects a launch token; game reads scope from it, never stores it.
	setLaunchToken(token) {
		this.launchToken = token || null;
		if (token) {
			try {
				const payload = JSON.parse(atob(token.split('.')[1] || ''));
				this.gameScope = payload.scope || payload.game || null;
			} catch { this.gameScope = null; }
		}
	}

	async _request(path, { method = 'GET', body, retries = 2 } = {}) {
		if (!this.fetch) return { ok: false, error: 'offline', recoverable: true };
		const headers = { 'Content-Type': 'application/json' };
		if (this.launchToken) headers['Authorization'] = `Bearer ${this.launchToken}`;
		for (let attempt = 0; attempt <= retries; attempt++) {
			try {
				const res = await this.fetch(this.baseUrl + path, {
					method, headers,
					body: body ? JSON.stringify(body).slice(0, MAX_BODY) : undefined,
				});
				let data = null;
				try { data = await res.json(); } catch { data = null; }
				if (res.status === 429) {
					// Structured rate limit: recoverable UI state.
					const wait = Number(res.headers.get('Retry-After')) * 1000 || RETRY_DELAYS[Math.min(attempt, 2)];
					if (attempt < retries) { await sleep(wait); continue; }
					return { ok: false, error: 'rate_limited', recoverable: true };
				}
				if (res.status === 401) return { ok: false, error: 'unauthorized', recoverable: true };
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

	// Synchronize clock with the platform: round-trip-adjusted offset.
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

	// --- Daily sessions, scores, leaderboards, achievements --------------------

	async getDaily() { return this._request('/api/v1/daily'); }

	async submitScore(payload) {
		// payload: { mode, contentId, seed, ruleset, contentVersion, assists, durationTicks,
		//            breakdown, inputLog, hashLog, initialHash, sessionId }
		return this._request('/api/v1/scores', { method: 'POST', body: payload });
	}

	async getLeaderboard(board = 'global', contentId = null) {
		const q = contentId ? `?board=${board}&content=${encodeURIComponent(contentId)}` : `?board=${board}`;
		return this._request('/api/v1/leaderboard' + q);
	}

	async unlockAchievement(key, sessionId) {
		return this._request('/api/v1/achievements', { method: 'POST', body: { key, sessionId } });
	}

	async getAchievements() { return this._request('/api/v1/achievements'); }

	// --- Cloud saves (versioned, checksummed) -----------------------------------

	async loadSave() { return this._request('/api/v1/save'); }
	async storeSave(doc) { return this._request('/api/v1/save', { method: 'PUT', body: doc }); }

	// --- Presence + activity -----------------------------------------------------

	startActivity() { return this._request('/api/v1/activity/start', { method: 'POST', body: { sessionId: this.sessionId } }); }
	endActivity() {
		this.stopPresence();
		return this._request('/api/v1/activity/end', { method: 'POST', body: { sessionId: this.sessionId } });
	}
	startPresence() {
		this.stopPresence();
		this._presenceTimer = setInterval(() => {
			this._request('/api/v1/presence', { method: 'POST', body: { sessionId: this.sessionId }, retries: 0 });
		}, 30000);
	}
	stopPresence() { if (this._presenceTimer) { clearInterval(this._presenceTimer); this._presenceTimer = null; } }

	// --- Telemetry (anonymous funnel only, consent gated) ------------------------

	track(event, props = {}) {
		if (!this.telemetryConsent) return;
		const allowed = ['start', 'tutorial_step', 'round_end', 'retry', 'settings_change', 'error'];
		if (!allowed.includes(event)) return;
		this._request('/api/v1/telemetry', { method: 'POST', body: { event, props, sessionId: this.sessionId }, retries: 0 });
	}

	dispose() { this.stopPresence(); }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

export function createPlatform(env) { return new PlatformModule(env); }
export function disposePlatform(platform) { platform?.dispose(); }
export default PlatformModule;
