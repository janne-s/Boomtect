export const REFERENCE_PRESSURE_PA = 2e-5;
export const FAST_SECONDS = .125;

/** IEC 61672-1 analytic A weighting, normalised to 0 dB at 1 kHz. */
const A_WEIGHTING_POLES_HZ = Object.freeze([20.598997, 107.65265, 737.86223, 12194.217]);

export const pressureDecibels = pa => 20 * Math.log10(pa / REFERENCE_PRESSURE_PA);

function aWeightingGain(hz) {
  const [f1, f2, f3, f4] = A_WEIGHTING_POLES_HZ;
  const squared = hz * hz;
  return f4 * f4 * squared * squared / ((squared + f1 * f1) * Math.sqrt((squared + f2 * f2) * (squared + f3 * f3)) * (squared + f4 * f4));
}

export const aWeightingDecibels = hz => 20 * Math.log10(aWeightingGain(hz) / aWeightingGain(1000));

const prewarpedPole = (hz, sampleRate) => (1 - Math.tan(Math.PI * hz / sampleRate)) / (1 + Math.tan(Math.PI * hz / sampleRate));

function biquadResponse({ b, a }, hz, sampleRate) {
  const w = 2 * Math.PI * hz / sampleRate;
  const evaluate = ([c0, c1, c2]) => {
    const re = c0 + c1 * Math.cos(w) + c2 * Math.cos(2 * w);
    const im = -c1 * Math.sin(w) - c2 * Math.sin(2 * w);
    return Math.hypot(re, im);
  };
  return evaluate(b) / evaluate(a);
}

export function aWeightingSections(sampleRate) {
  const [p1, p2, p3, p4] = A_WEIGHTING_POLES_HZ.map(hz => prewarpedPole(hz, sampleRate));
  const sections = [
    { b: [1, -2, 1], a: [1, -2 * p1, p1 * p1] },
    { b: [1, -2, 1], a: [1, -(p2 + p3), p2 * p3] },
    { b: [1, 2, 1], a: [1, -2 * p4, p4 * p4] }
  ];
  const gain = 1 / sections.reduce((product, section) => product * biquadResponse(section, 1000, sampleRate), 1);
  sections[0].b = sections[0].b.map(value => value * gain);
  return sections;
}

export const sectionsDecibels = (sections, hz, sampleRate) => 20 * Math.log10(sections.reduce((product, section) => product * biquadResponse(section, hz, sampleRate), 1));

export function aWeighted(samples, sampleRate) {
  const out = Float64Array.from(samples);
  for (const { b: [b0, b1, b2], a: [, a1, a2] } of aWeightingSections(sampleRate)) {
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let index = 0; index < out.length; index += 1) {
      const x = out[index];
      const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
      out[index] = y;
    }
  }
  return out;
}

export function fastMaximumDecibels(samples, sampleRate) {
  const step = 1 - Math.exp(-1 / (sampleRate * FAST_SECONDS));
  let mean = 0;
  let loudest = 0;
  for (let index = 0; index < samples.length; index += 1) {
    mean += (samples[index] * samples[index] - mean) * step;
    if (mean > loudest) loudest = mean;
  }
  return 10 * Math.log10(loudest / REFERENCE_PRESSURE_PA ** 2);
}

export const loudestDecibelsA = (samples, sampleRate) => fastMaximumDecibels(aWeighted(samples, sampleRate), sampleRate);
