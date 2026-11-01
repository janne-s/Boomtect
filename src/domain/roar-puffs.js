import { normalDeviate } from '../shared/domain/random.js';

export const PUFF_STEP = 32;

export function puffLayerWeights([low, high]) {
  const lowShare = frequencyHz => 1 / (1 + (frequencyHz / low) ** 4);
  const highShare = frequencyHz => 1 / (1 + (high / frequencyHz) ** 4);
  return [lowShare, frequencyHz => Math.max(0, 1 - lowShare(frequencyHz) - highShare(frequencyHz)), highShare];
}

export function drawPuffs(random, onsetSpanSeconds, holdSeconds, { count, onsetPower, shortestShareOfHold, longestShareOfHold, attackShare, spreadDecibels, layerSpreadDecibels, colourDecibels }, layerCount) {
  return Array.from({ length: count }, (_, index) => {
    const onsetSeconds = index === 0 ? 0 : onsetSpanSeconds * random() ** onsetPower;
    const attackSeconds = attackShare * holdSeconds * (index === 0 ? shortestShareOfHold : shortestShareOfHold + random() * (longestShareOfHold - shortestShareOfHold));
    const decibels = index === 0 ? 0 : spreadDecibels * normalDeviate(random);
    const colour = index === 0 ? 1 : normalDeviate(random);
    const gains = Array.from({ length: layerCount }, (__, layer) => 10 ** ((decibels + layerSpreadDecibels * normalDeviate(random) + colourDecibels * colour * (layer - 1)) / 20));
    return { onsetSeconds, attackSeconds, gains };
  });
}

export function puffPowers(puffs, layerCount, length, sampleRate, floorDecibels) {
  const floor = 10 ** (floorDecibels / 20);
  const steps = Math.ceil(length / PUFF_STEP) + 1;
  return Array.from({ length: layerCount }, (_, layer) => Float64Array.from({ length: steps }, (__, step) => {
    const t = step * PUFF_STEP / sampleRate;
    let power = floor ** 2;
    for (const { onsetSeconds, attackSeconds, gains } of puffs) {
      if (t <= onsetSeconds) continue;
      const x = (t - onsetSeconds) / attackSeconds;
      power += (gains[layer] * x * Math.exp(1 - x)) ** 2;
    }
    return power;
  }));
}

export function puffPowerAt(powers, index) {
  const step = Math.floor(index / PUFF_STEP);
  const share = index / PUFF_STEP - step;
  return powers[step] + share * (powers[step + 1] - powers[step]);
}
