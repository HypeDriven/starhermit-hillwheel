// Hillwheel session: local or hosted commands, snapshots, prediction policy, reconnect, replay.
// A session owns one rules state and an ordered, idempotent command log.
// Replay envelope: schema version, build/content version, seed, initial hash,
// ordered commands, periodic state hashes, terminal result.

import * as rules from './rules.js';
import { CONTENT_VERSION } from './content.js';

export const SESSION_SCHEMA_VERSION = 2;
export const REPLAY_SCHEMA_VERSION = 2;
const SNAPSHOT_INTERVAL = 60; // ticks between snapshot hash entries

let sessionCounter = 0;

export class Session {
	constructor(config, sessionId) {
		this.id = sessionId || `s-${Date.now().toString(36)}-${++sessionCounter}`;
		this.config = config;
		this.state = rules.createState(config);
		this.initialHash = rules.hashState(this.state);
		this.commands = [];       // accepted commands, in order
		this.seenIds = new Set(); // duplicate rejection is idempotent by command ID
		this.hashLog = [];        // { tick, hash } periodic verification
		this.snapshots = [];      // ring of serialized states for practice undo
		this.createdAt = Date.now();
		this._cmdSeq = 0;
	}

	nextCommandId() { return `${this.id}-c${++this._cmdSeq}`; }

	// Apply a validated command. Duplicates are rejected idempotently.
	apply(cmd) {
		if (!cmd || typeof cmd !== 'object' || typeof cmd.id !== 'string' || !cmd.id) {
			return { ok: false, reason: 'malformed_command' };
		}
		if (this.seenIds.has(cmd.id)) return { ok: true, duplicate: true };
		const res = rules.applyCommand(this.state, cmd);
		if (res.ok) {
			this.seenIds.add(cmd.id);
			this.commands.push({ id: cmd.id, type: cmd.type, throttle: cmd.throttle, brake: cmd.brake, tilt: cmd.tilt });
			if (this.state.tick % SNAPSHOT_INTERVAL === 0 || this.state.terminalReason) {
				this.hashLog.push({ tick: this.state.tick, hash: rules.hashState(this.state) });
			}
		}
		return res;
	}

	// Practice-mode undo: restore the most recent checkpoint snapshot.
	pushUndoSnapshot() {
		this.snapshots.push(rules.serializeState(this.state));
		if (this.snapshots.length > 8) this.snapshots.shift();
	}
	undo() {
		const snap = this.snapshots.pop();
		if (!snap) return { ok: false, reason: 'nothing_to_undo' };
		this.state = rules.deserializeState(snap);
		return { ok: true };
	}

	snapshot() {
		return {
			sessionId: this.id,
			config: this.config,
			state: rules.serializeState(this.state),
			hash: rules.hashState(this.state),
			tick: this.state.tick,
			commandCount: this.commands.length,
		};
	}

	// Durable reconnect: rebuild from snapshot, never from cached client memory.
	static restore(snapshot) {
		const s = new Session(snapshot.config, snapshot.sessionId);
		s.state = rules.deserializeState(snapshot.state);
		return s;
	}

	finished() { return this.state.terminalReason !== null; }
	result() {
		return {
			sessionId: this.id,
			terminalReason: this.state.terminalReason,
			breakdown: rules.scoreBreakdown(this.state),
			ticks: this.state.tick,
			invalidActions: this.state.invalidActions,
			hash: rules.hashState(this.state),
		};
	}

	// Replay envelope for validation and sharing.
	exportReplay() {
		return {
			replaySchema: REPLAY_SCHEMA_VERSION,
			contentVersion: CONTENT_VERSION,
			rulesSchema: rules.SCHEMA_VERSION,
			seed: this.config.seed >>> 0,
			config: this.config,
			initialHash: this.initialHash,
			timestampOffset: this.createdAt,
			commands: this.commands.slice(),
			hashLog: this.hashLog.slice(),
			terminal: this.result(),
		};
	}

	close() {
		this.snapshots.length = 0;
		this.seenIds.clear();
	}
}

// Deterministic replay: re-run an envelope and verify every periodic hash plus
// the terminal result. Same version + seed + commands => identical hashes.
export function verifyReplay(envelope) {
	if (!envelope || envelope.replaySchema !== REPLAY_SCHEMA_VERSION) {
		return { ok: false, reason: 'unsupported_replay_schema' };
	}
	const s = new Session(envelope.config, envelope.terminal?.sessionId || 'replay');
	if (s.initialHash !== envelope.initialHash) return { ok: false, reason: 'initial_hash_mismatch' };
	for (const cmd of envelope.commands || []) {
		s.apply({ ...cmd });
	}
	for (const entry of envelope.hashLog || []) {
		// hashLog is advisory during replay; final hash is authoritative.
		if (entry.tick === s.state.tick && entry.hash !== rules.hashState(s.state)) {
			return { ok: false, reason: 'intermediate_hash_mismatch', tick: entry.tick };
		}
	}
	const finalHash = rules.hashState(s.state);
	if (envelope.terminal && envelope.terminal.hash !== finalHash) {
		return { ok: false, reason: 'terminal_hash_mismatch', expected: envelope.terminal.hash, got: finalHash };
	}
	return { ok: true, result: s.result(), replay: s.exportReplay() };
}

export function createSession(config, sessionId) { return new Session(config, sessionId); }
export default Session;
