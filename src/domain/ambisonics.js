/**
 * Ambisonic encoding in AmbiX: ACN channel order and SN3D normalization, orders 0–3. The sound
 * field is encoded in the world frame with x toward north, y toward west, and z up, so a listener's
 * heading is a rotation applied when the field is heard, not a property of the render.
 */

export const MAXIMUM_AMBISONIC_ORDER = 3;

export const channelCount = order => (order + 1) ** 2;

const SQRT3 = Math.sqrt(3);
const SQRT15 = Math.sqrt(15);
const SQRT5_8 = Math.sqrt(5 / 8);
const SQRT3_8 = Math.sqrt(3 / 8);

/** World east/north/up components to the ambisonic frame (north, west, up). */
export const ambisonicDirection = (east, north, up) => [north, -east, up];

/**
 * Class A: real spherical harmonics, SN3D, ACN order, for a unit direction (x, y, z). Writes the
 * (order + 1)² gains into `target`.
 */
export function encodeDirection(x, y, z, order, target = new Float64Array(channelCount(order))) {
  target[0] = 1;
  if (order >= 1) {
    target[1] = y;
    target[2] = z;
    target[3] = x;
  }
  if (order >= 2) {
    target[4] = SQRT3 * x * y;
    target[5] = SQRT3 * y * z;
    target[6] = (3 * z * z - 1) / 2;
    target[7] = SQRT3 * x * z;
    target[8] = SQRT3 / 2 * (x * x - y * y);
  }
  if (order >= 3) {
    target[9] = SQRT5_8 * y * (3 * x * x - y * y);
    target[10] = SQRT15 * x * y * z;
    target[11] = SQRT3_8 * y * (5 * z * z - 1);
    target[12] = z * (5 * z * z - 3) / 2;
    target[13] = SQRT3_8 * x * (5 * z * z - 1);
    target[14] = SQRT15 / 2 * z * (x * x - y * y);
    target[15] = SQRT5_8 * x * (x * x - 3 * y * y);
  }
  return target;
}

const FIT_DIRECTIONS = (() => {
  const count = 96;
  const golden = Math.PI * (3 - Math.sqrt(5));
  return Array.from({ length: count }, (_, index) => {
    const z = 1 - 2 * (index + .5) / count;
    const radius = Math.sqrt(1 - z * z);
    return [radius * Math.cos(golden * index), radius * Math.sin(golden * index), z];
  });
})();

function solve(a, b) {
  const size = b.length;
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) if (Math.abs(a[row][column]) > Math.abs(a[pivot][column])) pivot = row;
    [a[column], a[pivot]] = [a[pivot], a[column]];
    [b[column], b[pivot]] = [b[pivot], b[column]];
    for (let row = column + 1; row < size; row += 1) {
      const factor = a[row][column] / a[column][column];
      for (let k = column; k < size; k += 1) a[row][k] -= factor * a[column][k];
      b[row] -= factor * b[column];
    }
  }
  const x = new Float64Array(size);
  for (let row = size - 1; row >= 0; row -= 1) {
    let sum = b[row];
    for (let k = row + 1; k < size; k += 1) sum -= a[row][k] * x[k];
    x[row] = sum / a[row][row];
  }
  return x;
}

/**
 * The field rotation for a listener facing `headingDegrees` (compass, clockwise from north) and
 * looking `pitchDegrees` up, so that the look direction becomes the front. As a list of
 * { from, to, gain } terms. Each degree's (2n + 1)² block is fitted by least squares from encoded
 * directions and their rotated encodings; spherical harmonics of one degree rotate among
 * themselves, so the fit is exact up to rounding.
 */
export function orientationRotation(headingDegrees, pitchDegrees, order) {
  const heading = headingDegrees * Math.PI / 180;
  const pitch = pitchDegrees * Math.PI / 180;
  const rotate = ([x, y, z]) => {
    const xh = Math.cos(heading) * x - Math.sin(heading) * y;
    const yh = Math.sin(heading) * x + Math.cos(heading) * y;
    return [xh * Math.cos(pitch) + z * Math.sin(pitch), yh, -xh * Math.sin(pitch) + z * Math.cos(pitch)];
  };
  const before = FIT_DIRECTIONS.map(direction => encodeDirection(...direction, order));
  const after = FIT_DIRECTIONS.map(direction => encodeDirection(...rotate(direction), order));
  const terms = [{ from: 0, to: 0, gain: 1 }];
  for (let n = 1; n <= order; n += 1) {
    const first = n * n;
    const size = 2 * n + 1;
    const normal = Array.from({ length: size }, (_, row) => Float64Array.from({ length: size }, (__, column) =>
      before.reduce((sum, gains) => sum + gains[first + row] * gains[first + column], 0)));
    for (let output = 0; output < size; output += 1) {
      const right = Float64Array.from({ length: size }, (_, row) =>
        before.reduce((sum, gains, index) => sum + gains[first + row] * after[index][first + output], 0));
      const weights = solve(normal.map(row => Float64Array.from(row)), right);
      weights.forEach((gain, input) => { if (Math.abs(gain) > 1e-12) terms.push({ from: first + input, to: first + output, gain }); });
    }
  }
  return terms;
}

export function rotationTerms(order) {
  const terms = [{ from: 0, to: 0 }];
  for (let n = 1; n <= order; n += 1) {
    for (let output = 0; output < 2 * n + 1; output += 1) {
      for (let input = 0; input < 2 * n + 1; input += 1) terms.push({ from: n * n + input, to: n * n + output });
    }
  }
  return terms;
}

export function rotateGains(gains, terms) {
  const rotated = new Float64Array(gains.length);
  for (const { from, to, gain } of terms) rotated[to] += gains[from] * gain;
  return rotated;
}
