// The look per graphics level: the browser build's four presets and budgets
// (gfx.js TABLE / BUDGETS, each tuned to hold 60 FPS on the weakest GPU its
// Auto gave it) keyed by the runtime's quality tier (frame().quality), with
// the tree and particle counts scaled within the tier by the level
// (frame().levelIndex), as the browser build scaled them by its hardware
// level (at most 2×). The runtime owns the rest of what the old Graphics
// panel did: Auto and the level choice, render scale and the pixel-ratio
// cap, adaptive resolution, the frame-rate limit and readout. The old
// panel's per-effect overrides are not offered (the runtime's Options choose
// a level).
import type { QualityTier } from "starhermit:engine";
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
  bloomRes: number;
  aoRes: number;
}
export interface Look {
  preset: QualityTier;
  shadows: 0 | 1024 | 2048 | 4096;
  ao: "off" | "on" | "high";
  bloom: boolean;
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

const TABLE: Record<QualityTier, Omit<Look, "preset" | "budget">> = {
  low: { shadows: 0, ao: "off", bloom: false, grade: false, antialias: "off", reflections: false, foliage: 0, animatedSky: false, detailed: false },
  balanced: { shadows: 1024, ao: "off", bloom: true, grade: true, antialias: "fxaa", reflections: true, foliage: 0.6, animatedSky: true, detailed: true },
  high: { shadows: 2048, ao: "on", bloom: true, grade: true, antialias: "smaa", reflections: true, foliage: 1, animatedSky: true, detailed: true },
  ultra: { shadows: 4096, ao: "high", bloom: true, grade: true, antialias: "msaa", reflections: true, foliage: 1, animatedSky: true, detailed: true },
};
/** gfx.js BUDGETS; the particle pool is the preset's Particles tier share (Low: off, Balanced: a third). */
const BUDGETS: Record<QualityTier, Budget> = {
  low: { material: "lambert", trees: 8, treeShadows: false, segments: 0.5, tufts: 0.8, particles: 0, bloomRes: 0.5, aoRes: 0.5 },
  balanced: { material: "standard", trees: 11, treeShadows: false, segments: 0.75, tufts: 1.2, particles: 48, bloomRes: 0.5, aoRes: 0.5 },
  high: { material: "physical", trees: 14.3, treeShadows: true, segments: 1, tufts: 2.2, particles: 192, bloomRes: 0.5, aoRes: 0.5 },
  ultra: { material: "physical", trees: 20, treeShadows: true, segments: 1.5, tufts: 3.2, particles: 320, bloomRes: 1, aoRes: 1 },
};
/** The first level index of each tier (quantum, molecular, terrestrial, galactic). */
const TIER_FLOOR: Record<QualityTier, number> = { low: 0, balanced: 2, high: 4, ultra: 7 };

/** The look for a quality tier at a level index (0 quantum … 9 infinite). */
export function lookFor(preset: QualityTier, levelIndex: number): Look {
  const b = { ...BUDGETS[preset] };
  // Levels are about 1.64× apart in GPU throughput: trees and particles grow
  // with the level above the tier's first, at most 2× the tier's budget.
  const k = Math.min(2, Math.pow(1.64, Math.max(0, levelIndex - TIER_FLOOR[preset])));
  b.trees = Math.round(b.trees * k * 10) / 10;
  b.particles = Math.round(b.particles * k);
  return { preset, ...TABLE[preset], budget: b };
}
