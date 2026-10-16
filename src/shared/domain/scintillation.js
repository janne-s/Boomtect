import { PROPAGATION } from './constants.js';
import { createRandom, normalDeviate } from './random.js';

const SCINTILLATION = PROPAGATION.scintillation;

/**
 * Slow log-amplitude fluctuation, frame by frame: a part shared by all frequencies and a part of each band,
 * each a first-order process of correlation time `seconds`. `gainsAt(frame, frequencies)` gives amplitude
 * factors whose mean power is one.
 */
export function createScintillation({ seed, hopSeconds, decibels = SCINTILLATION.decibels, bandShare = SCINTILLATION.bandShare, seconds = SCINTILLATION.seconds }) {
  const random = createRandom(seed);
  const bands = SCINTILLATION.bandsHz;
  const step = Math.exp(-hopSeconds / seconds);
  const drive = Math.sqrt(1 - step * step);
  const shared = Math.sqrt(1 - bandShare) * decibels;
  const own = Math.sqrt(bandShare) * decibels;
  const nepers = Math.LN10 / 20;
  const bias = nepers * nepers * decibels * decibels;
  const states = [];
  let current = Float64Array.from({ length: bands.length + 1 }, () => normalDeviate(random));
  const levelsAt = frame => {
    while (states.length <= frame) {
      if (states.length) current = current.map(value => step * value + drive * normalDeviate(random));
      states.push(Float64Array.from(bands, (_, band) => shared * current[0] + own * current[band + 1]));
    }
    return states[frame];
  };
  const logBands = bands.map(Math.log);
  return {
    levelsAt,
    gainsAt(frame, frequencies) {
      const levels = levelsAt(frame);
      return frequencies.map(frequency => {
        const at = Math.log(Math.max(frequency, bands[0]));
        let upper = logBands.findIndex(value => value >= at);
        if (upper < 0) upper = bands.length - 1;
        const lower = Math.max(0, upper - 1);
        const share = upper === lower ? 0 : Math.min(1, (at - logBands[lower]) / (logBands[upper] - logBands[lower]));
        return Math.exp(nepers * (levels[lower] + share * (levels[upper] - levels[lower])) - bias);
      });
    }
  };
}
