import { EAR } from './constants.js';

/** Class C as a whole: it reads uncalibrated model pressure. Sources at EAR in `constants.js`. */

const toDb = value => 20 * Math.log10(Math.max(value, 1e-30));
const fromDb = decibels => 10 ** (decibels / 20);

export function envelope(samples, sampleRate, seconds = EAR.envelopeSeconds) {
  const window = Math.max(1, Math.round(sampleRate * seconds));
  const values = new Float64Array(Math.ceil(samples.length / window));
  for (let frame = 0; frame < values.length; frame += 1) {
    let sum = 0;
    const end = Math.min(samples.length, (frame + 1) * window);
    for (let index = frame * window; index < end; index += 1) sum += samples[index] * samples[index];
    values[frame] = Math.sqrt(sum / Math.max(1, end - frame * window));
  }
  return { window, values };
}

export function reflexAttenuation(pressureEnvelope, frameSeconds) {
  const frames = pressureEnvelope.length;
  const target = new Float64Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    const excess = toDb(pressureEnvelope[frame] / EAR.referencePressurePa) - EAR.reflexThresholdDb;
    if (excess <= 0) continue;
    const share = Math.min(1, excess / EAR.latencyRangeDb);
    const latency = EAR.latencyNearThresholdSeconds + (EAR.latencyAtHighLevelSeconds - EAR.latencyNearThresholdSeconds) * share;
    const arrival = frame + Math.round(latency / frameSeconds);
    if (arrival < frames) target[arrival] = Math.max(target[arrival], Math.min(EAR.maximumAttenuationDb, EAR.attenuationPerDb * excess));
  }
  const attenuation = new Float64Array(frames);
  const onset = 1 - Math.exp(-frameSeconds / EAR.onsetSeconds);
  const release = 1 - Math.exp(-frameSeconds / EAR.releaseSeconds);
  let state = 0;
  let activeSeconds = 0;
  let held = 0;
  for (let frame = 0; frame < frames; frame += 1) {
    held = Math.max(target[frame], held * (1 - release));
    activeSeconds = held > .5 ? activeSeconds + frameSeconds : 0;
    const goal = held * .5 ** (activeSeconds / EAR.adaptationHalfLifeSeconds);
    state += (goal - state) * (goal > state ? onset : release);
    attenuation[frame] = state;
  }
  return attenuation;
}

function frameGains(decibels, window, length) {
  const gains = new Float64Array(length);
  for (let index = 0; index < length; index += 1) {
    const position = Math.min(decibels.length - 1, Math.max(0, (index + .5) / window - .5));
    const lower = Math.floor(position);
    const upper = Math.min(decibels.length - 1, lower + 1);
    gains[index] = fromDb(decibels[lower] + (decibels[upper] - decibels[lower]) * (position - lower));
  }
  return gains;
}

function capGains(gains, pressure, sampleRate) {
  let loudest = 0;
  for (const value of pressure) loudest = Math.max(loudest, Math.abs(value));
  if (!(loudest > 0)) return;
  for (let index = 0; index < gains.length; index += 1) {
    const magnitude = Math.abs(pressure[index]);
    if (magnitude * gains[index] > loudest) gains[index] = loudest / magnitude;
  }
  const step = fromDb(EAR.onsetCapSlewDbPerSecond / sampleRate);
  for (let index = 1; index < gains.length; index += 1) gains[index] = Math.min(gains[index], gains[index - 1] * step);
  for (let index = gains.length - 2; index >= 0; index -= 1) gains[index] = Math.min(gains[index], gains[index + 1] * step);
}

export function applyEar(channels, sampleRate, { reflex = true, loudness = true, capOnsets = true } = {}) {
  let output = channels.map(channel => Float32Array.from(channel));
  const length = output[0].length;
  if (reflex) {
    const { window, values } = envelope(output[0], sampleRate);
    const attenuation = reflexAttenuation(values, window / sampleRate);
    // A smoothly moving SVF shelf: switching a biquad's coefficients every frame buzzed at the frame rate under a loud bass.
    const gains = frameGains(attenuation.map(decibels => -decibels), window, length);
    const warped = Math.tan(Math.PI * EAR.shelfHz / sampleRate);
    const damping = Math.SQRT2;
    output = output.map(channel => {
      const result = new Float32Array(length);
      let ic1 = 0;
      let ic2 = 0;
      for (let index = 0; index < length; index += 1) {
        const a = Math.sqrt(gains[index]);
        const g = warped / Math.sqrt(a);
        const a1 = 1 / (1 + g * (g + damping));
        const a2 = g * a1;
        const a3 = g * a2;
        const v0 = channel[index];
        const v3 = v0 - ic2;
        const v1 = a1 * ic1 + a2 * v3;
        const v2 = ic2 + a2 * ic1 + a3 * v3;
        ic1 = 2 * v1 - ic1;
        ic2 = 2 * v2 - ic2;
        result[index] = v0 + damping * (a - 1) * v1 + (a * a - 1) * v2;
      }
      return result;
    });
  }
  if (loudness) {
    // Over 10 ms windows it swung with each cycle of a bass and added its harmonics.
    const square = 1 - Math.exp(-1 / (EAR.loudnessMeanSquareSeconds * sampleRate));
    const smooth = 1 - Math.exp(-1 / (EAR.loudnessLevelSeconds * sampleRate));
    const level = new Float64Array(length);
    let meanSquare = 0;
    let loudest = -Infinity;
    for (let index = 0; index < length; index += 1) {
      meanSquare += square * (output[0][index] * output[0][index] - meanSquare);
      level[index] = 10 * Math.log10(Math.max(meanSquare, 1e-30));
      loudest = Math.max(loudest, level[index]);
    }
    if (loudest > -300) {
      const floor = loudest + EAR.loudnessFloorDb;
      let decibels = Math.max(level[0], floor);
      let peak = -Infinity;
      for (let index = 0; index < length; index += 1) {
        decibels += smooth * (Math.max(level[index], floor) - decibels);
        level[index] = decibels;
        peak = Math.max(peak, decibels);
      }
      const gains = Float64Array.from(level, value => fromDb(Math.min(EAR.loudnessMaximumBoostDb, (EAR.loudnessExponent - 1) * (value - peak))));
      if (capOnsets) capGains(gains, output[0], sampleRate);
      output = output.map(channel => channel.map((value, index) => value * gains[index]));
    }
  }
  return output;
}
