// Hillwheel platform: StarHermit adapter over the shared SDK
// (starhermit-sdk.js, window.StarHermit) plus GET /api/v1/time when signed in.
// Standalone (no launch token) makes no network request at all. The SDK reads and
// strips the launch token, renews it, and owns every platform call made here:
// profile/avatar, the cloud-save slot game:<slug>, the per-player settings KV,
// key bindings, the invite link and the read-only leaderboard. Hosted mode is
// "the SDK holds a token"; without one no platform call is made.

export const PLATFORM_SCHEMA_VERSION = 4;

export class PlatformModule {
	constructor({ baseUrl = '', fetchImpl, sdk } = {}) {
		this.baseUrl = baseUrl;
		this.fetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
		this.sh = sdk || (typeof window !== 'undefined' ? window.StarHermit : null) || null;
		this.nickname = null;      // platform profile nickname, once loaded
		this.avatar = null;        // object URL of the account avatar
		this.syncState = this.hosted ? 'syncing' : 'offline'; // offline | syncing | saving | synced | error
		this.onChange = null;      // ui callback: nickname/sync/auth state changed
		this.onAuth = null;        // fn(signedIn) after the SDK signs in/out
		this.timeOffsetMs = 0;     // server time minus local time
		this.online = false;
		this.telemetryConsent = false;
		this.sessionId = `anon-${Math.random().toString(36).slice(2, 10)}`;
		this._presenceTimer = null;
		if (this.sh) {
			this.sh.on('saved', (ok) => this._setSync(ok ? 'synced' : 'error'));
			this.sh.on('auth', (a) => {
				if (!a.signedIn) { this.nickname = null; this.avatar = null; this.syncState = 'offline'; }
				if (this.onAuth) this.onAuth(a.signedIn);
				this._notify();
			});
		}
	}

	// --- Launch token (held by the SDK) -----------------------------------------------
	get launchToken() { return this.sh && this.sh.token || null; }
	get hosted() { return !!(this.sh && this.sh.signedIn); }
	get userId() { return this.hosted ? String(this.sh.userId) : null; }
	get gameScope() { return this.sh && this.sh.slug || null; }
	canSignIn() { return !!(this.sh && this.sh.canSignIn()); }
	signIn() { return !!(this.sh && this.sh.signIn()); }

	// --- Profile ------------------------------------------------------------------
	// Nickname from the user profile route only (never /api/v1/me, never usernames).
	async loadProfile() {
		if (!this.hosted) return { ok: false, error: 'offline', recoverable: true };
		const p = await this.sh.profile();
		this.nickname = p ? p.displayName : 'Player ' + this.userId.slice(0, 6);
		this._notify();
		this.sh.avatarUrl().then((url) => { if (url) { this.avatar = url; this._notify(); } });
		return { ok: !!p, nickname: this.nickname };
	}

	async nicknameFor(userId) {
		const p = this.hosted ? await this.sh.profile(String(userId)) : null;
		return p ? p.displayName : 'Player ' + String(userId).slice(0, 6);
	}

	// --- Server time (signed in only) ----------------------------------------------------
	// GET /api/v1/time is the only own-server route this game uses, and only with a
	// launch token. Standalone play uses the local clock and makes no request.
	async syncTime() {
		if (!this.hosted || !this.fetch) return { ok: false, error: 'offline', recoverable: true };
		const t0 = Date.now();
		let data = null;
		try {
			const res = await this.fetch(this.baseUrl + '/api/v1/time', { headers: { Authorization: `Bearer ${this.launchToken}` } });
			if (!res.ok) return { ok: false, error: `http_${res.status}`, recoverable: true };
			data = await res.json();
		} catch {
			return { ok: false, error: 'offline', recoverable: true };
		}
		if (!data || typeof data.serverTime !== 'number') return { ok: false, error: 'bad_time', recoverable: true };
		const t1 = Date.now();
		const rtt = t1 - t0;
		this.timeOffsetMs = data.serverTime + rtt / 2 - t1;
		this.serverDate = data.date;
		this.online = true;
		return { ok: true, offsetMs: this.timeOffsetMs, date: data.date, rtt };
	}

	now() { return Date.now() + this.timeOffsetMs; }
	todayUTC() {
		if (this.serverDate) return this.serverDate;
		return new Date(this.now()).toISOString().slice(0, 10);
	}

	// --- Leaderboards (read-only on the platform) ------------------------------------
	// Clients can never submit to a platform leaderboard. Hosted reads the first
	// platform board; standalone the game shows the player's local daily bests
	// (game.js) and this returns 'offline' without any request.
	async getLeaderboard() {
		if (!this.hosted) return { ok: false, error: 'offline', recoverable: true };
		const r = await this.sh.leaderboard(null, { pageSize: 20 });
		if (!r || !r.board) return { ok: false, error: 'unavailable', recoverable: false };
		const entries = [];
		for (const e of (r.items || []).slice(0, 20)) {
			entries.push({ name: await this.nicknameFor(e.userId), score: e.score ?? 0 });
		}
		return { ok: true, data: { entries } };
	}

	// --- Achievements (local) -----------------------------------------------------------
	// No platform script: unlocks stay in the progress doc, mirrored by the cloud save.
	async unlockAchievement(key) { return { ok: true, local: true, key }; }

	// --- Cloud save (slot game:<slug> via the SDK) ----------------------------------------
	// localStorage remains the offline cache written by ui.js; the cloud slot is a
	// mirror, loaded remote-first at boot and pushed debounced + on pagehide.
	async loadSave() {
		if (!this.hosted) return { ok: false, error: 'offline', recoverable: true };
		this._setSync('syncing');
		const doc = await this.sh.loadJSON();
		this._setSync('synced');
		return { ok: true, doc: doc || null };
	}

	async storeSave(doc) {
		if (!this.hosted) return { ok: false, error: 'offline', recoverable: true };
		const ok = await this.sh.writeSave(JSON.stringify(doc));
		return ok ? { ok: true } : { ok: false, error: 'save_failed', recoverable: true };
	}

	// Debounced mirror (~2 s of quiet), drained with keepalive on pagehide/hidden.
	queueSave(doc) {
		if (!this.hosted) return; // local-only play
		this._setSync('saving');
		this.sh.saveJSON(doc);
	}

	flushSave() { if (this.hosted) this.sh.flushSave(true); }

	// --- Settings KV, key bindings, invite link -----------------------------------------
	getSettings() { return this.hosted ? this.sh.getSettings() : Promise.resolve({}); }
	patchSettings(obj) { if (this.hosted) this.sh.patchSettings(obj); }
	loadBindings(defaults) {
		return this.hosted ? this.sh.loadBindings(defaults) : Promise.resolve(structuredClone(defaults));
	}
	inviteLink() { return this.hosted ? this.sh.inviteLink() : null; }

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
	}
}

export function createPlatform(env) { return new PlatformModule(env); }
export function disposePlatform(platform) { platform?.dispose(); }
export default PlatformModule;
