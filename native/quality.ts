// The look per graphics level. The engine-owned effects (shadows and their
// map size, ambient occlusion, bloom, the grade, anti-aliasing) are the
// level's own (levelSettings(): the same table every StarHermit game reads).
// The game's art (materials, trees and rocks, tree shadows, round-geometry
// LOD, grass tufts, foliage, the animated sky, terrain detail, reflections)
// is the browser build's four presets and budgets (gfx.js TABLE / BUDGETS)
// keyed by the level's quality tier, with the tree and particle counts
// scaled within the tier by the level's particle budget against the tier's
// anchor level (quantum, molecular, terrestrial, galactic), at most 2×. The
// runtime owns the rest of what the old Graphics panel did: Auto and the
// level choice, render scale and the pixel-ratio cap, adaptive resolution,
// the frame-rate limit and readout. The old panel's per-effect overrides are
// not offered (the runtime's Options choose a level).
import { levelSettings, type GraphicsLevel, type LevelSettings, type QualityTier } from "starhermit:engine";
import type { AntialiasMode } from "starhermit:scene";

export interface Budget {
  /** Props (vehicle, cans, flags, arch, trees, rocks): Lambert, standard, or clear-coated physical paint and cans. */
  material: "lambert" | "standard" | "physical";
  /** Trees per 100 m of course at Foliage "full" (rocks follow at 7/12). */
  trees: number;
  treeShadows: boolean;
  /** Round-geometry LOD multiplier. */
  segments: number;
  /** Grass tufts per metre of track (detailed terrain). */
  tufts: number;
  /** Dust and sparkle pool. */
  particles: number;
}
export interface Look {
  preset: QualityTier;
  /** The level's sun shadow map size, 0 when the level draws no shadows. */
  shadows: number;
  /** The level's ambient occlusion (null: off). */
  ao: { resolution: number; samples: number; denoiseSamples: number } | null;
  /** The level's bloom resolution (null: off). */
  bloom: number | null;
  grade: boolean;
  antialias: AntialiasMode;
  /** Image-based reflections on glossy pieces. */
  reflections: boolean;
  /** Foliage density: off, some (60 %), full. */
  foliage: 0 | 0.6 | 1;
  /** Clouds drift, stars twinkle, flags wave. */
  animatedSky: boolean;
  /** Terrain detail: 0.7-unit step, 17 rows, noise shading and grass tufts (else 2.0 units, 8 rows). */
  detailed: boolean;
  budget: Budget;
}

type Art = Pick<Look, "reflections" | "foliage" | "animatedSky" | "detailed">;
const ART: Record<QualityTier, Art> = {
  low: { reflections: false, foliage: 0, animatedSky: false, detailed: false },
  balanced: { reflections: true, foliage: 0.6, animatedSky: true, detailed: true },
  high: { reflections: true, foliage: 1, animatedSky: true, detailed: true },
  ultra: { reflections: true, foliage: 1, animatedSky: true, detailed: true },
};
/** gfx.js BUDGETS; the particle pool is the preset's Particles tier share (Low: off, Balanced: a third). */
const BUDGETS: Record<QualityTier, Budget> = {
  low: { material: "lambert", trees: 8, treeShadows: false, segments: 0.5, tufts: 0.8, particles: 0 },
  balanced: { material: "standard", trees: 11, treeShadows: false, segments: 0.75, tufts: 1.2, particles: 48 },
  high: { material: "physical", trees: 14.3, treeShadows: true, segments: 1, tufts: 2.2, particles: 192 },
  ultra: { material: "physical", trees: 20, treeShadows: true, segments: 1.5, tufts: 3.2, particles: 320 },
};
/** The level whose settings are each tier's preset. */
const ANCHOR: Record<QualityTier, GraphicsLevel> = { low: "quantum", balanced: "molecular", high: "terrestrial", ultra: "galactic" };

/** The look for a graphics level (the frame's by default). */
export function lookFor(s: LevelSettings = levelSettings()): Look {
  const preset = s.quality;
  const b = { ...BUDGETS[preset] };
  // Trees and particles grow with the level's particle budget above the tier's anchor, at most 2×.
  const k = Math.min(2, s.particles / levelSettings(ANCHOR[preset]).particles);
  b.trees = Math.round(b.trees * k * 10) / 10;
  b.particles = Math.round(b.particles * k);
  return {
    preset, ...ART[preset],
    shadows: s.shadows ? s.shadowMapSize : 0,
    ao: s.ao && { resolution: s.ao.resolution, samples: s.ao.samples, denoiseSamples: s.ao.denoiseSamples },
    bloom: s.bloom ? s.bloom.resolution : null,
    grade: s.grade,
    antialias: s.antialias,
    budget: b,
  };
}
