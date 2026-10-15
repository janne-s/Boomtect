import { PROPAGATION } from './constants.js';

/** Class B: thin-edge Fresnel–Kirchhoff, Deygout 1966 (ITU-R P.526), rounding ITU-R P.526-15 §4.2; the rounding's phase class C. */

const SERIES_LIMIT = 1.5;
const EPSILON = 6e-8;
const MAXIMUM_ITERATIONS = 100;
const TINY = 1e-30;

/** Numerical Recipes §6.9, to about 1e-7. */
export function fresnelIntegrals(x) {
  const ax = Math.abs(x);
  let c;
  let s;
  if (ax < 1e-15) {
    c = ax;
    s = 0;
  } else if (ax <= SERIES_LIMIT) {
    let sum = 0;
    let sums = 0;
    let sumc = ax;
    let sign = 1;
    const fact = Math.PI / 2 * ax * ax;
    let odd = true;
    let term = ax;
    let n = 3;
    for (let k = 1; k <= MAXIMUM_ITERATIONS; k += 1) {
      term *= fact / k;
      sum += sign * term / n;
      const test = Math.abs(sum) * EPSILON;
      if (odd) { sign = -sign; sums = sum; sum = sumc; } else { sumc = sum; sum = sums; }
      if (term < test) break;
      odd = !odd;
      n += 2;
    }
    c = sumc;
    s = sums;
  } else {
    const pix2 = Math.PI * ax * ax;
    const multiply = ([a, b], [p, q]) => [a * p - b * q, a * q + b * p];
    const divide = ([a, b], [p, q]) => { const scale = p * p + q * q; return [(a * p + b * q) / scale, (b * p - a * q) / scale]; };
    let b = [1, -pix2];
    let cc = [1 / TINY, 0];
    let d = divide([1, 0], b);
    let h = d;
    let n = -1;
    for (let k = 2; k <= MAXIMUM_ITERATIONS; k += 1) {
      n += 2;
      const a = -n * (n + 1);
      b = [b[0] + 4, b[1]];
      d = divide([1, 0], [a * d[0] + b[0], a * d[1] + b[1]]);
      const ratio = divide([a, 0], cc);
      cc = [b[0] + ratio[0], b[1] + ratio[1]];
      const del = multiply(cc, d);
      h = multiply(h, del);
      if (Math.abs(del[0] - 1) + Math.abs(del[1]) < EPSILON) break;
    }
    h = multiply([ax, -ax], h);
    const rotated = multiply([Math.cos(pix2 / 2), Math.sin(pix2 / 2)], h);
    const result = multiply([.5, .5], [1 - rotated[0], -rotated[1]]);
    c = result[0];
    s = result[1];
  }
  return x < 0 ? [-c, -s] : [c, s];
}

/** [re, im] in the e^(+iωt) convention of `fft.js`. */
export function knifeEdge(nu) {
  const [c, s] = fresnelIntegrals(nu);
  const a = .5 - c;
  const b = .5 - s;
  return [(a + b) / 2, (a - b) / 2];
}

/** ITU-R P.526-15 eqs. 26–27. */
export function roundingDecibels(m, n) {
  if (m * n <= 4) return (8.2 + 12 * n) * m ** (.73 + .27 * (1 - Math.exp(-1.43 * n)));
  return -6 - 20 * Math.log10(m * n) + 7.2 * Math.sqrt(m) - (2 - 17 * n) * m + 3.6 * m ** 1.5 - .8 * m * m;
}

function roundingNepers(edge, frequencyHz) {
  const cube = Math.cbrt(edge.radiusRatio * frequencyHz);
  return Math.max(0, roundingDecibels(edge.spread / cube, edge.rise * cube * cube)) * Math.LN10 / 20;
}

function roundingShare(edge, frequencyHz) {
  const kR = 2 * edge.radiusRatio * frequencyHz;
  const [low, high] = PROPAGATION.ridge.fadeKR;
  if (kR <= low) return 0;
  const position = Math.min(1, Math.log(kR / low) / Math.log(high / low));
  return position * position * (3 - 2 * position);
}

/** The rounding's phase by Kramers–Kronig for a power law, class C. */
export function edgeField(edge, frequencyHz) {
  const [re, im] = knifeEdge(edge.factor * Math.sqrt(frequencyHz));
  const share = edge.radiusRatio ? roundingShare(edge, frequencyHz) : 0;
  if (!share) return [re, im];
  const full = roundingNepers(edge, frequencyHz);
  if (!full) return [re, im];
  const slope = Math.min(.9, Math.max(0, Math.log(roundingNepers(edge, frequencyHz * SLOPE_STEP) / full) / Math.log(SLOPE_STEP)));
  const loss = share * full;
  const lag = loss * Math.tan(slope * Math.PI / 2);
  const size = Math.exp(-loss);
  const cos = size * Math.cos(-lag);
  const sin = size * Math.sin(-lag);
  return [re * cos - im * sin, re * sin + im * cos];
}

const SLOPE_STEP = 1.05;

const edgeFactor = (heightMetres, fromStart, toEnd, speed) => heightMetres * Math.sqrt(2 * (fromStart + toEnd) / (speed * fromStart * toEnd));

export function ridgeEdge(heightMetres, fromStart, toEnd, radiusMetres, speed) {
  const factor = edgeFactor(heightMetres, fromStart, toEnd, speed);
  if (!(radiusMetres > 0)) return { factor, spread: 0, rise: 0, radiusRatio: 0 };
  return { factor, spread: radiusMetres * (fromStart + toEnd) / (fromStart * toEnd), rise: heightMetres / radiusMetres, radiusRatio: Math.PI * radiusMetres / speed };
}

export function deygoutEdges({ distances, terrain, path, total, startHeight, endHeight, speed, span = 1 }) {
  // Only crests count as edges: on the flank of one rounded hill Deygout would find it twice.
  // A level crest of several samples counts once, at its first sample.
  const peak = index => terrain[index] > (terrain[index - 1] ?? -Infinity) && terrain[index] >= (terrain[index + 1] ?? -Infinity);
  const best = (from, to, startDistance, endDistance, lineAt) => {
    let found = null;
    for (let index = from; index < to; index += 1) {
      const d1 = distances[index] - startDistance;
      const d2 = endDistance - distances[index];
      if (!(d1 > 0 && d2 > 0)) continue;
      const h = terrain[index] - lineAt(index);
      if (h <= 0 || !peak(index)) continue;
      const ratio = h * Math.sqrt((d1 + d2) / (d1 * d2));
      if (!found || ratio > found.ratio) found = { index, h, d1, d2, ratio };
    }
    return found;
  };
  const radius = index => {
    const before = index - span;
    const after = index + span;
    if (before < 0 || after >= distances.length) return 0;
    const s1 = distances[index] - distances[before];
    const s2 = distances[after] - distances[index];
    const bend = 2 * ((terrain[after] - terrain[index]) / s2 - (terrain[index] - terrain[before]) / s1) / (s1 + s2);
    return Math.min(PROPAGATION.ridge.maximumRadiusMetres, bend < 0 ? -1 / bend : Infinity);
  };
  const edge = found => ridgeEdge(found.h, found.d1, found.d2, radius(found.index), speed);
  const main = best(0, distances.length, 0, total, index => path[index]);
  if (!main) return [];
  const edges = [edge(main)];
  const top = terrain[main.index];
  const at = distances[main.index];
  const left = best(0, main.index, 0, at, index => startHeight + (top - startHeight) * distances[index] / at);
  if (left) edges.push(edge(left));
  const right = best(main.index + 1, distances.length, at, total, index => top + (endHeight - top) * (distances[index] - at) / (total - at));
  if (right) edges.push(edge(right));
  return edges;
}
