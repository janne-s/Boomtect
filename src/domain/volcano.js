import { VOLCANO } from './constants.js';
import { scaleToLoudestWindow, spectralNoise, tableDensity } from './fireball.js';
import { friedlanderSpanSeconds } from '../shared/domain/pulses.js';
import { createRandom, normalDeviate } from '../shared/domain/random.js';
import { nextPowerOfTwo } from '../shared/domain/fft.js';
import { onGround } from '../shared/domain/terrain.js';
import { paMetresOfEquivalentCharge } from './blast-pulse.js';

export const ERUPTION_TYPES = Object.freeze(Object.keys(VOLCANO.eruptions));

export const ERUPTION_NUMBERS = Object.freeze(['equivalentChargeKilograms', 'pulseSeconds', 'decay', 'riseTimeSeconds', 'codaDecibels', 'codaSeconds', 'thumpShare']);

export const eruptionOf = emitter => ERUPTION_TYPES.find(type => ERUPTION_NUMBERS.every(key => VOLCANO.eruptions[type][key] === emitter[key])) ?? 'custom';

export function applyEruption(item, type) {
  for (const key of ERUPTION_NUMBERS) item[key] = VOLCANO.eruptions[type][key];
}

const CODA_OFF_DECIBELS = -60;

const falloff = VOLCANO.coda.falloffDecibels / 20 * Math.LN10;

export const codaSpanSeconds = codaSeconds => VOLCANO.coda.riseSeconds * 5 + codaSeconds * (3 * Math.LN10 / falloff) ** .25;

const codaDensity = tableDensity(VOLCANO.coda.spectrumHz, VOLCANO.coda.spectrumDensity);

/** Class C: a train of low thumps, 0.05–0.4 s apart (Anak Krakatau). */
function thumpTrain(seed, length, sampleRate) {
  const { intervalSeconds: [shortest, longest], attackSeconds, decaySeconds, sizeSpread } = VOLCANO.thumps;
  const random = createRandom(seed);
  const train = new Float64Array(length);
  const reach = Math.ceil(8 * decaySeconds * sampleRate);
  let start = 0;
  while (start < length) {
    const size = Math.exp(sizeSpread * normalDeviate(random));
    const end = Math.min(length, start + reach);
    for (let index = start; index < end; index += 1) {
      const t = (index - start) / sampleRate;
      train[index] += size * (1 - Math.exp(-t / attackSeconds)) * Math.exp(-t / decaySeconds);
    }
    start += Math.max(1, Math.round(shortest * (longest / shortest) ** random() * sampleRate));
  }
  let sum = 0;
  for (let index = 0; index < length; index += 1) sum += train[index];
  const mean = sum / length;
  if (mean > 0) for (let index = 0; index < length; index += 1) train[index] /= mean;
  return train;
}

/** Class C, fitted to the Dukono roar and the Anak Krakatau thumps; the thumps follow the emitter's seed so every path hears the same ones. */
export function codaSamples(seed, codaSeconds, sampleRate, emitter) {
  const length = Math.ceil(codaSpanSeconds(codaSeconds) * sampleRate);
  const noise = spectralNoise(createRandom(seed), nextPowerOfTwo(length), sampleRate, codaDensity);
  const share = emitter?.thumpShare ?? 0;
  const train = share > 0 ? thumpTrain(emitter.seed, length, sampleRate) : null;
  const samples = new Float64Array(length);
  for (let index = 0; index < length; index += 1) {
    const t = index / sampleRate;
    const envelope = (1 - Math.exp(-t / VOLCANO.coda.riseSeconds)) * Math.exp(-falloff * (t / codaSeconds) ** 4);
    samples[index] = noise[index] * envelope * (train ? 1 - share + share * train[index] : 1);
  }
  return scaleToLoudestWindow(samples, Math.max(1, Math.round(VOLCANO.coda.windowSeconds * sampleRate)));
}

export const volcanoPaMetres = emitter => paMetresOfEquivalentCharge(emitter.equivalentChargeKilograms, emitter.pulseSeconds, emitter.decay);

/** Class B: the pulse falls as 1/r from its equivalent charge (class C); a Friedlander shape (class C) of the given positive phase. */
export function volcanoSources(emitter, air, surface = null) {
  const positionMetres = surface ? onGround(surface, emitter.positionMetres) : emitter.positionMetres;
  const amplitudePaMetres = volcanoPaMetres(emitter);
  const common = { flash: 0, positionMetres, direction: null, elementMetres: 0, emissionSeconds: emitter.startSeconds };
  const pulse = {
    ...common, amplitudePaMetres, pulse: 'friedlander', durationSeconds: emitter.pulseSeconds, decay: emitter.decay,
    spanSeconds: friedlanderSpanSeconds(emitter.pulseSeconds, emitter.decay),
    linearRadiusMetres: amplitudePaMetres / (VOLCANO.linearPressureShare * air.pressureKpa * 1000)
  };
  const coda = {
    ...common, amplitudePaMetres: 10 ** (emitter.codaDecibels / 20) * amplitudePaMetres, pulse: 'noise', noiseSeed: emitter.seed,
    durationSeconds: emitter.codaSeconds, decay: 0, spanSeconds: codaSpanSeconds(emitter.codaSeconds), linearRadiusMetres: 0
  };
  return emitter.codaDecibels > CODA_OFF_DECIBELS ? [pulse, coda] : [pulse];
}
