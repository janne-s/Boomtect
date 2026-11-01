/** Class A: a fourth-order Butterworth high-pass, as a recording chain cuts infrasound; causal, so nothing rings ahead of an onset. */
const SECTION_Q = Object.freeze([1 / (2 * Math.cos(Math.PI / 8)), 1 / (2 * Math.cos(3 * Math.PI / 8))]);

export function lowCutSections(hz, sampleRate) {
  const w = 2 * Math.PI * hz / sampleRate;
  const cosine = Math.cos(w);
  return SECTION_Q.map(q => {
    const alpha = Math.sin(w) / (2 * q);
    const a0 = 1 + alpha;
    return { b: [(1 + cosine) / 2 / a0, -(1 + cosine) / a0, (1 + cosine) / 2 / a0], a: [1, -2 * cosine / a0, (1 - alpha) / a0] };
  });
}

export function lowCut(samples, hz, sampleRate) {
  for (const { b: [b0, b1, b2], a: [, a1, a2] } of lowCutSections(hz, sampleRate)) {
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let index = 0; index < samples.length; index += 1) {
      const x = samples[index];
      const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
      samples[index] = y;
    }
  }
  return samples;
}
