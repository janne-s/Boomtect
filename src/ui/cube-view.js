import { MAXIMUM_HEIGHT_METRES, SCENE_EXTENT_METRES } from '../domain/constants.js';
import { emissionSeconds } from '../domain/lightning.js';
import { grazingRange, soundSpeedProfile } from '../domain/refraction.js';
import { fitCanvas, formatMetres, niceStep, palette } from './canvas.js';
import { cachedFlashes } from './geometry-cache.js';

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
/** A wavefront crossing a face is drawn as a ripple: the front and fading rings behind it. */
const RIPPLE_ALPHAS = Object.freeze([.5, .3, .16, .07]);
/** Spacing of the ripple rings as a share of the box. */
const RIPPLE_SPACING_SHARE = .018;
const BOUNDARY_EDGE_ALPHA = .7;
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
  if (emitter.kind === 'blast') return [emitter.positionMetres];
  const flashes = cachedFlashes(emitter);
  if (!flashPoints.has(flashes)) flashPoints.set(flashes, flashes.flatMap(flash => flash.channels.flatMap(channel => channel.points)));
  return flashPoints.get(flashes);
}

/** The tip of a binaural receiver's look arrow, at a length relative to the box. */
function facingTip(receiver, box) {
  const length = Math.max(box.x1 - box.x0, box.y1 - box.y0) * FACING_LENGTH_SHARE;
  const heading = receiver.headingDegrees * Math.PI / 180;
  const pitch = receiver.pitchDegrees * Math.PI / 180;
  const base = receiver.positionMetres;
  return {
    x: base.x + Math.sin(heading) * Math.cos(pitch) * length,
    y: base.y + Math.cos(heading) * Math.cos(pitch) * length,
    z: Math.max(0, base.z + Math.sin(pitch) * length)
  };
}

/** Draggable points: blast positions, channel ends, storm edges, receivers, and look arrows. */
function handles(scene, box) {
  const list = [];
  for (const emitter of scene.emitters) {
    if (emitter.kind === 'blast') list.push({ type: 'emitter', id: emitter.id, field: 'positionMetres', point: emitter.positionMetres, role: 'source' });
    else if (emitter.kind === 'storm') {
      list.push({ type: 'emitter', id: emitter.id, field: 'centreMetres', point: emitter.centreMetres, onGround: true, role: 'start' });
      list.push({ type: 'emitter', id: emitter.id, field: 'radiusMetres', point: { x: emitter.centreMetres.x + emitter.radiusMetres, y: emitter.centreMetres.y, z: 0 }, onGround: true, role: 'radius' });
      // The cloud layer's base and top, on the far side of the storm from its edge handle; they move only up and down.
      for (const field of ['cloudBaseMetres', 'cloudTopMetres']) {
        list.push({ type: 'emitter', id: emitter.id, field, point: { x: emitter.centreMetres.x - emitter.radiusMetres, y: emitter.centreMetres.y, z: emitter[field] }, role: 'level', verticalOnly: true });
      }
    }
    else {
      list.push({ type: 'emitter', id: emitter.id, field: 'baseMetres', point: emitter.baseMetres, onGround: emitter.flashType === 'cloud-to-ground', role: 'start' });
      list.push({ type: 'emitter', id: emitter.id, field: 'topMetres', point: emitter.topMetres, role: 'end' });
    }
  }
  for (const receiver of scene.receivers) {
    list.push({ type: 'receiver', id: receiver.id, field: 'positionMetres', point: receiver.positionMetres, role: 'receiver', listening: receiver.listen });
    if (receiver.type === 'binaural' && box) {
      list.push({ type: 'receiver', id: receiver.id, field: 'headingDegrees', point: facingTip(receiver, box), role: 'facing', ownPlaneOnly: true, listening: receiver.listen });
    }
  }
  return list;
}

/** The point where a stroke's figurative front has reached on one channel, as an arc length. */
function frontArc(step, elapsed, routeLength) {
  return step.fromArc + elapsed / FLASH_TRAVERSE_SECONDS * routeLength - step.offsetMetres;
}

/**
 * The scene in an orthographic, rotatable box with equal metres on every axis. The floor is the
 * ground and carries the plan; the two far walls carry the elevations. Every point can be dragged
 * in 3D (horizontally) or on its shadow on a wall or the floor (in that plane). A drag moves the
 * point by the pointer's displacement in that plane, so grabbing never makes it jump.
 */
export function createCubeView(canvas, { onSelect, onMove, onCommit, onView, onViewChange, focus }) {
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

  function sceneBox() {
    let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity; let maxZ = 0;
    const include = point => {
      minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
      minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y);
      maxZ = Math.max(maxZ, point.z);
    };
    for (const emitter of scene.emitters) {
      if (emitter.kind === 'blast') { include(emitter.positionMetres); continue; }
      if (emitter.kind === 'storm') {
        const { x, y } = emitter.centreMetres;
        const r = emitter.radiusMetres;
        include({ x: x - r, y: y - r, z: emitter.cloudTopMetres });
        include({ x: x + r, y: y + r, z: 0 });
      }
      for (const flash of cachedFlashes(emitter)) for (const channel of flash.channels) channel.points.forEach(include);
    }
    scene.receivers.forEach(receiver => include(receiver.positionMetres));
    include({ x: 0, y: 0, z: 0 });
    const span = Math.max(MINIMUM_SPAN_METRES, maxX - minX, maxY - minY, maxZ);
    const pad = span * BOX_PADDING;
    const grow = (low, high) => {
      const half = Math.max(high - low, MINIMUM_SPAN_METRES) / 2 + pad;
      return [(low + high) / 2 - half, (low + high) / 2 + half];
    };
    const [x0, x1] = grow(minX, maxX);
    const [y0, y1] = grow(minY, maxY);
    return { x0, x1, y0, y1, z0: 0, z1: Math.max(MINIMUM_SPAN_METRES, maxZ) + pad };
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

  function onPlane(point, plane) {
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

  function drawBox(context, colors) {
    const { box, farX, farY } = frame;
    const nearX = farX === box.x1 ? box.x0 : box.x1;
    const nearY = farY === box.y1 ? box.y0 : box.y1;
    context.fillStyle = colors.wall;
    polygon(context, [{ x: farX, y: box.y0, z: 0 }, { x: farX, y: box.y1, z: 0 }, { x: farX, y: box.y1, z: box.z1 }, { x: farX, y: box.y0, z: box.z1 }]);
    context.fill();
    polygon(context, [{ x: box.x0, y: farY, z: 0 }, { x: box.x1, y: farY, z: 0 }, { x: box.x1, y: farY, z: box.z1 }, { x: box.x0, y: farY, z: box.z1 }]);
    context.fill();
    context.fillStyle = colors.ground;
    polygon(context, [{ x: box.x0, y: box.y0, z: 0 }, { x: box.x1, y: box.y0, z: 0 }, { x: box.x1, y: box.y1, z: 0 }, { x: box.x0, y: box.y1, z: 0 }]);
    context.fill();

    const step = niceStep(Math.max(box.x1 - box.x0, box.y1 - box.y0, box.z1), 6);
    context.lineWidth = 1;
    context.strokeStyle = colors.grid;
    const line = (a, b) => { const p = frame.project(a); const q = frame.project(b); context.beginPath(); context.moveTo(p.x, p.y); context.lineTo(q.x, q.y); context.stroke(); };
    for (let x = Math.ceil(box.x0 / step) * step; x <= box.x1; x += step) {
      line({ x, y: box.y0, z: 0 }, { x, y: box.y1, z: 0 });
      line({ x, y: farY, z: 0 }, { x, y: farY, z: box.z1 });
    }
    for (let y = Math.ceil(box.y0 / step) * step; y <= box.y1; y += step) {
      line({ x: box.x0, y, z: 0 }, { x: box.x1, y, z: 0 });
      line({ x: farX, y, z: 0 }, { x: farX, y, z: box.z1 });
    }
    for (let z = step; z <= box.z1; z += step) {
      line({ x: farX, y: box.y0, z }, { x: farX, y: box.y1, z });
      line({ x: box.x0, y: farY, z }, { x: box.x1, y: farY, z });
    }
    context.strokeStyle = colors.line;
    line({ x: farX, y: farY, z: 0 }, { x: farX, y: farY, z: box.z1 });

    context.font = '10px system-ui, sans-serif';
    context.fillStyle = colors.faint;
    const label = (text, point, dx = 4, dy = 12) => { const p = frame.project(point); context.fillText(text, p.x + dx, p.y + dy); };
    for (let x = Math.ceil(box.x0 / step) * step; x <= box.x1; x += step) label(formatMetres(x), { x, y: nearY, z: 0 });
    context.textAlign = 'right';
    for (let y = Math.ceil(box.y0 / step) * step; y <= box.y1; y += step) label(formatMetres(y), { x: nearX, y, z: 0 }, -6, 12);
    context.textAlign = 'left';
    for (let z = step; z <= box.z1; z += step) label(formatMetres(z), { x: farX, y: farY, z }, 4, -2);
    const origin = frame.project({ x: 0, y: 0, z: 0 });
    context.strokeStyle = colors.muted;
    context.beginPath();
    context.moveTo(origin.x - 6, origin.y); context.lineTo(origin.x + 6, origin.y);
    context.moveTo(origin.x, origin.y - 6); context.lineTo(origin.x, origin.y + 6);
    context.stroke();
    label('E', { x: box.x1, y: nearY, z: 0 }, 6, 24);
    label('N', { x: nearX, y: box.y1, z: 0 }, 6, 24);
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
      point => onPlane(point, { fixed: 'z', value: 0 }),
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
  /** The selected item's points above the ground: a microphone, a blast, or a channel's ends. */
  function selectedPoints() {
    if (selection?.type === 'receiver') {
      const receiver = scene.receivers.find(item => item.id === selection.id);
      return receiver ? [receiver.positionMetres] : [];
    }
    const emitter = selection?.type === 'emitter' ? scene.emitters.find(item => item.id === selection.id) : null;
    if (!emitter || emitter.kind === 'storm') return [];
    const points = emitter.kind === 'blast' ? [emitter.positionMetres] : [emitter.baseMetres, emitter.topMetres];
    return points.filter(point => point.z > 0);
  }

  function drawShadowBoundary(context, colors) {
    const profile = soundSpeedProfile(scene.air);
    const receiver = focus?.();
    if (!(profile.gradient < 0) || !receiver) return;
    const chosen = selection?.type === 'emitter' ? scene.emitters.filter(emitter => emitter.id === selection.id) : scene.emitters.filter(emitter => emitter.enabled);
    const points = chosen.flatMap(emitterPoints);
    if (!points.length) return;
    const stride = Math.ceil(points.length / BOUNDARY_POINTS);
    const reach = grazingRange(profile, receiver.positionMetres.z);
    const origin = frame.project({ x: 0, y: 0, z: 0 });
    const east = frame.project({ x: 1, y: 0, z: 0 });
    const north = frame.project({ x: 0, y: 1, z: 0 });
    const toScreen = (x, y) => ({ x: origin.x + x * (east.x - origin.x) + y * (north.x - origin.x), y: origin.y + x * (east.y - origin.y) + y * (north.y - origin.y) });
    const path = new Path2D();
    for (let index = 0; index < points.length; index += stride) {
      const point = points[index];
      const radius = grazingRange(profile, point.z) + reach;
      addPolygon(path, Array.from({ length: OUTLINE_STEPS }, (_, step) => {
        const angle = 2 * Math.PI * step / OUTLINE_STEPS;
        return toScreen(point.x + radius * Math.cos(angle), point.y + radius * Math.sin(angle));
      }));
    }
    context.save();
    context.clip(floorPath());
    unionOutline(context, path, colors.muted, { fillAlpha: 0, edgeAlpha: BOUNDARY_EDGE_ALPHA });
    context.restore();
  }

  /**
   * The wavefronts where they cross the floor and the two far walls, as ripples: each sampled
   * source's sphere meets a plane in a circle, and the outline of their union is drawn with fading
   * rings behind it, only within the face, so a front leaves no trace once it has passed. On the
   * floor the circle stops at the shadow boundary.
   */
  function drawWavefronts(context, colors, wavefronts) {
    const { profile, spheres } = wavefronts;
    const { box, farX, farY } = frame;
    const faces = [
      { fixed: 'z', value: 0, axes: ['x', 'y'], corners: [[box.x0, box.y0], [box.x1, box.y0], [box.x1, box.y1], [box.x0, box.y1]] },
      { fixed: 'x', value: farX, axes: ['y', 'z'], corners: [[box.y0, 0], [box.y1, 0], [box.y1, box.z1], [box.y0, box.z1]] },
      { fixed: 'y', value: farY, axes: ['x', 'z'], corners: [[box.x0, 0], [box.x1, 0], [box.x1, box.z1], [box.x0, box.z1]] }
    ];
    const spacing = Math.max(box.x1 - box.x0, box.y1 - box.y0, box.z1) * RIPPLE_SPACING_SHARE;
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

  /** Dashed lines from a selected point down to the floor and across to the walls, to its shadows there. */
  function drawProjectionLines(context, colors, point) {
    const { farX, farY } = frame;
    const floor = { ...point, z: 0 };
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
    context.fillStyle = colors.cloud;
    polygon(context, ring(emitter.cloudBaseMetres)); context.fill();
    polygon(context, ring(emitter.cloudTopMetres)); context.fill();
    context.strokeStyle = selected ? colors.accent : colors.line;
    context.lineWidth = 1;
    polygon(context, ring(0)); context.stroke();
  }

  function drawBlast(context, emitter, colors, state) {
    const centre = frame.project(emitter.positionMetres);
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
    const front = state?.fronts.get(emitter.id);
    if (front && !state.wavefronts) {
      const middle = frame.project(front.centre);
      context.strokeStyle = colors.accent;
      context.globalAlpha = .5;
      context.beginPath(); context.arc(middle.x, middle.y, front.radiusMetres * frame.scale, 0, 2 * Math.PI); context.stroke();
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
      const base = frame.project(owner.positionMetres);
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
      context.fillStyle = colors.muted;
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

    drawBox(context, colors);
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
    for (const point of selectedPoints()) drawProjectionLines(context, colors, point);
    for (const receiver of scene.receivers) {
      const level = state?.receivers.get(receiver.id) ?? 0;
      if (level > 0) {
        const p = frame.project(receiver.positionMetres);
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
      const a = frame.project(receiver.positionMetres);
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
      const anchor = emitter.kind === 'blast' ? emitter.positionMetres : emitter.kind === 'storm' ? emitter.centreMetres : emitter.topMetres;
      const p = frame.project(anchor);
      context.fillText(emitter.name, p.x + 9, p.y - 8);
    }
    for (const receiver of scene.receivers) {
      const p = frame.project(receiver.positionMetres);
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
    if (finished.kind === 'point') onCommit(finished);
    else { onView(view); frame = null; draw(); }
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
