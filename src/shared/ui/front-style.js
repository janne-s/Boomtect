import { atmosphericAbsorptionNepersPerMetre } from '../domain/air.js';
import { REFERENCE_SOUND_PRESSURE_PA, VIEW } from '../domain/constants.js';

export function createFrontStyle(style = 'level') {
  const levelDependent = style !== 'geometry';
  const absorptionCache = { air: null, decibels: new Map() };

  function absorptionDecibels(frequencyHz, air) {
    if (!air.absorption) return 0;
    if (absorptionCache.air !== air) Object.assign(absorptionCache, { air, decibels: new Map() });
    const step = Math.round(12 * Math.log2(frequencyHz));
    if (!absorptionCache.decibels.has(step)) absorptionCache.decibels.set(step, atmosphericAbsorptionNepersPerMetre(2 ** (step / 12), air) * 20 / Math.LN10);
    return absorptionCache.decibels.get(step);
  }

  function strength(amplitude, radius, frequencyHz, air) {
    if (!levelDependent) return 1;
    const absorption = absorptionDecibels(frequencyHz, air);
    const level = 20 * Math.log10(Math.max(amplitude, 1e-30) / Math.max(radius, 1) / REFERENCE_SOUND_PRESSURE_PA) - absorption * radius;
    return Math.min(1, Math.max(0, (level - VIEW.wavefront.floorDb) / (VIEW.wavefront.topDb - VIEW.wavefront.floorDb)));
  }

  return { levelDependent, shadowShare: levelDependent ? VIEW.wavefront.shadowShare : 1, strength };
}
