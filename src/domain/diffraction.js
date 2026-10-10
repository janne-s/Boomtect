/**
 * Diffraction of sound over terrain edges (class B): Fresnel–Kirchhoff diffraction over a thin
 * edge, with several ridges combined by Deygout's method (Deygout 1966, as in ITU-R P.526). Real
 * ridges are rounded and diffract less sound into their shadow than a thin edge would let through
 * at high frequencies; that rounding, and terrain finer than the heightfield, are not modelled.
 */

const SERIES_LIMIT = 1.5;
const EPSILON = 6e-8;
const MAXIMUM_ITERATIONS = 100;
const TINY = 1e-30;

/**
 * Fresnel integrals C(x) = ∫₀ˣ cos(πt²/2) dt and S(x) = ∫₀ˣ sin(πt²/2) dt, by a power series
 * below 1.5 and a continued fraction above (Press et al., Numerical Recipes, §6.9), to about 1e-7.
 */
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
    // Complex arithmetic on [re, im] pairs for Lentz's continued fraction.
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

/**
 * The field behind a thin edge relative to the free field, F(ν) = ((1 + i)/2)·∫_ν^∞ e^(−iπt²/2) dt,
 * as [re, im]. ν > 0 when the edge rises above the line of sight; F(0) = 1/2, F → 1 well clear of
 * the edge. Its phase e^(−iπν²/2) is the delay of the path over the edge, in the e^(+iωt)
 * convention of `fft.js`, so it multiplies the spectrum of the unobstructed path.
 */
export function knifeEdge(nu) {
  const [c, s] = fresnelIntegrals(nu);
  const a = .5 - c;
  const b = .5 - s;
  return [(a + b) / 2, (a - b) / 2];
}

/**
 * The geometric factor of an edge, g = h·sqrt(2(d₁ + d₂)/(c·d₁·d₂)), so that ν = g·sqrt(f) at
 * frequency f: h is the edge's height above the line of sight, d₁ and d₂ its distances from the
 * two ends, c the speed of sound.
 */
export const edgeFactor = (heightMetres, fromStart, toEnd, speed) => heightMetres * Math.sqrt(2 * (fromStart + toEnd) / (speed * fromStart * toEnd));

/**
 * Deygout's edges along a profile: the edge with the largest obstruction ratio
 * h·sqrt((d₁ + d₂)/(d₁·d₂)) between the ends, then the largest one between each end and that edge,
 * measured against the straight line from the end to the edge's top; only crests of the profile
 * count. For points along the path,
 * `distances` holds the distance from the start, `terrain` the ground height, and `path` the
 * height of the path; `startHeight` and `endHeight` are the path's ends. Returns the edges'
 * geometric factors, at most three, or none when the path is clear.
 */
export function deygoutEdges({ distances, terrain, path, total, startHeight, endHeight, speed }) {
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
  const main = best(0, distances.length, 0, total, index => path[index]);
  if (!main) return [];
  const edges = [edgeFactor(main.h, main.d1, main.d2, speed)];
  const top = terrain[main.index];
  const at = distances[main.index];
  const left = best(0, main.index, 0, at, index => startHeight + (top - startHeight) * distances[index] / at);
  if (left) edges.push(edgeFactor(left.h, left.d1, left.d2, speed));
  const right = best(main.index + 1, distances.length, at, total, index => top + (endHeight - top) * (distances[index] - at) / (total - at));
  if (right) edges.push(edgeFactor(right.h, right.d1, right.d2, speed));
  return edges;
}
