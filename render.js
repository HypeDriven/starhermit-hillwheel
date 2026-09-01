// Hillwheel render: Three.js scene graph, semantic entity views, camera, lighting, VFX, quality tiers.
// Rendering consumes immutable simulation snapshots plus an interpolation alpha.
// Cosmetic randomness uses its own seeded stream and never touches rules.

import * as THREE from 'three';
import { mulberry32 } from './rules.js';
import { getTheme } from './content.js';

export const QUALITY_TIERS = { low: 0, medium: 1, high: 2 };
export const QUALITY_CONFIG = {
	low: { pixelRatioCap: 1, shadows: false, treeDensity: 0, particles: 0, terrainStep: 2.0, antialias: false },
	medium: { pixelRatioCap: 1.5, shadows: false, treeDensity: 0.6, particles: 60, terrainStep: 1.2, antialias: true },
	high: { pixelRatioCap: 2, shadows: true, treeDensity: 1, particles: 160, terrainStep: 0.7, antialias: true },
};

// Authored framing constants (no magic offsets scattered through the code).
const CAM = { back: 26, up: 12, lookUp: 3, lookAhead: 8, fov: 42, near: 0.5, far: 900 };
const TERRAIN_VIEW = { behind: 40, ahead: 110 };
const VEHICLE_CLEARANCE = 0.9;

export class RenderModule {
	constructor(canvas, { tier = 'medium', reducedMotion = false } = {}) {
		this.canvas = canvas;
		this.tier = tier in QUALITY_CONFIG ? tier : 'medium';
		this.reducedMotion = reducedMotion;
		this.q = QUALITY_CONFIG[this.tier];
		this.disposed = false;
		this.contextLost = false;

		this.renderer = new THREE.WebGLRenderer({ canvas, antialias: this.q.antialias, powerPreference: 'default' });
		this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.q.pixelRatioCap));
		this.renderer.outputColorSpace = THREE.SRGBColorSpace;
		this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
		this.renderer.toneMappingExposure = 1.0;
		if (this.q.shadows) {
			this.renderer.shadowMap.enabled = true;
			this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
		}

		this.scene = new THREE.Scene();
		this.camera = new THREE.PerspectiveCamera(CAM.fov, 4 / 3, CAM.near, CAM.far);

		// Layers: 0 environment, 1 gameplay, 2 effects (cosmetic; never raycast).
		this.camera.layers.enable(0); this.camera.layers.enable(1); this.camera.layers.enable(2);

		this._buildLights();
		this._buildSky();
		this.level = null;      // active level views
		this.particles = null;
		this.camPos = new THREE.Vector3(CAM.back, CAM.up, CAM.back);
		this.camTarget = new THREE.Vector3();
		this._camInit = false;
		this.shake = 0;
		this._tmp = new THREE.Vector3();

		canvas.addEventListener('webglcontextlost', this._onContextLost = (e) => { e.preventDefault(); this.contextLost = true; });
		canvas.addEventListener('webglcontextrestored', this._onContextRestored = () => { this.contextLost = false; });
	}

	_buildLights() {
		// One dominant key light + soft hemisphere fill.
		this.sun = new THREE.DirectionalLight(0xfff2dd, 2.6);
		this.sun.position.set(-40, 70, 50);
		if (this.q.shadows) {
			this.sun.castShadow = true;
			this.sun.shadow.mapSize.set(1024, 1024);
			this.sun.shadow.camera.left = -60; this.sun.shadow.camera.right = 60;
			this.sun.shadow.camera.top = 60; this.sun.shadow.camera.bottom = -60;
		}
		this.hemi = new THREE.HemisphereLight(0xbfd8e8, 0x6a7a5a, 0.9);
		this.scene.add(this.sun, this.hemi);
	}

	_buildSky() {
		this.skyGeo = new THREE.SphereGeometry(600, 16, 10);
		this.skyMat = new THREE.MeshBasicMaterial({ color: 0x9fd3e8, side: THREE.BackSide, fog: false });
		this.sky = new THREE.Mesh(this.skyGeo, this.skyMat);
		this.sky.layers.set(0);
		this.scene.add(this.sky);
		this.scene.fog = new THREE.Fog(0xcfe8d8, 120, 700);
	}

	// --- Level views ------------------------------------------------------------

	loadLevel(state, themeId, seed) {
		this.unloadLevel();
		const theme = getTheme(themeId);
		this.theme = theme;
		this.skyMat.color.setHex(theme.sky);
		this.scene.fog.color.setHex(theme.fog);
		this.hemi.color.setHex(theme.sky);

		const group = new THREE.Group();
		const terrain = state.terrain;
		const length = state.goalX;
		const stepLen = this.q.terrainStep;

		// Terrain strip: single BufferGeometry, vertex colors near/far.
		const count = Math.ceil(length / stepLen) + 1;
		const pos = new Float32Array(count * 2 * 3);
		const col = new Float32Array(count * 2 * 3);
		const cNear = new THREE.Color(theme.ground), cFar = new THREE.Color(theme.groundFar);
		const depth = 26;
		for (let i = 0; i < count; i++) {
			const x = Math.min(length, i * stepLen);
			const y = terrain.height(x);
			const j = i * 6;
			pos[j] = x; pos[j + 1] = y; pos[j + 2] = 0;
			pos[j + 3] = x; pos[j + 4] = y - depth; pos[j + 5] = 0;
			const t = i / count;
			const c = cNear.clone().lerp(cFar, t);
			col[j] = c.r; col[j + 1] = c.g; col[j + 2] = c.b;
			col[j + 3] = c.r * 0.7; col[j + 4] = c.g * 0.7; col[j + 5] = c.b * 0.7;
		}
		const idx = [];
		for (let i = 0; i < count - 1; i++) {
			const a = i * 2, b = i * 2 + 1, c = i * 2 + 2, d = i * 2 + 3;
			idx.push(a, b, c, b, d, c);
		}
		const geo = new THREE.BufferGeometry();
		geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
		geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
		geo.setIndex(idx);
		geo.computeVertexNormals();
		const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
		const groundMesh = new THREE.Mesh(geo, mat);
		groundMesh.receiveShadow = this.q.shadows;
		groundMesh.layers.set(0);
		group.add(groundMesh);

		// Vehicle: authored low-poly buggy (body + roll bar + 2 wheels).
		const vehicle = new THREE.Group();
		const bodyMat = new THREE.MeshStandardMaterial({ color: 0xd84e2e, roughness: 0.4, metalness: 0.3 });
		const body = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.6, 1.2), bodyMat);
		body.position.y = 0.35;
		const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.55, 1.0), new THREE.MeshStandardMaterial({ color: 0x2e3a44, roughness: 0.3, metalness: 0.4 }));
		cabin.position.set(-0.25, 0.85, 0);
		const wheelGeo = new THREE.CylinderGeometry(0.45, 0.45, 0.35, 14);
		wheelGeo.rotateX(Math.PI / 2);
		const wheelMat = new THREE.MeshStandardMaterial({ color: 0x22262a, roughness: 0.9 });
		const wheelF = new THREE.Mesh(wheelGeo, wheelMat); wheelF.position.set(0.75, 0, 0.55);
		const wheelB = new THREE.Mesh(wheelGeo, wheelMat); wheelB.position.set(-0.75, 0, 0.55);
		const wheelF2 = wheelF.clone(); wheelF2.position.z = -0.55;
		const wheelB2 = wheelB.clone(); wheelB2.position.z = -0.55;
		vehicle.add(body, cabin, wheelF, wheelB, wheelF2, wheelB2);
		vehicle.traverse((o) => { o.layers.set(1); if (o.isMesh) o.castShadow = this.q.shadows; });
		group.add(vehicle);
		this.vehicleView = vehicle;
		this.wheels = [wheelF, wheelB, wheelF2, wheelB2];

		// Fuel cans.
		const canGeo = new THREE.BoxGeometry(0.7, 0.9, 0.5);
		const canMat = new THREE.MeshStandardMaterial({ color: theme.accent, roughness: 0.5, emissive: theme.accent, emissiveIntensity: 0.25 });
		this.canViews = state.cans.map((c) => {
			const m = new THREE.Mesh(canGeo, canMat);
			m.position.set(c.x, terrain.height(c.x) + 1.2, 0);
			m.layers.set(1);
			group.add(m);
			return m;
		});

		// Checkpoint flags + goal flag.
		const flagPole = new THREE.CylinderGeometry(0.08, 0.08, 4, 6);
		const poleMat = new THREE.MeshStandardMaterial({ color: 0xeeeeee, roughness: 0.6 });
		const flagGeo = new THREE.BoxGeometry(1.4, 0.8, 0.06);
		this.flagViews = state.checkpoints.map((cx) => {
			const g = new THREE.Group();
			const pole = new THREE.Mesh(flagPole, poleMat);
			const flag = new THREE.Mesh(flagGeo, new THREE.MeshStandardMaterial({ color: 0xf2c14e, roughness: 0.6 }));
			flag.position.set(0.7, 1.6, 0);
			g.add(pole, flag);
			g.position.set(cx, terrain.height(cx) + 2, 0);
			g.traverse((o) => o.layers.set(1));
			group.add(g);
			return { group: g, flag };
		});
		const goal = new THREE.Group();
		const gp = new THREE.Mesh(flagPole, poleMat);
		const gf = new THREE.Mesh(flagGeo, new THREE.MeshStandardMaterial({ color: 0x4ed88a, roughness: 0.5, emissive: 0x4ed88a, emissiveIntensity: 0.4 }));
		gf.scale.set(1.6, 1.6, 1); gf.position.set(1.1, 1.7, 0);
		goal.add(gp, gf);
		goal.position.set(state.goalX, terrain.height(state.goalX) + 2.2, 0);
		goal.traverse((o) => o.layers.set(1));
		group.add(goal);

		// Vegetation + rocks: instanced, deterministic from a decoration-only stream.
		const deco = mulberry32((seed ^ 0xdec0) >>> 0);
		if (this.q.treeDensity > 0) {
			const treeCount = Math.floor((length / 22) * this.q.treeDensity);
			const trunkGeo = new THREE.CylinderGeometry(0.15, 0.22, 1.2, 5);
			const crownGeo = new THREE.ConeGeometry(1.1, 2.6, 7);
			const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6a4a2e, roughness: 0.9 });
			const crownMat = new THREE.MeshStandardMaterial({ color: theme.tree, roughness: 0.85 });
			const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, treeCount);
			const crowns = new THREE.InstancedMesh(crownGeo, crownMat, treeCount);
			const m4 = new THREE.Matrix4();
			for (let i = 0; i < treeCount; i++) {
				const x = 10 + deco() * (length - 20);
				const z = (deco() < 0.5 ? -1 : 1) * (4 + deco() * 18);
				const s = 0.8 + deco() * 1.2;
				const y = terrain.height(x);
				m4.makeScale(s, s, s).setPosition(x, y + 0.6 * s, z);
				trunks.setMatrixAt(i, m4);
				m4.makeScale(s, s, s).setPosition(x, y + (1.2 + 1.3) * s, z);
				crowns.setMatrixAt(i, m4);
			}
			trunks.layers.set(0); crowns.layers.set(0);
			group.add(trunks, crowns);
		}

		// Dust particle pool (bounded, seeded variants, layer 2 = never raycast).
		const pCount = this.q.particles;
		if (pCount > 0) {
			const pGeo = new THREE.BufferGeometry();
			pGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pCount * 3), 3));
			const pMat = new THREE.PointsMaterial({ color: 0xd8cbb0, size: 0.6, transparent: true, opacity: 0.7, depthWrite: false });
			this.particles = new THREE.Points(pGeo, pMat);
			this.particles.layers.set(2);
			this.particleData = Array.from({ length: pCount }, () => ({ life: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 }));
			this._pNext = 0;
			group.add(this.particles);
		}

		this.level = { group, groundGeo: geo, groundMat: mat, state };
		this.scene.add(group);
		this._camInit = false;
	}

	unloadLevel() {
		if (!this.level) return;
		this.scene.remove(this.level.group);
		this.level.group.traverse((o) => {
			if (o.isMesh || o.isPoints) {
				o.geometry?.dispose();
				const mats = Array.isArray(o.material) ? o.material : [o.material];
				mats.forEach((m) => m?.dispose());
			}
		});
		this.level = null;
		this.particles = null;
	}

	// --- Frame update -------------------------------------------------------------
	// prev/cur are vehicle snapshots; alpha in [0,1) interpolates between them.

	update(prev, cur, alpha, state, events, dtReal) {
		if (!this.level || this.contextLost) return;
		const terrain = state.terrain;
		const x = prev.x + (cur.x - prev.x) * alpha;
		const y = prev.y + (cur.y - prev.y) * alpha;
		let dAng = cur.angle - prev.angle;
		while (dAng > Math.PI) dAng -= Math.PI * 2;
		while (dAng < -Math.PI) dAng += Math.PI * 2;
		const ang = prev.angle + dAng * alpha;

		this.vehicleView.position.set(x, y - VEHICLE_CLEARANCE + 0.45, 0);
		this.vehicleView.rotation.z = ang;
		const spin = -cur.x * 0.02;
		for (const w of this.wheels) w.rotation.z += spin;

		// Cans: hide collected, bob the rest (deterministic phase from index).
		const t = state.tick / 60;
		for (let i = 0; i < this.canViews.length; i++) {
			const m = this.canViews[i];
			if (state.cans[i].taken) { m.visible = false; continue; }
			m.visible = true;
			m.position.y = terrain.height(state.cans[i].x) + 1.2 + (this.reducedMotion ? 0 : Math.sin(t * 2 + i) * 0.15);
			m.rotation.y = this.reducedMotion ? 0 : t + i;
		}
		// Checkpoint flags: mark passed.
		for (let i = 0; i < this.flagViews.length; i++) {
			const passed = i < state.nextCheckpoint;
			this.flagViews[i].flag.material.color.setHex(passed ? 0x4ed88a : 0xf2c14e);
		}

		// Dust when grounded and moving.
		if (this.particles && cur.grounded && Math.abs(cur.vx) > 4 && !this.reducedMotion) {
			this._emitDust(x - 1, y - 0.5, cur.vx);
		}
		this._updateParticles(dtReal);

		// Camera: critically damped follow, interruptible, reduced-motion aware.
		const targetX = x + CAM.lookAhead * Math.sign(Math.max(0.2, cur.vx || 1));
		const groundY = terrain.height(x);
		const desired = this._tmp.set(targetX - CAM.back * 0.4, groundY + CAM.up, CAM.back);
		if (!this._camInit || this.reducedMotion) {
			this.camPos.copy(desired);
			this._camInit = true;
		} else {
			const k = 1 - Math.exp(-4 * dtReal); // frame-rate independent damp
			this.camPos.lerp(desired, k);
		}
		let shakeX = 0, shakeY = 0;
		if (this.shake > 0 && !this.reducedMotion) {
			shakeX = (Math.random() - 0.5) * this.shake;
			shakeY = (Math.random() - 0.5) * this.shake;
			this.shake = Math.max(0, this.shake - dtReal * 2);
		}
		this.camera.position.set(this.camPos.x + shakeX, Math.max(this.camPos.y, groundY + 4) + shakeY, this.camPos.z);
		this.camTarget.set(x, groundY + CAM.lookUp, 0);
		this.camera.lookAt(this.camTarget);
		this.sky.position.copy(this.camera.position);
	}

	addShake(amount) { if (!this.reducedMotion) this.shake = Math.min(1.2, this.shake + amount); }

	_emitDust(x, y, vx) {
		const d = this.particleData[this._pNext];
		this._pNext = (this._pNext + 1) % this.particleData.length;
		d.life = 0.8; d.x = x; d.y = y; d.z = (Math.random() - 0.5);
		d.vx = -vx * 0.15; d.vy = 1.5 + Math.random(); d.vz = (Math.random() - 0.5);
	}

	_updateParticles(dt) {
		if (!this.particles) return;
		const attr = this.particles.geometry.getAttribute('position');
		for (let i = 0; i < this.particleData.length; i++) {
			const d = this.particleData[i];
			if (d.life > 0) {
				d.life -= dt;
				d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt;
				attr.setXYZ(i, d.x, d.y, d.z);
			} else {
				attr.setXYZ(i, 0, -9999, 0);
			}
		}
		attr.needsUpdate = true;
	}

	resize(w, h) {
		this.camera.aspect = w / Math.max(1, h);
		this.camera.updateProjectionMatrix();
		this.renderer.setSize(w, h, false);
	}

	render() {
		if (this.contextLost || this.disposed) return;
		this.renderer.render(this.scene, this.camera);
	}

	setReducedMotion(v) { this.reducedMotion = v; }
	setTier(tier) {
		if (!(tier in QUALITY_CONFIG) || tier === this.tier) return;
		this.tier = tier;
		this.q = QUALITY_CONFIG[tier];
		this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.q.pixelRatioCap));
	}

	stats() {
		const i = this.renderer.info;
		return { drawCalls: i.render.calls, triangles: i.render.triangles };
	}

	dispose() {
		this.disposed = true;
		this.unloadLevel();
		this.canvas.removeEventListener('webglcontextlost', this._onContextLost);
		this.skyGeo.dispose(); this.skyMat.dispose();
		this.renderer.dispose();
	}
}

export function createRender(canvas, opts) { return new RenderModule(canvas, opts); }
export function disposeRender(render) { render?.dispose(); }
export default RenderModule;
