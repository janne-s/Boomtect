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

/**
 * The yaw rotation of a field for a listener facing `headingDegrees` (compass, clockwise from
 * north), as a list of { from, to, gain } terms. Each degree n mixes its cos(mφ) and sin(mφ)
 * components by the angle m·θ; the m = 0 components pass unchanged.
 */
export function headingRotation(headingDegrees, order) {
  const theta = headingDegrees * Math.PI / 180;
  const terms = [];
  for (let n = 0; n <= order; n += 1) {
    const centre = n * n + n;
    terms.push({ from: centre, to: centre, gain: 1 });
    for (let m = 1; m <= n; m += 1) {
      const cosine = centre + m;
      const sine = centre - m;
      const c = Math.cos(m * theta);
      const s = Math.sin(m * theta);
      terms.push({ from: cosine, to: cosine, gain: c }, { from: sine, to: cosine, gain: -s });
      terms.push({ from: cosine, to: sine, gain: s }, { from: sine, to: sine, gain: c });
    }
  }
  return terms;
}

/** Applies a rotation term list to one encoded gain vector. */
export function rotateGains(gains, terms) {
  const rotated = new Float64Array(gains.length);
  for (const { from, to, gain } of terms) rotated[to] += gains[from] * gain;
  return rotated;
}
