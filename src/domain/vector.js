export const subtract = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const scaled = (a, factor) => ({ x: a.x * factor, y: a.y * factor, z: a.z * factor });
export const length = a => Math.hypot(a.x, a.y, a.z);
export const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
export const unit = a => scaled(a, 1 / length(a));
export const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });

function perpendicularBasis(direction) {
  const helper = Math.abs(direction.z) < .9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
  const first = unit(cross(direction, helper));
  return [first, cross(direction, first)];
}

export function deflected(direction, angle, azimuth) {
  const [first, second] = perpendicularBasis(direction);
  return add(scaled(direction, Math.cos(angle)),
    scaled(add(scaled(first, Math.cos(azimuth)), scaled(second, Math.sin(azimuth))), Math.sin(angle)));
}
