import { VIEW } from '../domain/constants.js';

const timelines = new WeakMap();

function groupsOf(candidates) {
  if (!timelines.has(candidates)) {
    const groups = new Map();
    for (const candidate of candidates) {
      if (!groups.has(candidate.group)) groups.set(candidate.group, []);
      groups.get(candidate.group).push(candidate);
    }
    timelines.set(candidates, [...groups.values()].map(group => group.sort((a, b) => a.emitted - b.emitted)));
  }
  return timelines.get(candidates);
}

function at(group, index) {
  const low = Math.floor(index);
  const a = group[low];
  const b = group[Math.min(group.length - 1, low + 1)];
  const share = index - low;
  return { ...a, emitted: a.emitted + share * (b.emitted - a.emitted), point: Object.fromEntries(['x', 'y', 'z'].map(axis => [axis, a.point[axis] + share * (b.point[axis] - a.point[axis])])) };
}

/** Class C: bounded interpolation of emission histories for indicative geometry. */
export function sampleEnvelopeSources(candidates, now, maximum = VIEW.wavefront.spheres) {
  const groups = groupsOf(candidates).filter(group => group[0].emitted < now).slice(0, Math.min(VIEW.wavefront.groups, Math.floor(maximum / 2)));
  return groups.flatMap((group, member) => {
    let low = 0;
    let high = group.length - 1;
    while (high - low > 1) {
      const middle = Math.floor((low + high) / 2);
      if (group[middle].emitted <= now) low = middle;
      else high = middle;
    }
    const end = now >= group[high].emitted ? high : low + (now - group[low].emitted) / (group[high].emitted - group[low].emitted);
    const budget = Math.floor(maximum / groups.length) + (member < maximum % groups.length ? 1 : 0);
    const count = Math.min(budget, Math.ceil(end) + 1);
    return Array.from({ length: count }, (_, index) => at(group, count === 1 ? 0 : end * index / (count - 1)));
  });
}

export function outerSpheres(spheres) {
  const kept = [];
  const groups = new Map();
  for (const sphere of [...spheres].sort((a, b) => b.radiusMetres - a.radiusMetres)) {
    if (!groups.has(sphere.group)) groups.set(sphere.group, []);
    const group = groups.get(sphere.group);
    const { centre, radiusMetres } = sphere;
    if (group.some(other => Math.hypot(centre.x - other.centre.x, centre.y - other.centre.y, centre.z - other.centre.z) + radiusMetres <= other.radiusMetres)) continue;
    group.push(sphere);
    kept.push(sphere);
  }
  return kept;
}

export function outsideSphereIntervals(a, b, spheres, from = 0, to = 1, radiusShare = 1) {
  let intervals = [[from, to]];
  const dx = b.x - a.x; const dy = b.y - a.y; const dz = b.z - a.z;
  const lengthSquared = dx * dx + dy * dy + dz * dz;
  if (!(lengthSquared > 0)) return [];
  for (const { centre, radiusMetres } of spheres) {
    const x = a.x - centre.x; const y = a.y - centre.y; const z = a.z - centre.z;
    const along = x * dx + y * dy + z * dz;
    const discriminant = along * along - lengthSquared * (x * x + y * y + z * z - (radiusMetres * radiusShare) ** 2);
    if (!(discriminant > 0)) continue;
    const root = Math.sqrt(discriminant);
    const enter = (-along - root) / lengthSquared;
    const leave = (-along + root) / lengthSquared;
    intervals = intervals.flatMap(([start, end]) => {
      if (leave <= start || enter >= end) return [[start, end]];
      return [...(enter > start ? [[start, enter]] : []), ...(leave < end ? [[leave, end]] : [])];
    });
    if (!intervals.length) break;
  }
  return intervals;
}
