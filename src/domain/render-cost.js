import { PREVIEW, RENDER_COST } from './constants.js';
import { DEFAULT_QUALITY } from './scene.js';

/**
 * A render's cost for a quality against the full computation (DEFAULT_QUALITY), as RENDER_COST
 * fits it; `scatterShare` is the scattered paths' share of all, 0 without terrain echoes, and
 * `forest` whether the scene has one. An
 * estimate for the Settings dialog only: what a render costs depends on its scene.
 */
export function relativeCost(quality, scatterShare = RENDER_COST.scatterShare, forest = true) {
  return cost(quality, scatterShare, forest) / cost(DEFAULT_QUALITY, scatterShare, forest);
}

function cost(quality, scatterShare, forest) {
  const { fixedShare, referenceHz, binExponent, cellExponent, arrivalShare, forestShare, sharedSaving } = RENDER_COST;
  // The absorption's reach grows as the square root of the loss it may take.
  const reach = referenceHz * Math.sqrt(quality.cutoffDecibels / DEFAULT_QUALITY.cutoffDecibels);
  const bins = (Math.min(reach, quality.highestFrequencyHz) / referenceHz) ** binExponent;
  const direct = (1 - scatterShare) / quality.sourceMerge;
  const scattered = scatterShare * quality.echoCellScale ** cellExponent
    * (1 - arrivalShare + arrivalShare * quality.scatterArrivals / DEFAULT_QUALITY.scatterArrivals) * (quality.sharedScatter ? 1 - sharedSaving : 1);
  const canopy = forest && quality.coarseForest ? 1 - forestShare : 1;
  return fixedShare + (1 - fixedShare) * bins * canopy * (direct + scattered);
}

/** The quality a preview renders with (PREVIEW): the scene's, at most as heavy. */
export function previewQuality(quality) {
  return {
    ...quality,
    sourceMerge: Math.max(quality.sourceMerge, PREVIEW.sourceMerge),
    echoCellScale: Math.max(quality.echoCellScale, PREVIEW.echoCellScale),
    highestFrequencyHz: Math.min(quality.highestFrequencyHz, PREVIEW.highestHz)
  };
}
