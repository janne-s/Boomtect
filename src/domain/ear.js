/**
 * An optional listener model applied to what plays: the middle-ear acoustic reflex and loudness
 * compression. Both read the model's pressure in pascals, which is not calibrated, so their
 * response to level is only as good as the model's level (class C overall).
 *
 * Acoustic reflex (class B; Wikipedia "Acoustic reflex" and the sources it cites, verify against
 * Borg 1976 or Margolis & Popelka): threshold about 70–100 dB SPL; contraction latency about
 * 150 ms near threshold and 25–35 ms at high levels; about 15 dB less transmission 20 dB above
 * threshold, mostly at low frequencies; maximum tension after about 100 ms; tension halves after a
 * few seconds of sustained sound.
 *
 * Loudness (class B for the exponent, Stevens' power law: loudness ∝ intensity^0.3, that is
 * pressure^0.6; class C as a playback mapping): the level envelope is compressed so that level
 * differences shrink to 0.6 of their size in decibels.
 */
export const EAR = Object.freeze({
  referencePressurePa: 20e-6,
  envelopeSeconds: .01,
  reflexThresholdDb: 85,
  latencyNearThresholdSeconds: .15,
  latencyAtHighLevelSeconds: .03,
  latencyRangeDb: 30,
  attenuationPerDb: .75,
  maximumAttenuationDb: 20,
  onsetSeconds: .05,
  releaseSeconds: .5,
  adaptationHalfLifeSeconds: 3,
  shelfHz: 1000,
  loudnessExponent: .6,
  loudnessFloorDb: -60,
  loudnessMaximumBoostDb: 40
});

const toDb = value => 20 * Math.log10(Math.max(value, 1e-30));
const fromDb = decibels => 10 ** (decibels / 20);

/** RMS of a signal in consecutive windows. */
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

/**
 * The reflex attenuation in decibels per envelope frame, from the pressure envelope in pascals:
 * each frame above threshold asks for an attenuation that arrives after a level-dependent latency,
 * rises and falls with the onset and release time constants, and fades while sustained.
 */
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

/** Low-shelf biquad coefficients with shelf slope 1 (RBJ cookbook), normalized by a0. */
function lowShelf(gainDb, cutoffHz, sampleRate) {
  const a = 10 ** (gainDb / 40);
  const omega = 2 * Math.PI * cutoffHz / sampleRate;
  const cosine = Math.cos(omega);
  const term = 2 * Math.sqrt(a) * Math.sin(omega) / 2 * Math.SQRT2;
  const a0 = (a + 1) + (a - 1) * cosine + term;
  return {
    b0: a * ((a + 1) - (a - 1) * cosine + term) / a0,
    b1: 2 * a * ((a - 1) - (a + 1) * cosine) / a0,
    b2: a * ((a + 1) - (a - 1) * cosine - term) / a0,
    a1: -2 * ((a - 1) + (a + 1) * cosine) / a0,
    a2: ((a + 1) + (a - 1) * cosine - term) / a0
  };
}

/** Per-sample gain from per-frame decibels, interpolated between frame centres. */
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

/**
 * Applies the listener model to one listener's channels, driven by channel 0 (the pressure). The
 * same time-varying processing goes to every channel, so an ambisonic field keeps its directions.
 */
export function applyEar(channels, sampleRate, { reflex = true, loudness = true } = {}) {
  let output = channels.map(channel => Float32Array.from(channel));
  const length = output[0].length;
  if (reflex) {
    const { window, values } = envelope(output[0], sampleRate);
    const attenuation = reflexAttenuation(values, window / sampleRate);
    output = output.map(channel => {
      const result = new Float32Array(length);
      let x1 = 0; let x2 = 0; let y1 = 0; let y2 = 0;
      for (let frame = 0; frame < attenuation.length; frame += 1) {
        const { b0, b1, b2, a1, a2 } = lowShelf(-attenuation[frame], EAR.shelfHz, sampleRate);
        const end = Math.min(length, (frame + 1) * window);
        for (let index = frame * window; index < end; index += 1) {
          const x0 = channel[index];
          const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
          x2 = x1; x1 = x0; y2 = y1; y1 = y0;
          result[index] = y0;
        }
      }
      return result;
    });
  }
  if (loudness) {
    const { window, values } = envelope(output[0], sampleRate);
    const peak = Math.max(...values);
    if (peak > 0) {
      const floor = peak * fromDb(EAR.loudnessFloorDb);
      const decibels = Array.from(values, value => Math.min(EAR.loudnessMaximumBoostDb, (EAR.loudnessExponent - 1) * toDb(Math.max(value, floor) / peak)));
      const gains = frameGains(decibels, window, length);
      output = output.map(channel => channel.map((value, index) => value * gains[index]));
    }
  }
  return output;
}
