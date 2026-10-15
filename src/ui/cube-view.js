import { FIREWORKS, RENDER, STANDARD_GRAVITY_METRES_PER_SECOND_SQUARED, VIEW } from '../domain/constants.js';
import { airDensityKilogramsPerCubicMetre } from '../domain/air.js';
import { emissionSeconds } from '../domain/lightning.js';
import { createRandom } from '../domain/random.js';
import { grazingRange, inShadow, pathProfile, soundSpeedProfile } from '../domain/refraction.js';
import { meanPlaneFrame } from '../domain/terrain-propagation.js';
import { fitCanvas, formatMetres, niceStep, palette } from './canvas.js';
import { cachedFlashes, cachedRounds, cachedTracks, currentSurface, isFieldKind, isTrackKind, useTerrain } from './geometry-cache.js';

const DISC_POINTS = 64;

const OUTLINE_STEPS = 48;
const OUTLINE_DIRECTIONS = Object.freeze(Array.from({ length: OUTLINE_STEPS }, (_, step) => {
  const angle = 2 * Math.PI * step / OUTLINE_STEPS;
  return Object.freeze({ cos: Math.cos(angle), sin: Math.sin(angle) });
}));
const TERRAIN_LIGHT = (() => { const { x, y, z } = VIEW.terrain.light; const length = Math.hypot(x, y, z); return { x: x / length, y: y / length, z: z / length }; })();
const LABEL_PRIORITY = Object.freeze({ city: 0, town: 1, village: 2, peak: 3, water: 4, hamlet: 5, locality: 6 });
const TERRAIN_RIPPLE_ITERATIONS = 14;

function outerCircles(circles) {
  const kept = [];
  for (const circle of [...circles].sort((a, b) => b.radius - a.radius)) {
    if (!kept.some(other => Math.hypot(circle.u - other.u, circle.v - other.v) + circle.radius <= other.radius)) kept.push(circle);
  }
  return kept;
}

function unionArcs(circles) {
  const arcs = [];
  for (const circle of circles) {
    const covered = [];
    for (const other of circles) {
      if (other === circle) continue;
      const distance = Math.hypot(other.u - circle.u, other.v - circle.v);
      if (distance >= circle.radius + other.radius || distance <= Math.abs(circle.radius - other.radius)) continue;
      const toward = Math.atan2(other.v - circle.v, other.u - circle.u);
      const half = Math.acos((circle.radius ** 2 + distance ** 2 - other.radius ** 2) / (2 * circle.radius * distance));
      const from = ((toward - half) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
      if (from + 2 * half > 2 * Math.PI) covered.push([from, 2 * Math.PI], [0, from + 2 * half - 2 * Math.PI]);
      else covered.push([from, from + 2 * half]);
    }
    covered.sort((x, y) => x[0] - y[0]);
    let at = 0;
    for (const [from, to] of covered) {
      if (from > at) arcs.push([circle, at, from]);
      at = Math.max(at, to);
    }
    if (at < 2 * Math.PI) arcs.push([circle, at, 2 * Math.PI]);
  }
  return arcs;
}

const emptyBounds = () => ({ x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });

/** Not closePath: in Chrome it takes time in proportion to the path's earlier polygons. Strokes need round caps to look closed. */
function addPolygon(path, points, bounds) {
  if (!points.length) return;
  path.moveTo(points[0].x, points[0].y);
  for (let index = 1; index < points.length; index += 1) path.lineTo(points[index].x, points[index].y);
  path.lineTo(points[0].x, points[0].y);
  if (bounds) {
    for (const { x, y } of points) {
      if (x < bounds.x0) bounds.x0 = x;
      if (x > bounds.x1) bounds.x1 = x;
      if (y < bounds.y0) bounds.y0 = y;
      if (y > bounds.y1) bounds.y1 = y;
    }
  }
}

const flashPoints = new WeakMap();
const channelPaths = new WeakMap();
const extents = new WeakMap();
const soundTravel = new WeakMap();
const listIds = new WeakMap();
let nextListId = 0;

function pointsKey(lists) {
  return lists.map(list => {
    if (list.length === 1) return `${list[0].x},${list[0].y},${list[0].z}`;
    if (!listIds.has(list)) listIds.set(list, nextListId += 1);
    return `#${listIds.get(list)}`;
  }).join(';');
}

function emitterPoints(emitter) {
  if (emitter.kind === 'blast') return [placed(emitter.positionMetres)];
  const flashes = cachedFlashes(emitter);
  if (!flashPoints.has(flashes)) flashPoints.set(flashes, flashes.flatMap(flash => flash.channels.flatMap(channel => channel.points)));
  return flashPoints.get(flashes);
}

const ground = (x, y) => currentSurface().heightAt(x, y);
const placed = point => ({ ...point, z: ground(point.x, point.y) + point.z });
const channelBase = emitter => (emitter.flashType === 'cloud-to-ground' ? placed(emitter.baseMetres) : emitter.baseMetres);

function facingTip(receiver, box) {
  const length = Math.max(box.x1 - box.x0, box.y1 - box.y0) * VIEW.box.facingLengthShare;
  const heading = receiver.headingDegrees * Math.PI / 180;
  const pitch = receiver.pitchDegrees * Math.PI / 180;
  const base = placed(receiver.positionMetres);
  const x = base.x + Math.sin(heading) * Math.cos(pitch) * length;
  const y = base.y + Math.cos(heading) * Math.cos(pitch) * length;
  return { x, y, z: Math.max(ground(x, y), base.z + Math.sin(pitch) * length) };
}

function handles(scene, box) {
  const list = [];
  for (const emitter of scene.emitters) {
    if (isTrackKind(emitter)) {
      const start = emitter.kind === 'booster' ? placed(emitter.padMetres) : emitter.kind === 'whip' ? placed(emitter.startMetres) : emitter.startMetres;
      if (emitter.kind === 'booster') list.push({ type: 'emitter', id: emitter.id, field: 'padMetres', point: start, onGround: true, role: 'start' });
      else list.push({ type: 'emitter', id: emitter.id, field: 'startMetres', point: start, role: 'start' });
      const reach = box ? Math.max(box.x1 - box.x0, box.y1 - box.y0) * VIEW.box.facingLengthShare : 1000;
      const heading = emitter.headingDegrees * Math.PI / 180;
      list.push({ type: 'emitter', id: emitter.id, field: 'flightHeading', point: { x: start.x + reach * Math.sin(heading), y: start.y + reach * Math.cos(heading), z: start.z }, role: 'end', ownPlaneOnly: true });
      continue;
    }
    if (emitter.kind === 'blast') list.push({ type: 'emitter', id: emitter.id, field: 'positionMetres', point: placed(emitter.positionMetres), role: 'source' });
    else if (isFieldKind(emitter)) {
      list.push({ type: 'emitter', id: emitter.id, field: 'centreMetres', point: placed(emitter.centreMetres), onGround: true, role: 'start' });
      list.push({ type: 'emitter', id: emitter.id, field: 'radiusMetres', point: placed({ x: emitter.centreMetres.x + emitter.radiusMetres, y: emitter.centreMetres.y, z: 0 }), onGround: true, role: 'radius' });
    } else if (emitter.kind === 'storm') {
      list.push({ type: 'emitter', id: emitter.id, field: 'centreMetres', point: placed(emitter.centreMetres), onGround: true, role: 'start' });
      list.push({ type: 'emitter', id: emitter.id, field: 'radiusMetres', point: placed({ x: emitter.centreMetres.x + emitter.radiusMetres, y: emitter.centreMetres.y, z: 0 }), onGround: true, role: 'radius' });
      for (const field of ['cloudBaseMetres', 'cloudTopMetres']) {
        list.push({ type: 'emitter', id: emitter.id, field, point: { x: emitter.centreMetres.x - emitter.radiusMetres, y: emitter.centreMetres.y, z: emitter[field] }, role: 'level', verticalOnly: true, ownPlaneOnly: true });
      }
    }
    else {
      list.push({ type: 'emitter', id: emitter.id, field: 'baseMetres', point: channelBase(emitter), onGround: emitter.flashType === 'cloud-to-ground', role: 'start' });
      list.push({ type: 'emitter', id: emitter.id, field: 'topMetres', point: emitter.topMetres, role: 'end' });
    }
  }
  for (const receiver of scene.receivers) {
    list.push({ type: 'receiver', id: receiver.id, field: 'positionMetres', point: placed(receiver.positionMetres), role: 'receiver', listening: receiver.listen });
    if (receiver.type === 'binaural' && box) {
      list.push({ type: 'receiver', id: receiver.id, field: 'headingDegrees', point: facingTip(receiver, box), role: 'facing', ownPlaneOnly: true, listening: receiver.listen });
    }
  }
  return list;
}

function flicker(seed, elapsed) {
  const level = knot => {
    if (knot <= 0) return 1;
    let value = Math.imul((seed >>> 0) ^ Math.imul(knot, 0x9e3779b1), 0x85ebca6b) >>> 0;
    value = Math.imul(value ^ (value >>> 13), 0xc2b2ae35) >>> 0;
    return .35 + .65 * ((value ^ (value >>> 16)) >>> 0) / 4294967296;
  };
  const position = Math.max(0, elapsed) / VIEW.flash.flickerSeconds;
  const knot = Math.floor(position);
  const t = position - knot;
  const eased = t * t * (3 - 2 * t);
  return level(knot) + (level(knot + 1) - level(knot)) * eased;
}

function frontArc(step, elapsed, routeLength) {
  return step.fromArc + elapsed / VIEW.flash.traverseSeconds * routeLength - step.offsetMetres;
}

export function createCubeView(canvas, { onSelect, onMove, onCommit, onView, onViewChange, focus, contours = () => false, names = () => false, clouds = () => false, map = () => false, mapTiles: loadMapTiles = () => [] }) {
  let scene = null;
  let selection = null;
  let view = { ...VIEW.box.defaultView };
  let frame = null;
  let drag = null;
  let animation = null;
  let scratch = null;
  let held = false;
  let lastBox = null;
  let terrainLayer = null;
  let terrainMeshCache = null;
  let rippleLayer = null;
  let terrainBoundary = null;
  let relief = null;
  let shadowOutline = null;
  let shadowLayer = null;
  const cloudLayers = new Map();
  let cloudLight = null;

  function sceneBox() {
    let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity; let maxZ = 0;
    const include = point => {
      minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
      minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y);
      maxZ = Math.max(maxZ, point.z);
    };
    const includeExtent = (geometry, points) => {
      if (!extents.has(geometry)) {
        const extent = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, maxZ: -Infinity };
        for (const point of points()) {
          extent.minX = Math.min(extent.minX, point.x); extent.maxX = Math.max(extent.maxX, point.x);
          extent.minY = Math.min(extent.minY, point.y); extent.maxY = Math.max(extent.maxY, point.y);
          extent.maxZ = Math.max(extent.maxZ, point.z);
        }
        extents.set(geometry, extent);
      }
      const extent = extents.get(geometry);
      if (!(extent.maxX >= extent.minX)) return;
      include({ x: extent.minX, y: extent.minY, z: extent.maxZ });
      include({ x: extent.maxX, y: extent.maxY, z: extent.maxZ });
    };
    for (const emitter of scene.emitters) {
      if (emitter.kind === 'blast') { include(placed(emitter.positionMetres)); continue; }
      if (isTrackKind(emitter)) {
        const paths = cachedTracks(emitter, scene.air);
        includeExtent(paths, () => {
          const points = [];
          for (const path of paths) {
            for (let index = 0; index < path.x.length; index += 10) points.push({ x: path.x[index], y: path.y[index], z: path.z[index] });
            points.push({ x: path.x.at(-1), y: path.y.at(-1), z: path.z.at(-1) });
          }
          return points;
        });
        continue;
      }
      if (isFieldKind(emitter)) {
        const { x, y } = emitter.centreMetres;
        include({ x: x - emitter.radiusMetres, y: y - emitter.radiusMetres, z: 0 });
        include({ x: x + emitter.radiusMetres, y: y + emitter.radiusMetres, z: 0 });
        cachedRounds(emitter, scene.air).forEach(round => include(placed(round.positionMetres)));
        continue;
      }
      if (emitter.kind === 'storm') {
        const { x, y } = emitter.centreMetres;
        const r = emitter.radiusMetres;
        include({ x: x - r, y: y - r, z: emitter.cloudTopMetres });
        include({ x: x + r, y: y + r, z: 0 });
      }
      const flashes = cachedFlashes(emitter);
      includeExtent(flashes, () => flashes.flatMap(flash => flash.channels.flatMap(channel => channel.points)));
    }
    scene.receivers.forEach(receiver => include(placed(receiver.positionMetres)));
    const surface = currentSurface();
    const enabled = scene.emitters.filter(emitter => emitter.enabled);
    const span = enabled.length && enabled.every(emitter => emitter.kind === 'whip') ? VIEW.box.closeSpanMetres : VIEW.box.minimumSpanMetres;
    const pad = Math.max(span, maxX - minX, maxY - minY, maxZ) * VIEW.box.padding;
    const grow = (low, high) => {
      const half = Math.max(high - low, span) / 2 + pad;
      return [(low + high) / 2 - half, (low + high) / 2 + half];
    };
    const [x0, x1] = grow(minX, maxX);
    const [y0, y1] = grow(minY, maxY);
    let minZ = 0;
    if (!surface.flat) {
      const relief = groundRange(surface, x0, x1, y0, y1);
      minZ = Math.min(minZ, relief.low);
      maxZ = Math.max(maxZ, relief.high);
    }
    return { x0, x1, y0, y1, z0: minZ, z1: Math.max(minZ + span, maxZ) + pad };
  }

  function groundRange(surface, x0, x1, y0, y1) {
    const key = [x0, x1, y0, y1].join('|');
    if (relief?.surface === surface && relief.key === key) return relief;
    const { columns, rows, cellMetres, bounds } = surface;
    let low = Infinity;
    let high = -Infinity;
    for (let row = 0; row < rows; row += 1) {
      const y = bounds.south + (row + .5) * cellMetres;
      if (y < y0 || y > y1) continue;
      for (let column = 0; column < columns; column += 1) {
        const x = bounds.west + (column + .5) * cellMetres;
        if (x < x0 || x > x1) continue;
        const z = surface.values[row * columns + column] - surface.datumMetres;
        low = Math.min(low, z);
        high = Math.max(high, z);
      }
    }
    relief = { surface, key, low, high };
    return relief;
  }

  function computeFrame(width, height) {
    const box = held && lastBox ? lastBox : sceneBox();
    lastBox = box;
    const { yaw, pitch, zoom } = view;
    const cosYaw = Math.cos(yaw); const sinYaw = Math.sin(yaw);
    const cosPitch = Math.cos(pitch); const sinPitch = Math.sin(pitch);
    const centre = { x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2, z: (box.z0 + box.z1) / 2 };
    const raw = point => {
      const dx = point.x - centre.x; const dy = point.y - centre.y; const dz = point.z - centre.z;
      const a = cosYaw * dx - sinYaw * dy;
      const b = sinYaw * dx + cosYaw * dy;
      return { x: a, y: dz * cosPitch + b * sinPitch, depth: b * cosPitch - dz * sinPitch };
    };
    let extentX = 0; let extentY = 0;
    for (const x of [box.x0, box.x1]) for (const y of [box.y0, box.y1]) for (const z of [box.z0, box.z1]) {
      const p = raw({ x, y, z });
      extentX = Math.max(extentX, Math.abs(p.x));
      extentY = Math.max(extentY, Math.abs(p.y));
    }
    const scale = zoom * Math.min((width / 2 - VIEW.box.marginPixels) / extentX, (height / 2 - VIEW.box.marginPixels) / extentY);
    const unit = Math.max(extentX, extentY);
    const panX = view.panU * unit;
    const panY = view.panV * unit;
    const project = point => {
      const p = raw(point);
      return { x: width / 2 + (p.x + panX) * scale, y: height / 2 - (p.y + panY) * scale, depth: p.depth };
    };
    const farX = sinYaw > 0 ? box.x1 : box.x0;
    const farY = cosYaw > 0 ? box.y1 : box.y0;
    const right = { x: cosYaw, y: -sinYaw, z: 0 };
    const up = { x: sinPitch * sinYaw, y: sinPitch * cosYaw, z: cosPitch };
    const key = [yaw, pitch, zoom, view.panU, view.panV, width, height, box.x0, box.x1, box.y0, box.y1, box.z0, box.z1].join('|');
    return { box, scale, unit, project, farX, farY, width, height, right, up, key };
  }

  function planes() {
    const { farX, farY } = frame;
    return [
      { name: 'floor', fixed: 'z', value: 0, free: ['x', 'y'] },
      { name: 'wall-x', fixed: 'x', value: farX, free: ['y', 'z'] },
      { name: 'wall-y', fixed: 'y', value: farY, free: ['x', 'z'] }
    ];
  }

  function onPlane(point, plane) {
    if (plane.name === 'floor') return { ...point, z: ground(point.x, point.y) };
    return { ...point, [plane.fixed]: plane.value };
  }

  function fromScreen(plane, base, x, y) {
    const origin = frame.project({ ...base, [plane.free[0]]: 0, [plane.free[1]]: 0 });
    const first = frame.project({ ...base, [plane.free[0]]: 1, [plane.free[1]]: 0 });
    const second = frame.project({ ...base, [plane.free[0]]: 0, [plane.free[1]]: 1 });
    const ax = first.x - origin.x; const ay = first.y - origin.y;
    const bx = second.x - origin.x; const by = second.y - origin.y;
    const determinant = ax * by - ay * bx;
    if (Math.abs(determinant) < VIEW.box.degenerateArea * frame.scale * frame.scale) return null;
    const dx = x - origin.x; const dy = y - origin.y;
    return { [plane.free[0]]: (dx * by - dy * bx) / determinant, [plane.free[1]]: (ax * dy - ay * dx) / determinant };
  }

  function verticalPlane(point) {
    const facesX = Math.abs(frame.right.x) >= Math.abs(frame.right.y);
    return facesX ? { name: 'vertical', fixed: 'y', value: point.y, free: ['x', 'z'] } : { name: 'vertical', fixed: 'x', value: point.x, free: ['y', 'z'] };
  }

  function planeUsable(plane) {
    return fromScreen(plane, { x: 0, y: 0, z: 0 }, 0, 0) !== null;
  }

  function polygon(context, points) {
    context.beginPath();
    points.forEach((point, index) => {
      const p = frame.project(point);
      if (index) context.lineTo(p.x, p.y); else context.moveTo(p.x, p.y);
    });
    context.closePath();
  }

  const boxStep = box => niceStep(Math.max(box.x1 - box.x0, box.y1 - box.y0, box.z1 - box.z0), 6);

  function heightLevels(bounds, spacing) {
    const surface = currentSurface();
    const datum = surface.flat ? 0 : surface.datumMetres;
    const levels = [];
    let metres = Math.ceil((bounds.z0 + datum) / spacing) * spacing;
    if (metres - datum <= bounds.z0) metres += spacing;
    for (; metres - datum <= bounds.z1; metres += spacing) levels.push({ z: metres - datum, metres });
    return levels;
  }

  function drawBox(context, colors) {
    const { box, farX, farY } = frame;
    context.fillStyle = colors.wall;
    polygon(context, [{ x: farX, y: box.y0, z: box.z0 }, { x: farX, y: box.y1, z: box.z0 }, { x: farX, y: box.y1, z: box.z1 }, { x: farX, y: box.y0, z: box.z1 }]);
    context.fill();
    polygon(context, [{ x: box.x0, y: farY, z: box.z0 }, { x: box.x1, y: farY, z: box.z0 }, { x: box.x1, y: farY, z: box.z1 }, { x: box.x0, y: farY, z: box.z1 }]);
    context.fill();
    context.fillStyle = colors.ground;
    polygon(context, [{ x: box.x0, y: box.y0, z: box.z0 }, { x: box.x1, y: box.y0, z: box.z0 }, { x: box.x1, y: box.y1, z: box.z0 }, { x: box.x0, y: box.y1, z: box.z0 }]);
    context.fill();

    const step = boxStep(box);
    context.lineWidth = 1;
    context.strokeStyle = colors.grid;
    const line = (a, b) => { const p = frame.project(a); const q = frame.project(b); context.beginPath(); context.moveTo(p.x, p.y); context.lineTo(q.x, q.y); context.stroke(); };
    for (let x = Math.ceil(box.x0 / step) * step; x <= box.x1; x += step) {
      if (currentSurface().flat) line({ x, y: box.y0, z: box.z0 }, { x, y: box.y1, z: box.z0 });
      line({ x, y: farY, z: box.z0 }, { x, y: farY, z: box.z1 });
    }
    for (let y = Math.ceil(box.y0 / step) * step; y <= box.y1; y += step) {
      if (currentSurface().flat) line({ x: box.x0, y, z: box.z0 }, { x: box.x1, y, z: box.z0 });
      line({ x: farX, y, z: box.z0 }, { x: farX, y, z: box.z1 });
    }
    for (const { z } of heightLevels(box, step)) {
      line({ x: farX, y: box.y0, z }, { x: farX, y: box.y1, z });
      line({ x: box.x0, y: farY, z }, { x: box.x1, y: farY, z });
    }
    context.strokeStyle = colors.line;
    line({ x: farX, y: farY, z: box.z0 }, { x: farX, y: farY, z: box.z1 });
  }

  function drawBoxLabels(context, colors) {
    const { box, farX, farY } = frame;
    const nearX = farX === box.x1 ? box.x0 : box.x1;
    const nearY = farY === box.y1 ? box.y0 : box.y1;
    const step = boxStep(box);
    context.lineWidth = 1;
    context.font = '10px system-ui, sans-serif';
    context.fillStyle = colors.faint;
    const label = (text, point, dx = 4, dy = 12) => { const p = frame.project(point); context.fillText(text, p.x + dx, p.y + dy); };
    for (let x = Math.ceil(box.x0 / step) * step; x <= box.x1; x += step) label(formatMetres(x), { x, y: nearY, z: box.z0 });
    context.textAlign = 'right';
    for (let y = Math.ceil(box.y0 / step) * step; y <= box.y1; y += step) label(formatMetres(y), { x: nearX, y, z: box.z0 }, -6, 12);
    context.textAlign = 'left';
    for (const { z, metres } of heightLevels(box, step)) label(formatMetres(metres), { x: farX, y: farY, z }, 4, -2);
    const origin = frame.project({ x: 0, y: 0, z: ground(0, 0) });
    context.strokeStyle = colors.muted;
    context.beginPath();
    context.moveTo(origin.x - 6, origin.y); context.lineTo(origin.x + 6, origin.y);
    context.moveTo(origin.x, origin.y - 6); context.lineTo(origin.x, origin.y + 6);
    context.stroke();
    label('E', { x: box.x1, y: nearY, z: box.z0 }, 6, 24);
    label('N', { x: nearX, y: box.y1, z: box.z0 }, 6, 24);
  }

  function strokePoints(context, points, toScreen = frame.project) {
    context.beginPath();
    for (let index = 0; index < points.length; index += 1) {
      const p = toScreen(points[index]);
      if (index) context.lineTo(p.x, p.y); else context.moveTo(p.x, p.y);
    }
    context.stroke();
  }

  function shadowProjectors() {
    const onWall = (fixed, value, [u, v]) => {
      const at = (a, b) => frame.project({ [fixed]: value, [u]: a, [v]: b });
      const origin = at(0, 0); const alongU = at(1, 0); const alongV = at(0, 1);
      const ux = alongU.x - origin.x; const uy = alongU.y - origin.y;
      const vx = alongV.x - origin.x; const vy = alongV.y - origin.y;
      return point => ({ x: origin.x + point[u] * ux + point[v] * vx, y: origin.y + point[u] * uy + point[v] * vy });
    };
    return [
      point => frame.project({ x: point.x, y: point.y, z: ground(point.x, point.y) }),
      onWall('x', frame.farX, ['y', 'z']),
      onWall('y', frame.farY, ['x', 'z'])
    ];
  }

  function pointsUpTo(channel, fromArc, toArc) {
    const result = [];
    const { points, arcs } = channel;
    for (let index = 0; index < points.length; index += 1) {
      if (arcs[index] < fromArc) continue;
      if (arcs[index] > toArc) {
        if (index > 0 && arcs[index - 1] < toArc) {
          const a = points[index - 1]; const b = points[index];
          const t = (toArc - arcs[index - 1]) / (arcs[index] - arcs[index - 1]);
          result.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });
        }
        break;
      }
      result.push(points[index]);
    }
    return result;
  }

  function drawChannels(context, emitter, colors, selected, strokes) {
    const shadows = shadowProjectors();
    const flashes = cachedFlashes(emitter);
    context.lineJoin = 'round';
    let paths = channelPaths.get(flashes);
    if (paths?.key !== frame.key) {
      const shadowPath = new Path2D();
      const styles = new Map();
      const addLine = (path, points, toScreen) => points.forEach((point, index) => {
        const p = toScreen(point);
        if (index) path.lineTo(p.x, p.y); else path.moveTo(p.x, p.y);
      });
      for (const flash of flashes) {
        for (const channel of flash.channels) {
          if (channel.main) shadows.forEach(shadow => addLine(shadowPath, channel.points, shadow));
          const style = channel.main ? 'main' : channel.level;
          if (!styles.has(style)) styles.set(style, { main: channel.main, level: channel.level, path: new Path2D() });
          addLine(styles.get(style).path, channel.points, frame.project);
        }
      }
      paths = { key: frame.key, shadowPath, styles: [...styles.values()] };
      channelPaths.set(flashes, paths);
    }
    const alpha = context.globalAlpha;
    context.strokeStyle = colors.shadow;
    context.lineWidth = .6;
    context.stroke(paths.shadowPath);
    context.strokeStyle = colors.lightning;
    for (const { main, level, path } of paths.styles) {
      context.globalAlpha = alpha * (main ? 1 : Math.max(.35, .8 - .2 * level));
      context.lineWidth = main ? (selected ? 1.6 : 1.1) : Math.max(.4, .8 - .15 * level);
      context.stroke(path);
    }
    context.globalAlpha = alpha;
    for (const stroke of strokes ?? []) {
      const flash = flashes[stroke.flash];
      if (!flash) continue;
      const routeLength = Math.max(...stroke.route.map(step => step.offsetMetres + flash.channels[step.channel].arcs.at(-1) - step.fromArc));
      const fade = stroke.elapsed > VIEW.flash.traverseSeconds ? Math.exp(-(stroke.elapsed - VIEW.flash.traverseSeconds) / VIEW.flash.fadeSeconds) : 1;
      context.shadowColor = colors.glow;
      context.strokeStyle = colors.flash;
      for (const step of stroke.route) {
        const channel = flash.channels[step.channel];
        const reached = frontArc(step, stroke.elapsed, routeLength);
        if (reached <= step.fromArc) continue;
        const lit = pointsUpTo(channel, step.fromArc, reached);
        if (lit.length < 2) continue;
        context.globalAlpha = fade;
        context.shadowBlur = 18 * fade;
        context.lineWidth = channel.main ? 2.6 : 1.3;
        strokePoints(context, lit);
        context.shadowBlur = 0;
        context.globalAlpha = .35 * fade;
        context.lineWidth = channel.main ? 1.2 : .6;
        shadows.forEach(shadow => strokePoints(context, lit, shadow));
      }
      context.globalAlpha = emitter.enabled ? 1 : .35;
    }
  }

  function drawSoundGlow(context, emitter, colors, sound) {
    const levels = [[], [], [], []];
    const { seconds, travelSeconds, key } = sound;
    const travel = channel => {
      const kept = soundTravel.get(channel);
      if (kept?.key === key) return kept.seconds;
      const values = Float64Array.from(channel.points, travelSeconds);
      soundTravel.set(channel, { key, seconds: values });
      return values;
    };
    const glow = arrival => {
      const age = seconds - arrival;
      return age >= 0 && age < VIEW.soundGlowSeconds ? 1 - age / VIEW.soundGlowSeconds : 0;
    };
    for (const flash of cachedFlashes(emitter)) {
      for (const stroke of flash.strokes) {
        if (seconds < flash.startSeconds + stroke.offsetSeconds) continue;
        for (const step of stroke.route) {
          const channel = flash.channels[step.channel];
          const travelled = travel(channel);
          let previous = null;
          channel.points.forEach((point, index) => {
            const arc = channel.arcs[index];
            if (arc < step.fromArc) return;
            const level = glow(emissionSeconds(flash, stroke, step, arc) + travelled[index]);
            if (previous && level > .02) levels[Math.min(3, Math.floor(level * 4))].push(previous, point);
            previous = point;
          });
        }
      }
    }
    context.strokeStyle = colors.flash;
    context.shadowColor = colors.glow;
    levels.forEach((pairs, level) => {
      if (!pairs.length) return;
      context.globalAlpha = (level + 1) / 4;
      context.shadowBlur = 6 + 4 * level;
      context.lineWidth = 1.2 + .6 * level;
      context.beginPath();
      for (let index = 0; index < pairs.length; index += 2) {
        const a = frame.project(pairs[index]);
        const b = frame.project(pairs[index + 1]);
        context.moveTo(a.x, a.y);
        context.lineTo(b.x, b.y);
      }
      context.stroke();
    });
    context.shadowBlur = 0;
    context.globalAlpha = 1;
  }

  /** The cut also strokes every edge: where two edges nearly coincide the coverage stays below one and leaves a seam. */
  function unionOutline(context, path, color, { fillAlpha, edgeAlpha, bounds }) {
    scratch ??= document.createElement('canvas');
    if (scratch.width !== canvas.width || scratch.height !== canvas.height) {
      scratch.width = canvas.width;
      scratch.height = canvas.height;
    }
    const transform = context.getTransform();
    const reach = (VIEW.box.outlinePixels * 2 + VIEW.box.seamPixels) * transform.a + 2;
    const x0 = Math.max(0, Math.floor(bounds.x0 * transform.a + transform.e - reach));
    const y0 = Math.max(0, Math.floor(bounds.y0 * transform.d + transform.f - reach));
    const x1 = Math.min(scratch.width, Math.ceil(bounds.x1 * transform.a + transform.e + reach));
    const y1 = Math.min(scratch.height, Math.ceil(bounds.y1 * transform.d + transform.f + reach));
    if (!(x1 > x0 && y1 > y0)) return;
    const layer = scratch.getContext('2d');
    layer.setTransform(1, 0, 0, 1, 0, 0);
    layer.clearRect(x0, y0, x1 - x0, y1 - y0);
    layer.setTransform(transform);
    layer.lineJoin = 'round';
    layer.lineCap = 'round';
    layer.lineWidth = VIEW.box.outlinePixels * 2 + VIEW.box.seamPixels;
    layer.strokeStyle = color;
    layer.stroke(path);
    layer.globalCompositeOperation = 'destination-out';
    layer.fill(path);
    layer.lineWidth = VIEW.box.seamPixels;
    layer.stroke(path);
    layer.globalCompositeOperation = 'source-over';
    if (fillAlpha) {
      context.globalAlpha = fillAlpha;
      context.fillStyle = color;
      context.fill(path);
    }
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalAlpha = edgeAlpha;
    context.drawImage(scratch, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
    context.restore();
    context.globalAlpha = 1;
  }

  function floorPath() {
    const { box } = frame;
    const path = new Path2D();
    addPolygon(path, [{ x: box.x0, y: box.y0, z: 0 }, { x: box.x1, y: box.y0, z: 0 }, { x: box.x1, y: box.y1, z: 0 }, { x: box.x0, y: box.y1, z: 0 }].map(frame.project));
    return path;
  }

  function mixColors(a, b, t) {
    return a.map((value, index) => Math.round(value + (b[index] - value) * t));
  }

  const rgb = hex => [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16));

  function terrainFog(surface, x, y) {
    const { box } = frame;
    const smooth = t => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
    const outside = Math.hypot(Math.max(0, box.x0 - x, x - box.x1), Math.max(0, box.y0 - y, y - box.y1));
    const { west, east, south, north } = surface.bounds;
    const inside = Math.min(x - west, east - x, y - south, north - y);
    return Math.max(smooth(outside / (VIEW.terrain.fogShare * Math.max(box.x1 - box.x0, box.y1 - box.y0))), 1 - smooth(inside / (VIEW.terrain.edgeShare * Math.max(east - west, north - south))));
  }

  function terrainMesh(surface, box, striped, colors) {
    const key = [box.x0, box.x1, box.y0, box.y1, striped, colors.ground, colors.line, colors.muted, colors.panel].join('|');
    if (terrainMeshCache?.key === key && terrainMeshCache.surface === surface) return terrainMeshCache;
    const { bounds } = surface;
    const fogMetres = VIEW.terrain.fogShare * Math.max(box.x1 - box.x0, box.y1 - box.y0);
    const west = Math.max(bounds.west, box.x0 - fogMetres);
    const south = Math.max(bounds.south, box.y0 - fogMetres);
    const east = Math.min(bounds.east, box.x1 + fogMetres);
    const north = Math.min(bounds.north, box.y1 + fogMetres);
    const side = Math.max(east - west, north - south);
    const cells = Math.max(2, Math.min(VIEW.terrain.drawCells, Math.ceil(side / surface.cellMetres)));
    const spacing = side / cells;
    const vertices = [];
    for (let row = 0; row <= cells; row += 1) {
      for (let column = 0; column <= cells; column += 1) {
        const x = Math.min(east, west + column * spacing);
        const y = Math.min(north, south + row * spacing);
        vertices.push({ x, y, z: ground(x, y) });
      }
    }
    let lowest = Infinity;
    let highest = -Infinity;
    for (const vertex of vertices) { lowest = Math.min(lowest, vertex.z); highest = Math.max(highest, vertex.z); }
    const band = niceStep(Math.max(1, highest - lowest), VIEW.terrain.contourBands);
    const dark = rgb(colors.ground);
    const light = mixColors(rgb(colors.line), rgb(colors.muted), .35);
    const fogColor = rgb(colors.panel);
    const quads = [];
    for (let row = 0; row < cells; row += 1) {
      for (let column = 0; column < cells; column += 1) {
        const indices = [row * (cells + 1) + column, row * (cells + 1) + column + 1, (row + 1) * (cells + 1) + column + 1, (row + 1) * (cells + 1) + column];
        const corners = indices.map(index => vertices[index]);
        const centreX = (corners[0].x + corners[2].x) / 2;
        const centreY = (corners[0].y + corners[2].y) / 2;
        if (!(corners[2].x > corners[0].x && corners[2].y > corners[0].y)) continue;
        const fog = terrainFog(surface, centreX, centreY);
        if (fog > .995) continue;
        const u = { x: corners[2].x - corners[0].x, y: corners[2].y - corners[0].y, z: corners[2].z - corners[0].z };
        const v = { x: corners[3].x - corners[1].x, y: corners[3].y - corners[1].y, z: corners[3].z - corners[1].z };
        const n = { x: u.y * v.z - u.z * v.y, y: u.z * v.x - u.x * v.z, z: u.x * v.y - u.y * v.x };
        const length = Math.hypot(n.x, n.y, n.z) || 1;
        const lit = Math.max(0, (n.x * TERRAIN_LIGHT.x + n.y * TERRAIN_LIGHT.y + n.z * TERRAIN_LIGHT.z) / length);
        const height = corners.reduce((sum, corner) => sum + corner.z, 0) / 4;
        const stripe = striped && Math.floor((height - lowest) / band) % 2 === 1 ? .82 : 1;
        const shaded = mixColors(dark, light, lit * lit).map(value => value * stripe);
        const [r, g, b] = mixColors(shaded, fogColor, fog);
        quads.push({ indices, centreX, centreY, depth: 0, color: `rgb(${r},${g},${b})`, mask: `rgba(255,255,255,${(1 - fog).toFixed(3)})` });
      }
    }
    terrainMeshCache = { key, surface, vertices, quads };
    return terrainMeshCache;
  }

  function terrainLayers(colors) {
    const surface = currentSurface();
    const { box, farX, farY } = frame;
    const ratio = window.devicePixelRatio || 1;
    const striped = contours();
    const key = [frame.key, canvas.width, canvas.height, striped, colors.ground, colors.line, colors.muted, colors.panel].join('|');
    if (terrainLayer?.key === key && terrainLayer.surface === surface) return terrainLayer;
    const layers = (terrainLayer?.layers ?? [null, null, null]).map(layer => {
      layer = sized(layer);
      const paint = layer.getContext('2d');
      paint.setTransform(ratio, 0, 0, ratio, 0, 0);
      paint.lineWidth = .6;
      return layer;
    });
    const { vertices, quads } = terrainMesh(surface, box, striped, colors);
    const projected = vertices.map(frame.project);
    const behind = (x, y) => (farX === box.x1 ? x > box.x1 : x < box.x0) || (farY === box.y1 ? y > box.y1 : y < box.y0);
    for (const quad of quads) quad.depth = projected[quad.indices[0]].depth + projected[quad.indices[1]].depth + projected[quad.indices[2]].depth + projected[quad.indices[3]].depth;
    const ordered = [...quads].sort((a, b) => b.depth - a.depth);
    const paints = layers.map(layer => layer.getContext('2d'));
    for (const { indices, centreX, centreY, color, mask } of ordered) {
      const front = paints[behind(centreX, centreY) ? 0 : 1];
      for (const [paint, style] of [[front, color], [paints[2], mask]]) {
        paint.beginPath();
        paint.moveTo(projected[indices[0]].x, projected[indices[0]].y);
        for (let corner = 1; corner < 4; corner += 1) paint.lineTo(projected[indices[corner]].x, projected[indices[corner]].y);
        paint.closePath();
        paint.fillStyle = style;
        paint.fill();
        if (paint !== paints[2]) { paint.strokeStyle = style; paint.stroke(); }
      }
    }
    terrainLayer = { key, surface, layers };
    return terrainLayer;
  }

  function drawTerrain(context, colors, back) {
    if (currentSurface().flat) return;
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.drawImage(terrainLayers(colors).layers[back ? 0 : 1], 0, 0);
    context.restore();
  }

  function mapArea() {
    const { box, width, height, scale } = frame;
    const z = box.z0;
    const centre = fromScreen({ fixed: 'z', free: ['x', 'y'] }, { x: 0, y: 0, z }, width / 2, height / 2) ?? { x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2 };
    const seen = Math.max(width, height) / scale / Math.max(VIEW.map.minimumSine, Math.abs(Math.sin(view.pitch))) * VIEW.map.viewMargin;
    const side = 2 ** Math.ceil(Math.log2(Math.max(seen, box.x1 - box.x0, box.y1 - box.y0)));
    const step = side / 4;
    const x = Math.round(centre.x / step) * step;
    const y = Math.round(centre.y / step) * step;
    return { west: x - side / 2, east: x + side / 2, south: y - side / 2, north: y + side / 2 };
  }

  function drawMap(context, tiles, area) {
    const { box } = frame;
    const z = box.z0;
    context.save();
    polygon(context, [{ x: area.west, y: area.south, z }, { x: area.east, y: area.south, z }, { x: area.east, y: area.north, z }, { x: area.west, y: area.north, z }]);
    context.clip();
    context.globalAlpha *= VIEW.map.alpha;
    for (const { image, northWest, northEast, southWest } of tiles) {
      const origin = frame.project({ ...northWest, z });
      const across = frame.project({ ...northEast, z });
      const down = frame.project({ ...southWest, z });
      const size = image.naturalWidth || image.width || 256;
      context.save();
      context.transform((across.x - origin.x) / size, (across.y - origin.y) / size, (down.x - origin.x) / size, (down.y - origin.y) / size, origin.x, origin.y);
      // Half a pixel over each edge, so that neighbouring tiles leave no seam.
      context.drawImage(image, -.5, -.5, size + 1, size + 1);
      context.restore();
    }
    context.restore();
  }

  function drawNames(context, colors) {
    const list = scene.terrain?.enabled ? scene.terrain.names : [];
    if (!names() || !list?.length) return;
    const placed = [];
    context.font = '10px system-ui, sans-serif';
    context.textBaseline = 'middle';
    const sorted = [...list].sort((a, b) => LABEL_PRIORITY[a.kind] - LABEL_PRIORITY[b.kind]);
    for (const item of sorted) {
      if (placed.length >= VIEW.terrain.maximumLabels) break;
      const p = frame.project({ x: item.x, y: item.y, z: map() ? frame.box.z0 : ground(item.x, item.y) });
      const text = item.kind === 'peak' && item.elevationMetres !== null ? `${item.name} ${Math.round(item.elevationMetres)} m` : item.name;
      const width = context.measureText(text).width;
      const box = { x0: p.x - 3, x1: p.x + 7 + width, y0: p.y - 7, y1: p.y + 7 };
      const fog = terrainFog(currentSurface(), item.x, item.y);
      if (fog > .8) continue;
      if (placed.some(other => box.x0 < other.x1 && box.x1 > other.x0 && box.y0 < other.y1 && box.y1 > other.y0)) continue;
      placed.push(box);
      context.fillStyle = item.kind === 'water' ? colors.direct : colors.muted;
      context.globalAlpha = (item.kind === 'hamlet' || item.kind === 'locality' ? .6 : .85) * (1 - fog);
      if (item.kind === 'peak') {
        context.beginPath(); context.moveTo(p.x, p.y - 3); context.lineTo(p.x + 3, p.y + 2); context.lineTo(p.x - 3, p.y + 2); context.closePath(); context.fill();
      } else if (item.kind !== 'water') {
        context.beginPath(); context.arc(p.x, p.y, 1.6, 0, 2 * Math.PI); context.fill();
      }
      context.fillText(text, p.x + 6, p.y);
    }
    context.globalAlpha = 1;
    context.textBaseline = 'alphabetic';
  }

  function selectedPoints() {
    if (selection?.type === 'receiver') {
      const receiver = scene.receivers.find(item => item.id === selection.id);
      return receiver ? [placed(receiver.positionMetres)] : [];
    }
    const emitter = selection?.type === 'emitter' ? scene.emitters.find(item => item.id === selection.id) : null;
    if (!emitter || emitter.kind === 'storm' || isFieldKind(emitter)) return [];
    if (emitter.kind === 'booster') return [placed(emitter.padMetres)];
    if (isTrackKind(emitter)) return [emitter.startMetres];
    return emitter.kind === 'blast' ? [placed(emitter.positionMetres)] : [channelBase(emitter), emitter.topMetres];
  }

  function drawShadowBoundary(context, colors) {
    const profile = soundSpeedProfile(scene.air);
    const receiver = focus?.();
    const leastGradient = profile.gradient - (profile.shear ? Math.hypot(profile.shear.x, profile.shear.y) : 0);
    if (!(leastGradient < 0) || !receiver) return;
    const chosen = selection?.type === 'emitter' ? scene.emitters.filter(emitter => emitter.id === selection.id) : scene.emitters.filter(emitter => emitter.enabled);
    const pointSets = chosen.map(emitterPoints);
    const points = pointSets.flat();
    if (!points.length) return;
    const key = `${pointsKey(pointSets)}|${JSON.stringify(scene.air)}|${receiver.positionMetres.z}`;
    if (!currentSurface().flat) {
      drawTerrainShadowBoundary(context, colors, profile, points, receiver.positionMetres.z, key);
      return;
    }
    if (shadowOutline?.key !== key) {
      const stride = Math.ceil(points.length / VIEW.shadowBoundary.points);
      const height = receiver.positionMetres.z;
      const rings = [];
      for (let index = 0; index < points.length; index += stride) {
        const point = points[index];
        rings.push(OUTLINE_DIRECTIONS.map(({ cos, sin }) => {
          const along = pathProfile(profile, point, { x: point.x + cos, y: point.y + sin, z: height });
          const radius = Math.min(2 * RENDER.sceneExtentMetres, grazingRange(along, point.z) + grazingRange(along, height));
          return { x: point.x + radius * cos, y: point.y + radius * sin };
        }));
      }
      shadowOutline = { key, rings };
    }
    const layerKey = `${frame.key}|${canvas.width}|${canvas.height}|${colors.muted}`;
    if (shadowOutline.layerKey !== layerKey) {
      const origin = frame.project({ x: 0, y: 0, z: 0 });
      const east = frame.project({ x: 1, y: 0, z: 0 });
      const north = frame.project({ x: 0, y: 1, z: 0 });
      const toScreen = ({ x, y }) => ({ x: origin.x + x * (east.x - origin.x) + y * (north.x - origin.x), y: origin.y + x * (east.y - origin.y) + y * (north.y - origin.y) });
      const path = new Path2D();
      const bounds = emptyBounds();
      for (const ring of shadowOutline.rings) addPolygon(path, ring.map(toScreen), bounds);
      shadowLayer = sized(shadowLayer);
      const paint = shadowLayer.getContext('2d');
      paint.setTransform(context.getTransform());
      paint.save();
      paint.clip(floorPath());
      unionOutline(paint, path, colors.muted, { fillAlpha: 0, edgeAlpha: VIEW.shadowBoundary.edgeAlpha, bounds });
      paint.restore();
      shadowOutline.layerKey = layerKey;
    }
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.drawImage(shadowLayer, 0, 0);
    context.restore();
  }

  function drawTerrainShadowBoundary(context, colors, profile, points, heightAboveGround, sourcesKey) {
    const { box } = frame;
    const surface = currentSurface();
    const key = [sourcesKey, box.x0, box.x1, box.y0, box.y1].join('|');
    if (terrainBoundary?.key !== key || terrainBoundary.surface !== surface) {
      const stride = Math.ceil(points.length / VIEW.shadowBoundary.terrainSources);
      const sampled = points.filter((_, index) => index % stride === 0);
      const lit = new Uint8Array(VIEW.shadowBoundary.terrainCells * VIEW.shadowBoundary.terrainCells);
      const width = (box.x1 - box.x0) / VIEW.shadowBoundary.terrainCells;
      const depth = (box.y1 - box.y0) / VIEW.shadowBoundary.terrainCells;
      for (let row = 0; row < VIEW.shadowBoundary.terrainCells; row += 1) {
        for (let column = 0; column < VIEW.shadowBoundary.terrainCells; column += 1) {
          const x = box.x0 + (column + .5) * width;
          const y = box.y0 + (row + .5) * depth;
          const receiver = { x, y, z: ground(x, y) + heightAboveGround };
          lit[row * VIEW.shadowBoundary.terrainCells + column] = sampled.some(point => {
            const plane = meanPlaneFrame(pathProfile(profile, point, receiver), ground, point, receiver, VIEW.shadowBoundary.planeSamples);
            return !inShadow(plane.profile, plane.from, plane.to);
          }) ? 1 : 0;
        }
      }
      terrainBoundary = { key, surface, lit, width, depth };
    }
    const { lit, width, depth } = terrainBoundary;
    if (lit.every(Boolean)) return;
    const path = new Path2D();
    const bounds = emptyBounds();
    for (let row = 0; row < VIEW.shadowBoundary.terrainCells; row += 1) {
      for (let column = 0; column < VIEW.shadowBoundary.terrainCells; column += 1) {
        if (!lit[row * VIEW.shadowBoundary.terrainCells + column]) continue;
        const x0 = box.x0 + column * width;
        const y0 = box.y0 + row * depth;
        addPolygon(path, [[x0, y0], [x0 + width, y0], [x0 + width, y0 + depth], [x0, y0 + depth]].map(([x, y]) => frame.project({ x, y, z: ground(x, y) })), bounds);
      }
    }
    unionOutline(context, path, colors.muted, { fillAlpha: 0, edgeAlpha: VIEW.shadowBoundary.edgeAlpha, bounds });
  }

  function drawWavefronts(context, colors, { profile, spheres, total }) {
    // A flash is dropped whole: dropping a single sphere would uncover the edges it hides.
    const { box } = frame;
    const innermost = (VIEW.wavefront.rippleAlphas.length - 1) * rippleSpacing();
    const terrain = currentSurface().bounds;
    const bounds = terrain ? { x0: Math.min(box.x0, terrain.west), x1: Math.max(box.x1, terrain.east), y0: Math.min(box.y0, terrain.south), y1: Math.max(box.y1, terrain.north) } : box;
    const terrainStride = Math.max(1, Math.ceil(total / VIEW.wavefront.terrainSpheres));
    const groups = new Map();
    const passed = new Set();
    for (const sphere of spheres) {
      const { centre, radiusMetres } = sphere;
      const farthest = Math.hypot(Math.max(centre.x - bounds.x0, bounds.x1 - centre.x), Math.max(centre.y - bounds.y0, bounds.y1 - centre.y), Math.max(centre.z - box.z0, box.z1 - centre.z));
      if (radiusMetres - innermost > farthest) passed.add(sphere.group);
      if (!groups.has(sphere.group)) groups.set(sphere.group, []);
      groups.get(sphere.group).push(sphere);
    }
    for (const group of passed) groups.delete(group);
    const strength = group => Math.max(0, ...group.map(sphere => sphere.strength ?? 1));
    const drawn = [...groups.values()].sort((a, b) => strength(b) - strength(a)).slice(0, VIEW.wavefront.groups);
    for (const group of drawn) drawFronts(context, colors, profile, group, terrainStride);
  }

  const rippleSpacing = () => Math.max(frame.box.x1 - frame.box.x0, frame.box.y1 - frame.box.y0, frame.box.z1) * VIEW.wavefront.rippleSpacingShare;

  function drawFronts(context, colors, profile, spheres, terrainStride) {
    const strength = Math.max(0, ...spheres.map(sphere => sphere.strength ?? 1));
    if (!(strength > 0)) return;
    const { box, farX, farY } = frame;
    const faces = [
      ...(currentSurface().flat ? [{ fixed: 'z', value: 0, axes: ['x', 'y'], corners: [[box.x0, box.y0], [box.x1, box.y0], [box.x1, box.y1], [box.x0, box.y1]] }] : []),
      { fixed: 'x', value: farX, axes: ['y', 'z'], corners: [[box.y0, 0], [box.y1, 0], [box.y1, box.z1], [box.y0, box.z1]] },
      { fixed: 'y', value: farY, axes: ['x', 'z'], corners: [[box.x0, 0], [box.x1, 0], [box.x1, box.z1], [box.x0, box.z1]] }
    ];
    const spacing = rippleSpacing();
    if (!currentSurface().flat) drawTerrainRipples(context, colors, spheres.filter(sphere => sphere.order % terrainStride === 0), spacing, strength);
    for (const face of faces) {
      const [u, v] = face.axes;
      const at = (a, b) => frame.project({ [face.fixed]: face.value, [u]: a, [v]: b });
      const origin = at(0, 0);
      const alongU = at(1, 0);
      const alongV = at(0, 1);
      const ux = alongU.x - origin.x; const uy = alongU.y - origin.y;
      const vx = alongV.x - origin.x; const vy = alongV.y - origin.y;
      const place = (a, b) => ({ x: origin.x + a * ux + b * vx, y: origin.y + a * uy + b * vy });
      const outline = new Path2D();
      addPolygon(outline, face.corners.map(([a, b]) => place(a, b)));
      context.save();
      context.clip(outline);
      VIEW.wavefront.rippleAlphas.forEach((alpha, ring) => {
        if (alpha * strength < VIEW.wavefront.visibleAlpha) return;
        const parts = [{ circles: [], alpha: alpha * strength }, { circles: [], alpha: alpha * strength * VIEW.wavefront.shadowShare }];
        for (const { source, centre, radiusMetres } of spheres) {
          const sphere = radiusMetres - ring * spacing;
          const offset = face.value - centre[face.fixed];
          if (!(sphere > Math.abs(offset))) continue;
          const radius = Math.sqrt(sphere ** 2 - offset ** 2);
          if (!(radius > 0)) continue;
          parts[face.fixed === 'z' && profile.gradient < 0 && radius > grazingRange(profile, source.z) ? 1 : 0].circles.push({ u: centre[u], v: centre[v], radius });
        }
        for (const part of parts) {
          if (!part.circles.length || part.alpha < VIEW.wavefront.visibleAlpha) continue;
          if (part.circles.some(circle => face.corners.every(([a, b]) => Math.hypot(a - circle.u, b - circle.v) <= circle.radius))) continue;
          strokeUnion(context, outerCircles(part.circles), [ux, uy, vx, vy, origin.x, origin.y], colors.glow, part.alpha);
        }
      });
      context.restore();
    }
  }

  function strokeUnion(context, circles, mapping, color, alpha) {
    context.save();
    context.transform(...mapping);
    context.beginPath();
    for (const [{ u, v, radius }, from, to] of unionArcs(circles)) {
      context.moveTo(u + radius * Math.cos(from), v + radius * Math.sin(from));
      context.arc(u, v, radius, from, to);
    }
    context.restore();
    context.lineWidth = VIEW.box.outlinePixels;
    context.lineCap = 'round';
    context.strokeStyle = color;
    context.globalAlpha = alpha;
    context.stroke();
    context.globalAlpha = 1;
  }

  function drawTerrainRipples(context, colors, spheres, spacing, strength = 1) {
    const rings = VIEW.wavefront.rippleAlphas.map((alpha, ring) => {
      if (alpha * strength < VIEW.wavefront.visibleAlpha) return null;
      const path = new Path2D();
      const bounds = emptyBounds();
      let any = false;
      for (const { centre, radiusMetres } of spheres) {
        const radius = radiusMetres - ring * spacing;
        if (!(radius > 0)) continue;
        const points = [];
        for (const { cos, sin } of OUTLINE_DIRECTIONS) {
          const excess = distance => distance * distance + (ground(centre.x + distance * cos, centre.y + distance * sin) - centre.z) ** 2 - radius * radius;
          if (excess(0) > 0) continue;
          let low = 0;
          let high = radius;
          for (let iteration = 0; iteration < TERRAIN_RIPPLE_ITERATIONS; iteration += 1) {
            const middle = (low + high) / 2;
            if (excess(middle) > 0) high = middle; else low = middle;
          }
          const distance = (low + high) / 2;
          const x = centre.x + distance * cos;
          const y = centre.y + distance * sin;
          points.push(frame.project({ x, y, z: ground(x, y) }));
        }
        if (points.length < OUTLINE_STEPS) continue;
        any = true;
        addPolygon(path, points, bounds);
      }
      return any ? { path, bounds, alpha } : null;
    }).filter(Boolean);
    if (!rings.length) return;
    const ratio = window.devicePixelRatio || 1;
    const area = rings.reduce((all, { bounds }) => ({ x0: Math.min(all.x0, bounds.x0), y0: Math.min(all.y0, bounds.y0), x1: Math.max(all.x1, bounds.x1), y1: Math.max(all.y1, bounds.y1) }), emptyBounds());
    const reach = (VIEW.box.outlinePixels * 2 + VIEW.box.seamPixels) * ratio + 2;
    const x0 = Math.max(0, Math.floor(area.x0 * ratio - reach));
    const y0 = Math.max(0, Math.floor(area.y0 * ratio - reach));
    const width = Math.min(canvas.width, Math.ceil(area.x1 * ratio + reach)) - x0;
    const height = Math.min(canvas.height, Math.ceil(area.y1 * ratio + reach)) - y0;
    if (!(width > 0 && height > 0)) return;
    rippleLayer ??= document.createElement('canvas');
    if (rippleLayer.width !== canvas.width || rippleLayer.height !== canvas.height) {
      rippleLayer.width = canvas.width;
      rippleLayer.height = canvas.height;
    }
    const paint = rippleLayer.getContext('2d');
    paint.setTransform(1, 0, 0, 1, 0, 0);
    paint.globalCompositeOperation = 'source-over';
    paint.clearRect(x0, y0, width, height);
    paint.setTransform(ratio, 0, 0, ratio, 0, 0);
    for (const { path, bounds, alpha } of rings) unionOutline(paint, path, colors.glow, { fillAlpha: 0, edgeAlpha: alpha * strength, bounds });
    paint.setTransform(1, 0, 0, 1, 0, 0);
    paint.globalCompositeOperation = 'destination-in';
    paint.drawImage(terrainLayers(colors).layers[2], x0, y0, width, height, x0, y0, width, height);
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.drawImage(rippleLayer, x0, y0, width, height, x0, y0, width, height);
    context.restore();
  }

  function drawProjectionLines(context, colors, point) {
    const { farX, farY } = frame;
    const floor = { ...point, z: ground(point.x, point.y) };
    const line = points => {
      context.beginPath();
      points.map(frame.project).forEach((p, index) => (index ? context.lineTo(p.x, p.y) : context.moveTo(p.x, p.y)));
      context.stroke();
    };
    context.save();
    context.setLineDash([3, 4]);
    context.lineWidth = 1;
    context.strokeStyle = colors.receiver;
    context.globalAlpha = .45;
    line([point, floor]);
    line([floor, { ...floor, x: farX }, { ...point, x: farX }]);
    line([floor, { ...floor, y: farY }, { ...point, y: farY }]);
    context.restore();
  }

  function drawStorm(context, emitter, colors, selected) {
    const { x, y } = emitter.centreMetres;
    const ring = z => Array.from({ length: DISC_POINTS }, (_, index) => {
      const angle = 2 * Math.PI * index / DISC_POINTS;
      return { x: x + emitter.radiusMetres * Math.cos(angle), y: y + emitter.radiusMetres * Math.sin(angle), z };
    });
    if (!clouds()) {
      context.fillStyle = colors.cloud;
      polygon(context, ring(emitter.cloudBaseMetres)); context.fill();
      polygon(context, ring(emitter.cloudTopMetres)); context.fill();
    }
    context.strokeStyle = selected ? colors.accent : colors.lightning;
    context.lineWidth = selected ? 1.4 : 1.2;
    polygon(context, ring(0).map(point => ({ ...point, z: ground(point.x, point.y) }))); context.stroke();
  }

  function cloudPuffs(emitter) {
    const random = createRandom(emitter.seed ^ 0x5c10d);
    const { x, y } = emitter.centreMetres;
    const base = emitter.cloudBaseMetres;
    const depth = emitter.cloudTopMetres - base;
    return Array.from({ length: VIEW.cloud.puffs }, () => {
      const share = random() ** 1.4;
      const reach = emitter.radiusMetres * (.75 + VIEW.cloud.anvilSpread * share ** 4);
      const angle = 2 * Math.PI * random();
      const distance = reach * Math.sqrt(random());
      return {
        centre: { x: x + distance * Math.cos(angle), y: y + distance * Math.sin(angle), z: base + depth * share },
        radius: Math.max(depth * (.22 + .22 * random()), emitter.radiusMetres * .18),
        share
      };
    });
  }

  function drawCloud(context, emitter, colors) {
    const key = [view.yaw, view.pitch, view.zoom, view.panU, view.panV, canvas.width, canvas.height, emitter.seed, emitter.centreMetres.x, emitter.centreMetres.y, emitter.radiusMetres, emitter.cloudBaseMetres, emitter.cloudTopMetres, colors['storm-base'], colors['storm-top'], frame.box.x0, frame.box.x1, frame.box.z1].join('|');
    let layer = cloudLayers.get(emitter.id);
    if (layer?.key !== key) {
      const canvasLayer = sized(layer?.canvas);
      const paint = canvasLayer.getContext('2d');
      const ratio = window.devicePixelRatio || 1;
      paint.setTransform(ratio, 0, 0, ratio, 0, 0);
      const dark = rgb(colors['storm-base']);
      const light = rgb(colors['storm-top']);
      const puffs = cloudPuffs(emitter).map(puff => {
        const p = frame.project(puff.centre);
        const edge = frame.project({ ...puff.centre, z: puff.centre.z + puff.radius });
        return { ...puff, p, size: Math.hypot(edge.x - p.x, edge.y - p.y) };
      }).sort((a, b) => b.p.depth - a.p.depth);
      for (const { p, size, share } of puffs) {
        const [r, g, b] = mixColors(dark, light, share ** 1.5);
        const gradient = paint.createRadialGradient(p.x, p.y, 0, p.x, p.y, size);
        gradient.addColorStop(0, `rgba(${r},${g},${b},${VIEW.cloud.puffAlpha})`);
        gradient.addColorStop(.6, `rgba(${r},${g},${b},${VIEW.cloud.puffAlpha * .5})`);
        gradient.addColorStop(1, `rgba(${r},${g},${b},0)`);
        paint.fillStyle = gradient;
        paint.beginPath();
        paint.arc(p.x, p.y, size, 0, 2 * Math.PI);
        paint.fill();
      }
      layer = { key, canvas: canvasLayer };
      cloudLayers.set(emitter.id, layer);
    }
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.drawImage(layer.canvas, 0, 0);
    context.restore();
  }

  function drawCloudLight(context, emitter, colors, strokes) {
    const layer = cloudLayers.get(emitter.id);
    if (!layer || !strokes?.length) return;
    const flashes = cachedFlashes(emitter);
    const depth = emitter.cloudTopMetres - emitter.cloudBaseMetres;
    cloudLight = { light: sized(cloudLight?.light), mask: sized(cloudLight?.mask) };
    const { light, mask } = cloudLight;
    const ratio = window.devicePixelRatio || 1;
    const glow = light.getContext('2d');
    glow.setTransform(ratio, 0, 0, ratio, 0, 0);
    glow.globalCompositeOperation = 'lighter';
    const [r, g, b] = rgb(colors.flash);
    let lit = false;
    for (const stroke of strokes) {
      const flash = flashes[stroke.flash];
      if (!flash) continue;
      const fade = stroke.elapsed > VIEW.flash.traverseSeconds ? Math.exp(-(stroke.elapsed - VIEW.flash.traverseSeconds) / VIEW.flash.fadeSeconds) : 1;
      const intensity = VIEW.cloud.flashAlpha * fade * flicker(emitter.seed + stroke.flash * 7919, stroke.elapsed);
      if (intensity < .01) continue;
      const routeLength = Math.max(...stroke.route.map(step => step.offsetMetres + flash.channels[step.channel].arcs.at(-1) - step.fromArc));
      const inCloud = stroke.route.flatMap(step => {
        const reached = frontArc(step, stroke.elapsed, routeLength);
        return reached > step.fromArc ? pointsUpTo(flash.channels[step.channel], step.fromArc, reached) : [];
      }).filter(point => point.z >= emitter.cloudBaseMetres);
      const along = inCloud.length ? inCloud : [flash.channels[0].points.at(-1)];
      const random = createRandom((emitter.seed ^ Math.imul(stroke.flash + 1, 0x27d4eb2d)) >>> 0);
      for (let blob = 0; blob < VIEW.cloud.flashBlobs; blob += 1) {
        const at = along[Math.min(along.length - 1, Math.floor((blob + random()) / VIEW.cloud.flashBlobs * along.length))];
        const offset = depth * VIEW.cloud.blobScatter;
        const centre = { x: at.x + offset * (random() - .5), y: at.y + offset * (random() - .5), z: at.z + offset * (random() - .5) };
        const p = frame.project(centre);
        const edge = frame.project({ ...centre, z: centre.z + depth * VIEW.cloud.flashReach * (.6 + .8 * random()) });
        const size = Math.hypot(edge.x - p.x, edge.y - p.y);
        const gradient = glow.createRadialGradient(p.x, p.y, 0, p.x, p.y, size);
        const alpha = intensity / VIEW.cloud.flashBlobs * 2.2;
        gradient.addColorStop(0, `rgba(${r},${g},${b},${alpha})`);
        gradient.addColorStop(.45, `rgba(${r},${g},${b},${alpha * .45})`);
        gradient.addColorStop(1, `rgba(${r},${g},${b},0)`);
        glow.fillStyle = gradient;
        glow.beginPath();
        glow.arc(p.x, p.y, size, 0, 2 * Math.PI);
        glow.fill();
        lit = true;
      }
    }
    if (!lit) return;
    const shape = mask.getContext('2d');
    shape.drawImage(layer.canvas, 0, 0);
    shape.globalCompositeOperation = 'source-in';
    shape.drawImage(light, 0, 0);
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalCompositeOperation = 'lighter';
    context.drawImage(mask, 0, 0);
    context.restore();
  }

  function drawBlast(context, emitter, colors, state) {
    const stroke = state?.strokes.get(emitter.id)?.[0];
    if (stroke) drawBurst(context, frame.project(placed(emitter.positionMetres)), stroke, colors);
  }

  function drawBarrage(context, emitter, colors, selected, state) {
    const { x, y } = emitter.centreMetres;
    context.strokeStyle = selected ? colors.accent : colors.end;
    context.lineWidth = selected ? 1.4 : 1.2;
    polygon(context, Array.from({ length: DISC_POINTS }, (_, index) => {
      const angle = 2 * Math.PI * index / DISC_POINTS;
      const px = x + emitter.radiusMetres * Math.cos(angle);
      const py = y + emitter.radiusMetres * Math.sin(angle);
      return { x: px, y: py, z: ground(px, py) };
    }));
    context.stroke();
    context.fillStyle = colors.end;
    const alpha = context.globalAlpha;
    context.globalAlpha = alpha * .5;
    const rounds = cachedRounds(emitter, scene.air);
    for (const round of rounds) {
      const p = frame.project(placed(round.positionMetres));
      context.beginPath(); context.arc(p.x, p.y, 1.5, 0, 2 * Math.PI); context.fill();
    }
    if (emitter.kind === 'fireworks') {
      context.lineWidth = .8;
      const mortars = new Map(rounds.filter(round => round.id.endsWith(':thump')).map(round => [round.id.slice(0, -':thump'.length), round]));
      context.beginPath();
      for (const round of rounds) {
        const mortar = round.id.endsWith(':burst') ? mortars.get(round.id.slice(0, -':burst'.length)) : null;
        if (!mortar) continue;
        const from = frame.project(placed(mortar.positionMetres));
        const to = frame.project(placed(round.positionMetres));
        context.moveTo(from.x, from.y); context.lineTo(to.x, to.y);
      }
      context.stroke();
    }
    context.globalAlpha = alpha;
    for (const stroke of state?.strokes.get(emitter.id) ?? []) {
      if (stroke.shell === null || stroke.shell === undefined) {
        drawBurst(context, frame.project(placed(stroke.position)), stroke, colors);
        continue;
      }
      const color = colors.fireworks[stroke.shell % colors.fireworks.length];
      drawStars(context, placed(stroke.position), stroke, color);
      drawBurst(context, frame.project(placed(stroke.position)), stroke, colors, color);
    }
  }

  function drawStars(context, centre, stroke, color) {
    const { stars, burnSeconds } = VIEW.fireworks;
    const t = stroke.elapsed;
    if (t >= burnSeconds) return;
    const pull = airDensityKilogramsPerCubicMetre(scene.air.pressureKpa * 1000, scene.air.temperatureCelsius) / (2 * FIREWORKS.starKilogramsPerSquareMetre);
    const reach = Math.log1p(pull * FIREWORKS.starMetresPerSecond * t) / pull;
    const sag = STANDARD_GRAVITY_METRES_PER_SECOND_SQUARED * t * t / 2;
    const turn = stroke.shell / 0x100000000 * 2 * Math.PI;
    const alpha = context.globalAlpha;
    context.globalAlpha = alpha * (1 - t / burnSeconds) ** 1.5;
    context.fillStyle = color;
    context.beginPath();
    for (let star = 0; star < stars; star += 1) {
      const up = 1 - 2 * (star + .5) / stars;
      const around = turn + star * Math.PI * (3 - Math.sqrt(5));
      const across = Math.sqrt(1 - up * up);
      const p = frame.project({ x: centre.x + reach * across * Math.cos(around), y: centre.y + reach * across * Math.sin(around), z: centre.z + reach * up - sag });
      context.moveTo(p.x + 1.6, p.y);
      context.arc(p.x, p.y, 1.6, 0, 2 * Math.PI);
    }
    context.fill();
    context.globalAlpha = alpha;
  }

  function drawFlight(context, emitter, colors, selected, state) {
    context.strokeStyle = selected ? colors.accent : colors.end;
    context.lineWidth = selected ? 1.4 : 1.2;
    for (const path of cachedTracks(emitter, scene.air)) {
      context.beginPath();
      for (let index = 0; index < path.x.length; index += 1) {
        const p = frame.project({ x: path.x[index], y: path.y[index], z: path.z[index] });
        if (index === 0) context.moveTo(p.x, p.y); else context.lineTo(p.x, p.y);
      }
      context.stroke();
    }
    for (const body of state?.flights?.get(emitter.id) ?? []) {
      const p = frame.project(body);
      context.fillStyle = colors.flash;
      context.shadowColor = colors.glow;
      context.shadowBlur = 12;
      context.beginPath(); context.arc(p.x, p.y, 5, 0, 2 * Math.PI); context.fill();
      context.shadowBlur = 0;
    }
    for (const stroke of state?.strokes.get(emitter.id) ?? []) drawBurst(context, frame.project(stroke.position), stroke, colors);
  }

  function drawCones(context, cones, colors) {
    const { box } = frame;
    const terrain = currentSurface().bounds;
    const low = { x: Math.min(box.x0, terrain?.west ?? box.x0), y: Math.min(box.y0, terrain?.south ?? box.y0), z: box.z0 };
    const high = { x: Math.max(box.x1, terrain?.east ?? box.x1), y: Math.max(box.y1, terrain?.north ?? box.y1), z: box.z1 };
    const highest = currentSurface().highestMetres;
    const levels = Array.from({ length: VIEW.cone.levels }, () => new Path2D());
    let path = null;
    let from = 0;
    let to = 1;
    const within = (start, delta, minimum, maximum) => {
      if (delta === 0) return start >= minimum && start <= maximum;
      const t0 = (minimum - start) / delta;
      const t1 = (maximum - start) / delta;
      from = Math.max(from, Math.min(t0, t1));
      to = Math.min(to, Math.max(t0, t1));
      return true;
    };
    const draw = (p, q, start, end) => {
      path.moveTo(p.x + (q.x - p.x) * start, p.y + (q.y - p.y) * start);
      path.lineTo(p.x + (q.x - p.x) * end, p.y + (q.y - p.y) * end);
    };
    const line = (a, b, p, q) => {
      from = 0;
      to = 1;
      if (!within(a.x, b.x - a.x, low.x, high.x) || !within(a.y, b.y - a.y, low.y, high.y) || !within(a.z, b.z - a.z, low.z, high.z)) return;
      if (!(to > from)) return;
      if (Math.min(a.z + (b.z - a.z) * from, a.z + (b.z - a.z) * to) > highest) { draw(p, q, from, to); return; }
      for (let piece = 0; piece < VIEW.cone.pieces; piece += 1) {
        const start = from + (to - from) * piece / VIEW.cone.pieces;
        const end = from + (to - from) * (piece + 1) / VIEW.cone.pieces;
        const t = (start + end) / 2;
        if (a.z + (b.z - a.z) * t < ground(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)) continue;
        draw(p, q, start, end);
      }
    };
    for (const { apex, rings, strengths } of cones) {
      const screen = rings.map(ring => ring.map(frame.project));
      const apexScreen = apex && frame.project(apex);
      rings.forEach((ring, index) => {
        const strength = strengths?.[index] ?? 1;
        if (!(strength > 0)) return;
        path = levels[Math.min(VIEW.cone.levels, Math.ceil(strength * VIEW.cone.levels)) - 1];
        const points = screen[index];
        ring.forEach((point, step) => {
          const next = (step + 1) % ring.length;
          line(point, ring[next], points[step], points[next]);
          if (step % VIEW.cone.lineEvery) return;
          if (index) line(rings[index - 1][step], point, screen[index - 1][step], points[step]);
          else if (apex) line(apex, point, apexScreen, points[step]);
        });
      });
    }
    const alpha = context.globalAlpha;
    context.strokeStyle = colors.glow;
    context.lineWidth = 1;
    levels.forEach((level, index) => {
      context.globalAlpha = alpha * VIEW.cone.alpha * (index + 1) / VIEW.cone.levels;
      context.stroke(level);
    });
    context.globalAlpha = alpha;
  }

  function drawBurst(context, centre, stroke, colors, glow = colors.glow) {
    const alpha = context.globalAlpha;
    const level = Math.exp(-stroke.elapsed / VIEW.flash.fadeSeconds);
    context.fillStyle = colors.flash;
    context.shadowColor = glow;
    context.shadowBlur = 30 * level;
    context.globalAlpha = alpha * level;
    context.beginPath(); context.arc(centre.x, centre.y, 4 + 12 * level, 0, 2 * Math.PI); context.fill();
    context.shadowBlur = 0;
    context.globalAlpha = alpha;
  }

  function drawHandle(context, handle, colors, selected, usable) {
    const shadowPlanes = handle.ownPlaneOnly ? [] : planes().filter(plane => usable.has(plane.name) && !(handle.onGround && plane.fixed === 'z'));
    const shadowColor = handle.role === 'receiver' ? colors.receiver : colors.end;
    context.globalAlpha *= selected ? .7 : .4;
    for (const plane of shadowPlanes) {
      const p = frame.project(onPlane(handle.point, plane));
      context.fillStyle = shadowColor;
      context.beginPath(); context.arc(p.x, p.y, 2.5, 0, 2 * Math.PI); context.fill();
    }
    context.globalAlpha /= selected ? .7 : .4;
    const p = frame.project(handle.point);
    context.lineWidth = selected ? 2 : 1.5;
    context.beginPath();
    if (handle.role === 'receiver') {
      context.arc(p.x, p.y, VIEW.box.microphoneRadius, 0, 2 * Math.PI);
      context.fillStyle = colors.receiver;
      context.fill();
      context.fillStyle = colors.panel;
      context.beginPath(); context.arc(p.x, p.y, VIEW.box.microphoneRadius * .4, 0, 2 * Math.PI); context.fill();
      if (selected) {
        context.strokeStyle = colors.accent;
        context.beginPath(); context.arc(p.x, p.y, VIEW.box.microphoneRadius + 1.5, 0, 2 * Math.PI); context.stroke();
      }
      return;
    }
    if (handle.role === 'facing') {
      const owner = scene.receivers.find(receiver => receiver.id === handle.id);
      const base = frame.project(placed(owner.positionMetres));
      const angle = Math.atan2(p.y - base.y, p.x - base.x);
      const size = VIEW.box.arrowheadPixels;
      context.moveTo(p.x + Math.cos(angle) * size * .6, p.y + Math.sin(angle) * size * .6);
      context.lineTo(p.x + Math.cos(angle + 2.5) * size, p.y + Math.sin(angle + 2.5) * size);
      context.lineTo(p.x + Math.cos(angle - 2.5) * size, p.y + Math.sin(angle - 2.5) * size);
      context.closePath();
      context.fillStyle = selected ? colors.accent : colors.receiver;
      context.fill();
      return;
    }
    if (handle.role === 'level') {
      context.arc(p.x, p.y, VIEW.box.handleRadius - 1, 0, 2 * Math.PI);
      context.fillStyle = colors['cloud-handle'];
      context.fill();
      if (selected) {
        context.strokeStyle = colors.accent;
        context.beginPath(); context.arc(p.x, p.y, VIEW.box.handleRadius + 1, 0, 2 * Math.PI); context.stroke();
      }
      return;
    }
    const radius = handle.role === 'radius' ? VIEW.box.handleRadius - 1.5 : VIEW.box.handleRadius;
    context.arc(p.x, p.y, radius, 0, 2 * Math.PI);
    if (handle.role === 'end') {
      context.fillStyle = colors.end;
      context.fill();
      context.strokeStyle = selected ? colors.accent : colors.end;
      context.stroke();
    } else if (handle.role === 'radius') {
      context.strokeStyle = selected ? colors.accent : colors.end;
      context.stroke();
    } else {
      context.fillStyle = colors.start;
      context.fill();
      context.strokeStyle = selected ? colors.accent : colors.end;
      context.stroke();
    }
  }

  // Resized only when the view's size changes: setting a canvas's size allocates its pixels again.
  function sized(layer) {
    layer ??= document.createElement('canvas');
    if (layer.width !== canvas.width || layer.height !== canvas.height) {
      layer.width = canvas.width;
      layer.height = canvas.height;
      return layer;
    }
    const paint = layer.getContext('2d');
    paint.setTransform(1, 0, 0, 1, 0, 0);
    paint.globalCompositeOperation = 'source-over';
    paint.globalAlpha = 1;
    paint.clearRect(0, 0, layer.width, layer.height);
    return layer;
  }

  let draws = 0;
  let drawRequested = false;

  function requestDraw() {
    if (drawRequested) return;
    drawRequested = true;
    const since = draws;
    requestAnimationFrame(() => {
      drawRequested = false;
      if (draws === since) draw();
    });
  }

  function draw() {
    if (!scene) return;
    draws += 1;
    const { context, width, height } = fitCanvas(canvas);
    const colors = palette();
    if (!drag || !frame) frame = computeFrame(width, height);
    const state = animation?.() ?? null;
    const usable = new Set(planes().filter(planeUsable).map(plane => plane.name));

    const area = map() ? mapArea() : null;
    const mapTiles = area ? loadMapTiles(area) : null;
    if (!mapTiles) drawTerrain(context, colors, true);
    if (mapTiles) drawMap(context, mapTiles, area);
    drawBox(context, colors);
    if (mapTiles) drawMap(context, mapTiles, { west: frame.box.x0, east: frame.box.x1, south: frame.box.y0, north: frame.box.y1 });
    else drawTerrain(context, colors, false);
    drawBoxLabels(context, colors);
    drawNames(context, colors);
    drawShadowBoundary(context, colors);
    if (state?.wavefronts) drawWavefronts(context, colors, state.wavefronts);
    if (state?.cones.length) drawCones(context, state.cones, colors);
    for (const emitter of scene.emitters) {
      const selected = selection?.type === 'emitter' && selection.id === emitter.id;
      context.globalAlpha = emitter.enabled ? 1 : .35;
      if (emitter.kind === 'storm') drawStorm(context, emitter, colors, selected);
      if (emitter.kind === 'blast') drawBlast(context, emitter, colors, state);
      else if (isFieldKind(emitter)) drawBarrage(context, emitter, colors, selected, state);
      else if (isTrackKind(emitter)) drawFlight(context, emitter, colors, selected, state);
      else {
        drawChannels(context, emitter, colors, selected, state?.strokes.get(emitter.id));
        if (state?.sound && emitter.enabled) drawSoundGlow(context, emitter, colors, state.sound);
      }
      context.globalAlpha = 1;
    }
    if (clouds()) {
      for (const emitter of scene.emitters) {
        if (emitter.kind !== 'storm' || !emitter.enabled) continue;
        drawCloud(context, emitter, colors);
        drawCloudLight(context, emitter, colors, state?.strokes.get(emitter.id));
      }
    }
    for (const point of selectedPoints()) drawProjectionLines(context, colors, point);
    for (const receiver of scene.receivers) {
      const level = state?.receivers.get(receiver.id) ?? 0;
      if (level > 0) {
        const p = frame.project(placed(receiver.positionMetres));
        context.fillStyle = receiver.listen ? colors.accent : colors.muted;
        context.globalAlpha = (receiver.listen ? 1 : .5) * (.2 + .5 * level);
        context.beginPath(); context.arc(p.x, p.y, 6 + 14 * level, 0, 2 * Math.PI); context.fill();
        context.globalAlpha = 1;
      }
    }
    context.strokeStyle = colors.receiver;
    context.lineWidth = 1.5;
    for (const receiver of scene.receivers) {
      if (receiver.type !== 'binaural') continue;
      const a = frame.project(placed(receiver.positionMetres));
      const b = frame.project(facingTip(receiver, frame.box));
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      if (length <= VIEW.box.microphoneRadius) continue;
      const ux = (b.x - a.x) / length;
      const uy = (b.y - a.y) / length;
      context.globalAlpha = receiver.listen ? 1 : .35;
      context.beginPath(); context.moveTo(a.x + ux * VIEW.box.microphoneRadius, a.y + uy * VIEW.box.microphoneRadius); context.lineTo(b.x, b.y); context.stroke();
    }
    context.globalAlpha = 1;
    for (const handle of handles(scene, frame.box)) {
      const selected = selection?.type === handle.type && selection.id === handle.id;
      const owner = handle.type === 'emitter' ? scene.emitters.find(emitter => emitter.id === handle.id) : null;
      context.globalAlpha = (owner && !owner.enabled) || handle.listening === false ? .35 : 1;
      drawHandle(context, handle, colors, selected, usable);
      context.globalAlpha = 1;
    }
    context.font = '11px system-ui, sans-serif';
    context.fillStyle = colors.faint;
    for (const emitter of scene.emitters) {
      const anchor = emitter.kind === 'blast' ? placed(emitter.positionMetres) : emitter.kind === 'storm' || isFieldKind(emitter) ? placed(emitter.centreMetres)
        : emitter.kind === 'booster' ? placed(emitter.padMetres) : isTrackKind(emitter) ? emitter.startMetres : emitter.topMetres;
      const p = frame.project(anchor);
      context.fillText(emitter.name, p.x + 9, p.y - 8);
    }
    for (const receiver of scene.receivers) {
      const p = frame.project(placed(receiver.positionMetres));
      context.fillText(receiver.name, p.x + 9, p.y - 8);
    }
  }

  function hit(x, y) {
    let best = null;
    const usable = planes().filter(planeUsable);
    for (const handle of handles(scene, frame.box)) {
      if (handle.verticalOnly) {
        const p = frame.project(handle.point);
        const distance = Math.hypot(p.x - x, p.y - y);
        if (distance <= VIEW.box.hitRadius && (!best || distance < best.distance)) best = { ...handle, plane: verticalPlane(handle.point), distance };
        continue;
      }
      const candidates = [{ point: handle.point, plane: { name: 'own', fixed: 'z', value: handle.point.z, free: ['x', 'y'] } }];
      for (const plane of handle.ownPlaneOnly ? [] : usable) {
        if (handle.onGround && plane.fixed === 'z') continue;
        candidates.push({ point: onPlane(handle.point, plane), plane });
      }
      for (const candidate of candidates) {
        const p = frame.project(candidate.point);
        const distance = Math.hypot(p.x - x, p.y - y);
        if (distance <= VIEW.box.hitRadius && (!best || distance < best.distance)) best = { ...handle, plane: candidate.plane, distance };
      }
    }
    return best;
  }

  function localPoint(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function changeView(next) {
    view = next;
    if (frame && scene) {
      frame = computeFrame(frame.width, frame.height);
      requestDraw();
    } else {
      frame = null;
      draw();
    }
    onViewChange?.(view);
  }

  function zoomAt(factor, x, y) {
    if (!frame) return;
    const [low, high] = VIEW.box.zoomRange;
    const zoom = Math.min(high, Math.max(low, view.zoom * factor));
    const before = frame.scale;
    const after = before * zoom / view.zoom;
    const u = (x - frame.width / 2) / before - view.panU * frame.unit;
    const v = (frame.height / 2 - y) / before - view.panV * frame.unit;
    changeView({ ...view, zoom, panU: ((x - frame.width / 2) / after - u) / frame.unit, panV: ((frame.height / 2 - y) / after - v) / frame.unit });
  }

  function panBy(dx, dy) {
    if (!frame) return;
    changeView({ ...view, panU: view.panU + dx / frame.scale / frame.unit, panV: view.panV - dy / frame.scale / frame.unit });
  }

  const touches = new Map();
  let pinch = null;

  function pinchState() {
    const [a, b] = [...touches.values()];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, distance: Math.hypot(a.x - b.x, a.y - b.y) };
  }

  canvas.addEventListener('pointerdown', event => {
    if (!scene || !frame) return;
    const { x, y } = localPoint(event);
    canvas.setPointerCapture(event.pointerId);
    event.preventDefault();
    if (event.pointerType === 'touch') {
      touches.set(event.pointerId, { x, y });
      if (touches.size === 2) {
        drag = null;
        pinch = pinchState();
        return;
      }
      if (touches.size > 2) return;
    }
    const target = event.button === 0 && !event.shiftKey ? hit(x, y) : null;
    if (target) {
      onSelect({ type: target.type, id: target.id });
      const grabbed = fromScreen(target.plane, onPlane(target.point, target.plane), x, y);
      drag = grabbed ? { kind: 'point', ...target, origin: { ...target.point }, grabbed, x, y, moving: false } : null;
    } else if (event.button === 1 || event.button === 2 || event.shiftKey) {
      drag = { kind: 'pan', x, y };
    } else {
      drag = { kind: 'rotate', x, y, view: { ...view }, touch: event.pointerType === 'touch' };
    }
  });
  canvas.addEventListener('pointermove', event => {
    if (!scene || !frame) return;
    const { x, y } = localPoint(event);
    if (event.pointerType === 'touch' && touches.has(event.pointerId)) {
      touches.set(event.pointerId, { x, y });
      if (pinch && touches.size === 2) {
        const next = pinchState();
        if (pinch.distance > 0) zoomAt(next.distance / pinch.distance, next.x, next.y);
        panBy(next.x - pinch.x, next.y - pinch.y);
        pinch = next;
        return;
      }
    }
    if (!drag) {
      canvas.style.cursor = hit(x, y) ? 'grab' : 'default';
      return;
    }
    if (drag.kind === 'rotate') {
      const [low, high] = VIEW.box.pitchRange;
      changeView({
        ...view,
        yaw: drag.view.yaw - (drag.touch ? -1 : 1) * (x - drag.x) * VIEW.box.rotateRadiansPerPixel,
        pitch: Math.min(high, Math.max(low, drag.view.pitch + (y - drag.y) * VIEW.box.rotateRadiansPerPixel))
      });
      return;
    }
    if (drag.kind === 'pan') {
      panBy(x - drag.x, y - drag.y);
      drag = { ...drag, x, y };
      return;
    }
    if (!drag.moving && Math.hypot(x - drag.x, y - drag.y) < VIEW.box.clickPixels * (event.pointerType === 'touch' ? 2 : 1)) return;
    drag.moving = true;
    const solved = fromScreen(drag.plane, onPlane(drag.origin, drag.plane), x, y);
    if (!solved) return;
    const clamp = (value, limit, minimum = -limit) => Math.min(limit, Math.max(minimum, value));
    const { box } = frame;
    drag.resolution = Math.min(1, 10 ** Math.floor(Math.log10(Math.max(box.x1 - box.x0, box.y1 - box.y0, box.z1 - box.z0) / 1000)));
    const round = (value, step) => +(Math.round(value / step) * step).toFixed(Math.max(0, -Math.log10(step)));
    const point = { ...drag.origin };
    for (const axis of drag.plane.free) {
      if (drag.verticalOnly && axis !== 'z') continue;
      const moved = drag.origin[axis] + solved[axis] - drag.grabbed[axis];
      if (axis === 'z') {
        if (!drag.onGround) point.z = round(clamp(moved, RENDER.maximumHeightMetres, 0), Math.min(.1, drag.resolution));
      } else point[axis] = round(clamp(moved, RENDER.sceneExtentMetres), drag.resolution);
    }
    drag.point = point;
    onMove(drag, point);
  });
  const finish = event => {
    if (event.pointerType === 'touch') {
      touches.delete(event.pointerId);
      if (pinch && touches.size < 2) { pinch = null; onView(view); }
    }
    if (!drag) return;
    const finished = drag;
    drag = null;
    if (finished.kind === 'point') { if (finished.moving) onCommit(finished); return; }
    if (finished.kind === 'rotate' && event.type === 'pointerup') {
      const { x, y } = localPoint(event);
      if (Math.hypot(x - finished.x, y - finished.y) < VIEW.box.clickPixels) onSelect({ type: null, id: null });
    }
    onView(view); frame = null; draw();
  };
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', finish);
  canvas.addEventListener('contextmenu', event => event.preventDefault());
  canvas.addEventListener('wheel', event => {
    event.preventDefault();
    const { x, y } = localPoint(event);
    const scale = event.deltaMode === 1 ? VIEW.box.wheelLinePixels : 1;
    const deltaX = event.deltaX * scale;
    const deltaY = event.deltaY * scale;
    const mouseWheel = event.deltaMode === 1 || (event.deltaX === 0 && Math.abs(event.deltaY) >= 40 && Number.isInteger(event.deltaY));
    if (event.ctrlKey || mouseWheel) zoomAt(Math.exp(-deltaY * VIEW.box.zoomPerPixel * (event.ctrlKey ? 2 : 1)), x, y);
    else panBy(-deltaX, -deltaY);
    onView(view);
  }, { passive: false });
  let gestureScale = 1;
  canvas.addEventListener('gesturestart', event => { event.preventDefault(); gestureScale = 1; });
  canvas.addEventListener('gesturechange', event => {
    event.preventDefault();
    const { x, y } = localPoint(event);
    zoomAt(event.scale / gestureScale, x, y);
    gestureScale = event.scale;
  });
  canvas.addEventListener('gestureend', event => { event.preventDefault(); onView(view); });
  canvas.addEventListener('dblclick', () => {
    changeView({ ...VIEW.box.defaultView });
    onView(view);
  });
  new ResizeObserver(() => { frame = null; draw(); }).observe(canvas);

  return {
    update(nextScene, nextSelection) {
      scene = nextScene;
      useTerrain(scene.terrain);
      selection = nextSelection;
      if (!drag) frame = null;
      draw();
    },
    setView(next) {
      const { yaw, pitch, zoom, panU, panV } = { ...VIEW.box.defaultView, ...next };
      changeView({ yaw, pitch, zoom, panU, panV });
    },
    getView: () => view,
    zoomBy(factor) { if (frame) zoomAt(factor, frame.width / 2, frame.height / 2); },
    draw,
    setAnimation(source) { animation = source; },
    hold(on) { held = on; if (!on) draw(); }
  };
}
