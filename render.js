// Hillwheel render: Three.js scene graph, semantic entity views, camera, lighting, VFX, graphics settings.
// Rendering consumes immutable simulation snapshots plus an interpolation alpha.
// Cosmetic randomness uses its own seeded stream and never touches rules.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mulberry32 } from './rules.js';
import { getTheme } from './content.js';
import { detectPreset, resolve, describe, SHADOW_MAP, PARTICLE_POOL, FOLIAGE_DENSITY } from './gfx.js';

// Authored framing constants (no magic offsets scattered through the code).
const CAM = { back: 26, up: 12, lookUp: 3, lookAhead: 8, fov: 42, near: 0.5, far: 900 };
const VEHICLE_CLEARANCE = 0.9;
const WHEEL_R = 0.47;
// Ground ribbon: z rows of the top surface (front lip → far back) and the front cut face depth.
const TRACK_HALF = 2.5;           // |z| ≤ this is exactly the rules' height profile
const FRONT_Z = 6;
const CUT_DEPTH = 26;
const ROWS_DETAILED = [FRONT_Z, 4.2, TRACK_HALF, 1.4, 0, -1.4, -TRACK_HALF, -4, -6.5, -10, -15, -21, -29, -39, -52, -68, -90];
const ROWS_PLAIN = [FRONT_Z, TRACK_HALF, 0, -TRACK_HALF, -8, -20, -40, -90];
const TERRAIN_STEP = { plain: 2.0, detailed: 0.7 };
// Key light direction (towards the light) and the sun disc shown in the sky (in view, low right).
const SUN_DIR = new THREE.Vector3(-0.45, 0.78, 0.5).normalize();
// The gameplay camera looks ~19° down, so the visible "sky" band sits just below the true
// horizon; the gradient and sun are placed for that framing.
const SKY_SUN_DIR = new THREE.Vector3(0.62, -0.03, -1).normalize();
const SHADOW_EXTENT = 30;

// Cheap deterministic value noise for cosmetic surface variation (never used by rules).
function hash2(x, z) {
	const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
	return s - Math.floor(s);
}
function vnoise(x, z) {
	const xi = Math.floor(x), zi = Math.floor(z);
	const xf = x - xi, zf = z - zi;
	const u = xf * xf * (3 - 2 * xf), v = zf * zf * (3 - 2 * zf);
	const a = hash2(xi, zi), b = hash2(xi + 1, zi), c = hash2(xi, zi + 1), d = hash2(xi + 1, zi + 1);
	return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

// Colour grade + vignette, applied in display space after the OutputPass.
const GradeShader = {
	uniforms: { tDiffuse: { value: null }, uAmount: { value: 1.0 }, uVignette: { value: 0.2 } },
	vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
	fragmentShader: `
		uniform sampler2D tDiffuse; uniform float uAmount; uniform float uVignette;
		varying vec2 vUv;
		void main() {
			vec4 src = texture2D(tDiffuse, vUv);
			vec3 c = clamp(src.rgb, 0.0, 1.0);
			// Gentle S-curve, a touch more saturation, warm highlights and cool shadows.
			vec3 s = mix(c, c * c * (3.0 - 2.0 * c), 0.18);
			float l = dot(s, vec3(0.299, 0.587, 0.114));
			s = mix(vec3(l), s, 1.07);
			s *= mix(vec3(0.97, 0.99, 1.04), vec3(1.03, 1.0, 0.97), smoothstep(0.2, 0.8, l));
			c = mix(c, s, uAmount);
			float d = length((vUv - 0.5) * vec2(1.1, 1.0));
			c *= 1.0 - uVignette * smoothstep(0.4, 0.9, d);
			gl_FragColor = vec4(c, src.a);
		}`,
};

// Gradient sky with a sun (or moon) disc whose core is HDR so bloom picks it up.
const SKY_VERT = `
	varying vec3 vDir;
	void main() {
		vDir = normalize((modelMatrix * vec4(position, 1.0)).xyz - cameraPosition);
		gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
	}`;
const SKY_FRAG = `
	uniform vec3 uTop; uniform vec3 uHorizon; uniform vec3 uSun; uniform vec3 uSunDir; uniform float uSunSize;
	varying vec3 vDir;
	void main() {
		vec3 d = normalize(vDir);
		float h = d.y;
		vec3 col = mix(uHorizon, uTop, smoothstep(-0.34, 0.06, h));
		float s = max(dot(d, uSunDir), 0.0);
		col += uSun * (pow(s, 6.0) * 0.18 + pow(s, 60.0) * 0.35);
		col += uSun * 3.0 * smoothstep(1.0 - uSunSize, 1.0 - uSunSize * 0.55, s);
		gl_FragColor = vec4(col, 1.0);
		#include <tonemapping_fragment>
		#include <colorspace_fragment>
	}`;

// Soft round point sprites with per-point size, colour and alpha (dust, sparkles, stars).
const POINTS_VERT = `
	attribute float aSize; attribute float aAlpha; attribute vec3 aColor; attribute float aPhase;
	uniform float uScale; uniform float uTime; uniform float uTwinkle;
	varying float vAlpha; varying vec3 vColor;
	void main() {
		vec4 mv = modelViewMatrix * vec4(position, 1.0);
		vAlpha = aAlpha * mix(1.0, 0.55 + 0.45 * sin(uTime * 2.3 + aPhase), uTwinkle);
		vColor = aColor;
		gl_PointSize = aSize * uScale / max(0.001, -mv.z);
		gl_Position = projectionMatrix * mv;
	}`;
const POINTS_FRAG = `
	varying float vAlpha; varying vec3 vColor;
	void main() {
		vec2 p = gl_PointCoord - 0.5;
		float a = smoothstep(0.5, 0.1, length(p)) * vAlpha;
		if (a < 0.01) discard;
		gl_FragColor = vec4(vColor, a);
		#include <tonemapping_fragment>
		#include <colorspace_fragment>
	}`;

function pointsMaterial(extra = {}) {
	return new THREE.ShaderMaterial({
		uniforms: { uScale: { value: 400 }, uTime: { value: 0 }, uTwinkle: { value: 0 } },
		vertexShader: POINTS_VERT, fragmentShader: POINTS_FRAG,
		transparent: true, depthWrite: false, ...extra,
	});
}

function canvasTexture(w, h, draw) {
	const c = document.createElement('canvas');
	c.width = w; c.height = h;
	draw(c.getContext('2d'), w, h);
	const t = new THREE.CanvasTexture(c);
	t.colorSpace = THREE.SRGBColorSpace;
	return t;
}

export class RenderModule {
	constructor(canvas, { graphics = {}, reducedMotion = false, mobile = false, prefersReducedMotion = false } = {}) {
		this.canvas = canvas;
		this.reducedMotion = reducedMotion;
		this.prefersReducedMotion = prefersReducedMotion; // stills ambient animation only
		this.disposed = false;
		this.contextLost = false;

		// No canvas MSAA: anti-aliasing is a post option, so Low stays as cheap as the original.
		this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'default' });
		this.renderer.outputColorSpace = THREE.SRGBColorSpace;
		this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
		this.renderer.toneMappingExposure = 0.92;
		this.renderer.shadowMap.type = THREE.PCFShadowMap;
		this.gpu = RenderModule._gpuName(this.renderer);
		this.detected = detectPreset(this.gpu, { mobile });

		this.scene = new THREE.Scene();
		this.camera = new THREE.PerspectiveCamera(CAM.fov, 4 / 3, CAM.near, CAM.far);
		// Layers: 0 environment, 1 gameplay, 2 effects (cosmetic; never raycast).
		this.camera.layers.enable(0); this.camera.layers.enable(1); this.camera.layers.enable(2);

		this.time = 0;
		this.size = [1, 1];
		this.pixelRatio = 1;
		this.adaptiveScale = 1;
		this._frames = [];
		this.fps = 0;
		this.composer = null;
		this.postKey = null;
		this.postFailed = false;
		this.uDetail = { value: 0 };

		this._buildLights();
		this._buildSky();
		this.level = null;      // active level views
		this.particles = null;
		this.camPos = new THREE.Vector3(CAM.back, CAM.up, CAM.back);
		this.camTarget = new THREE.Vector3();
		this._camInit = false;
		this.shake = 0;
		this._tmp = new THREE.Vector3();
		this._applyTheme(getTheme('meadow'));

		this.setGraphics(graphics);

		canvas.addEventListener('webglcontextlost', this._onContextLost = (e) => { e.preventDefault(); this.contextLost = true; });
		canvas.addEventListener('webglcontextrestored', this._onContextRestored = () => { this.contextLost = false; this.postKey = null; });
	}

	static _gpuName(r) {
		try {
			const gl = r.getContext();
			const ext = gl.getExtension('WEBGL_debug_renderer_info');
			return String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '');
		} catch {
			return '';
		}
	}

	_buildLights() {
		// One dominant key light + soft hemisphere fill. The shadow box follows the vehicle.
		this.sun = new THREE.DirectionalLight(0xfff2dd, 2.0);
		this.sun.position.copy(SUN_DIR).multiplyScalar(120);
		const sh = this.sun.shadow;
		Object.assign(sh.camera, { left: -SHADOW_EXTENT, right: SHADOW_EXTENT, top: SHADOW_EXTENT, bottom: -SHADOW_EXTENT, near: 1, far: 260 });
		sh.camera.updateProjectionMatrix();
		sh.bias = -0.0004;
		sh.normalBias = 0.03;
		this.hemi = new THREE.HemisphereLight(0xbfd8e8, 0x6a7a5a, 0.9);
		this.scene.add(this.sun, this.sun.target, this.hemi);
	}

	_buildSky() {
		this.skyGeo = new THREE.SphereGeometry(600, 32, 16);
		this.skyMat = new THREE.ShaderMaterial({
			uniforms: {
				uTop: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() },
				uSun: { value: new THREE.Color() }, uSunDir: { value: SKY_SUN_DIR.clone() }, uSunSize: { value: 0.0006 },
			},
			vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, depthWrite: false, fog: false,
		});
		this.sky = new THREE.Mesh(this.skyGeo, this.skyMat);
		this.sky.layers.set(0);
		this.sky.renderOrder = -10;
		this.sky.userData.noAO = true;
		this.scene.add(this.sky);
		this.scene.fog = new THREE.Fog(0xcfe8d8, 90, 620);

		// Sky dome decorations follow the camera: clouds (drift when animated) and stars at night.
		this.skyDeco = new THREE.Group();
		this.skyDeco.layers.set(0);
		this.skyDeco.userData.noAO = true;
		this.scene.add(this.skyDeco);
		const rand = mulberry32(0x5c1e5);
		const puff = new THREE.IcosahedronGeometry(1, 1);
		this.cloudMat = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.35, flatShading: true });
		const CLOUDS = 9, PUFFS = 6;
		this.clouds = new THREE.InstancedMesh(puff, this.cloudMat, CLOUDS * PUFFS);
		this.cloudData = [];
		const m4 = new THREE.Matrix4();
		for (let c = 0; c < CLOUDS; c++) {
			// Relative to the camera: the visible sky band sits 0–0.12 rad below the horizon.
			const cx = -260 + c * 60 + rand() * 30, cy = -26 + rand() * 24, cz = -230 - rand() * 60;
			const puffs = [];
			for (let p = 0; p < PUFFS; p++) {
				const s = 6 + rand() * 7;
				puffs.push({ dx: (p - PUFFS / 2) * 5 + rand() * 4, dy: rand() * 4 - (s > 10 ? 0 : 2), dz: rand() * 6, s, sy: s * (0.55 + rand() * 0.2) });
			}
			this.cloudData.push({ x: cx, y: cy, z: cz, speed: 1.2 + rand() * 1.8, puffs });
		}
		this._layoutClouds(m4);
		this.skyDeco.add(this.clouds);

		const STARS = 420;
		const sg = new THREE.BufferGeometry();
		const pos = new Float32Array(STARS * 3), size = new Float32Array(STARS), alpha = new Float32Array(STARS);
		const col = new Float32Array(STARS * 3), phase = new Float32Array(STARS);
		for (let i = 0; i < STARS; i++) {
			const th = Math.PI * (1.15 + rand() * 0.7), y = -0.32 + rand() * 0.4;
			const r = Math.sqrt(1 - y * y);
			pos.set([Math.cos(th) * r * 520, y * 520, Math.sin(th) * r * 520], i * 3);
			size[i] = 2.2 + rand() * 3.2; alpha[i] = 0.5 + rand() * 0.5; phase[i] = rand() * 6.28;
			const warm = rand();
			col.set([1.4 + warm * 0.3, 1.4 + warm * 0.15, 1.6], i * 3);
		}
		sg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
		sg.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
		sg.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
		sg.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
		sg.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
		this.starMat = pointsMaterial({ fog: false });
		this.stars = new THREE.Points(sg, this.starMat);
		this.stars.frustumCulled = false;
		this.stars.renderOrder = -9;
		this.skyDeco.add(this.stars);
	}

	_layoutClouds(m4 = new THREE.Matrix4()) {
		let i = 0;
		const span = 560;
		for (const c of this.cloudData) {
			const x = ((c.x + this.time * c.speed) % span + span) % span - span / 2;
			for (const p of c.puffs) {
				m4.makeScale(p.s, p.sy, p.s).setPosition(x + p.dx, c.y + p.dy, c.z + p.dz);
				this.clouds.setMatrixAt(i++, m4);
			}
		}
		this.clouds.instanceMatrix.needsUpdate = true;
	}

	_applyTheme(theme) {
		this.theme = theme;
		const sky = new THREE.Color(theme.sky), fog = new THREE.Color(theme.fog);
		const dark = sky.getHSL({}).l < 0.3;
		this.night = dark;
		// Zenith is a deeper version of the theme sky; the horizon melts into the fog colour.
		// ACES desaturates brights, so the zenith is authored a little richer than the theme sky.
		this.skyMat.uniforms.uTop.value.copy(sky).offsetHSL(0, dark ? 0 : 0.18, dark ? 0 : -0.1);
		this.skyMat.uniforms.uHorizon.value.copy(fog).lerp(sky, 0.15);
		this.skyMat.uniforms.uSun.value.set(dark ? 0xcfd8ff : 0xfff0d0).multiplyScalar(dark ? 0.55 : 1);
		this.skyMat.uniforms.uSunSize.value = dark ? 0.0004 : 0.0006;
		this.scene.fog.color.copy(fog);
		this.hemi.color.setHex(theme.sky);
		this.hemi.groundColor.set(theme.ground).multiplyScalar(0.6);
		this.cloudMat.color.set(dark ? 0x5a6078 : 0xffffff).lerp(fog, 0.15);
		this.cloudMat.emissive.set(dark ? 0x20243a : 0xffffff);
		this.stars.visible = dark;
		this._envStrength();
	}

	// Diffuse IBL stays subtle (scene.environmentIntensity); glossy pieces carry their own
	// stronger envMap (userData.hwEnv) so paint, rims and cans get real reflections.
	_envStrength() {
		this.scene.environmentIntensity = this.night ? 0.1 : 0.22;
		const refl = this.q?.reflections === 'on';
		this.hemi.intensity = refl ? 0.62 : 0.8;
	}

	_applyEnvToMaterials(root) {
		const env = this.q?.reflections === 'on' ? this.scene.environment : null;
		root.traverse((o) => {
			const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
			for (const m of mats) {
				if (m.userData.hwEnv === undefined) continue;
				m.envMap = env;
				m.envMapIntensity = m.userData.hwEnv * (this.night ? 0.5 : 1);
				m.needsUpdate = true;
			}
		});
	}

	_envMap() {
		if (!this.envTex) {
			const pmrem = new THREE.PMREMGenerator(this.renderer);
			const room = new RoomEnvironment();
			this.envTex = pmrem.fromScene(room, 0.04).texture;
			room.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
			pmrem.dispose();
		}
		return this.envTex;
	}

	// --- Graphics settings ---------------------------------------------------------

	/** Apply saved graphics settings ({} = Auto). Takes effect on the next frame, no reload. */
	setGraphics(saved) {
		const key = JSON.stringify(saved || {});
		if (key === this._gfxKey) return;
		this._gfxKey = key;
		const prev = this.q;
		const g = resolve(saved, this.detected);
		this.q = g;

		const size = SHADOW_MAP[g.shadows];
		this.renderer.shadowMap.enabled = size > 0;
		this.sun.castShadow = size > 0;
		if (size > 0 && this.sun.shadow.mapSize.x !== size) {
			this.sun.shadow.mapSize.set(size, size);
			this.sun.shadow.map?.dispose();
			this.sun.shadow.map = null;
		}
		try { this.scene.environment = g.reflections === 'on' ? this._envMap() : null; }
		catch { this.scene.environment = null; }
		this._envStrength();
		this.uDetail.value = g.detail === 'detailed' ? 1 : 0;

		// Geometry-level choices rebuild the level views (same seed, same layout).
		const rebuild = prev && this.level && (prev.detail !== g.detail || prev.foliage !== g.foliage || prev.particles !== g.particles);
		if (rebuild) {
			const { state, themeId, seed } = this.level;
			this.loadLevel(state, themeId, seed);
		} else if (this.level) {
			this._applyShadowFlags();
			this._applyEnvToMaterials(this.level.group);
		}
		this.adaptiveScale = 1;
		this._frames = [];
		this.postKey = null;
		this.postFailed = false;
		this._fpsVisible(g.showFps);
		this.canvas.dataset.gfxPreset = g.preset;
		this.canvas.dataset.gfxAuto = g.auto ? '1' : '0';
		// Materials pick up shadow-map / environment changes on recompile.
		this.scene.traverse((o) => {
			const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
			for (const m of mats) m.needsUpdate = true;
		});
	}

	/** What the Settings panel shows: GPU, auto choice, resolved tiers, cost and frame rate. */
	graphicsInfo(words) {
		const px = [Math.round(this.size[0] * this.pixelRatio), Math.round(this.size[1] * this.pixelRatio)];
		return {
			gpu: this.gpu,
			detected: this.detected,
			resolved: this.q,
			summary: describe(this.q, px, words),
			fps: Math.round(this.fps || 0),
			adaptiveScale: Math.round(this.adaptiveScale * 100) / 100,
			postFailed: !!this.postFailed,
		};
	}

	_applyShadowFlags() {
		const on = this.q.shadows !== 'off';
		const lv = this.level;
		if (!lv) return;
		lv.ground.receiveShadow = on;
		lv.ground.castShadow = this.q.shadows === 'high';
		for (const o of lv.casters) o.castShadow = on;
		for (const o of lv.receivers) o.receiveShadow = on;
	}

	_fpsVisible(on) {
		let el = document.getElementById('hw-fps');
		if (on && !el) {
			el = document.createElement('div');
			el.id = 'hw-fps';
			el.className = 'hw-fps';
			el.setAttribute('aria-hidden', 'true');
			el.textContent = '… fps';
			(this.canvas.closest('.hw-root') || document.body).appendChild(el);
		}
		if (el) el.hidden = !on;
	}

	_postKey(w, h) {
		const g = this.q;
		return g.post ? [g.ao, g.bloom, g.grade, g.antialias, w, h, this.pixelRatio, this.theme?.id].join('|') : 'none';
	}

	_buildPost(w, h) {
		const g = this.q;
		this.composer?.dispose();
		this.composer = null;
		if (!g.post || this.postFailed) return;
		const pr = this.pixelRatio;
		try {
			const target = new THREE.WebGLRenderTarget(Math.max(1, Math.round(w * pr)), Math.max(1, Math.round(h * pr)), {
				type: THREE.HalfFloatType, samples: g.antialias === 'msaa' ? 4 : 0,
			});
			const composer = new EffectComposer(this.renderer, target);
			composer.setPixelRatio(pr);
			composer.setSize(w, h);
			composer.addPass(new RenderPass(this.scene, this.camera));
			if (g.ao !== 'off') {
				const ao = new GTAOPass(this.scene, this.camera, w * pr, h * pr);
				ao.output = GTAOPass.OUTPUT.Default;
				// Keep the sky dome, clouds, backdrop ridges and halo sprites out of the AO
				// depth/normal pre-pass: they are backdrop, not contact surfaces.
				const hidePoints = ao._overrideVisibility.bind(ao);
				ao._overrideVisibility = () => {
					hidePoints();
					this.scene.traverse((o) => {
						if (o.userData.noAO && o.visible) { o.visible = false; ao._visibilityCache.push(o); }
					});
				};
				ao.blendIntensity = 0.7;
				ao.updateGtaoMaterial({ radius: 1.2, distanceExponent: 1.5, thickness: 1.5, scale: 1.0, samples: g.ao === 'high' ? 16 : 8 });
				ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: g.ao === 'high' ? 6 : 4, rings: 2, samples: g.ao === 'high' ? 16 : 8 });
				composer.addPass(ao);
			}
			if (g.bloom === 'on') {
				// High threshold: only the sun, headlights, fuel cans, the goal flag and sparkles bloom.
				const bright = new THREE.Color(this.theme.ground).getHSL({}).l > 0.7; // snow would bloom
				composer.addPass(new UnrealBloomPass(new THREE.Vector2(w, h), 0.42, 0.45, bright ? 2.2 : 0.92));
			}
			composer.addPass(new OutputPass());
			if (g.grade === 'on') composer.addPass(new ShaderPass(GradeShader));
			if (g.antialias === 'smaa') composer.addPass(new SMAAPass());
			if (g.antialias === 'fxaa') {
				const fxaa = new ShaderPass(FXAAShader);
				fxaa.material.uniforms.resolution.value.set(1 / (w * pr), 1 / (h * pr));
				composer.addPass(fxaa);
			}
			this.composer = composer;
		} catch {
			// Post-processing is an enhancement: render directly and let the panel say so.
			this.postFailed = true;
			this.composer = null;
		}
	}

	// Adaptive resolution: step the render scale down when frames are slow, back up when fast.
	_adapt(dtMs) {
		const f = this._frames;
		f.push(dtMs);
		if (f.length < 90) return false;
		const avg = f.reduce((a, b) => a + b, 0) / f.length;
		f.length = 0;
		this.fps = 1000 / avg;
		const el = document.getElementById('hw-fps');
		if (el && !el.hidden) el.textContent = `${Math.round(this.fps)} fps · ${Math.round(this.pixelRatio * 100) / 100}×`;
		if (!this.q.adaptive) return false;
		const before = this.adaptiveScale;
		if (avg > 26) this.adaptiveScale = Math.max(0.6, this.adaptiveScale - 0.1);
		else if (avg < 14 && this.adaptiveScale < 1) this.adaptiveScale = Math.min(1, this.adaptiveScale + 0.05);
		return before !== this.adaptiveScale;
	}

	// --- Level views ------------------------------------------------------------

	loadLevel(state, themeId, seed) {
		this.unloadLevel();
		const theme = getTheme(themeId);
		this._applyTheme(theme);
		const q = this.q;
		const detailed = q.detail === 'detailed';
		const group = new THREE.Group();
		const terrain = state.terrain;
		const length = state.goalX;
		const casters = [], receivers = [];

		// Surface height: the rules' profile across the track band, then a rolling slope that
		// falls away behind it, so the course reads as a ridge above a hazy valley with sky
		// above (cosmetic only; the vehicle only ever touches z = 0).
		const surfaceY = (x, z) => {
			const base = terrain.height(x);
			if (z >= -TRACK_HALF) return base;
			const d = -z - TRACK_HALF;
			const n = vnoise(x * 0.045 + 3.1, z * 0.07) * 0.65 + vnoise(x * 0.12, z * 0.2 + 7.7) * 0.35;
			return base - d * 0.3 + (n - 0.4) * Math.min(1, d / 6) * (2 + d * 0.1);
		};
		this._surfaceY = surfaceY;

		const stepLen = TERRAIN_STEP[q.detail];
		const startX = -60, endX = length + 80;
		const count = Math.ceil((endX - startX) / stepLen) + 1;
		const xs = Array.from({ length: count }, (_, i) => startX + i * stepLen);

		const cNear = new THREE.Color(theme.ground), cFar = new THREE.Color(theme.groundFar);
		const cRock = new THREE.Color(theme.rock);
		const cTrack = cNear.clone().lerp(cRock, 0.45).lerp(new THREE.Color(0xb89a6a), 0.25);
		const cSoil = cRock.clone().lerp(new THREE.Color(0x4a3526), 0.7);
		const cDeep = cSoil.clone().multiplyScalar(0.55);
		const cFog = new THREE.Color(theme.fog);
		const tmpC = new THREE.Color();

		const pos = [], col = [], idx = [];
		const addGrid = (rows, point, colour, up) => {
			const base = pos.length / 3;
			for (let r = 0; r < rows.length; r++) {
				for (let i = 0; i < count; i++) {
					const p = point(xs[i], rows[r]);
					pos.push(p[0], p[1], p[2]);
					const c = colour(xs[i], rows[r], i / count);
					col.push(c.r, c.g, c.b);
				}
			}
			for (let r = 0; r < rows.length - 1; r++) {
				for (let i = 0; i < count - 1; i++) {
					const a = base + r * count + i, b = a + 1, c = a + count, d = c + 1;
					if (up) idx.push(a, b, c, b, d, c); else idx.push(a, c, b, b, c, d);
				}
			}
		};
		// Top surface, front lip → far back.
		const rows = detailed ? ROWS_DETAILED : ROWS_PLAIN;
		addGrid(rows, (x, z) => [x, surfaceY(x, z), z], (x, z, t) => {
			const n = vnoise(x * 0.3, z * 0.3);
			if (Math.abs(z) < TRACK_HALF - 0.6) {
				return tmpC.copy(cTrack).multiplyScalar(0.94 + n * 0.12);
			}
			const far = Math.min(1, Math.max(0, (-z - 4) / 70));
			tmpC.copy(cNear).lerp(cFar, Math.min(1, t * 0.6 + far * 0.7));
			tmpC.multiplyScalar(0.8 + n * 0.25);
			return tmpC.lerp(cFog, far * 0.25);
		}, true);
		// Front cut face: grass lip, soil band, dark depth.
		const cutRows = [0, -0.35, -1.6, -CUT_DEPTH];
		addGrid(cutRows, (x, dy) => [x, terrain.height(x) + dy, FRONT_Z], (x, dy) => {
			if (dy === 0) return tmpC.copy(cNear).multiplyScalar(0.8);
			if (dy > -1) return tmpC.copy(cSoil);
			if (dy > -2) return tmpC.copy(cSoil).multiplyScalar(0.85);
			return tmpC.copy(cDeep);
		}, false);
		const geo = new THREE.BufferGeometry();
		geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
		geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
		geo.setIndex(idx);
		geo.computeVertexNormals();
		const mat = this._terrainMaterial();
		const groundMesh = new THREE.Mesh(geo, mat);
		groundMesh.layers.set(0);
		group.add(groundMesh);

		// Backdrop ridges: two silhouette layers that rise with the course; fog gives depth.
		const smooth = (x, w) => {
			let s = 0;
			for (let k = -2; k <= 2; k++) s += terrain.height(Math.min(length, Math.max(0, x + k * w)));
			return s / 5;
		};
		const ridges = [
			{ z: -170, amp: 20, lift: -52, freq: 0.012, w: 50, color: cFar.clone().multiplyScalar(0.8).lerp(cFog, 0.38) },
			{ z: -320, amp: 45, lift: -48, freq: 0.006, w: 110, color: cFar.clone().lerp(cFog, 0.72).lerp(new THREE.Color(theme.sky), 0.15) },
		];
		this.ridges = [];
		for (const [ri, rdg] of ridges.entries()) {
			const rStep = 8, rStart = -500, rEnd = length + 500;
			const n = Math.ceil((rEnd - rStart) / rStep) + 1;
			const rp = new Float32Array(n * 2 * 3);
			for (let i = 0; i < n; i++) {
				const x = rStart + i * rStep;
				const top = smooth(x, rdg.w) + rdg.lift + rdg.amp * (vnoise(x * rdg.freq + ri * 13, 0.5) * 0.8 + vnoise(x * rdg.freq * 3.1, 2.5) * 0.25);
				rp.set([x, top, rdg.z, x, top - 400, rdg.z], i * 6);
			}
			const ri2 = [];
			for (let i = 0; i < n - 1; i++) { const a = i * 2; ri2.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
			const rg = new THREE.BufferGeometry();
			rg.setAttribute('position', new THREE.BufferAttribute(rp, 3));
			rg.setIndex(ri2);
			const rm = new THREE.Mesh(rg, new THREE.MeshBasicMaterial({ color: rdg.color }));
			rm.layers.set(0);
			rm.renderOrder = -5;
			rm.userData.noAO = true;
			group.add(rm);
			this.ridges.push(rm);
		}

		// Vehicle: rounded clear-coated buggy with roll cage, driver, spoked wheels and lights.
		const vehicle = this._buildVehicle();
		group.add(vehicle.group);
		this.vehicleView = vehicle.group;
		this.wheels = vehicle.wheels;
		vehicle.group.traverse((o) => { o.layers.set(1); if (o.isMesh) casters.push(o); });

		// Fuel cans: glossy jerry cans with a soft halo so they read from far away.
		const canBody = new RoundedBoxGeometry(0.62, 0.82, 0.34, 2, 0.07);
		const canHandle = new THREE.TorusGeometry(0.13, 0.035, 6, 12, Math.PI);
		const canSpout = new THREE.CylinderGeometry(0.05, 0.06, 0.16, 8);
		const canMat = new THREE.MeshPhysicalMaterial({ color: theme.accent, roughness: 0.35, metalness: 0.15, clearcoat: 1, clearcoatRoughness: 0.2, emissive: theme.accent, emissiveIntensity: 0.22 });
		canMat.userData.hwEnv = 0.5;
		const capMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.5, metalness: 0.6 });
		const haloTex = this._haloTexture();
		const haloMat = new THREE.SpriteMaterial({ map: haloTex, color: new THREE.Color(theme.accent).multiplyScalar(1.3), transparent: true, opacity: 0.55, depthWrite: false, fog: false });
		this.canViews = state.cans.map((c) => {
			const g = new THREE.Group();
			const body = new THREE.Mesh(canBody, canMat);
			const handle = new THREE.Mesh(canHandle, capMat); handle.position.set(-0.08, 0.41, 0);
			const spout = new THREE.Mesh(canSpout, capMat); spout.position.set(0.2, 0.47, 0); spout.rotation.z = -0.5;
			const halo = new THREE.Sprite(haloMat); halo.scale.set(2.2, 2.2, 1); halo.renderOrder = 2;
			halo.userData.noAO = true;
			g.add(halo, body, handle, spout);
			g.position.set(c.x, terrain.height(c.x) + 1.2, 0);
			g.traverse((o) => { o.layers.set(1); if (o.isMesh) casters.push(o); });
			group.add(g);
			return g;
		});

		// Checkpoint flags (yellow → green when passed) and the goal: cloth that waves in the wind.
		const flagPole = new THREE.CylinderGeometry(0.07, 0.07, 4, 8);
		const poleMat = new THREE.MeshStandardMaterial({ color: 0xd4d8dc, roughness: 0.35, metalness: 0.6 });
		poleMat.userData.hwEnv = 0.8;
		const knob = new THREE.SphereGeometry(0.13, 12, 8);
		const knobMat = new THREE.MeshStandardMaterial({ color: 0xf2c14e, roughness: 0.3, metalness: 0.8 });
		const mkCloth = () => new THREE.PlaneGeometry(1.4, 0.8, 10, 3).translate(0.7, 0, 0);
		this.cloths = [];
		this.flagViews = state.checkpoints.map((cx) => {
			const g = new THREE.Group();
			const pole = new THREE.Mesh(flagPole, poleMat);
			const top = new THREE.Mesh(knob, knobMat); top.position.y = 2.05;
			const flag = new THREE.Mesh(mkCloth(), new THREE.MeshStandardMaterial({ color: 0xf2c14e, roughness: 0.7, side: THREE.DoubleSide, emissive: 0xf2c14e, emissiveIntensity: 0.12 }));
			flag.position.set(0.05, 1.6, 0);
			g.add(pole, top, flag);
			g.position.set(cx, terrain.height(cx) + 2, -0.9);
			g.traverse((o) => { o.layers.set(1); if (o.isMesh) casters.push(o); });
			group.add(g);
			this.cloths.push(flag);
			return { group: g, flag };
		});
		const goal = new THREE.Group();
		const gp = new THREE.Mesh(flagPole, poleMat);
		const gtop = new THREE.Mesh(knob, knobMat); gtop.position.y = 2.05;
		const gf = new THREE.Mesh(mkCloth(), new THREE.MeshStandardMaterial({ color: 0x4ed88a, roughness: 0.5, side: THREE.DoubleSide, emissive: 0x4ed88a, emissiveIntensity: 0.45 }));
		gf.scale.set(1.6, 1.6, 1); gf.position.set(0.05, 1.5, 0);
		goal.add(gp, gtop, gf);
		goal.position.set(state.goalX, terrain.height(state.goalX) + 2.2, -0.9);
		this.cloths.push(gf);
		// Finish arch: two posts and a chequered banner across the track.
		const archMat = new THREE.MeshStandardMaterial({ color: 0xf0f0f0, roughness: 0.4, metalness: 0.4 });
		const checker = canvasTexture(256, 32, (ctx, w, h) => {
			for (let i = 0; i < 16; i++) for (let j = 0; j < 2; j++) {
				ctx.fillStyle = (i + j) % 2 ? '#111' : '#f4f4f4';
				ctx.fillRect(i * 16, j * 16, 16, 16);
			}
		});
		const gy = terrain.height(state.goalX);
		const post = new THREE.CylinderGeometry(0.1, 0.1, 6, 8);
		for (const z of [-2.6, 2.6]) {
			const p = new THREE.Mesh(post, archMat);
			p.position.set(state.goalX, gy + 3, z);
			group.add(p); casters.push(p);
		}
		// The banner spans the track (along z); the chequer faces the camera (+x/−x box faces).
		const checkerMat = new THREE.MeshStandardMaterial({ map: checker, roughness: 0.6 });
		const banner = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.7, 5.4), [checkerMat, checkerMat, archMat, archMat, archMat, archMat]);
		banner.position.set(state.goalX, gy + 5.6, 0);
		group.add(banner); casters.push(banner);
		goal.traverse((o) => { o.layers.set(1); if (o.isMesh) casters.push(o); });
		group.add(goal);

		// Vegetation + rocks: instanced, deterministic from a decoration-only stream.
		const deco = mulberry32((seed ^ 0xdec0) >>> 0);
		const density = FOLIAGE_DENSITY[q.foliage];
		if (density > 0) {
			const treeCount = Math.floor((length / 7) * density);
			const trunkGeo = new THREE.CylinderGeometry(0.14, 0.24, 1.4, 6);
			const crownLo = new THREE.ConeGeometry(1.15, 2.0, 8);
			const crownHi = new THREE.ConeGeometry(0.8, 1.7, 8);
			const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6a4a2e, roughness: 0.9 });
			const crownMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, flatShading: true });
			const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, treeCount);
			const lows = new THREE.InstancedMesh(crownLo, crownMat, treeCount);
			const highs = new THREE.InstancedMesh(crownHi, crownMat, treeCount);
			const m4 = new THREE.Matrix4(), rot = new THREE.Quaternion(), sc = new THREE.Vector3(), pv = new THREE.Vector3();
			const base = new THREE.Color(theme.tree), c = new THREE.Color();
			for (let i = 0; i < treeCount; i++) {
				const x = -40 + deco() * (length + 90);
				const z = -(5 + Math.pow(deco(), 1.4) * 55);
				const s = 0.8 + deco() * 1.1;
				const y = surfaceY(x, z) - 0.1;
				rot.setFromAxisAngle(pv.set(0, 1, 0), deco() * 6.28);
				sc.set(s, s * (0.9 + deco() * 0.3), s);
				m4.compose(pv.set(x, y + 0.7 * sc.y, z), rot, sc); trunks.setMatrixAt(i, m4);
				m4.compose(pv.set(x, y + 2.1 * sc.y, z), rot, sc); lows.setMatrixAt(i, m4);
				m4.compose(pv.set(x, y + 3.2 * sc.y, z), rot, sc); highs.setMatrixAt(i, m4);
				c.copy(base).multiplyScalar(0.8 + deco() * 0.45);
				lows.setColorAt(i, c); highs.setColorAt(i, c.multiplyScalar(1.12));
			}
			const rockCount = Math.floor((length / 12) * density);
			const rockGeo = new THREE.DodecahedronGeometry(0.6, 0);
			const rockMat = new THREE.MeshStandardMaterial({ color: theme.rock, roughness: 0.85, flatShading: true });
			const rocks = new THREE.InstancedMesh(rockGeo, rockMat, rockCount);
			for (let i = 0; i < rockCount; i++) {
				const x = -40 + deco() * (length + 90);
				const z = -(3.2 + deco() * 30);
				const s = 0.5 + deco() * 1.4;
				rot.setFromEuler(new THREE.Euler(deco() * 3, deco() * 3, deco() * 3));
				m4.compose(pv.set(x, surfaceY(x, z) + 0.15 * s, z), rot, sc.set(s * 1.3, s * 0.7, s));
				rocks.setMatrixAt(i, m4);
			}
			for (const m of [trunks, lows, highs, rocks]) { m.layers.set(0); group.add(m); casters.push(m); }
		}

		// Grass tufts along the track edges (detailed terrain only).
		if (detailed && theme.id !== 'frost') {
			const tuftGeo = new THREE.ConeGeometry(0.09, 0.5, 3).translate(0, 0.25, 0);
			const tuftCount = Math.floor(length * 2.2);
			const tufts = new THREE.InstancedMesh(tuftGeo, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 }), tuftCount);
			const m4 = new THREE.Matrix4(), rot = new THREE.Quaternion(), sc = new THREE.Vector3(), pv = new THREE.Vector3(), e = new THREE.Euler();
			const tc = new THREE.Color(theme.groundFar), c = new THREE.Color();
			for (let i = 0; i < tuftCount; i++) {
				const x = -40 + deco() * (length + 90);
				const side = deco() < 0.3 ? 1 : -1;
				const z = side * (TRACK_HALF - 0.2 + deco() * 3.2);
				const s = 0.6 + deco() * 0.9;
				rot.setFromEuler(e.set((deco() - 0.5) * 0.5, deco() * 6.28, (deco() - 0.5) * 0.5));
				m4.compose(pv.set(x, surfaceY(x, Math.min(z, FRONT_Z - 0.3)) - 0.02, z), rot, sc.set(s, s * (0.7 + deco() * 0.8), s));
				tufts.setMatrixAt(i, m4);
				tufts.setColorAt(i, c.copy(tc).multiplyScalar(0.85 + deco() * 0.35));
			}
			tufts.layers.set(0);
			group.add(tufts);
			receivers.push(tufts);
		}

		// Particle pool: dust, landing puffs and can sparkles (bounded, layer 2 = never raycast).
		const pCount = PARTICLE_POOL[q.particles];
		this.particles = null;
		if (pCount > 0) {
			const pGeo = new THREE.BufferGeometry();
			pGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pCount * 3), 3));
			pGeo.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(pCount), 1));
			pGeo.setAttribute('aAlpha', new THREE.BufferAttribute(new Float32Array(pCount), 1));
			pGeo.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(pCount * 3), 3));
			pGeo.setAttribute('aPhase', new THREE.BufferAttribute(new Float32Array(pCount), 1));
			this.particles = new THREE.Points(pGeo, pointsMaterial());
			this.particles.frustumCulled = false;
			this.particles.layers.set(2);
			this.particleData = Array.from({ length: pCount }, () => ({ life: 0, max: 1, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, size: 1, g: 0, r: 1, gg: 1, b: 1 }));
			this._pNext = 0;
			group.add(this.particles);
		}
		this.dustColor = cTrack.clone().lerp(new THREE.Color(0xe8dcc0), 0.5);
		this.accentColor = new THREE.Color(theme.accent).multiplyScalar(2.2);

		this.level = { group, ground: groundMesh, casters, receivers, state, themeId, seed };
		this._applyShadowFlags();
		this._applyEnvToMaterials(group);
		this.scene.add(group);
		this._camInit = false;
		this._canTaken = state.cans.map((c) => c.taken);
		this._wasGrounded = true;
	}

	_terrainMaterial() {
		const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, envMapIntensity: 0.5 });
		const uDetail = this.uDetail;
		mat.onBeforeCompile = (shader) => {
			shader.uniforms.uDetail = uDetail;
			shader.vertexShader = shader.vertexShader
				.replace('#include <common>', '#include <common>\nvarying vec3 vHwWorld;')
				.replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvHwWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
			shader.fragmentShader = shader.fragmentShader
				.replace('#include <common>', `#include <common>
					uniform float uDetail; varying vec3 vHwWorld;
					float hwHash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
					float hwNoise(vec3 p) {
						vec3 i = floor(p); vec3 f = fract(p); f = f * f * (3.0 - 2.0 * f);
						return mix(mix(mix(hwHash(i), hwHash(i + vec3(1,0,0)), f.x), mix(hwHash(i + vec3(0,1,0)), hwHash(i + vec3(1,1,0)), f.x), f.y),
							mix(mix(hwHash(i + vec3(0,0,1)), hwHash(i + vec3(1,0,1)), f.x), mix(hwHash(i + vec3(0,1,1)), hwHash(i + vec3(1,1,1)), f.x), f.y), f.z);
					}`)
				.replace('#include <color_fragment>', `#include <color_fragment>
					if (uDetail > 0.5) {
						float n = hwNoise(vHwWorld * 0.55) * 0.55 + hwNoise(vHwWorld * 2.1) * 0.3 + hwNoise(vHwWorld * 7.0) * 0.15;
						diffuseColor.rgb *= 0.84 + 0.32 * n;
					}`);
		};
		mat.customProgramCacheKey = () => 'hw-terrain-v1';
		return mat;
	}

	_haloTexture() {
		if (!this._halo) {
			this._halo = canvasTexture(64, 64, (ctx, w, h) => {
				const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
				g.addColorStop(0, 'rgba(255,255,255,0.9)');
				g.addColorStop(0.35, 'rgba(255,255,255,0.35)');
				g.addColorStop(1, 'rgba(255,255,255,0)');
				ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
			});
		}
		return this._halo;
	}

	_buildVehicle() {
		const group = new THREE.Group();
		const paint = new THREE.MeshPhysicalMaterial({ color: 0xc83a22, roughness: 0.38, metalness: 0.2, clearcoat: 1, clearcoatRoughness: 0.15 });
		const dark = new THREE.MeshStandardMaterial({ color: 0x2e3a44, roughness: 0.45, metalness: 0.5 });
		const tube = new THREE.MeshStandardMaterial({ color: 0x3a4148, roughness: 0.3, metalness: 0.85 });
		const helmetMat = new THREE.MeshPhysicalMaterial({ color: 0x2f6fb0, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.1 });
		const stripe = new THREE.MeshStandardMaterial({ color: 0x1f2830, roughness: 0.4 });
		const visor = new THREE.MeshPhysicalMaterial({ color: 0x14181e, roughness: 0.1, metalness: 0.4, clearcoat: 1 });
		paint.userData.hwEnv = 0.6; tube.userData.hwEnv = 1; helmetMat.userData.hwEnv = 1; visor.userData.hwEnv = 1.2; dark.userData.hwEnv = 0.6;

		const chassis = new THREE.Mesh(new RoundedBoxGeometry(2.2, 0.46, 1.1, 2, 0.12), paint);
		chassis.position.y = 0.3;
		const hood = new THREE.Mesh(new RoundedBoxGeometry(0.8, 0.22, 1.0, 2, 0.08), paint);
		hood.position.set(0.72, 0.56, 0); hood.rotation.z = -0.22;
		const stripeGeo = new THREE.BoxGeometry(1.7, 0.08, 0.02);
		const stripeF = new THREE.Mesh(stripeGeo, stripe); stripeF.position.set(0, 0.34, 0.56);
		const stripeB = stripeF.clone(); stripeB.position.z = -0.56;
		const seat = new THREE.Mesh(new RoundedBoxGeometry(0.55, 0.36, 0.72, 2, 0.08), dark);
		seat.position.set(-0.45, 0.66, 0);
		const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.24, 16, 12), helmetMat);
		helmet.position.set(-0.2, 1.0, 0);
		const vis = new THREE.Mesh(new RoundedBoxGeometry(0.1, 0.13, 0.3, 1, 0.04), visor);
		vis.position.set(0.02, 1.01, 0);
		const body = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.24, 0.4, 10), dark);
		body.position.set(-0.25, 0.72, 0);
		// Roll cage: two hoops across the car joined by a top bar.
		const hoopGeo = new THREE.TorusGeometry(0.5, 0.045, 6, 18, Math.PI);
		const hoopA = new THREE.Mesh(hoopGeo, tube); hoopA.rotation.y = Math.PI / 2; hoopA.position.set(-0.7, 0.55, 0);
		const hoopB = new THREE.Mesh(hoopGeo, tube); hoopB.rotation.y = Math.PI / 2; hoopB.position.set(0.15, 0.5, 0); hoopB.scale.set(1, 0.95, 1);
		const barGeo = new THREE.CylinderGeometry(0.04, 0.04, 0.9, 6);
		const bar = new THREE.Mesh(barGeo, tube); bar.rotation.z = Math.PI / 2 - 0.06; bar.position.set(-0.28, 1.03, 0);
		// Lights: HDR emissive so bloom gives them a glow.
		const headMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff1c8, emissiveIntensity: 3.2 });
		const tailMat = new THREE.MeshStandardMaterial({ color: 0x661010, emissive: 0xff2a1a, emissiveIntensity: 2.2 });
		const lampGeo = new THREE.BoxGeometry(0.06, 0.12, 0.2);
		const headF = new THREE.Mesh(lampGeo, headMat); headF.position.set(1.11, 0.4, 0.34);
		const headB = headF.clone(); headB.position.z = -0.34;
		const tail = new THREE.Mesh(lampGeo, tailMat); tail.position.set(-1.11, 0.4, 0.34);
		const exhaust = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.4, 8), tube);
		exhaust.rotation.z = Math.PI / 2; exhaust.position.set(-1.15, 0.18, -0.3);
		group.add(chassis, hood, stripeF, stripeB, seat, body, helmet, vis, hoopA, hoopB, bar, headF, headB, tail, exhaust);

		// Wheels: chunky tyre, silver rim, three spokes so the roll is visible.
		const tyreGeo = new THREE.TorusGeometry(0.34, 0.13, 10, 22);
		const rimGeo = new THREE.CylinderGeometry(0.25, 0.25, 0.26, 16).rotateX(Math.PI / 2);
		const spokeGeo = new THREE.BoxGeometry(0.44, 0.07, 0.04);
		const axleGeo = new THREE.CylinderGeometry(0.05, 0.05, 1.1, 6).rotateX(Math.PI / 2);
		const tyreMat = new THREE.MeshStandardMaterial({ color: 0x1c1f22, roughness: 0.9 });
		const rimMat = new THREE.MeshStandardMaterial({ color: 0xc8ccd0, roughness: 0.25, metalness: 0.9 });
		rimMat.userData.hwEnv = 1;
		const spokeMat = new THREE.MeshStandardMaterial({ color: 0xf2c14e, roughness: 0.4, metalness: 0.3 });
		const wheels = [];
		for (const wx of [0.75, -0.75]) {
			const axle = new THREE.Mesh(axleGeo, tube); axle.position.set(wx, 0, 0);
			group.add(axle);
			for (const wz of [0.55, -0.55]) {
				const w = new THREE.Group();
				const tyre = new THREE.Mesh(tyreGeo, tyreMat); tyre.scale.z = 1.9;
				const rim = new THREE.Mesh(rimGeo, rimMat);
				w.add(tyre, rim);
				for (let k = 0; k < 3; k++) {
					const sp = new THREE.Mesh(spokeGeo, spokeMat);
					sp.rotation.z = (k * Math.PI) / 3;
					sp.position.z = Math.sign(wz) * 0.14;
					w.add(sp);
				}
				w.position.set(wx, 0, wz);
				group.add(w);
				wheels.push(w);
			}
		}
		return { group, wheels };
	}

	unloadLevel() {
		if (!this.level) return;
		this.scene.remove(this.level.group);
		const seen = new Set();
		this.level.group.traverse((o) => {
			if (o.isMesh || o.isPoints || o.isSprite) {
				if (!o.isSprite) o.geometry?.dispose();
				const mats = Array.isArray(o.material) ? o.material : [o.material];
				for (const m of mats) {
					if (!m || seen.has(m)) continue;
					seen.add(m);
					if (m.map && m.map !== this._halo) m.map.dispose();
					m.dispose();
				}
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
		for (const w of this.wheels) w.rotation.z = -x / WHEEL_R;

		// Cans: hide collected (with a sparkle burst), bob the rest (deterministic phase from index).
		const t = state.tick / 60;
		const moving = !this.reducedMotion;
		for (let i = 0; i < this.canViews.length; i++) {
			const m = this.canViews[i];
			if (state.cans[i].taken) {
				if (!this._canTaken[i] && moving) this._burst(m.position.x, m.position.y, 18, this.accentColor, 0.35, 5);
				this._canTaken[i] = true;
				m.visible = false;
				continue;
			}
			this._canTaken[i] = false;
			m.visible = true;
			m.position.y = terrain.height(state.cans[i].x) + 1.2 + (moving ? Math.sin(t * 2 + i) * 0.15 : 0);
			m.rotation.y = moving ? t + i : 0;
		}
		// Checkpoint flags: mark passed.
		for (let i = 0; i < this.flagViews.length; i++) {
			const passed = i < state.nextCheckpoint;
			const f = this.flagViews[i].flag.material;
			f.color.setHex(passed ? 0x4ed88a : 0xf2c14e);
			f.emissive.setHex(passed ? 0x4ed88a : 0xf2c14e);
		}

		// Dust when grounded and moving; a puff on landing.
		if (this.particles && moving) {
			if (cur.grounded && Math.abs(cur.vx) > 4) this._emitDust(x - Math.sign(cur.vx || 1) * 0.8, terrain.height(x) + 0.1, cur.vx);
			if (cur.grounded && !this._wasGrounded) this._burst(x, terrain.height(x) + 0.2, 14, this.dustColor, 0.9, 3);
		}
		this._wasGrounded = cur.grounded;
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
		this._fitShadow(x + 6, groundY);
	}

	// Keep the shadow box on the play area around the vehicle, snapped to whole texels so it
	// does not shimmer as the camera moves.
	_fitShadow(fx, fy) {
		if (!this.sun.castShadow) return;
		const size = this.sun.shadow.mapSize.x || 1024;
		const texel = (SHADOW_EXTENT * 2) / size;
		const fwd = this._tmp.copy(SUN_DIR).negate();
		const right = new THREE.Vector3().crossVectors(fwd, THREE.Object3D.DEFAULT_UP).normalize();
		const up = new THREE.Vector3().crossVectors(right, fwd);
		const p = new THREE.Vector3(fx, fy, 0);
		const r = p.dot(right), u = p.dot(up), f = p.dot(fwd);
		const snapped = right.multiplyScalar(Math.round(r / texel) * texel)
			.add(up.multiplyScalar(Math.round(u / texel) * texel))
			.add(fwd.multiplyScalar(f));
		this.sun.target.position.copy(snapped);
		this.sun.position.copy(snapped).addScaledVector(SUN_DIR, 120);
		this.sun.target.updateMatrixWorld();
	}

	addShake(amount) { if (!this.reducedMotion) this.shake = Math.min(1.2, this.shake + amount); }

	_spawn() {
		const d = this.particleData[this._pNext];
		this._pNext = (this._pNext + 1) % this.particleData.length;
		return d;
	}

	_emitDust(x, y, vx) {
		const d = this._spawn();
		d.life = d.max = 0.9; d.x = x; d.y = y; d.z = (Math.random() - 0.5) * 1.2;
		d.vx = -vx * 0.12; d.vy = 1.2 + Math.random(); d.vz = (Math.random() - 0.5);
		d.size = 0.9 + Math.random() * 0.8; d.g = 1.5; d.grow = 1.6;
		d.r = this.dustColor.r; d.gg = this.dustColor.g; d.b = this.dustColor.b; d.a = 0.55;
	}

	_burst(x, y, n, color, size, speed) {
		if (!this.particles) return;
		for (let i = 0; i < n; i++) {
			const d = this._spawn();
			const a = Math.random() * Math.PI * 2, s = speed * (0.4 + Math.random() * 0.6);
			d.life = d.max = 0.6 + Math.random() * 0.5;
			d.x = x; d.y = y; d.z = (Math.random() - 0.5) * 0.8;
			d.vx = Math.cos(a) * s; d.vy = Math.abs(Math.sin(a)) * s + 1; d.vz = (Math.random() - 0.5) * s * 0.5;
			d.size = size * (0.8 + Math.random() * 0.8); d.g = 4; d.grow = size > 0.5 ? 1.2 : 0;
			d.r = color.r; d.gg = color.g; d.b = color.b; d.a = size > 0.5 ? 0.5 : 1;
		}
	}

	_updateParticles(dt) {
		if (!this.particles) return;
		const g = this.particles.geometry;
		const pos = g.getAttribute('position'), size = g.getAttribute('aSize'), alpha = g.getAttribute('aAlpha'), col = g.getAttribute('aColor');
		for (let i = 0; i < this.particleData.length; i++) {
			const d = this.particleData[i];
			if (d.life > 0) {
				d.life -= dt;
				d.vy -= d.g * dt;
				d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt;
				const k = Math.max(0, d.life / d.max);
				pos.setXYZ(i, d.x, d.y, d.z);
				size.setX(i, d.size * (1 + (1 - k) * d.grow));
				alpha.setX(i, d.a * k);
				col.setXYZ(i, d.r, d.gg, d.b);
			} else {
				alpha.setX(i, 0);
				pos.setXYZ(i, 0, -9999, 0);
			}
		}
		pos.needsUpdate = size.needsUpdate = alpha.needsUpdate = col.needsUpdate = true;
	}

	// Ambient animation (clouds, flags, stars); frozen by reduced motion or a still sky.
	_animate(dt) {
		const animated = this.q.background === 'animated' && !this.reducedMotion && !this.prefersReducedMotion;
		if (animated) this.time += dt;
		this.skyDeco.position.set(this.camera.position.x * 0.85, this.camera.position.y, 0);
		this.sky.position.copy(this.camera.position);
		this._layoutClouds();
		this.starMat.uniforms.uTime.value = this.time;
		this.starMat.uniforms.uTwinkle.value = animated ? 1 : 0;
		if (this.cloths && this.level) {
			for (const [ci, cloth] of this.cloths.entries()) {
				const p = cloth.geometry.getAttribute('position');
				for (let i = 0; i < p.count; i++) {
					const u = p.getX(i) / 1.4;
					p.setZ(i, animated ? Math.sin(this.time * 4 - u * 4 + ci) * 0.14 * u : 0);
				}
				p.needsUpdate = true;
				cloth.geometry.computeVertexNormals();
			}
		}
	}

	resize(w, h) {
		this.camera.aspect = w / Math.max(1, h);
		this.camera.updateProjectionMatrix();
		this.size = [Math.max(1, w), Math.max(1, h)];
		this._sizeDirty = true;
	}

	render() {
		if (this.contextLost || this.disposed) return;
		const now = performance.now();
		const dtMs = this._last ? Math.min(250, now - this._last) : 16;
		this._last = now;
		const rescale = this._adapt(dtMs);
		const [w, h] = this.size;
		const ratio = Math.min(window.devicePixelRatio || 1, this.q.cap) * this.q.scale * this.adaptiveScale;
		if (this._sizeDirty || ratio !== this.pixelRatio || rescale) {
			this._sizeDirty = false;
			this.pixelRatio = ratio;
			this.renderer.setPixelRatio(ratio);
			this.renderer.setSize(w, h, false);
		}
		// Point sprites size in world units: pixels per unit at distance 1.
		const pxPerUnit = h * ratio * 0.5 / Math.tan((CAM.fov * Math.PI) / 360);
		this.starMat.uniforms.uScale.value = pxPerUnit * 0.25;
		if (this.particles) this.particles.material.uniforms.uScale.value = pxPerUnit;
		this._animate(dtMs / 1000);
		const key = this._postKey(w, h);
		if (key !== this.postKey) {
			this.postKey = key;
			this._buildPost(w, h);
		}
		if (this.composer) {
			try { this.composer.render(dtMs / 1000); return; }
			catch { this.postFailed = true; this.composer = null; this.postKey = null; }
		}
		this.renderer.render(this.scene, this.camera);
	}

	setReducedMotion(v) { this.reducedMotion = v; }

	stats() {
		const i = this.renderer.info;
		return { drawCalls: i.render.calls, triangles: i.render.triangles };
	}

	dispose() {
		this.disposed = true;
		this.unloadLevel();
		this.composer?.dispose();
		this.canvas.removeEventListener('webglcontextlost', this._onContextLost);
		this.canvas.removeEventListener('webglcontextrestored', this._onContextRestored);
		this.skyGeo.dispose(); this.skyMat.dispose();
		this.envTex?.dispose();
		this.renderer.dispose();
	}
}

export function createRender(canvas, opts) { return new RenderModule(canvas, opts); }
export function disposeRender(render) { render?.dispose(); }
export default RenderModule;
