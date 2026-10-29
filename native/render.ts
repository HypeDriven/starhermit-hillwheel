// The hills on starhermit:scene, as the browser build's render.js drew them
// with three.js: the terrain ribbon (the rules' height profile across the
// track band, a lighter dirt track, grass shoulders falling away into a hazy
// valley, a dark soil cut face in front; with detailed terrain world-space
// value noise in a surface hook and grass tufts), two fog-tinted backdrop
// ridges, the gradient sky dome with its sun (a pale moon on dark themes)
// whose HDR core blooms, drifting low-poly clouds and twinkling stars, the
// buggy (clear-coated rounded chassis, roll cage, helmeted driver, spoked
// wheels that roll with distance, glowing head and tail lights), glossy fuel
// cans with a soft halo that bob and spin, waving checkpoint flags (yellow,
// green once passed) and the goal flag with its chequered finish arch,
// instanced two-tier pines and rocks, soft particles (dust while driving, a
// puff on every landing, a sparkle burst per can), the critically damped
// follow camera with its look-ahead and event shake, and the key light whose
// shadow follows the vehicle.
//
// From three.js: light intensities are three.js r185's (minor 23+); ShaderMaterials are WGSL (the sky, and one instanced billboard
// material for the dust, sparkles and stars, which were per-point-size
// ShaderMaterial Points); the terrain's onBeforeCompile noise is a surface
// hook; RoomEnvironment(renderer) gives the image-based lighting; the post
// chain is renderer.ao / bloom / grade / antialias (GTAOPass, UnrealBloomPass
// threshold 0.92, the GradeShader in display space, FXAA / SMAA / MSAA); the
// shadow box (±30 units, texel-snapped) is the page's shadow.camera box.
// Adaptive resolution, the pixel-ratio cap and the frame-rate readout are
// the runtime's. Cosmetic randomness never touches the rules' streams.
import {
  ACESFilmicToneMapping, BackSide, BoxGeometry, BufferAttribute, BufferGeometry, CanvasTexture, Color, ConeGeometry, CylinderGeometry,
  DirectionalLight, DodecahedronGeometry, DoubleSide, DynamicDrawUsage, Euler, Float32BufferAttribute, Fog, Group, HemisphereLight,
  IcosahedronGeometry, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, MeshLambertMaterial, MeshPhysicalMaterial, MeshStandardMaterial,
  PerspectiveCamera, PlaneGeometry, PMREMGenerator, Quaternion, RoomEnvironment, RoundedBoxGeometry, ShaderMaterial, SphereGeometry, Sprite,
  SpriteMaterial, SRGBColorSpace, TorusGeometry, Vector3, Vector4, renderer, scene,
  FrontSide, type OrthographicCamera, type Material, type Object3D, type Side, type Texture,
} from "starhermit:scene";
import { frame } from "starhermit:engine";
import { OffscreenCanvas, type OffscreenCanvasRenderingContext2D } from "starhermit:canvas";
import { Content, Rules, type State, type Theme, type Vehicle } from "./game.ts";
import type { Look } from "./quality.ts";

const PI = Math.PI;
const UP = new Vector3(0, 1, 0);
const shTmp = [new Vector3(), new Vector3(), new Vector3(), new Vector3()];
// Authored framing constants (render.js CAM).
const CAM = { back: 26, up: 12, lookUp: 3, lookAhead: 8, fov: 42, near: 0.5, far: 900 };
const VEHICLE_CLEARANCE = 0.9;
const WHEEL_R = 0.47;
// Ground ribbon: z rows of the top surface (front lip → far back) and the front cut face depth.
const TRACK_HALF = 2.5;
const FRONT_Z = 6;
const CUT_DEPTH = 26;
const ROWS_DETAILED = [FRONT_Z, 4.2, TRACK_HALF, 1.4, 0, -1.4, -TRACK_HALF, -4, -6.5, -10, -15, -21, -29, -39, -52, -68, -90];
const ROWS_PLAIN = [FRONT_Z, TRACK_HALF, 0, -TRACK_HALF, -8, -20, -40, -90];
// Key light direction (towards the light) and the sun shown in the sky (in view, low right).
const SUN_DIR = new Vector3(-0.45, 0.78, 0.5).normalize();
const SKY_SUN_DIR = new Vector3(0.62, -0.03, -1).normalize();

renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.92;
const camera = new PerspectiveCamera(CAM.fov, 16 / 9, CAM.near, CAM.far);

let look: Look | null = null;
let reducedMotion = false;
let theme: Theme = Content.getTheme("meadow");
let night = false;

// Cheap deterministic value noise for cosmetic surface variation (never used by rules).
function hash2(x: number, z: number): number {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function vnoise(x: number, z: number): number {
  const xi = Math.floor(x), zi = Math.floor(z);
  const xf = x - xi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = zf * zf * (3 - 2 * zf);
  const a = hash2(xi, zi), b = hash2(xi + 1, zi), c = hash2(xi, zi + 1), d = hash2(xi + 1, zi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
/** HSL lightness of a hex colour as three.js's getHSL reads it (sRGB). */
function lightness(hex: number): number {
  const r = ((hex >> 16) & 255) / 255, g = ((hex >> 8) & 255) / 255, b = (hex & 255) / 255;
  return (Math.max(r, g, b) + Math.min(r, g, b)) / 2;
}

// -- lights and environment (three.js r185 intensities, minor 23+) ---------------------------------
const SHADOW_EXTENT = 30;
const sun = new DirectionalLight(0xfff2dd, 2.0);
sun.position.copy(SUN_DIR).multiplyScalar(120);
{
  const sc = sun.shadow.camera as OrthographicCamera;
  sc.left = -SHADOW_EXTENT; sc.right = SHADOW_EXTENT; sc.top = SHADOW_EXTENT; sc.bottom = -SHADOW_EXTENT;
  sc.near = 1; sc.far = 260;
  sc.updateProjectionMatrix();
}
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.03;
const hemi = new HemisphereLight(0xbfd8e8, 0x6a7a5a, 0.9);
scene.add(sun, sun.target, hemi);
scene.fog = new Fog(0xcfe8d8, 90, 620);

let envTex: Texture | null = null;
function envMap(): Texture | null {
  if (!envTex) {
    try {
      // three r183+: RoomEnvironment(renderer) with the room lowered (engine environment-ports rule)
      const room = new RoomEnvironment(renderer);
      room.position.y = -3.5;
      envTex = new PMREMGenerator(renderer).fromScene(room, 0.04).texture;
    }
    catch (e) { console.warn(`environment: ${e instanceof Error ? e.message : String(e)}`); }
  }
  return envTex;
}
/** Glossy materials and their own reflection strength (render.js userData.hwEnv). */
const glossy: { m: MeshStandardMaterial; env: number }[] = [];
function applyEnv(): void {
  const on = !!look && look.reflections;
  scene.environment = on ? envMap() : null;
  scene.environmentIntensity = night ? 0.1 : 0.22;
  hemi.intensity = on ? 0.62 : 0.8;
  for (const g of glossy) {
    g.m.envMap = on ? envMap() : null;
    g.m.envMapIntensity = g.env * (night ? 0.5 : 1);
  }
}

// -- the sky: a gradient dome with the sun (WGSL port of render.js SKY_FRAG) --------------------
const skyMat = new ShaderMaterial({
  uniforms: {
    uTop: { value: new Color() }, uHorizon: { value: new Color() }, uSun: { value: new Color() },
    uSunDir: { value: SKY_SUN_DIR.clone() }, uSunSize: { value: 0.0006 },
  },
  fragmentShader: /* wgsl */ `
fn fragment(f: Fragment) -> vec4f {
  let d = normalize(f.world - camera_position());
  var col = mix(uniforms.uHorizon, uniforms.uTop, smoothstep(-0.34, 0.06, d.y));
  let s = max(dot(d, uniforms.uSunDir), 0.0);
  col = col + uniforms.uSun * (pow(s, 6.0) * 0.18 + pow(s, 60.0) * 0.35);
  col = col + uniforms.uSun * 3.0 * smoothstep(1.0 - uniforms.uSunSize, 1.0 - uniforms.uSunSize * 0.55, s);
  return vec4f(col, 1.0);
}`,
  side: BackSide, depthWrite: false, fog: false,
});
const sky = new Mesh(new SphereGeometry(600, 32, 16), skyMat);
sky.renderOrder = -10;
sky.noAO = true;
sky.frustumCulled = false;
scene.add(sky);

// -- soft billboards: dust, landing puffs, can sparkles and stars ------------------------------------
// render.js drew them as Points with a per-point size, alpha and colour; here an InstancedMesh of
// quads turned to the camera in a vertex hook: instanceCustom slot 0 = (size in world units, alpha,
// twinkle phase), the instance colour its (HDR) colour.
const BILLBOARD_VERT = /* wgsl */ `
fn vertex(v: Vertex) -> Vertex {
  var o = v;
  let c = (model_matrix() * vec4f(0.0, 0.0, 0.0, 1.0)).xyz;
  let toCam = normalize(camera_position() - c);
  let right = normalize(cross(vec3f(0.0, 1.0, 0.0), toCam));
  let up = cross(toCam, right);
  let world = c + (right * v.position.x + up * v.position.y) * v.instance.x;
  o.clip = view_projection() * vec4f(world, 1.0);
  o.v0 = vec4f(v.position.x + 0.5, v.position.y + 0.5, v.instance.y, v.instance.z);
  o.v1 = v.instance_color;
  return o;
}`;
const BILLBOARD_FRAG = /* wgsl */ `
fn fragment(f: Fragment) -> vec4f {
  let p = f.v0.xy - vec2f(0.5, 0.5);
  let tw = mix(1.0, 0.55 + 0.45 * sin(uniforms.uTime * 2.3 + f.v0.w), uniforms.uTwinkle);
  let a = (1.0 - smoothstep(0.1, 0.5, length(p))) * f.v0.z * tw;
  if (a < 0.01) { discard; }
  return vec4f(f.v1.rgb, a);
}`;
function billboardMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uTwinkle: { value: 0 } },
    vertexShader: BILLBOARD_VERT, fragmentShader: BILLBOARD_FRAG,
    transparent: true, depthWrite: false, fog: false,
  });
}
const quad = new PlaneGeometry(1, 1);
function billboards(capacity: number, mat: ShaderMaterial): InstancedMesh {
  const im = new InstancedMesh(quad, mat, capacity);
  im.customSlots = 1;
  im.setCustomAt(0, new Vector4(0, 0, 0, 0));
  im.setColorAt(0, new Color(1, 1, 1));
  im.instanceMatrix.setUsage(DynamicDrawUsage);
  im.frustumCulled = false;
  im.noAO = true;
  im.count = 0;
  return im;
}

// -- sky decorations: clouds and stars, following the camera ------------------------------------------
const skyDeco = new Group();
skyDeco.noAO = true;
scene.add(skyDeco);
const cloudMat = new MeshLambertMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.35, flatShading: true });
const CLOUDS = 9, PUFFS = 6;
const clouds = new InstancedMesh(new IcosahedronGeometry(1, 1), cloudMat, CLOUDS * PUFFS);
clouds.frustumCulled = false;
clouds.noAO = true;
skyDeco.add(clouds);
interface Puff { dx: number; dy: number; dz: number; s: number; sy: number }
const cloudData: { x: number; y: number; z: number; speed: number; puffs: Puff[] }[] = [];
const starMat = billboardMaterial();
const STARS = 420;
const stars = billboards(STARS, starMat);
stars.renderOrder = -9;
skyDeco.add(stars);
{
  const rand = Rules.mulberry32(0x5c1e5);
  for (let c = 0; c < CLOUDS; c++) {
    // Relative to the camera: the visible sky band sits 0–0.12 rad below the horizon.
    const cx = -260 + c * 60 + rand() * 30, cy = -26 + rand() * 24, cz = -230 - rand() * 60;
    const puffs: Puff[] = [];
    for (let p = 0; p < PUFFS; p++) {
      const s = 6 + rand() * 7;
      puffs.push({ dx: (p - PUFFS / 2) * 5 + rand() * 4, dy: rand() * 4 - (s > 10 ? 0 : 2), dz: rand() * 6, s, sy: s * (0.55 + rand() * 0.2) });
    }
    cloudData.push({ x: cx, y: cy, z: cz, speed: 1.2 + rand() * 1.8, puffs });
  }
  const m4 = new Matrix4();
  const col = new Color();
  for (let i = 0; i < STARS; i++) {
    const th = PI * (1.15 + rand() * 0.7), y = -0.32 + rand() * 0.4;
    const r = Math.sqrt(1 - y * y);
    const size = 2.2 + rand() * 3.2, alpha = 0.5 + rand() * 0.5, phase = rand() * 6.28;
    const warm = rand();
    m4.makeTranslation(Math.cos(th) * r * 520, y * 520, Math.sin(th) * r * 520);
    stars.setMatrixAt(i, m4);
    // render.js sized stars at a quarter of a particle's pixels per unit: about 0.25 × size world units at 520.
    stars.setCustomAt(i, new Vector4(size * 0.25 * 1.3, alpha, phase, 0));
    stars.setColorAt(i, col.setRGB(1.4 + warm * 0.3, 1.4 + warm * 0.15, 1.6));
  }
  stars.count = STARS;
}
let skyTime = 0;
function layoutClouds(): void {
  const m4 = new Matrix4();
  let i = 0;
  const span = 560;
  for (const c of cloudData) {
    const x = ((c.x + skyTime * c.speed) % span + span) % span - span / 2;
    for (const p of c.puffs) {
      m4.makeScale(p.s, p.sy, p.s).setPosition(x + p.dx, c.y + p.dy, c.z + p.dz);
      clouds.setMatrixAt(i++, m4);
    }
  }
  clouds.instanceMatrix.needsUpdate = true;
}
layoutClouds();

/** render.js _applyTheme: the sky, fog, hemisphere fill, clouds and stars for a theme. */
function applyTheme(t: Theme): void {
  theme = t;
  const skyC = new Color(t.sky), fog = new Color(t.fog);
  night = lightness(t.sky) < 0.3;
  // Zenith is a deeper version of the theme sky; the horizon melts into the fog colour.
  (skyMat.uniforms.uTop!.value as Color).copy(skyC).offsetHSL(0, night ? 0 : 0.18, night ? 0 : -0.1);
  (skyMat.uniforms.uHorizon!.value as Color).copy(fog).lerp(skyC, 0.15);
  (skyMat.uniforms.uSun!.value as Color).set(night ? 0xcfd8ff : 0xfff0d0).multiplyScalar(night ? 0.55 : 1);
  skyMat.uniforms.uSunSize!.value = night ? 0.0004 : 0.0006;
  (scene.fog as Fog).color.copy(fog);
  hemi.color.setHex(t.sky);
  hemi.groundColor.set(t.ground).multiplyScalar(0.6);
  cloudMat.color.set(night ? 0x5a6078 : 0xffffff).lerp(fog, 0.15);
  cloudMat.emissive.set(night ? 0x20243a : 0xffffff);
  stars.visible = night;
  scene.background = fog.clone();
  applyEnv();
}

// -- the level -------------------------------------------------------------------------------------
interface CanView { group: Group }
interface FlagView { group: Group; mat: MeshStandardMaterial | MeshLambertMaterial }
interface Level {
  group: Group; ground: Mesh; casters: Object3D[]; receivers: Object3D[];
  state: State; themeId: string; seed: number;
  cans: CanView[]; flags: FlagView[]; cloths: Mesh[]; vehicle: Group; wheels: Group[];
}
let level: Level | null = null;
let particles: { mesh: InstancedMesh; mat: ShaderMaterial; pool: Particle[]; next: number } | null = null;
interface Particle { life: number; max: number; x: number; y: number; z: number; vx: number; vy: number; vz: number; size: number; g: number; grow: number; r: number; gg: number; b: number; a: number }
let dustColor = new Color();
let accentColor = new Color();
let canTaken: boolean[] = [];
let wasGrounded = true;

type LitParams = {
  color: number | Color; roughness?: number; metalness?: number; emissive?: number; emissiveIntensity?: number;
  map?: Texture | null; flatShading?: boolean; side?: Side; vertexColors?: boolean; transparent?: boolean; opacity?: number;
};
/** A prop material in the budget's class (render.js budgetMaterial): Lambert on Low, standard on
 * Balanced, clear-coated physical paint and cans on High/Ultra. */
function lit(p: LitParams, physical?: { clearcoat: number; clearcoatRoughness: number }, env?: number): MeshStandardMaterial | MeshLambertMaterial {
  const kind = look?.budget.material ?? "standard";
  const common = {
    color: p.color, map: p.map ?? null, emissive: p.emissive ?? 0x000000, emissiveIntensity: p.emissiveIntensity ?? 1,
    flatShading: !!p.flatShading, vertexColors: !!p.vertexColors, transparent: !!p.transparent, opacity: p.opacity ?? 1, side: p.side ?? FrontSide,
  };
  if (kind === "lambert") return new MeshLambertMaterial(common);
  const m = physical && kind === "physical"
    ? new MeshPhysicalMaterial({ ...common, roughness: p.roughness ?? 1, metalness: p.metalness ?? 0, ...physical })
    : new MeshStandardMaterial({ ...common, roughness: p.roughness ?? 1, metalness: p.metalness ?? 0 });
  if (env !== undefined) glossy.push({ m, env });
  return m;
}
const seg = (n: number, min = 5): number => Math.max(min, Math.round(n * (look?.budget.segments ?? 1)));

function canvasTexture(w: number, h: number, paint: (ctx: OffscreenCanvasRenderingContext2D, w: number, h: number) => void): Texture {
  const cv = new OffscreenCanvas(w, h);
  paint(cv.getContext("2d"), w, h);
  const t = new CanvasTexture(cv);
  t.colorSpace = SRGBColorSpace;
  return t;
}
let halo: Texture | null = null;
function haloTexture(): Texture {
  return (halo ??= canvasTexture(64, 64, (ctx, w, h) => {
    const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    g.addColorStop(0, "rgba(255,255,255,0.9)");
    g.addColorStop(0.35, "rgba(255,255,255,0.35)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }));
}
let checker: Texture | null = null;
function checkerTexture(): Texture {
  return (checker ??= canvasTexture(256, 32, (ctx) => {
    for (let i = 0; i < 16; i++) for (let j = 0; j < 2; j++) {
      ctx.fillStyle = (i + j) % 2 ? "#111" : "#f4f4f4";
      ctx.fillRect(i * 16, j * 16, 16, 16);
    }
  }));
}

/** The terrain: vertex colours, and world-space value noise over them with detailed terrain (render.js _terrainMaterial). */
function terrainMaterial(detailed: boolean): MeshStandardMaterial {
  // envMapIntensity 1: three.js r185 lit the scene's environment by environmentIntensity alone.
  const mat = new MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
  if (detailed) {
    mat.hooks = {
      surface: /* wgsl */ `
fn hwHash(p: vec3f) -> f32 { return fract(sin(dot(p, vec3f(127.1, 311.7, 74.7))) * 43758.5453); }
fn hwNoise(p: vec3f) -> f32 {
  let i = floor(p);
  var f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hwHash(i), hwHash(i + vec3f(1.0, 0.0, 0.0)), f.x), mix(hwHash(i + vec3f(0.0, 1.0, 0.0)), hwHash(i + vec3f(1.0, 1.0, 0.0)), f.x), f.y),
    mix(mix(hwHash(i + vec3f(0.0, 0.0, 1.0)), hwHash(i + vec3f(1.0, 0.0, 1.0)), f.x), mix(hwHash(i + vec3f(0.0, 1.0, 1.0)), hwHash(i + vec3f(1.0, 1.0, 1.0)), f.x), f.y), f.z);
}
fn surface(s: Surface) -> Surface {
  var o = s;
  let n = hwNoise(s.world * 0.55) * 0.55 + hwNoise(s.world * 2.1) * 0.3 + hwNoise(s.world * 7.0) * 0.15;
  o.base_color = vec4f(s.base_color.rgb * (0.84 + 0.32 * n), s.base_color.a);
  return o;
}`,
    };
  }
  return mat;
}

function disposeTree(o: Object3D): void {
  const seen = new Set<unknown>();
  o.traverse((ch) => {
    const m = ch as Mesh;
    if (m.geometry && m.geometry !== quad && !seen.has(m.geometry)) { seen.add(m.geometry); m.geometry.dispose(); }
    const mat = (m as { material?: Material | Material[] }).material;
    if (mat) for (const x of Array.isArray(mat) ? mat : [mat]) {
      if (seen.has(x)) continue;
      seen.add(x);
      x.dispose();
    }
  });
}
/** render.js unloadLevel. */
export function unloadLevel(): void {
  if (!level) return;
  scene.remove(level.group);
  disposeTree(level.group);
  level = null;
  particles = null;
  glossy.length = 0;
}

/** render.js loadLevel: the level's views from the run's state (terrain, cans, flags) and the theme;
 * the decoration stream comes from the seed, so a rebuild (a graphics change) looks the same. */
export function loadLevel(state: State, themeId: string, seed: number): void {
  unloadLevel();
  const t = Content.getTheme(themeId);
  const L = look!;
  const b = L.budget;
  const detailed = L.detailed;
  const group = new Group();
  const terrain = state.terrain;
  const length = state.goalX;
  const casters: Object3D[] = [], receivers: Object3D[] = [];

  // Surface height: the rules' profile across the track band, then a rolling slope that falls away
  // behind it, so the course reads as a ridge above a hazy valley (cosmetic; the vehicle only ever
  // touches z = 0).
  const surfaceY = (x: number, z: number): number => {
    const base = terrain.height(x);
    if (z >= -TRACK_HALF) return base;
    const d = -z - TRACK_HALF;
    const n = vnoise(x * 0.045 + 3.1, z * 0.07) * 0.65 + vnoise(x * 0.12, z * 0.2 + 7.7) * 0.35;
    return base - d * 0.3 + (n - 0.4) * Math.min(1, d / 6) * (2 + d * 0.1);
  };

  const stepLen = detailed ? 0.7 : 2.0;
  const startX = -60, endX = length + 80;
  const count = Math.ceil((endX - startX) / stepLen) + 1;
  const xs = Array.from({ length: count }, (_, i) => startX + i * stepLen);
  const heights = xs.map((x) => terrain.height(x));

  const cNear = new Color(t.ground), cFar = new Color(t.groundFar);
  const cRock = new Color(t.rock);
  const cTrack = cNear.clone().lerp(cRock, 0.45).lerp(new Color(0xb89a6a), 0.25);
  const cSoil = cRock.clone().lerp(new Color(0x4a3526), 0.7);
  const cDeep = cSoil.clone().multiplyScalar(0.55);
  const cFog = new Color(t.fog);
  const tmpC = new Color();

  const pos: number[] = [], col: number[] = [], idx: number[] = [];
  const addGrid = (rows: number[], point: (i: number, r: number) => [number, number, number], colour: (i: number, r: number, f: number) => Color, up: boolean): void => {
    const base = pos.length / 3;
    for (let r = 0; r < rows.length; r++) {
      for (let i = 0; i < count; i++) {
        const p = point(i, rows[r]!);
        pos.push(p[0], p[1], p[2]);
        const c = colour(i, rows[r]!, i / count);
        col.push(c.r, c.g, c.b);
      }
    }
    for (let r = 0; r < rows.length - 1; r++) {
      for (let i = 0; i < count - 1; i++) {
        const a = base + r * count + i, bb = a + 1, c = a + count, d = c + 1;
        if (up) idx.push(a, bb, c, bb, d, c); else idx.push(a, c, bb, bb, c, d);
      }
    }
  };
  // Top surface, front lip → far back.
  const rows = detailed ? ROWS_DETAILED : ROWS_PLAIN;
  addGrid(rows, (i, z) => [xs[i]!, z >= -TRACK_HALF ? heights[i]! : surfaceY(xs[i]!, z), z], (i, z, f) => {
    const x = xs[i]!;
    const n = vnoise(x * 0.3, z * 0.3);
    if (Math.abs(z) < TRACK_HALF - 0.6) return tmpC.copy(cTrack).multiplyScalar(0.94 + n * 0.12);
    const far = Math.min(1, Math.max(0, (-z - 4) / 70));
    tmpC.copy(cNear).lerp(cFar, Math.min(1, f * 0.6 + far * 0.7));
    tmpC.multiplyScalar(0.8 + n * 0.25);
    return tmpC.lerp(cFog, far * 0.25);
  }, true);
  // Front cut face: grass lip, soil band, dark depth.
  addGrid([0, -0.35, -1.6, -CUT_DEPTH], (i, dy) => [xs[i]!, heights[i]! + dy, FRONT_Z], (_i, dy) => {
    if (dy === 0) return tmpC.copy(cNear).multiplyScalar(0.8);
    if (dy > -1) return tmpC.copy(cSoil);
    if (dy > -2) return tmpC.copy(cSoil).multiplyScalar(0.85);
    return tmpC.copy(cDeep);
  }, false);
  const geo = new BufferGeometry();
  geo.setAttribute("position", new Float32BufferAttribute(pos, 3));
  geo.setAttribute("color", new Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const ground = new Mesh(geo, terrainMaterial(detailed));
  group.add(ground);

  // Backdrop ridges: two silhouette layers that rise with the course; fog gives depth.
  const smooth = (x: number, w: number): number => {
    let s = 0;
    for (let k = -2; k <= 2; k++) s += terrain.height(Math.min(length, Math.max(0, x + k * w)));
    return s / 5;
  };
  const ridges = [
    { z: -170, amp: 20, lift: -52, freq: 0.012, w: 50, color: cFar.clone().multiplyScalar(0.8).lerp(cFog, 0.38) },
    { z: -320, amp: 45, lift: -48, freq: 0.006, w: 110, color: cFar.clone().lerp(cFog, 0.72).lerp(new Color(t.sky), 0.15) },
  ];
  ridges.forEach((rdg, ri) => {
    const rStep = 8, rStart = -500, rEnd = length + 500;
    const n = Math.ceil((rEnd - rStart) / rStep) + 1;
    const rp = new Float32Array(n * 2 * 3);
    for (let i = 0; i < n; i++) {
      const x = rStart + i * rStep;
      const top = smooth(x, rdg.w) + rdg.lift + rdg.amp * (vnoise(x * rdg.freq + ri * 13, 0.5) * 0.8 + vnoise(x * rdg.freq * 3.1, 2.5) * 0.25);
      rp.set([x, top, rdg.z, x, top - 400, rdg.z], i * 6);
    }
    const ri2: number[] = [];
    for (let i = 0; i < n - 1; i++) { const a = i * 2; ri2.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    const rg = new BufferGeometry();
    rg.setAttribute("position", new BufferAttribute(rp, 3));
    rg.setIndex(ri2);
    const rm = new Mesh(rg, new MeshBasicMaterial({ color: rdg.color }));
    rm.renderOrder = -5;
    rm.noAO = true;
    group.add(rm);
  });

  // Vehicle.
  const vehicle = buildVehicle();
  group.add(vehicle.group);
  vehicle.group.traverse((o) => { if ((o as Mesh).geometry) casters.push(o); });

  // Fuel cans: glossy jerry cans with a soft halo so they read from far away.
  const canBody = new RoundedBoxGeometry(0.62, 0.82, 0.34, 2, 0.07);
  const canHandle = new TorusGeometry(0.13, 0.035, seg(6, 4), seg(12), PI);
  const canSpout = new CylinderGeometry(0.05, 0.06, 0.16, seg(8));
  const canMat = lit({ color: t.accent, roughness: 0.35, metalness: 0.15, emissive: t.accent, emissiveIntensity: 0.22 }, { clearcoat: 1, clearcoatRoughness: 0.2 }, 0.5);
  const capMat = lit({ color: 0x2a2a2a, roughness: 0.5, metalness: 0.6 });
  const haloMat = new SpriteMaterial({ map: haloTexture(), color: new Color(t.accent).multiplyScalar(1.3), transparent: true, opacity: 0.55, depthWrite: false, fog: false });
  const cans = state.cans.map((c) => {
    const g = new Group();
    const body = new Mesh(canBody, canMat);
    const handle = new Mesh(canHandle, capMat); handle.position.set(-0.08, 0.41, 0);
    const spout = new Mesh(canSpout, capMat); spout.position.set(0.2, 0.47, 0); spout.rotation.z = -0.5;
    const h = new Sprite(haloMat); h.scale.set(2.2, 2.2, 1); h.renderOrder = 2;
    g.add(h, body, handle, spout);
    g.position.set(c.x, terrain.height(c.x) + 1.2, 0);
    casters.push(body, handle, spout);
    group.add(g);
    return { group: g };
  });

  // Checkpoint flags (yellow → green when passed) and the goal: cloth that waves in the wind.
  const flagPole = new CylinderGeometry(0.07, 0.07, 4, seg(8));
  const poleMat = lit({ color: 0xd4d8dc, roughness: 0.35, metalness: 0.6 }, undefined, 0.8);
  const knob = new SphereGeometry(0.13, seg(12), seg(8, 4));
  const knobMat = lit({ color: 0xf2c14e, roughness: 0.3, metalness: 0.8 });
  const mkCloth = (): PlaneGeometry => new PlaneGeometry(1.4, 0.8, 10, 3).translate(0.7, 0, 0) as PlaneGeometry;
  const cloths: Mesh[] = [];
  const flags = state.checkpoints.map((cx) => {
    const g = new Group();
    const pole = new Mesh(flagPole, poleMat);
    const top = new Mesh(knob, knobMat); top.position.y = 2.05;
    const mat = lit({ color: 0xf2c14e, roughness: 0.7, side: DoubleSide, emissive: 0xf2c14e, emissiveIntensity: 0.12 });
    const flag = new Mesh(mkCloth(), mat);
    flag.position.set(0.05, 1.6, 0);
    g.add(pole, top, flag);
    g.position.set(cx, terrain.height(cx) + 2, -0.9);
    casters.push(pole, top, flag);
    group.add(g);
    cloths.push(flag);
    return { group: g, mat };
  });
  const goal = new Group();
  const gp = new Mesh(flagPole, poleMat);
  const gtop = new Mesh(knob, knobMat); gtop.position.y = 2.05;
  const gf = new Mesh(mkCloth(), lit({ color: 0x4ed88a, roughness: 0.5, side: DoubleSide, emissive: 0x4ed88a, emissiveIntensity: 0.45 }));
  gf.scale.set(1.6, 1.6, 1); gf.position.set(0.05, 1.5, 0);
  goal.add(gp, gtop, gf);
  goal.position.set(state.goalX, terrain.height(state.goalX) + 2.2, -0.9);
  cloths.push(gf);
  casters.push(gp, gtop, gf);
  group.add(goal);
  // Finish arch: two posts and a chequered banner across the track.
  const archMat = lit({ color: 0xf0f0f0, roughness: 0.4, metalness: 0.4 });
  const gy = terrain.height(state.goalX);
  const post = new CylinderGeometry(0.1, 0.1, 6, seg(8));
  for (const z of [-2.6, 2.6]) {
    const p = new Mesh(post, archMat);
    p.position.set(state.goalX, gy + 3, z);
    group.add(p); casters.push(p);
  }
  // The banner spans the track (along z); the chequer faces the camera (+x/−x box faces).
  const checkerMat = lit({ color: 0xffffff, map: checkerTexture(), roughness: 0.6 });
  const banner = new Mesh(new BoxGeometry(0.12, 0.7, 5.4), [checkerMat, checkerMat, archMat, archMat, archMat, archMat]);
  banner.position.set(state.goalX, gy + 5.6, 0);
  group.add(banner); casters.push(banner);

  // Vegetation and rocks: instanced, deterministic from a decoration-only stream.
  const deco = Rules.mulberry32((seed ^ 0xdec0) >>> 0);
  if (L.foliage > 0) {
    const treeCount = Math.floor((length / 100) * b.trees * L.foliage);
    const trunkMat = lit({ color: 0x6a4a2e, roughness: 0.9 });
    const crownMat = lit({ color: 0xffffff, roughness: 0.8, flatShading: true });
    const trunks = new InstancedMesh(new CylinderGeometry(0.14, 0.24, 1.4, seg(6, 4)), trunkMat, Math.max(1, treeCount));
    const lows = new InstancedMesh(new ConeGeometry(1.15, 2.0, seg(8)), crownMat, Math.max(1, treeCount));
    const highs = new InstancedMesh(new ConeGeometry(0.8, 1.7, seg(8)), crownMat, Math.max(1, treeCount));
    const m4 = new Matrix4(), rot = new Quaternion(), sc = new Vector3(), pv = new Vector3(), axis = new Vector3(0, 1, 0);
    const base = new Color(t.tree), c = new Color();
    for (let i = 0; i < treeCount; i++) {
      const x = -40 + deco() * (length + 90);
      const z = -(5 + Math.pow(deco(), 1.4) * 55);
      const s = 0.8 + deco() * 1.1;
      const y = surfaceY(x, z) - 0.1;
      rot.setFromAxisAngle(axis, deco() * 6.28);
      sc.set(s, s * (0.9 + deco() * 0.3), s);
      m4.compose(pv.set(x, y + 0.7 * sc.y, z), rot, sc); trunks.setMatrixAt(i, m4);
      m4.compose(pv.set(x, y + 2.1 * sc.y, z), rot, sc); lows.setMatrixAt(i, m4);
      m4.compose(pv.set(x, y + 3.2 * sc.y, z), rot, sc); highs.setMatrixAt(i, m4);
      c.copy(base).multiplyScalar(0.8 + deco() * 0.45);
      lows.setColorAt(i, c); highs.setColorAt(i, c.multiplyScalar(1.12));
    }
    trunks.count = lows.count = highs.count = treeCount;
    const rockCount = Math.floor((length / 100) * (b.trees * 7 / 12) * L.foliage);
    const rocks = new InstancedMesh(new DodecahedronGeometry(0.6, 0), lit({ color: t.rock, roughness: 0.85, flatShading: true }), Math.max(1, rockCount));
    const e = new Euler();
    for (let i = 0; i < rockCount; i++) {
      const x = -40 + deco() * (length + 90);
      const z = -(3.2 + deco() * 30);
      const s = 0.5 + deco() * 1.4;
      rot.setFromEuler(e.set(deco() * 3, deco() * 3, deco() * 3));
      m4.compose(pv.set(x, surfaceY(x, z) + 0.15 * s, z), rot, sc.set(s * 1.3, s * 0.7, s));
      rocks.setMatrixAt(i, m4);
    }
    rocks.count = rockCount;
    for (const m of [trunks, lows, highs, rocks]) { group.add(m); if (b.treeShadows) casters.push(m); else receivers.push(m); }
  }

  // Grass tufts along the track edges (detailed terrain only).
  if (detailed && t.id !== "frost") {
    const tuftCount = Math.floor(length * b.tufts);
    const tufts = new InstancedMesh(new ConeGeometry(0.09, 0.5, 3).translate(0, 0.25, 0), lit({ color: 0xffffff, roughness: 0.9 }), Math.max(1, tuftCount));
    const m4 = new Matrix4(), rot = new Quaternion(), sc = new Vector3(), pv = new Vector3(), e = new Euler();
    const tc = new Color(t.groundFar), c = new Color();
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
    tufts.count = tuftCount;
    group.add(tufts);
    receivers.push(tufts);
  }

  // Particle pool: dust, landing puffs and can sparkles (bounded).
  particles = null;
  if (b.particles > 0) {
    const mat = billboardMaterial();
    const mesh = billboards(b.particles, mat);
    group.add(mesh);
    particles = {
      mesh, mat, next: 0,
      pool: Array.from({ length: b.particles }, () => ({ life: 0, max: 1, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, size: 1, g: 0, grow: 0, r: 1, gg: 1, b: 1, a: 1 })),
    };
  }
  dustColor = cTrack.clone().lerp(new Color(0xe8dcc0), 0.5);
  accentColor = new Color(t.accent).multiplyScalar(2.2);

  level = { group, ground, casters, receivers, state, themeId, seed, cans, flags, cloths, vehicle: vehicle.group, wheels: vehicle.wheels };
  applyTheme(t);
  applyShadowFlags();
  scene.add(group);
  camInit = false;
  canTaken = state.cans.map((c) => c.taken);
  wasGrounded = true;
}

function applyShadowFlags(): void {
  const on = !!look && look.shadows > 0;
  renderer.shadowMap.enabled = on;
  sun.castShadow = on;
  if (on) sun.shadow.mapSize = look!.shadows;
  const lv = level;
  if (!lv) return;
  lv.ground.receiveShadow = on;
  lv.ground.castShadow = !!look && look.shadows >= 4096;
  for (const o of lv.casters) { o.castShadow = on; o.receiveShadow = on; }
  for (const o of lv.receivers) o.receiveShadow = on;
}

/** render.js _buildVehicle: rounded buggy with roll cage, driver, spoked wheels and lights. */
function buildVehicle(): { group: Group; wheels: Group[] } {
  const group = new Group();
  const paint = lit({ color: 0xc83a22, roughness: 0.38, metalness: 0.2 }, { clearcoat: 1, clearcoatRoughness: 0.15 }, 0.6);
  const dark = lit({ color: 0x2e3a44, roughness: 0.45, metalness: 0.5 }, undefined, 0.6);
  const tube = lit({ color: 0x3a4148, roughness: 0.3, metalness: 0.85 }, undefined, 1);
  const helmetMat = lit({ color: 0x2f6fb0, roughness: 0.3 }, { clearcoat: 1, clearcoatRoughness: 0.1 }, 1);
  const stripe = lit({ color: 0x1f2830, roughness: 0.4 });
  const visor = lit({ color: 0x14181e, roughness: 0.1, metalness: 0.4 }, { clearcoat: 1, clearcoatRoughness: 0 }, 1.2);

  const chassis = new Mesh(new RoundedBoxGeometry(2.2, 0.46, 1.1, 2, 0.12), paint);
  chassis.position.y = 0.3;
  const hood = new Mesh(new RoundedBoxGeometry(0.8, 0.22, 1.0, 2, 0.08), paint);
  hood.position.set(0.72, 0.56, 0); hood.rotation.z = -0.22;
  const stripeGeo = new BoxGeometry(1.7, 0.08, 0.02);
  const stripeF = new Mesh(stripeGeo, stripe); stripeF.position.set(0, 0.34, 0.56);
  const stripeB = new Mesh(stripeGeo, stripe); stripeB.position.set(0, 0.34, -0.56);
  const seat = new Mesh(new RoundedBoxGeometry(0.55, 0.36, 0.72, 2, 0.08), dark);
  seat.position.set(-0.45, 0.66, 0);
  const helmet = new Mesh(new SphereGeometry(0.24, seg(16), seg(12, 4)), helmetMat);
  helmet.position.set(-0.2, 1.0, 0);
  const vis = new Mesh(new RoundedBoxGeometry(0.1, 0.13, 0.3, 1, 0.04), visor);
  vis.position.set(0.02, 1.01, 0);
  const body = new Mesh(new CylinderGeometry(0.2, 0.24, 0.4, 10), dark);
  body.position.set(-0.25, 0.72, 0);
  // Roll cage: two hoops across the car joined by a top bar.
  const hoopGeo = new TorusGeometry(0.5, 0.045, 6, 18, PI);
  const hoopA = new Mesh(hoopGeo, tube); hoopA.rotation.y = PI / 2; hoopA.position.set(-0.7, 0.55, 0);
  const hoopB = new Mesh(hoopGeo, tube); hoopB.rotation.y = PI / 2; hoopB.position.set(0.15, 0.5, 0); hoopB.scale.set(1, 0.95, 1);
  const bar = new Mesh(new CylinderGeometry(0.04, 0.04, 0.9, 6), tube); bar.rotation.z = PI / 2 - 0.06; bar.position.set(-0.28, 1.03, 0);
  // Lights: HDR emissive so bloom gives them a glow.
  const headMat = new MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff1c8, emissiveIntensity: 3.2 });
  const tailMat = new MeshStandardMaterial({ color: 0x661010, emissive: 0xff2a1a, emissiveIntensity: 2.2 });
  const lampGeo = new BoxGeometry(0.06, 0.12, 0.2);
  const headF = new Mesh(lampGeo, headMat); headF.position.set(1.11, 0.4, 0.34);
  const headB = new Mesh(lampGeo, headMat); headB.position.set(1.11, 0.4, -0.34);
  const tail = new Mesh(lampGeo, tailMat); tail.position.set(-1.11, 0.4, 0.34);
  const exhaust = new Mesh(new CylinderGeometry(0.06, 0.07, 0.4, 8), tube);
  exhaust.rotation.z = PI / 2; exhaust.position.set(-1.15, 0.18, -0.3);
  group.add(chassis, hood, stripeF, stripeB, seat, body, helmet, vis, hoopA, hoopB, bar, headF, headB, tail, exhaust);

  // Wheels: chunky tyre, silver rim, three spokes so the roll is visible.
  const tyreGeo = new TorusGeometry(0.34, 0.13, seg(10, 6), seg(22, 12));
  const rimGeo = new CylinderGeometry(0.25, 0.25, 0.26, seg(16, 8)).rotateX(PI / 2);
  const spokeGeo = new BoxGeometry(0.44, 0.07, 0.04);
  const axleGeo = new CylinderGeometry(0.05, 0.05, 1.1, 6).rotateX(PI / 2);
  const tyreMat = lit({ color: 0x1c1f22, roughness: 0.9 });
  const rimMat = lit({ color: 0xc8ccd0, roughness: 0.25, metalness: 0.9 }, undefined, 1);
  const spokeMat = lit({ color: 0xf2c14e, roughness: 0.4, metalness: 0.3 });
  const wheels: Group[] = [];
  for (const wx of [0.75, -0.75]) {
    const axle = new Mesh(axleGeo, tube); axle.position.set(wx, 0, 0);
    group.add(axle);
    for (const wz of [0.55, -0.55]) {
      const w = new Group();
      const tyre = new Mesh(tyreGeo, tyreMat); tyre.scale.z = 1.9;
      const rim = new Mesh(rimGeo, rimMat);
      w.add(tyre, rim);
      for (let k = 0; k < 3; k++) {
        const sp = new Mesh(spokeGeo, spokeMat);
        sp.rotation.z = (k * PI) / 3;
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

// -- particles (render.js _emitDust / _burst / _updateParticles) --------------------------------------
function spawn(): Particle | null {
  const P = particles;
  if (!P) return null;
  const d = P.pool[P.next]!;
  P.next = (P.next + 1) % P.pool.length;
  return d;
}
function emitDust(x: number, y: number, vx: number): void {
  const d = spawn();
  if (!d) return;
  d.life = d.max = 0.9; d.x = x; d.y = y; d.z = (Math.random() - 0.5) * 1.2;
  d.vx = -vx * 0.12; d.vy = 1.2 + Math.random(); d.vz = Math.random() - 0.5;
  d.size = 0.9 + Math.random() * 0.8; d.g = 1.5; d.grow = 1.6;
  d.r = dustColor.r; d.gg = dustColor.g; d.b = dustColor.b; d.a = 0.55;
}
function burst(x: number, y: number, n: number, color: Color, size: number, speed: number): void {
  for (let i = 0; i < n; i++) {
    const d = spawn();
    if (!d) return;
    const a = Math.random() * PI * 2, s = speed * (0.4 + Math.random() * 0.6);
    d.life = d.max = 0.6 + Math.random() * 0.5;
    d.x = x; d.y = y; d.z = (Math.random() - 0.5) * 0.8;
    d.vx = Math.cos(a) * s; d.vy = Math.abs(Math.sin(a)) * s + 1; d.vz = (Math.random() - 0.5) * s * 0.5;
    d.size = size * (0.8 + Math.random() * 0.8); d.g = 4; d.grow = size > 0.5 ? 1.2 : 0;
    d.r = color.r; d.gg = color.g; d.b = color.b; d.a = size > 0.5 ? 0.5 : 1;
  }
}
function updateParticles(dt: number): void {
  const P = particles;
  if (!P) return;
  const mesh = P.mesh;
  const mtx = mesh.instanceMatrix.array as Float32Array;
  const cust = mesh.instanceCustom!.array as Float32Array;
  const colA = mesh.instanceColor!.array as Float32Array;
  let n = 0;
  for (const d of P.pool) {
    if (d.life <= 0) continue;
    d.life -= dt;
    if (d.life <= 0) continue;
    d.vy -= d.g * dt;
    d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt;
    const k = Math.max(0, d.life / d.max);
    const o = n * 16;
    mtx[o] = 1; mtx[o + 1] = 0; mtx[o + 2] = 0; mtx[o + 3] = 0;
    mtx[o + 4] = 0; mtx[o + 5] = 1; mtx[o + 6] = 0; mtx[o + 7] = 0;
    mtx[o + 8] = 0; mtx[o + 9] = 0; mtx[o + 10] = 1; mtx[o + 11] = 0;
    mtx[o + 12] = d.x; mtx[o + 13] = d.y; mtx[o + 14] = d.z; mtx[o + 15] = 1;
    cust[n * 4] = d.size * (1 + (1 - k) * d.grow); cust[n * 4 + 1] = d.a * k; cust[n * 4 + 2] = 0; cust[n * 4 + 3] = 0;
    colA[n * 3] = d.r; colA[n * 3 + 1] = d.gg; colA[n * 3 + 2] = d.b;
    n++;
  }
  mesh.count = n;
  mesh.instanceMatrix.needsUpdate = true;
  mesh.instanceCustom!.needsUpdate = true;
  mesh.instanceColor!.needsUpdate = true;
}

// -- the camera and shake ----------------------------------------------------------------------------
const camPos = new Vector3(CAM.back, CAM.up, CAM.back);
const camTarget = new Vector3();
const tmp = new Vector3();
let camInit = false;
let shake = 0;
/** Snap the camera back onto the vehicle (the recenter action). */
export function recenter(): void { camInit = false; }
export function addShake(amount: number): void { if (!reducedMotion) shake = Math.min(1.2, shake + amount); }

// -- look and options -----------------------------------------------------------------------------------
export function applyLook(next: Look): void {
  if (look && JSON.stringify(look) === JSON.stringify(next)) return;
  const before = look;
  look = next;
  renderer.ao = next.ao === "off" ? null : {
    blendIntensity: 0.7, radius: 1.2, distanceExponent: 1.5, thickness: 1.5, scale: 1.0, samples: next.ao === "high" ? 16 : 8, resolution: next.budget.aoRes,
    denoise: { lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: next.ao === "high" ? 6 : 4, rings: 2, samples: next.ao === "high" ? 16 : 8, radiusExponent: 2 },
  };
  applyBloom();
  // render.js GradeShader (display space, after the output): a gentle S-curve, +7 % saturation, warm
  // highlights and cool shadows, the 0.2 vignette.
  renderer.grade = next.grade ? {
    space: "display", contrast: 0.09, saturation: 1.07,
    shadows: [0.97, 0.99, 1.04], highlights: [1.03, 1.0, 0.97], split: [0.2, 0.8],
    vignette: { amount: 0.2, inner: 0.4, outer: 0.9, scale: [1.1, 1] },
  } : null;
  renderer.antialias = next.antialias;
  const b = before?.budget, nb = next.budget;
  const assets = !b || before!.detailed !== next.detailed || before!.foliage !== next.foliage || b.material !== nb.material
    || b.trees !== nb.trees || b.treeShadows !== nb.treeShadows || b.segments !== nb.segments || b.tufts !== nb.tufts || b.particles !== nb.particles;
  if (assets && level) {
    const { state, themeId, seed } = level;
    loadLevel(state, themeId, seed);
  } else {
    applyShadowFlags();
    applyEnv();
  }
}
/** High threshold: only the sun, lights, cans, the goal flag and sparkles bloom (raised on snow). */
function applyBloom(): void {
  renderer.bloom = look?.bloom ? { strength: 0.42, radius: 0.45, threshold: lightness(theme.ground) > 0.7 ? 2.2 : 0.92, resolution: look.budget.bloomRes } : null;
}
export function setReducedMotion(on: boolean): void { reducedMotion = on; }
/** The title's backdrop: the Meadow sky without a level. */
export function showSky(): void { unloadLevel(); applyTheme(Content.getTheme("meadow")); applyBloom(); camInit = false; }
export function setActive(on: boolean): void { renderer.camera = on ? camera : null; }

// -- the frame ------------------------------------------------------------------------------------------------
/** render.js update + render: prev/cur are the vehicle at the last two rules steps, alpha (0–1) between them. */
export function update(prev: Vehicle | null, cur: Vehicle | null, alpha: number, state: State | null, dtIn: number): void {
  // minor 20+: the camera renders with its own aspect (render.js resize)
  const fr = frame(), aspect = fr.width / Math.max(1, fr.height);
  if (aspect !== camera.aspect) { camera.aspect = aspect; camera.updateProjectionMatrix(); }
  const dt = Math.min(0.25, Math.max(0, dtIn));
  const animated = !!look && look.animatedSky && !reducedMotion;
  if (animated) skyTime += dt;
  if (level && state && prev && cur) frameLevel(prev, cur, alpha, state, dt);
  else {
    // No level (the title): a slow pan over the empty sky.
    camera.position.set(0, 14, 26);
    camTarget.set(0, 10, 0);
    camera.lookAt(camTarget);
  }
  // Ambient animation: clouds, stars, flags (frozen by reduced motion or a still sky).
  skyDeco.position.set(camera.position.x * 0.85, camera.position.y, 0);
  sky.position.copy(camera.position);
  layoutClouds();
  starMat.uniforms.uTime!.value = skyTime;
  starMat.uniforms.uTwinkle!.value = animated ? 1 : 0;
  if (level) {
    level.cloths.forEach((cloth, ci) => {
      const p = cloth.geometry.getAttribute("position") as BufferAttribute;
      for (let i = 0; i < p.count; i++) {
        const u = p.getX(i) / 1.4;
        p.setZ(i, animated ? Math.sin(skyTime * 4 - u * 4 + ci) * 0.14 * u : 0);
      }
      p.needsUpdate = true;
      cloth.geometry.computeVertexNormals();
    });
  }
}

function frameLevel(prev: Vehicle, cur: Vehicle, alpha: number, state: State, dt: number): void {
  const lv = level!;
  const terrain = state.terrain;
  const x = prev.x + (cur.x - prev.x) * alpha;
  const y = prev.y + (cur.y - prev.y) * alpha;
  let dAng = cur.angle - prev.angle;
  while (dAng > PI) dAng -= PI * 2;
  while (dAng < -PI) dAng += PI * 2;
  const ang = prev.angle + dAng * alpha;
  lv.vehicle.position.set(x, y - VEHICLE_CLEARANCE + 0.45, 0);
  lv.vehicle.rotation.z = ang;
  for (const w of lv.wheels) w.rotation.z = -x / WHEEL_R;

  // Cans: hide collected (with a sparkle burst), bob the rest (deterministic phase from index).
  const t = state.tick / Rules.TICK_RATE;
  const moving = !reducedMotion;
  for (let i = 0; i < lv.cans.length; i++) {
    const g = lv.cans[i]!.group;
    if (state.cans[i]!.taken) {
      if (!canTaken[i] && moving) burst(g.position.x, g.position.y, 18, accentColor, 0.35, 5);
      canTaken[i] = true;
      g.visible = false;
      continue;
    }
    canTaken[i] = false;
    g.visible = true;
    g.position.y = terrain.height(state.cans[i]!.x) + 1.2 + (moving ? Math.sin(t * 2 + i) * 0.15 : 0);
    g.rotation.y = moving ? t + i : 0;
  }
  // Checkpoint flags: mark passed.
  lv.flags.forEach((f, i) => {
    const hex = i < state.nextCheckpoint ? 0x4ed88a : 0xf2c14e;
    f.mat.color.setHex(hex);
    f.mat.emissive.setHex(hex);
  });

  // Dust when grounded and moving; a puff on landing.
  if (particles && moving) {
    if (cur.grounded && Math.abs(cur.vx) > 4) emitDust(x - Math.sign(cur.vx || 1) * 0.8, terrain.height(x) + 0.1, cur.vx);
    if (cur.grounded && !wasGrounded) burst(x, terrain.height(x) + 0.2, 14, dustColor, 0.9, 3);
  }
  wasGrounded = cur.grounded;
  updateParticles(dt);

  // Camera: critically damped follow, interruptible, reduced-motion aware.
  const targetX = x + CAM.lookAhead * Math.sign(Math.max(0.2, cur.vx || 1));
  const groundY = terrain.height(x);
  const desired = tmp.set(targetX - CAM.back * 0.4, groundY + CAM.up, CAM.back);
  if (!camInit || reducedMotion) {
    camPos.copy(desired);
    camInit = true;
  } else {
    camPos.lerp(desired, 1 - Math.exp(-4 * dt)); // frame-rate independent damp
  }
  let sx = 0, sy = 0;
  if (shake > 0 && !reducedMotion) {
    sx = (Math.random() - 0.5) * shake;
    sy = (Math.random() - 0.5) * shake;
    shake = Math.max(0, shake - dt * 2);
  }
  camera.position.set(camPos.x + sx, Math.max(camPos.y, groundY + 4) + sy, camPos.z);
  camTarget.set(x, groundY + CAM.lookUp, 0);
  camera.lookAt(camTarget);
  // The key light's shadow box follows the play area around the vehicle, snapped to whole
  // texels so it does not shimmer as the camera moves (render.js _fitShadow).
  const size = look && look.shadows > 0 ? look.shadows : 1024;
  const texel = (SHADOW_EXTENT * 2) / size;
  const fwd = shTmp[0]!.copy(SUN_DIR).negate();
  const right = shTmp[1]!.crossVectors(fwd, UP).normalize();
  const up = shTmp[2]!.crossVectors(right, fwd);
  const p = shTmp[3]!.set(x + 6, groundY, 0);
  const pr = p.dot(right), pu = p.dot(up), pf = p.dot(fwd);
  sun.target.position.copy(right.multiplyScalar(Math.round(pr / texel) * texel))
    .add(up.multiplyScalar(Math.round(pu / texel) * texel)).add(fwd.multiplyScalar(pf));
  sun.position.copy(sun.target.position).addScaledVector(SUN_DIR, 120);
}
