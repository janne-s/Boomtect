import { BLAST_PULSE } from './blast-pulse.js';
import { BLAST, GAS_EXPLOSION } from './constants.js';
import { scaleToLoudestWindow, spectralNoise, spectralNoisePair, tableDensity } from './fireball.js';
import { speedOfSoundMetresPerSecond } from '../shared/domain/air.js';
import { nextPowerOfTwo } from '../shared/domain/fft.js';
import { friedlanderSpanSeconds } from '../shared/domain/pulses.js';
import { createRandom } from '../shared/domain/random.js';
import { onGround } from '../shared/domain/terrain.js';
import { drawPuffs, puffLayerWeights, puffPowerAt, puffPowers } from './roar-puffs.js';

export const FUEL_TYPES = Object.freeze(Object.keys(GAS_EXPLOSION.fuels));
export const CONGESTION_TYPES = Object.freeze(Object.keys(GAS_EXPLOSION.congestions));
export const CONFINEMENT_TYPES = Object.freeze(Object.keys(GAS_EXPLOSION.confinements));
export const IGNITION_TYPES = Object.freeze(Object.keys(GAS_EXPLOSION.ignitions));

const FIREBALL_OFF_DECIBELS = -60;

const BAR_PA = 1e5;

/** Class B: the GAME correlation for a spark in the cloud's centre, the flame's path its radius; a burster charge detonates the cloud. */
export function gasSourcePa(emitter) {
  const { strengthPressuresKpa: pressures, congestions, confinements, fuels } = GAS_EXPLOSION;
  const [weakest, strongest] = [pressures[0] * 1000, pressures.at(-1) * 1000];
  if (emitter.ignition === 'charge') return strongest;
  const { blockageRatio, obstacleMetres } = congestions[emitter.congestion];
  const { coefficient, exponent } = confinements[emitter.confinement];
  const argument = blockageRatio * cloudRadiusMetres(emitter.cloudCubicMetres) / obstacleMetres;
  const bar = coefficient * argument ** exponent * fuels[emitter.fuel].burningMetresPerSecond ** 2.7 * obstacleMetres ** .7;
  return Math.min(strongest, Math.max(weakest, bar * BAR_PA));
}

/** The Multi-Energy strength 1–10 whose source pressure this is, between classes on a log scale. */
export function strengthOfPa(sourcePa) {
  const pressures = GAS_EXPLOSION.strengthPressuresKpa.map(kpa => kpa * 1000);
  const upper = Math.min(pressures.length - 1, Math.max(1, pressures.findIndex(pressure => pressure >= sourcePa)));
  return upper + Math.log(sourcePa / pressures[upper - 1]) / Math.log(pressures[upper] / pressures[upper - 1]);
}

export const gasStrength = emitter => strengthOfPa(gasSourcePa(emitter));

export const cloudRadiusMetres = cubicMetres => Math.cbrt(3 * cubicMetres / (2 * Math.PI));

export const combustionJoules = emitter => GAS_EXPLOSION.fuels[emitter.fuel].megajoulesPerCubicMetre * 1e6 * emitter.cloudCubicMetres;

export const gasEquivalentKilograms = emitter => combustionJoules(emitter) / (GAS_EXPLOSION.tntMegajoulesPerKilogram * 1e6);

/** Class A for a weak deflagration: an expanding flame at speed S gives 2ρ(1 − 1/σ)S² at its edge. */
export function flameMetresPerSecond(sourcePa, air) {
  const density = air.pressureKpa * 1000 / (287.05 * (air.temperatureCelsius + 273.15));
  return Math.sqrt(sourcePa / (2 * density * (1 - 1 / GAS_EXPLOSION.expansionRatio)));
}

const friedlanderArea = (seconds, durationSeconds, decay) => {
  const integral = u => Math.exp(-decay * u) * ((u - 1) / decay + 1 / decay ** 2);
  return durationSeconds * (integral(seconds / durationSeconds) - integral(0));
};

export function onsetAmplitude(peakPaMetres, onsetSeconds, durationSeconds, decay) {
  return onsetSeconds > 0 ? peakPaMetres * onsetSeconds / friedlanderArea(onsetSeconds, durationSeconds, decay) : peakPaMetres;
}

function mergedOverpressure(scaledDistance) {
  const { mergedScaledDistances: distances, mergedOverpressures: pressures } = GAS_EXPLOSION.multiEnergy;
  let band = 0;
  while (band < distances.length - 2 && scaledDistance > distances[band + 1]) band += 1;
  const slope = Math.log(pressures[band + 1] / pressures[band]) / Math.log(distances[band + 1] / distances[band]);
  return pressures[band] * (scaledDistance / distances[band]) ** slope;
}

function classOverpressure(strengthClass, scaledDistance, ambientPa) {
  const { farFieldShares, kneeExponent: n } = GAS_EXPLOSION.multiEnergy;
  const source = GAS_EXPLOSION.strengthPressuresKpa[strengthClass - 1] * 1000 / ambientPa;
  const decay = strengthClass <= farFieldShares.length ? farFieldShares[strengthClass - 1] * source / scaledDistance : mergedOverpressure(scaledDistance);
  return (source ** -n + decay ** -n) ** (-1 / n);
}

/** Class B: the Multi-Energy overpressure ΔP/p₀ of a source pressure at a scaled distance, between the classes on a log scale, and in proportion below strength 1. */
export function multiEnergyOverpressure(sourcePa, scaledDistance, ambientPa) {
  const strength = strengthOfPa(sourcePa);
  if (strength < 1) return classOverpressure(1, scaledDistance, ambientPa) * sourcePa / (GAS_EXPLOSION.strengthPressuresKpa[0] * 1000);
  const lower = Math.min(9, Math.floor(strength));
  const share = Math.min(1, strength - lower);
  return classOverpressure(lower, scaledDistance, ambientPa) ** (1 - share) * classOverpressure(lower + 1, scaledDistance, ambientPa) ** share;
}

/** Class B: the Multi-Energy positive phase t̄₊ = t₊c₀/(E/p₀)^⅓ at the reference scaled distance, between the classes on a log scale. */
export function multiEnergyPositivePhase(sourcePa) {
  const phases = GAS_EXPLOSION.multiEnergy.referencePositivePhases;
  const strength = Math.max(1, strengthOfPa(sourcePa));
  const lower = Math.min(9, Math.floor(strength));
  const share = Math.min(1, strength - lower);
  return phases[lower - 1] ** (1 - share) * phases[lower] ** share;
}

export function positivePhaseShare(onsetShare, decay) {
  const area = seconds => friedlanderArea(seconds, 1, decay) - friedlanderArea(Math.max(0, seconds - onsetShare), 1, decay);
  let [low, high] = [1, 1 + onsetShare];
  for (let step = 0; step < 50; step += 1) {
    const middle = (low + high) / 2;
    if (area(middle) > 0) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

/** Class B level and positive phase: the Multi-Energy curves at their reference scaled distance, which hold the wave's aging up to there; the level carried as 1/r and halved because the ground doubles it, aged as a weak shock only beyond. Class C shape: the pulse rises over its Friedlander duration while the wave is a pressure wave, and is a shock from strength 7. */
export function deflagrationPulse({ sourcePa, radiusMetres, kilograms }, air) {
  const strength = strengthOfPa(sourcePa);
  const ambientPa = air.pressureKpa * 1000;
  const scaleMetres = Math.cbrt(kilograms * GAS_EXPLOSION.tntMegajoulesPerKilogram * 1e6 / ambientPa);
  const reference = GAS_EXPLOSION.multiEnergy.referenceScaledDistance;
  const peakPaMetres = multiEnergyOverpressure(sourcePa, reference, ambientPa) * reference * ambientPa * scaleMetres / 2;
  const burnSeconds = radiusMetres / flameMetresPerSecond(sourcePa, air);
  const positiveSeconds = multiEnergyPositivePhase(sourcePa) * scaleMetres / speedOfSoundMetresPerSecond(air.temperatureCelsius);
  const decay = BLAST_PULSE.decay;
  const onsetShare = 1 - shockShare(strength);
  const durationSeconds = positiveSeconds / positivePhaseShare(onsetShare, decay);
  const onsetSeconds = onsetShare * durationSeconds;
  return { strength, sourcePa, radiusMetres, kilograms, peakPaMetres, agingRadiusMetres: reference * scaleMetres, burnSeconds, positiveSeconds, onsetSeconds, durationSeconds, decay, amplitudePaMetres: onsetAmplitude(peakPaMetres, onsetSeconds, durationSeconds, decay) };
}

export const gasExplosionPulse = (emitter, air) => deflagrationPulse({ sourcePa: gasSourcePa(emitter), radiusMetres: cloudRadiusMetres(emitter.cloudCubicMetres), kilograms: gasEquivalentKilograms(emitter) }, air);

export const pulseSource = (common, pulse, air) => ({
  ...common, amplitudePaMetres: pulse.amplitudePaMetres, pulse: 'friedlander', durationSeconds: pulse.durationSeconds, onsetSeconds: pulse.onsetSeconds, decay: pulse.decay,
  spanSeconds: friedlanderSpanSeconds(pulse.durationSeconds, pulse.decay),
  linearRadiusMetres: pulse.peakPaMetres / (GAS_EXPLOSION.linearPressureShare * air.pressureKpa * 1000),
  agingRadiusMetres: pulse.agingRadiusMetres ?? 0
});

export const gasPaMetres = (emitter, air) => gasExplosionPulse(emitter, air).peakPaMetres;

export const gasRoarTailSeconds = emitter => emitter.fireballSecondsPerSixthRootKilogram * gasEquivalentKilograms(emitter) ** (1 / 6);

export const roarSpanSeconds = (burnSeconds, tailSeconds) => burnSeconds + tailSeconds * 70 / BLAST.roar.durationDecibels;

const deflagrationDensity = tableDensity(GAS_EXPLOSION.roar.spectrumHz, GAS_EXPLOSION.roar.deflagrationDensity);
const detonationDensity = tableDensity(GAS_EXPLOSION.roar.spectrumHz, GAS_EXPLOSION.roar.detonationDensity);

export function shockShare(strength) {
  const [soft, sharp] = GAS_EXPLOSION.pressureWaveStrengths;
  return Math.min(1, Math.max(0, (strength - soft) / (sharp - soft)));
}

function roarDensity(strength, radiusMetres) {
  const share = shockShare(strength);
  const scale = radiusMetres / GAS_EXPLOSION.roar.referenceMetres;
  return frequencyHz => deflagrationDensity(frequencyHz * scale) ** (1 - share) * detonationDensity(frequencyHz * scale) ** share;
}

function roarEnvelope(burnSeconds, tailSeconds) {
  const riseSeconds = Math.max(BLAST.roar.riseSeconds, GAS_EXPLOSION.roar.riseShare * burnSeconds);
  const decay = BLAST.roar.durationDecibels / 20 * Math.LN10 / tailSeconds;
  return t => (t < riseSeconds ? t / riseSeconds : t < burnSeconds ? 1 : Math.exp(-decay * (t - Math.max(riseSeconds, burnSeconds))));
}

/** Class C: a burning cloud's roar, its length the burn plus the fireball's tail, loudest window at unit level. */
export function roarSamples(seed, { burnSeconds, tailSeconds, strength, radiusMetres }, sampleRate) {
  const length = Math.ceil(roarSpanSeconds(burnSeconds, tailSeconds) * sampleRate);
  const noise = spectralNoise(createRandom(seed), nextPowerOfTwo(length), sampleRate, roarDensity(strength, radiusMetres));
  const envelope = roarEnvelope(burnSeconds, tailSeconds);
  const samples = new Float64Array(length);
  for (let index = 0; index < length; index += 1) samples[index] = noise[index] * envelope(index / sampleRate);
  return scaleToLoudestWindow(samples, Math.max(1, Math.round(BLAST.roar.windowSeconds * sampleRate)));
}

const PUFF_LAYERS = puffLayerWeights(GAS_EXPLOSION.roar.puffs.crossoversHz);

/** Class C: the roar as puffs drawn from the cloud's seed, each layer keeping the plain roar's energy, so that its spectrum and level stay. */
export function puffedRoarSamples(seed, puffSeed, { burnSeconds, tailSeconds, strength, radiusMetres, blend = GAS_EXPLOSION.roar.puffs.defaultBlend }, sampleRate) {
  const config = GAS_EXPLOSION.roar.puffs;
  const density = roarDensity(strength, radiusMetres);
  const densities = PUFF_LAYERS.map(share => frequencyHz => share(frequencyHz) * density(frequencyHz));
  const length = Math.ceil(roarSpanSeconds(burnSeconds, tailSeconds) * sampleRate);
  const envelope = roarEnvelope(burnSeconds, tailSeconds);
  const activeSeconds = burnSeconds + config.activeShareOfTail * tailSeconds;
  const onsetSpanSeconds = activeSeconds + blend * (burnSeconds + tailSeconds - activeSeconds);
  const puffs = drawPuffs(createRandom(puffSeed), onsetSpanSeconds, activeSeconds, config, PUFF_LAYERS.length, blend * config.blendLengthening);
  const powers = puffPowers(puffs, PUFF_LAYERS.length, length, sampleRate, config.floorDecibels);
  const random = createRandom(seed);
  const size = nextPowerOfTwo(length);
  const noises = [...spectralNoisePair(random, size, sampleRate, densities), spectralNoise(random, size, sampleRate, densities[2])];
  const samples = new Float64Array(length);
  const shaped = new Float64Array(length);
  noises.forEach((noise, layer) => {
    let plainEnergy = 0;
    let shapedEnergy = 0;
    for (let index = 0; index < length; index += 1) {
      const t = index / sampleRate;
      const plain = envelope(t);
      const value = plain * 10 ** (-config.darkeningDecibels[layer] * Math.min(t, activeSeconds) / activeSeconds / 20) * Math.sqrt(puffPowerAt(powers[layer], index));
      plainEnergy += plain ** 2;
      shapedEnergy += value ** 2;
      shaped[index] = value;
    }
    const scale = shapedEnergy > 0 ? Math.sqrt(plainEnergy / shapedEnergy) : 0;
    for (let index = 0; index < length; index += 1) samples[index] += scale * shaped[index] * noise[index];
  });
  return scaleToLoudestWindow(samples, Math.max(1, Math.round(BLAST.roar.windowSeconds * sampleRate)));
}

const roarStrength = emitter => (emitter.ignition !== 'charge' && emitter.denseRegions > 0
  ? strengthOfPa(gasSourcePa(partOf(emitter, 1 - GAS_EXPLOSION.regions.denseShare, GAS_EXPLOSION.regions.openCongestion)))
  : gasStrength(emitter));

export function combustionSamples(seed, durationSeconds, sampleRate, emitter) {
  const tailSeconds = gasRoarTailSeconds(emitter);
  return puffedRoarSamples(seed, emitter.seed, { burnSeconds: Math.max(0, durationSeconds - tailSeconds), tailSeconds, strength: roarStrength(emitter), radiusMetres: cloudRadiusMetres(emitter.cloudCubicMetres), blend: emitter.puffBlend }, sampleRate);
}

const REGION_SEED = 0x3c6ef372;

const partOf = (emitter, share, congestion) => ({ ...emitter, cloudCubicMetres: share * emitter.cloudCubicMetres, congestion });

const partPulse = (part, air) => deflagrationPulse({ sourcePa: gasSourcePa(part), radiusMetres: cloudRadiusMetres(part.cloudCubicMetres), kilograms: gasEquivalentKilograms(part) }, air);

/** The open rest and the dense regions of a spark-lit cloud, each region's offset from the centre and the time its flame reaches it; none for a detonation or without regions. */
export function gasRegions(emitter, air) {
  const count = emitter.ignition === 'charge' ? 0 : emitter.denseRegions;
  if (!(count > 0)) return null;
  const { denseShare, nearestShareOfRadius, farthestShareOfRadius, openCongestion } = GAS_EXPLOSION.regions;
  const open = partPulse(partOf(emitter, 1 - denseShare, openCongestion), air);
  const openSpeed = flameMetresPerSecond(open.sourcePa, air);
  const radius = cloudRadiusMetres(emitter.cloudCubicMetres);
  const random = createRandom((emitter.seed ^ REGION_SEED) >>> 0);
  const regions = Array.from({ length: count }, () => {
    const pulse = partPulse(partOf(emitter, denseShare / count, emitter.congestion), air);
    const distance = radius * (nearestShareOfRadius + (farthestShareOfRadius - nearestShareOfRadius) * random());
    const angle = 2 * Math.PI * random();
    return { pulse, offsetMetres: { x: distance * Math.cos(angle), y: distance * Math.sin(angle), z: 0 }, delaySeconds: distance / openSpeed };
  });
  return { open, regions };
}

export function gasExplosionSources(emitter, air, surface = null) {
  const placedAt = offset => (surface ? onGround(surface, { ...emitter.positionMetres, x: emitter.positionMetres.x + offset.x, y: emitter.positionMetres.y + offset.y }) : { ...emitter.positionMetres, x: emitter.positionMetres.x + offset.x, y: emitter.positionMetres.y + offset.y });
  const positionMetres = placedAt({ x: 0, y: 0 });
  const split = gasRegions(emitter, air);
  const pulse = split ? split.open : gasExplosionPulse(emitter, air);
  const common = { flash: 0, positionMetres, direction: null, elementMetres: 0, emissionSeconds: emitter.startSeconds };
  const shocks = [pulseSource(common, pulse, air), ...(split?.regions ?? []).map(region => pulseSource({ ...common, positionMetres: placedAt(region.offsetMetres), emissionSeconds: emitter.startSeconds + region.delaySeconds }, region.pulse, air))];
  const loudest = Math.max(pulse.peakPaMetres, ...(split?.regions ?? []).map(region => region.pulse.peakPaMetres));
  const tailSeconds = gasRoarTailSeconds(emitter);
  const roar = {
    ...common, amplitudePaMetres: 10 ** (emitter.fireballDecibels / 20) * loudest, pulse: 'noise', noiseSeed: emitter.seed,
    durationSeconds: pulse.burnSeconds + tailSeconds, decay: 0, spanSeconds: roarSpanSeconds(pulse.burnSeconds, tailSeconds), linearRadiusMetres: 0
  };
  return emitter.fireballDecibels > FIREBALL_OFF_DECIBELS ? [...shocks, roar] : shocks;
}
