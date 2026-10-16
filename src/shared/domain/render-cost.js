import { PREVIEW, RENDER_COST } from './constants.js';
import { DEFAULT_QUALITY } from './scene.js';

export function relativeCost(quality, scatterShare = RENDER_COST.scatterShare, forest = true) {
  return cost(quality, scatterShare, forest) / cost(DEFAULT_QUALITY, scatterShare, forest);
}

function cost(quality, scatterShare, forest) {
  const { fixedShare, referenceHz, binExponent, cellExponent, arrivalShare, forestShare, sharedSaving } = RENDER_COST;
  const reach = referenceHz * Math.sqrt(quality.cutoffDecibels / DEFAULT_QUALITY.cutoffDecibels);
  const bins = (Math.min(reach, quality.highestFrequencyHz) / referenceHz) ** binExponent;
  const direct = (1 - scatterShare) / quality.sourceMerge;
  const scattered = scatterShare * quality.echoCellScale ** cellExponent
    * (1 - arrivalShare + arrivalShare * quality.scatterArrivals / DEFAULT_QUALITY.scatterArrivals) * (quality.sharedScatter ? 1 - sharedSaving : 1);
  const canopy = forest && quality.coarseForest ? 1 - forestShare : 1;
  return fixedShare + (1 - fixedShare) * bins * canopy * (direct + scattered);
}

export function previewQuality(quality) {
  return {
    ...quality,
    sourceMerge: Math.max(quality.sourceMerge, PREVIEW.sourceMerge),
    echoCellScale: Math.max(quality.echoCellScale, PREVIEW.echoCellScale),
    highestFrequencyHz: Math.min(quality.highestFrequencyHz, PREVIEW.highestHz)
  };
}
