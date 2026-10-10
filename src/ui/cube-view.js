import { MAXIMUM_HEIGHT_METRES, SCENE_EXTENT_METRES } from '../domain/constants.js';
import { emissionSeconds } from '../domain/lightning.js';
import { createRandom } from '../domain/random.js';
import { grazingRange, inShadow, pathProfile, soundSpeedProfile } from '../domain/refraction.js';
import { meanPlaneFrame } from '../domain/terrain-propagation.js';
import { fitCanvas, formatMetres, niceStep, palette } from './canvas.js';
import { cachedFlashes, currentSurface, useTerrain } from './geometry-cache.js';

const MARGIN = 36;
const HANDLE_RADIUS = 5;
const HIT_RADIUS = 10;
const MINIMUM_SPAN_METRES = 100;
const BOX_PADDING = .08;
const ROTATE_RADIANS_PER_PIXEL = .008;
const PITCH_RANGE = Object.freeze([.12, 1.45]);
const ZOOM_RANGE = Object.freeze([.2, 40]);
/** Zoom per pixel of pinch or wheel travel; a mouse wheel notch is about 100 pixels. */
const ZOOM_PER_PIXEL = .006;
const LINE_PIXELS = 16;
/** Below this screen-space area a plane is seen edge-on and offers no handles. */
const DEGENERATE_AREA = .08;
const DISC_POINTS = 64;
/** Figurative flash: every stroke runs its route in this time, then fades. */
export const FLASH_TRAVERSE_SECONDS = .12;
const FLASH_FADE_SECONDS = .2;

export const DEFAULT_CUBE_VIEW = Object.freeze({ yaw: .62, pitch: .42, zoom: 1, panX: 0, panY: 0 });
const MICROPHONE_RADIUS = 5.5;
const ARROWHEAD_PIXELS = 8;
/** Length of a receiver's facing arrow, as a share of the box. */
const FACING_LENGTH_SHARE = .1;
/** While the sound plays without the real delay, a point glows from its arrival for this long. */
const SOUND_GLOW_SECONDS = .25;
/** Source points sampled for the shadow boundary on the floor. */
const BOUNDARY_POINTS = 600;
const OUTLINE_STEPS = 48;
/** A press that moves less than this is a click rather than a turn of the view. */
const CLICK_PIXELS = 4;
/** The terrain is drawn on a grid of at most this many cells a side, separate from its heightfield. */
const TERRAIN_DRAW_CELLS = 110;
/** Direction the terrain is lit from: north-west and above. */
const TERRAIN_LIGHT = (() => { const length = Math.hypot(-1, 1, 1.6); return { x: -1 / length, y: 1 / length, z: 1.6 / length }; })();
/**
 * Terrain outside the box fades into the panel over this share of the box's width, and the edge of
 * the captured terrain over this share of its own width, so neither ends in a hard line.
 */
const TERRAIN_FOG_SHARE = .3;
const TERRAIN_EDGE_SHARE = .05;
/**
 * A storm's cloud is drawn as soft puffs placed by its seed in the cloud layer: a dark, flat base and
 * a paler top that spreads into an anvil. Representational only.
 */
const CLOUD_PUFFS = 240;
const CLOUD_PUFF_ALPHA = .34;
const CLOUD_ANVIL_SPREAD = .45;
/** A flash lights the cloud around its top for as long as its channel glows. */
const CLOUD_FLASH_ALPHA = 1.2;
/** Radius of each glow of a flash's light in its cloud, as a share of the cloud's depth. */
const CLOUD_FLASH_REACH = .32;
/** Glows per flash, and how far they stray from its channel, as a share of the cloud's depth. */
const CLOUD_BLOBS = 6;
const CLOUD_BLOB_SCATTER = .25;
/** A stroke's light flickers between seeded levels this far apart in time. */
const FLICKER_SECONDS = .025;
/** Contour stripes: roughly this many bands over the terrain's height range. */
const CONTOUR_BANDS = 12;
/** Place names drawn at most, in the order of PLACE_NAME_KINDS, without overlapping. */
const MAXIMUM_LABELS = 60;
const LABEL_PRIORITY = Object.freeze({ city: 0, town: 1, village: 2, peak: 3, water: 4, hamlet: 5, locality: 6 });
/** A wavefront crossing a face is drawn as a ripple: the front and fading rings behind it. */
const RIPPLE_ALPHAS = Object.freeze([.5, .3, .16, .07]);
/** Spacing of the ripple rings as a share of the box. */
const RIPPLE_SPACING_SHARE = .018;
/** Over terrain, where a front meets the ground is solved per direction, so fewer fronts are drawn. */
const TERRAIN_RIPPLE_SPHERES = 80;
const TERRAIN_RIPPLE_ITERATIONS = 14;
const BOUNDARY_EDGE_ALPHA = .7;
/** Over terrain the boundary is found on a grid of this many cells a side, from this many source points. */
const BOUNDARY_TERRAIN_CELLS = 48;
const BOUNDARY_TERRAIN_SOURCES = 120;
/** Ground samples for each mean plane the terrain boundary judges, fewer than the render uses. */
const BOUNDARY_PLANE_SAMPLES = 8;
/** Width of an outline outside its shape, and of the seam cut along every edge. */
const OUTLINE_PIXELS = 1.2;
const SEAM_PIXELS = 1;

function addPolygon(path, points) {
  points.forEach((point, index) => (index ? path.lineTo(point.x, point.y) : path.moveTo(point.x, point.y)));
  path.closePath();
}

const flashPoints = new WeakMap();

/** Every channel point of an emitter, or its blast point, for outlines on the floor; kept per generated geometry. */
function emitterPoints(emitter) {
  if (emitter.kind === 'blast') return [placed(emitter.positionMetres)];
  const flashes = cachedFlashes(emitter);
  if (!flashPoints.has(flashes)) flashPoints.set(flashes, flashes.flatMap(flash => flash.channels.flatMap(channel => channel.points)));
  return flashPoints.get(flashes);
}

/** Height of the ground under a point, above the datum. */
const ground = (x, y) => currentSurface().heightAt(x, y);
/** A point stored above the ground under it, placed in the scene frame. */
const placed = point => ({ ...point, z: ground(point.x, point.y) + point.z });
/** A ground flash's ground point is stored above the ground; other channel ends above the datum. */
const channelBase = emitter => (emitter.flashType === 'cloud-to-ground' ? placed(emitter.baseMetres) : emitter.baseMetres);

/** The tip of a binaural receiver's look arrow, at a length relative to the box. */
function facingTip(receiver, box) {
  const length = Math.max(box.x1 - box.x0, box.y1 - box.y0) * FACING_LENGTH_SHARE;
  const heading = receiver.headingDegrees * Math.PI / 180;
  const pitch = receiver.pitchDegrees * Math.PI / 180;
  const base = placed(receiver.positionMetres);
  const x = base.x + Math.sin(heading) * Math.cos(pitch) * length;
  const y = base.y + Math.cos(heading) * Math.cos(pitch) * length;
  // A downward look stops at the ground under the tip.
  return { x, y, z: Math.max(ground(x, y), base.z + Math.sin(pitch) * length) };
}

/** Draggable points: blast positions, channel ends, storm edges, receivers, and look arrows. */
function handles(scene, box) {
  const list = [];
  for (const emitter of scene.emitters) {
    if (emitter.kind === 'blast') list.push({ type: 'emitter', id: emitter.id, field: 'positionMetres', point: placed(emitter.positionMetres), role: 'source' });
    else if (emitter.kind === 'storm') {
      list.push({ type: 'emitter', id: emitter.id, field: 'centreMetres', point: placed(emitter.centreMetres), onGround: true, role: 'start' });
      list.push({ type: 'emitter', id: emitter.id, field: 'radiusMetres', point: placed({ x: emitter.centreMetres.x + emitter.radiusMetres, y: emitter.centreMetres.y, z: 0 }), onGround: true, role: 'radius' });
      // The cloud layer's base and top, on the far side of the storm from its edge handle; they move only up and down.
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

/** The point where a stroke's figurative front has reached on one channel, as an arc length. */
/**
 * A flash's flicker at a time after it starts: seeded levels between 0.35 and 1 every FLICKER_SECONDS,
 * eased between, the first one full. Deterministic, so a replay looks the same.
 */
function flicker(seed, elapsed) {
  const level = knot => {
    if (knot <= 0) return 1;
    let value = Math.imul((seed >>> 0) ^ Math.imul(knot, 0x9e3779b1), 0x85ebca6b) >>> 0;
    value = Math.imul(value ^ (value >>> 13), 0xc2b2ae35) >>> 0;
    return .35 + .65 * ((value ^ (value >>> 16)) >>> 0) / 4294967296;
  };
  const position = Math.max(0, elapsed) / FLICKER_SECONDS;
  const knot = Math.floor(position);
  const t = position - knot;
  const eased = t * t * (3 - 2 * t);
  return level(knot) + (level(knot + 1) - level(knot)) * eased;
}

function frontArc(step, elapsed, routeLength) {
  return step.fromArc + elapsed / FLASH_TRAVERSE_SECONDS * routeLength - step.offsetMetres;
}

/**
 * The scene in an orthographic, rotatable box with equal metres on every axis. The floor is the
 * ground and carries the plan; the two far walls carry the elevations. Every point can be dragged
 * in 3D (horizontally) or on its shadow on a wall or the floor (in that plane). A drag moves the
 * point by the pointer's displacement in that plane, so grabbing never makes it jump.
 */
export function createCubeView(canvas, { onSelect, onMove, onCommit, onView, onViewChange, focus, contours = () => false, names = () => false, clouds = () => false }) {
  let scene = null;
  let selection = null;
  let view = { ...DEFAULT_CUBE_VIEW };
  let frame = null;
  let drag = null;
  let animation = null;
  let scratch = null;
  /** While a control changes the scene continuously, the box keeps its size so the view stays still. */
  let held = false;
  let lastBox = null;
  let terrainLayer = null;
  let rippleLayer = null;
  let terrainBoundary = null;
  const cloudLayers = new Map();
  let cloudLight = null;

  function sceneBox() {
    let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity; let maxZ = 0;
    const include = point => {
      minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
      minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y);
      maxZ = Math.max(maxZ, point.z);
    };
    for (const emitter of scene.emitters) {
      if (emitter.kind === 'blast') { include(placed(emitter.positionMetres)); continue; }
      if (emitter.kind === 'storm') {
        const { x, y } = emitter.centreMetres;
        const r = emitter.radiusMetres;
        include({ x: x - r, y: y - r, z: emitter.cloudTopMetres });
        include({ x: x + r, y: y + r, z: 0 });
      }
      for (const flash of cachedFlashes(emitter)) for (const channel of flash.channels) channel.points.forEach(include);
    }
    scene.receivers.forEach(receiver => include(placed(receiver.positionMetres)));
    include({ x: 0, y: 0, z: 0 });
    // The box holds the scene; terrain beyond it fades out (drawTerrain), so only the ground inside sets its depth.
    const pad = Math.max(MINIMUM_SPAN_METRES, maxX - minX, maxY - minY, maxZ) * BOX_PADDING;
    const grow = (low, high) => {
      const half = Math.max(high - low, MINIMUM_SPAN_METRES) / 2 + pad;
      return [(low + high) / 2 - half, (low + high) / 2 + half];
    };
    const [x0, x1] = grow(minX, maxX);
    const [y0, y1] = grow(minY, maxY);
    const surface = currentSurface();
    let minZ = 0;
    if (!surface.flat) {
      const { columns, rows, cellMetres } = surface;
      for (let row = 0; row < rows; row += 1) {
        const y = (row + .5 - rows / 2) * cellMetres;
        if (y < y0 || y > y1) continue;
        for (let column = 0; column < columns; column += 1) {
          const x = (column + .5 - columns / 2) * cellMetres;
          if (x < x0 || x > x1) continue;
          const z = surface.values[row * columns + column] - surface.datumMetres;
          minZ = Math.min(minZ, z);
          maxZ = Math.max(maxZ, z);
        }
      }
    }
    return { x0, x1, y0, y1, z0: minZ, z1: Math.max(minZ + MINIMUM_SPAN_METRES, maxZ) + pad };
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
    const scale = zoom * Math.min((width / 2 - MARGIN) / extentX, (height / 2 - MARGIN) / extentY);
    const project = point => {
      const p = raw(point);
      return { x: width / 2 + (p.x + view.panX) * scale, y: height / 2 - (p.y + view.panY) * scale, depth: p.depth };
    };
    const farX = sinYaw > 0 ? box.x1 : box.x0;
    const farY = cosYaw > 0 ? box.y1 : box.y0;
    // World directions of the screen's right and up, for outlines of spheres.
    const right = { x: cosYaw, y: -sinYaw, z: 0 };
    const up = { x: sinPitch * sinYaw, y: sinPitch * cosYaw, z: cosPitch };
    return { box, scale, project, farX, farY, width, height, right, up };
  }

  /** The planes a point can be dragged in: its own height, the floor, and the two far walls. */
  function planes() {
    const { farX, farY } = frame;
    return [
      { name: 'floor', fixed: 'z', value: 0, free: ['x', 'y'] },
      { name: 'wall-x', fixed: 'x', value: farX, free: ['y', 'z'] },
      { name: 'wall-y', fixed: 'y', value: farY, free: ['x', 'z'] }
    ];
  }

  /** A point's shadow on a plane; on the floor it lies on the ground under the point. */
  function onPlane(point, plane) {
    if (plane.name === 'floor') return { ...point, z: ground(point.x, point.y) };
    return { ...point, [plane.fixed]: plane.value };
  }

  /**
   * Solves a screen point back to the two free coordinates of a plane through `base`. The
   * plane's fixed coordinate comes from `base`, so pass the point already placed on the plane.
   */
  function fromScreen(plane, base, x, y) {
    const origin = frame.project({ ...base, [plane.free[0]]: 0, [plane.free[1]]: 0 });
    const first = frame.project({ ...base, [plane.free[0]]: 1, [plane.free[1]]: 0 });
    const second = frame.project({ ...base, [plane.free[0]]: 0, [plane.free[1]]: 1 });
    const ax = first.x - origin.x; const ay = first.y - origin.y;
    const bx = second.x - origin.x; const by = second.y - origin.y;
    const determinant = ax * by - ay * bx;
    if (Math.abs(determinant) < DEGENERATE_AREA * frame.scale * frame.scale) return null;
    const dx = x - origin.x; const dy = y - origin.y;
    return { [plane.free[0]]: (dx * by - dy * bx) / determinant, [plane.free[1]]: (ax * dy - ay * dx) / determinant };
  }

  /** The vertical plane through a point that faces the viewer most, for dragging a height alone. */
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

  /** The first height line above the floor, skipping the floor itself. */
  function firstLevel(bounds, spacing) {
    const first = Math.ceil(bounds.z0 / spacing) * spacing;
    return first === bounds.z0 ? first + spacing : first;
  }

  function drawBox(context, colors) {
    const { box, farX, farY } = frame;
    const nearX = farX === box.x1 ? box.x0 : box.x1;
    const nearY = farY === box.y1 ? box.y0 : box.y1;
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
    for (let z = firstLevel(box, step); z <= box.z1; z += step) {
      line({ x: farX, y: box.y0, z }, { x: farX, y: box.y1, z });
      line({ x: box.x0, y: farY, z }, { x: box.x1, y: farY, z });
    }
    context.strokeStyle = colors.line;
    line({ x: farX, y: farY, z: box.z0 }, { x: farX, y: farY, z: box.z1 });
  }

  /** The scale, compass, and origin, drawn over the terrain. */
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
    for (let z = firstLevel(box, step); z <= box.z1; z += step) label(formatMetres(z), { x: farX, y: farY, z }, 4, -2);
    const origin = frame.project({ x: 0, y: 0, z: ground(0, 0) });
    context.strokeStyle = colors.muted;
    context.beginPath();
    context.moveTo(origin.x - 6, origin.y); context.lineTo(origin.x + 6, origin.y);
    context.moveTo(origin.x, origin.y - 6); context.lineTo(origin.x, origin.y + 6);
    context.stroke();
    label('E', { x: box.x1, y: nearY, z: box.z0 }, 6, 24);
    label('N', { x: nearX, y: box.y1, z: box.z0 }, 6, 24);
  }

  function strokePoints(context, points, transform) {
    context.beginPath();
    points.forEach((point, index) => {
      const p = frame.project(transform ? transform(point) : point);
      if (index) context.lineTo(p.x, p.y); else context.moveTo(p.x, p.y);
    });
    context.stroke();
  }

  /** Points of a channel from its start up to a given arc, ending exactly at that arc. */
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
    const shadows = [
      point => onPlane(point, { name: 'floor', fixed: 'z', value: 0 }),
      point => onPlane(point, { fixed: 'x', value: frame.farX }),
      point => onPlane(point, { fixed: 'y', value: frame.farY })
    ];
    const flashes = cachedFlashes(emitter);
    context.lineJoin = 'round';
    context.strokeStyle = colors.shadow;
    context.lineWidth = .6;
    for (const flash of flashes) for (const channel of flash.channels) if (channel.main) shadows.forEach(shadow => strokePoints(context, channel.points, shadow));
    for (const flash of flashes) {
      for (const channel of flash.channels) {
        context.strokeStyle = colors.lightning;
        context.globalAlpha *= channel.main ? 1 : Math.max(.35, .8 - .2 * channel.level);
        context.lineWidth = channel.main ? (selected ? 1.6 : 1.1) : Math.max(.4, .8 - .15 * channel.level);
        strokePoints(context, channel.points);
        context.globalAlpha = emitter.enabled ? 1 : .35;
      }
    }
    for (const stroke of strokes ?? []) {
      const flash = flashes[stroke.flash];
      if (!flash) continue;
      const routeLength = Math.max(...stroke.route.map(step => step.offsetMetres + flash.channels[step.channel].arcs.at(-1) - step.fromArc));
      const fade = stroke.elapsed > FLASH_TRAVERSE_SECONDS ? Math.exp(-(stroke.elapsed - FLASH_TRAVERSE_SECONDS) / FLASH_FADE_SECONDS) : 1;
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

  /**
   * Lights every channel point whose direct sound is arriving at the listening receiver now: the
   * flash drawn where the sound comes from instead of when the light left.
   */
  function drawSoundGlow(context, emitter, colors, sound) {
    const levels = [[], [], [], []];
    const { seconds, travelSeconds } = sound;
    const glow = arrival => {
      const age = seconds - arrival;
      return age >= 0 && age < SOUND_GLOW_SECONDS ? 1 - age / SOUND_GLOW_SECONDS : 0;
    };
    for (const flash of cachedFlashes(emitter)) {
      for (const stroke of flash.strokes) {
        if (seconds < flash.startSeconds + stroke.offsetSeconds) continue;
        for (const step of stroke.route) {
          const channel = flash.channels[step.channel];
          let previous = null;
          channel.points.forEach((point, index) => {
            const arc = channel.arcs[index];
            if (arc < step.fromArc) return;
            const level = glow(emissionSeconds(flash, stroke, step, arc) + travelSeconds(point));
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

  /**
   * Fills the union of the shapes in `path` faintly and draws only its outer edge: the shapes are
   * stroked on a scratch canvas, their insides are cut away, and what is left is the outline. The
   * cut also takes a thin stroke along every edge, because where two shapes' edges nearly coincide
   * inside the union the rasterizer's coverage stays below one and would leave a seam.
   */
  function unionOutline(context, path, color, { fillAlpha, edgeAlpha }) {
    scratch ??= document.createElement('canvas');
    if (scratch.width !== canvas.width || scratch.height !== canvas.height) {
      scratch.width = canvas.width;
      scratch.height = canvas.height;
    }
    const layer = scratch.getContext('2d');
    layer.setTransform(1, 0, 0, 1, 0, 0);
    layer.clearRect(0, 0, scratch.width, scratch.height);
    layer.setTransform(context.getTransform());
    layer.lineJoin = 'round';
    layer.lineWidth = OUTLINE_PIXELS * 2 + SEAM_PIXELS;
    layer.strokeStyle = color;
    layer.stroke(path);
    layer.globalCompositeOperation = 'destination-out';
    layer.fill(path);
    layer.lineWidth = SEAM_PIXELS;
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
    context.drawImage(scratch, 0, 0);
    context.restore();
    context.globalAlpha = 1;
  }

  function floorPath() {
    const { box } = frame;
    const path = new Path2D();
    addPolygon(path, [{ x: box.x0, y: box.y0, z: 0 }, { x: box.x1, y: box.y0, z: 0 }, { x: box.x1, y: box.y1, z: 0 }, { x: box.x0, y: box.y1, z: 0 }].map(frame.project));
    return path;
  }

  /**
   * Where refraction lifts the sound off the ground: around each source point, the distance at
   * which the ray to the followed microphone's height grazes the ground. Drawn for the selected
   * emitter, or for every enabled one.
   */
  /** Two colors as [r, g, b] mixed by t. */
  function mixColors(a, b, t) {
    return a.map((value, index) => Math.round(value + (b[index] - value) * t));
  }

  const rgb = hex => [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16));

  /**
   * How far a ground point has faded into the panel, 0–1: outside the box over TERRAIN_FOG_SHARE of
   * its width, and toward the edge of the captured terrain over TERRAIN_EDGE_SHARE of its width.
   */
  function terrainFog(surface, x, y) {
    const { box } = frame;
    const smooth = t => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
    const outside = Math.hypot(Math.max(0, box.x0 - x, x - box.x1), Math.max(0, box.y0 - y, y - box.y1));
    const half = surface.halfExtentMetres;
    const inside = half - Math.max(Math.abs(x), Math.abs(y));
    return Math.max(smooth(outside / (TERRAIN_FOG_SHARE * Math.max(box.x1 - box.x0, box.y1 - box.y0))), 1 - smooth(inside / (TERRAIN_EDGE_SHARE * 2 * half)));
  }

  /**
   * The terrain as a shaded surface: quads drawn far to near, lit from the north-west, with optional
   * contour stripes, fading into the panel beyond the box and at its own edge. Ground behind the far
   * walls goes into a back layer drawn before them, the rest into a front layer drawn after the
   * floor. Both are reused until the view, the size, or the terrain changes, so playback does not
   * redraw them every frame.
   */
  function terrainLayers(colors) {
    const surface = currentSurface();
    const { box, farX, farY } = frame;
    const ratio = window.devicePixelRatio || 1;
    const striped = contours();
    const key = [view.yaw, view.pitch, view.zoom, view.panX, view.panY, canvas.width, canvas.height, box.x0, box.x1, box.y0, box.y1, box.z0, box.z1, surface.datumMetres, surface.values.length, striped, colors.ground, colors.panel].join('|');
    if (terrainLayer?.key === key && terrainLayer.surface === surface) return terrainLayer;
    // Back, front, and the fog mask: white with the opacity the ground keeps through the fog.
    const layers = (terrainLayer?.layers ?? [document.createElement('canvas'), document.createElement('canvas'), document.createElement('canvas')]).map(layer => {
      layer.width = canvas.width;
      layer.height = canvas.height;
      const paint = layer.getContext('2d');
      paint.setTransform(ratio, 0, 0, ratio, 0, 0);
      paint.clearRect(0, 0, layer.width, layer.height);
      paint.lineWidth = .6;
      return layer;
    });
    // The grid covers what can be seen: the box and its fog, within the captured terrain.
    const half = surface.halfExtentMetres;
    const fogMetres = TERRAIN_FOG_SHARE * Math.max(box.x1 - box.x0, box.y1 - box.y0);
    const west = Math.max(-half, box.x0 - fogMetres);
    const south = Math.max(-half, box.y0 - fogMetres);
    const side = Math.max(Math.min(half, box.x1 + fogMetres) - west, Math.min(half, box.y1 + fogMetres) - south);
    const cells = Math.max(2, Math.min(TERRAIN_DRAW_CELLS, Math.ceil(side / surface.cellMetres)));
    const spacing = side / cells;
    const vertices = [];
    for (let row = 0; row <= cells; row += 1) {
      for (let column = 0; column <= cells; column += 1) {
        const x = Math.min(half, west + column * spacing);
        const y = Math.min(half, south + row * spacing);
        vertices.push({ x, y, z: ground(x, y) });
      }
    }
    let lowest = Infinity;
    let highest = -Infinity;
    for (const vertex of vertices) { lowest = Math.min(lowest, vertex.z); highest = Math.max(highest, vertex.z); }
    const band = niceStep(Math.max(1, highest - lowest), CONTOUR_BANDS);
    const dark = rgb(colors.ground);
    const light = mixColors(rgb(colors.line), rgb(colors.muted), .35);
    const fogColor = rgb(colors.panel);
    const behind = (x, y) => (farX === box.x1 ? x > box.x1 : x < box.x0) || (farY === box.y1 ? y > box.y1 : y < box.y0);
    const quads = [];
    for (let row = 0; row < cells; row += 1) {
      for (let column = 0; column < cells; column += 1) {
        const at = (r, c) => vertices[r * (cells + 1) + c];
        const corners = [at(row, column), at(row, column + 1), at(row + 1, column + 1), at(row + 1, column)];
        const centreX = (corners[0].x + corners[2].x) / 2;
        const centreY = (corners[0].y + corners[2].y) / 2;
        if (!(corners[2].x > corners[0].x && corners[2].y > corners[0].y)) continue;
        const fog = terrainFog(surface, centreX, centreY);
        if (fog > .995) continue;
        const projected = corners.map(frame.project);
        const depth = projected.reduce((sum, p) => sum + p.depth, 0) / 4;
        // Normal from the quad's diagonals.
        const u = { x: corners[2].x - corners[0].x, y: corners[2].y - corners[0].y, z: corners[2].z - corners[0].z };
        const v = { x: corners[3].x - corners[1].x, y: corners[3].y - corners[1].y, z: corners[3].z - corners[1].z };
        const n = { x: u.y * v.z - u.z * v.y, y: u.z * v.x - u.x * v.z, z: u.x * v.y - u.y * v.x };
        const length = Math.hypot(n.x, n.y, n.z) || 1;
        const lit = Math.max(0, (n.x * TERRAIN_LIGHT.x + n.y * TERRAIN_LIGHT.y + n.z * TERRAIN_LIGHT.z) / length);
        const height = corners.reduce((sum, corner) => sum + corner.z, 0) / 4;
        const stripe = striped && Math.floor((height - lowest) / band) % 2 === 1 ? .82 : 1;
        const shaded = mixColors(dark, light, lit * lit).map(value => value * stripe);
        const [r, g, b] = mixColors(shaded, fogColor, fog);
        quads.push({ projected, depth, layer: behind(centreX, centreY) ? 0 : 1, color: `rgb(${r},${g},${b})`, mask: `rgba(255,255,255,${(1 - fog).toFixed(3)})` });
      }
    }
    quads.sort((a, b) => b.depth - a.depth);
    const paints = layers.map(layer => layer.getContext('2d'));
    for (const { projected, color, layer, mask } of quads) {
      for (const [paint, style] of [[paints[layer], color], [paints[2], mask]]) {
        paint.beginPath();
        projected.forEach((p, index) => (index ? paint.lineTo(p.x, p.y) : paint.moveTo(p.x, p.y)));
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

  /** Place names on the terrain, most important first, each skipped where it would overlap another. */
  function drawNames(context, colors) {
    const list = scene.terrain?.enabled ? scene.terrain.names : [];
    if (!names() || !list?.length) return;
    const placed = [];
    context.font = '10px system-ui, sans-serif';
    context.textBaseline = 'middle';
    const sorted = [...list].sort((a, b) => LABEL_PRIORITY[a.kind] - LABEL_PRIORITY[b.kind]);
    for (const item of sorted) {
      if (placed.length >= MAXIMUM_LABELS) break;
      const p = frame.project({ x: item.x, y: item.y, z: ground(item.x, item.y) });
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

  /** The selected item's points: a microphone, a blast, or a channel's ends, also those on the ground. */
  function selectedPoints() {
    if (selection?.type === 'receiver') {
      const receiver = scene.receivers.find(item => item.id === selection.id);
      return receiver ? [placed(receiver.positionMetres)] : [];
    }
    const emitter = selection?.type === 'emitter' ? scene.emitters.find(item => item.id === selection.id) : null;
    if (!emitter || emitter.kind === 'storm') return [];
    return emitter.kind === 'blast' ? [placed(emitter.positionMetres)] : [channelBase(emitter), emitter.topMetres];
  }

  function drawShadowBoundary(context, colors) {
    const profile = soundSpeedProfile(scene.air);
    const receiver = focus?.();
    // In wind the air casts a shadow in the directions where its effective speed falls with height.
    const leastGradient = profile.gradient - (profile.shear ? Math.hypot(profile.shear.x, profile.shear.y) : 0);
    if (!(leastGradient < 0) || !receiver) return;
    const chosen = selection?.type === 'emitter' ? scene.emitters.filter(emitter => emitter.id === selection.id) : scene.emitters.filter(emitter => emitter.enabled);
    const points = chosen.flatMap(emitterPoints);
    if (!points.length) return;
    if (!currentSurface().flat) {
      drawTerrainShadowBoundary(context, colors, profile, points, receiver.positionMetres.z);
      return;
    }
    const stride = Math.ceil(points.length / BOUNDARY_POINTS);
    const height = receiver.positionMetres.z;
    // Outward from a source, so each direction's radius uses the air along it; downwind of a strong shear none is cast.
    const directions = Array.from({ length: OUTLINE_STEPS }, (_, step) => {
      const angle = 2 * Math.PI * step / OUTLINE_STEPS;
      return { cos: Math.cos(angle), sin: Math.sin(angle) };
    });
    const origin = frame.project({ x: 0, y: 0, z: 0 });
    const east = frame.project({ x: 1, y: 0, z: 0 });
    const north = frame.project({ x: 0, y: 1, z: 0 });
    const toScreen = (x, y) => ({ x: origin.x + x * (east.x - origin.x) + y * (north.x - origin.x), y: origin.y + x * (east.y - origin.y) + y * (north.y - origin.y) });
    const path = new Path2D();
    for (let index = 0; index < points.length; index += stride) {
      const point = points[index];
      addPolygon(path, directions.map(({ cos, sin }) => {
        const along = pathProfile(profile, point, { x: point.x + cos, y: point.y + sin, z: height });
        const radius = Math.min(2 * SCENE_EXTENT_METRES, grazingRange(along, point.z) + grazingRange(along, height));
        return toScreen(point.x + radius * cos, point.y + radius * sin);
      }));
    }
    context.save();
    context.clip(floorPath());
    unionOutline(context, path, colors.muted, { fillAlpha: 0, edgeAlpha: BOUNDARY_EDGE_ALPHA });
    context.restore();
  }

  /**
   * The shadow boundary over terrain: the cells of a grid over the box where a microphone at the
   * given height above the ground hears at least one source point outside the refraction shadow,
   * judged from the mean ground plane as the render does, and outlined. The cells are kept until
   * the sources, the air, the height, the box, or the terrain change.
   */
  function drawTerrainShadowBoundary(context, colors, profile, points, heightAboveGround) {
    const { box } = frame;
    const surface = currentSurface();
    const middle = points[points.length >> 1];
    const key = [points.length, points[0].x, points[0].z, middle.x, middle.y, middle.z, profile.groundSpeed, profile.gradient, profile.wind?.x, profile.wind?.y, profile.shear?.x, profile.shear?.y, heightAboveGround, box.x0, box.x1, box.y0, box.y1].join('|');
    if (terrainBoundary?.key !== key || terrainBoundary.surface !== surface) {
      const stride = Math.ceil(points.length / BOUNDARY_TERRAIN_SOURCES);
      const sampled = points.filter((_, index) => index % stride === 0);
      const lit = new Uint8Array(BOUNDARY_TERRAIN_CELLS * BOUNDARY_TERRAIN_CELLS);
      const width = (box.x1 - box.x0) / BOUNDARY_TERRAIN_CELLS;
      const depth = (box.y1 - box.y0) / BOUNDARY_TERRAIN_CELLS;
      for (let row = 0; row < BOUNDARY_TERRAIN_CELLS; row += 1) {
        for (let column = 0; column < BOUNDARY_TERRAIN_CELLS; column += 1) {
          const x = box.x0 + (column + .5) * width;
          const y = box.y0 + (row + .5) * depth;
          const receiver = { x, y, z: ground(x, y) + heightAboveGround };
          lit[row * BOUNDARY_TERRAIN_CELLS + column] = sampled.some(point => {
            const plane = meanPlaneFrame(pathProfile(profile, point, receiver), ground, point, receiver, BOUNDARY_PLANE_SAMPLES);
            return !inShadow(plane.profile, plane.from, plane.to);
          }) ? 1 : 0;
        }
      }
      terrainBoundary = { key, surface, lit, width, depth };
    }
    const { lit, width, depth } = terrainBoundary;
    if (lit.every(Boolean)) return;
    const path = new Path2D();
    for (let row = 0; row < BOUNDARY_TERRAIN_CELLS; row += 1) {
      for (let column = 0; column < BOUNDARY_TERRAIN_CELLS; column += 1) {
        if (!lit[row * BOUNDARY_TERRAIN_CELLS + column]) continue;
        const x0 = box.x0 + column * width;
        const y0 = box.y0 + row * depth;
        addPolygon(path, [[x0, y0], [x0 + width, y0], [x0 + width, y0 + depth], [x0, y0 + depth]].map(([x, y]) => frame.project({ x, y, z: ground(x, y) })));
      }
    }
    unionOutline(context, path, colors.muted, { fillAlpha: 0, edgeAlpha: BOUNDARY_EDGE_ALPHA });
  }

  /**
   * The wavefronts where they cross the floor and the two far walls, as ripples: each sampled
   * source's sphere meets a plane in a circle, and the outline of their union is drawn with fading
   * rings behind it, only within the face, so a front leaves no trace once it has passed. On the
   * floor the circle stops at the shadow boundary.
   */
  function drawWavefronts(context, colors, { profile, spheres, total }) {
    // Each flash's fronts form their own outline, so an older, wider front does not hide a newer
    // one inside it; fronts that have left the box and the terrain around it are dropped.
    const { box } = frame;
    const half = currentSurface().flat ? 0 : currentSurface().halfExtentMetres;
    const bounds = { x0: Math.min(box.x0, -half), x1: Math.max(box.x1, half), y0: Math.min(box.y0, -half), y1: Math.max(box.y1, half) };
    // Fronts over terrain are thinned by their fixed order, so the same ones are drawn in every frame.
    const terrainStride = Math.max(1, Math.ceil(total / TERRAIN_RIPPLE_SPHERES));
    const groups = new Map();
    for (const sphere of spheres) {
      const { centre, radiusMetres } = sphere;
      const farthest = Math.hypot(Math.max(centre.x - bounds.x0, bounds.x1 - centre.x), Math.max(centre.y - bounds.y0, bounds.y1 - centre.y), Math.max(centre.z - box.z0, box.z1 - centre.z));
      if (radiusMetres > farthest) continue;
      if (!groups.has(sphere.group)) groups.set(sphere.group, []);
      groups.get(sphere.group).push(sphere);
    }
    for (const group of groups.values()) drawFronts(context, colors, profile, group, terrainStride);
  }

  function drawFronts(context, colors, profile, spheres, terrainStride) {
    const { box, farX, farY } = frame;
    const faces = [
      ...(currentSurface().flat ? [{ fixed: 'z', value: 0, axes: ['x', 'y'], corners: [[box.x0, box.y0], [box.x1, box.y0], [box.x1, box.y1], [box.x0, box.y1]] }] : []),
      { fixed: 'x', value: farX, axes: ['y', 'z'], corners: [[box.y0, 0], [box.y1, 0], [box.y1, box.z1], [box.y0, box.z1]] },
      { fixed: 'y', value: farY, axes: ['x', 'z'], corners: [[box.x0, 0], [box.x1, 0], [box.x1, box.z1], [box.x0, box.z1]] }
    ];
    const spacing = Math.max(box.x1 - box.x0, box.y1 - box.y0, box.z1) * RIPPLE_SPACING_SHARE;
    if (!currentSurface().flat) drawTerrainRipples(context, colors, spheres.filter(sphere => sphere.order % terrainStride === 0), spacing);
    for (const face of faces) {
      const [u, v] = face.axes;
      const place = (a, b) => frame.project({ [face.fixed]: face.value, [u]: a, [v]: b });
      const outline = new Path2D();
      addPolygon(outline, face.corners.map(([a, b]) => place(a, b)));
      context.save();
      context.clip(outline);
      RIPPLE_ALPHAS.forEach((alpha, ring) => {
        const path = new Path2D();
        let any = false;
        for (const { source, centre, radiusMetres } of spheres) {
          const sphere = radiusMetres - ring * spacing;
          const offset = face.value - centre[face.fixed];
          if (!(sphere > Math.abs(offset))) continue;
          let radius = Math.sqrt(sphere ** 2 - offset ** 2);
          if (face.fixed === 'z' && profile.gradient < 0) radius = Math.min(radius, grazingRange(profile, source.z));
          if (!(radius > 0)) continue;
          any = true;
          addPolygon(path, Array.from({ length: OUTLINE_STEPS }, (_, step) => {
            const angle = 2 * Math.PI * step / OUTLINE_STEPS;
            return place(centre[u] + radius * Math.cos(angle), centre[v] + radius * Math.sin(angle));
          }));
        }
        if (any) unionOutline(context, path, colors.glow, { fillAlpha: 0, edgeAlpha: alpha });
      });
      context.restore();
    }
  }

  /**
   * Where the fronts meet the terrain: for every direction from a sphere's centre, the horizontal
   * distance at which the ground lies exactly one radius from the centre, by bisection. Drawn as
   * ripples like on the walls into a layer of their own, which then fades with the terrain's fog.
   */
  function drawTerrainRipples(context, colors, spheres, spacing) {
    const ratio = window.devicePixelRatio || 1;
    rippleLayer ??= document.createElement('canvas');
    if (rippleLayer.width !== canvas.width || rippleLayer.height !== canvas.height) {
      rippleLayer.width = canvas.width;
      rippleLayer.height = canvas.height;
    }
    const paint = rippleLayer.getContext('2d');
    paint.setTransform(1, 0, 0, 1, 0, 0);
    paint.globalCompositeOperation = 'source-over';
    paint.clearRect(0, 0, rippleLayer.width, rippleLayer.height);
    paint.setTransform(ratio, 0, 0, ratio, 0, 0);
    RIPPLE_ALPHAS.forEach((alpha, ring) => {
      const path = new Path2D();
      let any = false;
      for (const { centre, radiusMetres } of spheres) {
        const radius = radiusMetres - ring * spacing;
        if (!(radius > 0)) continue;
        const points = [];
        for (let step = 0; step < OUTLINE_STEPS; step += 1) {
          const angle = 2 * Math.PI * step / OUTLINE_STEPS;
          const cos = Math.cos(angle);
          const sin = Math.sin(angle);
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
        addPolygon(path, points);
      }
      if (any) unionOutline(paint, path, colors.glow, { fillAlpha: 0, edgeAlpha: alpha });
    });
    paint.setTransform(1, 0, 0, 1, 0, 0);
    paint.globalCompositeOperation = 'destination-in';
    paint.drawImage(terrainLayers(colors).layers[2], 0, 0);
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.drawImage(rippleLayer, 0, 0);
    context.restore();
  }

  /** Dashed lines from a selected point down to the floor and across to the walls, to its shadows there. */
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
    // The flat layer marks the cloud when its fog is off.
    if (!clouds()) {
      context.fillStyle = colors.cloud;
      polygon(context, ring(emitter.cloudBaseMetres)); context.fill();
      polygon(context, ring(emitter.cloudTopMetres)); context.fill();
    }
    // The storm's reach on the ground, clear over terrain too.
    context.strokeStyle = selected ? colors.accent : colors.lightning;
    context.lineWidth = selected ? 1.4 : 1.2;
    polygon(context, ring(0).map(point => ({ ...point, z: ground(point.x, point.y) }))); context.stroke();
  }

  /** The puffs of a storm's cloud, from its seed, in the scene frame: centre, radius, and height share. */
  function cloudPuffs(emitter) {
    const random = createRandom(emitter.seed ^ 0x5c10d);
    const { x, y } = emitter.centreMetres;
    const base = emitter.cloudBaseMetres;
    const depth = emitter.cloudTopMetres - base;
    return Array.from({ length: CLOUD_PUFFS }, () => {
      // More of the cloud low down, where it is broad and dark; the top spreads into an anvil.
      const share = random() ** 1.4;
      const reach = emitter.radiusMetres * (.75 + CLOUD_ANVIL_SPREAD * share ** 4);
      const angle = 2 * Math.PI * random();
      const distance = reach * Math.sqrt(random());
      return {
        centre: { x: x + distance * Math.cos(angle), y: y + distance * Math.sin(angle), z: base + depth * share },
        radius: Math.max(depth * (.22 + .22 * random()), emitter.radiusMetres * .18),
        share
      };
    });
  }

  /**
   * A storm's cloud as fog: its puffs far to near, each a soft disc darker at the base, drawn into a
   * layer kept until the view, the size, or the storm changes.
   */
  function drawCloud(context, emitter, colors) {
    const key = [view.yaw, view.pitch, view.zoom, view.panX, view.panY, canvas.width, canvas.height, emitter.seed, emitter.centreMetres.x, emitter.centreMetres.y, emitter.radiusMetres, emitter.cloudBaseMetres, emitter.cloudTopMetres, colors['storm-base'], colors['storm-top'], frame.box.x0, frame.box.x1, frame.box.z1].join('|');
    let layer = cloudLayers.get(emitter.id);
    if (layer?.key !== key) {
      const canvasLayer = layer?.canvas ?? document.createElement('canvas');
      canvasLayer.width = canvas.width;
      canvasLayer.height = canvas.height;
      const paint = canvasLayer.getContext('2d');
      const ratio = window.devicePixelRatio || 1;
      paint.setTransform(ratio, 0, 0, ratio, 0, 0);
      paint.clearRect(0, 0, canvas.width, canvas.height);
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
        gradient.addColorStop(0, `rgba(${r},${g},${b},${CLOUD_PUFF_ALPHA})`);
        gradient.addColorStop(.6, `rgba(${r},${g},${b},${CLOUD_PUFF_ALPHA * .5})`);
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

  /**
   * The light of a storm's flashes in its cloud: a loose blob that follows each flash's lit channel
   * inside the cloud without tracing it, made of a few large soft glows at seeded offsets along it,
   * flickering as the stroke's current does, kept to the cloud's fog by its layer as a mask, and added
   * to the scene. Representational, not a model of scattering.
   */
  function drawCloudLight(context, emitter, colors, strokes) {
    const layer = cloudLayers.get(emitter.id);
    if (!layer || !strokes?.length) return;
    const flashes = cachedFlashes(emitter);
    const depth = emitter.cloudTopMetres - emitter.cloudBaseMetres;
    cloudLight ??= { light: document.createElement('canvas'), mask: document.createElement('canvas') };
    const { light, mask } = cloudLight;
    for (const target of [light, mask]) {
      target.width = canvas.width;
      target.height = canvas.height;
    }
    const ratio = window.devicePixelRatio || 1;
    const glow = light.getContext('2d');
    glow.setTransform(ratio, 0, 0, ratio, 0, 0);
    glow.globalCompositeOperation = 'lighter';
    const [r, g, b] = rgb(colors.flash);
    let lit = false;
    for (const stroke of strokes) {
      const flash = flashes[stroke.flash];
      if (!flash) continue;
      const fade = stroke.elapsed > FLASH_TRAVERSE_SECONDS ? Math.exp(-(stroke.elapsed - FLASH_TRAVERSE_SECONDS) / FLASH_FADE_SECONDS) : 1;
      const intensity = CLOUD_FLASH_ALPHA * fade * flicker(emitter.seed + stroke.flash * 7919, stroke.elapsed);
      if (intensity < .01) continue;
      // The lit channel inside the cloud, or the flash's top when none of it is there yet.
      const routeLength = Math.max(...stroke.route.map(step => step.offsetMetres + flash.channels[step.channel].arcs.at(-1) - step.fromArc));
      const inCloud = stroke.route.flatMap(step => {
        const reached = frontArc(step, stroke.elapsed, routeLength);
        return reached > step.fromArc ? pointsUpTo(flash.channels[step.channel], step.fromArc, reached) : [];
      }).filter(point => point.z >= emitter.cloudBaseMetres);
      const along = inCloud.length ? inCloud : [flash.channels[0].points.at(-1)];
      const random = createRandom((emitter.seed ^ Math.imul(stroke.flash + 1, 0x27d4eb2d)) >>> 0);
      for (let blob = 0; blob < CLOUD_BLOBS; blob += 1) {
        const at = along[Math.min(along.length - 1, Math.floor((blob + random()) / CLOUD_BLOBS * along.length))];
        const offset = depth * CLOUD_BLOB_SCATTER;
        const centre = { x: at.x + offset * (random() - .5), y: at.y + offset * (random() - .5), z: at.z + offset * (random() - .5) };
        const p = frame.project(centre);
        const edge = frame.project({ ...centre, z: centre.z + depth * CLOUD_FLASH_REACH * (.6 + .8 * random()) });
        const size = Math.hypot(edge.x - p.x, edge.y - p.y);
        const gradient = glow.createRadialGradient(p.x, p.y, 0, p.x, p.y, size);
        const alpha = intensity / CLOUD_BLOBS * 2.2;
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
    const centre = frame.project(placed(emitter.positionMetres));
    const stroke = state?.strokes.get(emitter.id)?.[0];
    if (stroke) {
      const level = Math.exp(-stroke.elapsed / FLASH_FADE_SECONDS);
      context.fillStyle = colors.flash;
      context.shadowColor = colors.glow;
      context.shadowBlur = 30 * level;
      context.globalAlpha = level;
      context.beginPath(); context.arc(centre.x, centre.y, 4 + 12 * level, 0, 2 * Math.PI); context.fill();
      context.shadowBlur = 0;
      context.globalAlpha = 1;
    }
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
      context.arc(p.x, p.y, MICROPHONE_RADIUS, 0, 2 * Math.PI);
      context.fillStyle = colors.receiver;
      context.fill();
      context.fillStyle = colors.panel;
      context.beginPath(); context.arc(p.x, p.y, MICROPHONE_RADIUS * .4, 0, 2 * Math.PI); context.fill();
      if (selected) {
        context.strokeStyle = colors.accent;
        context.beginPath(); context.arc(p.x, p.y, MICROPHONE_RADIUS + 1.5, 0, 2 * Math.PI); context.stroke();
      }
      return;
    }
    if (handle.role === 'facing') {
      const owner = scene.receivers.find(receiver => receiver.id === handle.id);
      // Along the drawn arrow, which starts at the microphone where it stands on the terrain.
      const base = frame.project(placed(owner.positionMetres));
      const angle = Math.atan2(p.y - base.y, p.x - base.x);
      const size = ARROWHEAD_PIXELS;
      context.moveTo(p.x + Math.cos(angle) * size * .6, p.y + Math.sin(angle) * size * .6);
      context.lineTo(p.x + Math.cos(angle + 2.5) * size, p.y + Math.sin(angle + 2.5) * size);
      context.lineTo(p.x + Math.cos(angle - 2.5) * size, p.y + Math.sin(angle - 2.5) * size);
      context.closePath();
      context.fillStyle = selected ? colors.accent : colors.receiver;
      context.fill();
      return;
    }
    if (handle.role === 'level') {
      context.arc(p.x, p.y, HANDLE_RADIUS - 1, 0, 2 * Math.PI);
      context.fillStyle = colors['cloud-handle'];
      context.fill();
      if (selected) {
        context.strokeStyle = colors.accent;
        context.beginPath(); context.arc(p.x, p.y, HANDLE_RADIUS + 1, 0, 2 * Math.PI); context.stroke();
      }
      return;
    }
    const radius = handle.role === 'radius' ? HANDLE_RADIUS - 1.5 : HANDLE_RADIUS;
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

  function draw() {
    if (!scene) return;
    const { context, width, height } = fitCanvas(canvas);
    const colors = palette();
    if (!drag || !frame) frame = computeFrame(width, height);
    const state = animation?.() ?? null;
    const usable = new Set(planes().filter(planeUsable).map(plane => plane.name));

    drawTerrain(context, colors, true);
    drawBox(context, colors);
    drawTerrain(context, colors, false);
    drawBoxLabels(context, colors);
    drawNames(context, colors);
    drawShadowBoundary(context, colors);
    if (state?.wavefronts) drawWavefronts(context, colors, state.wavefronts);
    for (const emitter of scene.emitters) {
      const selected = selection?.type === 'emitter' && selection.id === emitter.id;
      context.globalAlpha = emitter.enabled ? 1 : .35;
      if (emitter.kind === 'storm') drawStorm(context, emitter, colors, selected);
      if (emitter.kind === 'blast') drawBlast(context, emitter, colors, state);
      else {
        drawChannels(context, emitter, colors, selected, state?.strokes.get(emitter.id));
        if (state?.sound && emitter.enabled) drawSoundGlow(context, emitter, colors, state.sound);
      }
      context.globalAlpha = 1;
    }
    // The storm clouds over their channels, lit by the flashes inside them.
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
      if (length <= MICROPHONE_RADIUS) continue;
      const ux = (b.x - a.x) / length;
      const uy = (b.y - a.y) / length;
      context.globalAlpha = receiver.listen ? 1 : .35;
      context.beginPath(); context.moveTo(a.x + ux * MICROPHONE_RADIUS, a.y + uy * MICROPHONE_RADIUS); context.lineTo(b.x, b.y); context.stroke();
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
      const anchor = emitter.kind === 'blast' ? placed(emitter.positionMetres) : emitter.kind === 'storm' ? placed(emitter.centreMetres) : emitter.topMetres;
      const p = frame.project(anchor);
      context.fillText(emitter.name, p.x + 9, p.y - 8);
    }
    for (const receiver of scene.receivers) {
      const p = frame.project(placed(receiver.positionMetres));
      context.fillText(receiver.name, p.x + 9, p.y - 8);
    }
  }

  /** The nearest handle or handle shadow under the pointer, with the plane it moves in. */
  function hit(x, y) {
    let best = null;
    const usable = planes().filter(planeUsable);
    for (const handle of handles(scene, frame.box)) {
      if (handle.verticalOnly) {
        const p = frame.project(handle.point);
        const distance = Math.hypot(p.x - x, p.y - y);
        if (distance <= HIT_RADIUS && (!best || distance < best.distance)) best = { ...handle, plane: verticalPlane(handle.point), distance };
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
        if (distance <= HIT_RADIUS && (!best || distance < best.distance)) best = { ...handle, plane: candidate.plane, distance };
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
    frame = null;
    draw();
    onViewChange?.(view);
  }

  /** Zooms by a factor about a screen point, keeping the scene under that point in place. */
  function zoomAt(factor, x, y) {
    if (!frame) return;
    const [low, high] = ZOOM_RANGE;
    const zoom = Math.min(high, Math.max(low, view.zoom * factor));
    const before = frame.scale;
    const after = before * zoom / view.zoom;
    const u = (x - frame.width / 2) / before - view.panX;
    const v = (frame.height / 2 - y) / before - view.panY;
    changeView({ ...view, zoom, panX: (x - frame.width / 2) / after - u, panY: (frame.height / 2 - y) / after - v });
  }

  function panBy(dx, dy) {
    if (!frame) return;
    changeView({ ...view, panX: view.panX + dx / frame.scale, panY: view.panY - dy / frame.scale });
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
      drag = grabbed ? { kind: 'point', ...target, origin: { ...target.point }, grabbed } : null;
    } else if (event.button === 1 || event.button === 2 || event.shiftKey) {
      drag = { kind: 'pan', x, y };
    } else {
      drag = { kind: 'rotate', x, y, view: { ...view } };
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
      const [low, high] = PITCH_RANGE;
      changeView({
        ...view,
        yaw: drag.view.yaw - (x - drag.x) * ROTATE_RADIANS_PER_PIXEL,
        pitch: Math.min(high, Math.max(low, drag.view.pitch + (y - drag.y) * ROTATE_RADIANS_PER_PIXEL))
      });
      return;
    }
    if (drag.kind === 'pan') {
      panBy(x - drag.x, y - drag.y);
      drag = { ...drag, x, y };
      return;
    }
    const solved = fromScreen(drag.plane, onPlane(drag.origin, drag.plane), x, y);
    if (!solved) return;
    const clamp = (value, limit, minimum = -limit) => Math.min(limit, Math.max(minimum, value));
    const point = { ...drag.origin };
    for (const axis of drag.plane.free) {
      if (drag.verticalOnly && axis !== 'z') continue;
      const moved = drag.origin[axis] + solved[axis] - drag.grabbed[axis];
      if (axis === 'z') {
        if (!drag.onGround) point.z = Math.round(clamp(moved, MAXIMUM_HEIGHT_METRES, 0) * 10) / 10;
      } else point[axis] = Math.round(clamp(moved, SCENE_EXTENT_METRES));
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
    if (finished.kind === 'point') { onCommit(finished); return; }
    // A click on empty space, without turning the view, clears the selection.
    if (finished.kind === 'rotate' && event.type === 'pointerup') {
      const { x, y } = localPoint(event);
      if (Math.hypot(x - finished.x, y - finished.y) < CLICK_PIXELS) onSelect({ type: null, id: null });
    }
    onView(view); frame = null; draw();
  };
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', finish);
  canvas.addEventListener('contextmenu', event => event.preventDefault());
  canvas.addEventListener('wheel', event => {
    event.preventDefault();
    const { x, y } = localPoint(event);
    const scale = event.deltaMode === 1 ? LINE_PIXELS : 1;
    const deltaX = event.deltaX * scale;
    const deltaY = event.deltaY * scale;
    const mouseWheel = event.deltaMode === 1 || (event.deltaX === 0 && Math.abs(event.deltaY) >= 40 && Number.isInteger(event.deltaY));
    if (event.ctrlKey || mouseWheel) zoomAt(Math.exp(-deltaY * ZOOM_PER_PIXEL * (event.ctrlKey ? 2 : 1)), x, y);
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
    changeView({ ...DEFAULT_CUBE_VIEW });
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
    setView(next) { changeView({ ...DEFAULT_CUBE_VIEW, ...next }); },
    getView: () => view,
    draw,
    setAnimation(source) { animation = source; },
    hold(on) { held = on; if (!on) draw(); }
  };
}
