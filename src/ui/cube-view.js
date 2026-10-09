import { MAXIMUM_HEIGHT_METRES, SCENE_EXTENT_METRES } from '../domain/constants.js';
import { fitCanvas, formatMetres, niceStep, palette } from './canvas.js';
import { cachedFlashes } from './geometry-cache.js';

const MARGIN = 36;
const HANDLE_RADIUS = 5;
const HIT_RADIUS = 10;
const MINIMUM_SPAN_METRES = 100;
const BOX_PADDING = .08;
const ROTATE_RADIANS_PER_PIXEL = .008;
const PITCH_RANGE = Object.freeze([.12, 1.45]);
const ZOOM_RANGE = Object.freeze([.3, 8]);
const ZOOM_PER_WHEEL = 1.0015;
/** Below this screen-space area a plane is seen edge-on and offers no handles. */
const DEGENERATE_AREA = .08;
const DISC_POINTS = 64;
/** Figurative flash: every stroke runs its route in this time, then fades. */
export const FLASH_TRAVERSE_SECONDS = .12;
const FLASH_FADE_SECONDS = .2;

export const DEFAULT_CUBE_VIEW = Object.freeze({ yaw: .62, pitch: .42, zoom: 1 });

/** Draggable points: blast positions, channel ends, storm centres, and receivers. */
function handles(scene) {
  const list = [];
  for (const emitter of scene.emitters) {
    if (emitter.kind === 'blast') list.push({ type: 'emitter', id: emitter.id, field: 'positionMetres', point: emitter.positionMetres, role: 'source' });
    else if (emitter.kind === 'storm') list.push({ type: 'emitter', id: emitter.id, field: 'centreMetres', point: emitter.centreMetres, onGround: true, role: 'start' });
    else {
      list.push({ type: 'emitter', id: emitter.id, field: 'baseMetres', point: emitter.baseMetres, onGround: emitter.flashType === 'cloud-to-ground', role: 'start' });
      list.push({ type: 'emitter', id: emitter.id, field: 'topMetres', point: emitter.topMetres, role: 'end' });
    }
  }
  for (const receiver of scene.receivers) list.push({ type: 'receiver', id: receiver.id, field: 'positionMetres', point: receiver.positionMetres, role: 'receiver' });
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
export function createCubeView(canvas, { onSelect, onMove, onCommit, onView }) {
  let scene = null;
  let selection = null;
  let view = { ...DEFAULT_CUBE_VIEW };
  let frame = null;
  let drag = null;
  let animation = null;

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
    const box = sceneBox();
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
      return { x: width / 2 + p.x * scale, y: height / 2 - p.y * scale, depth: p.depth };
    };
    const farX = sinYaw > 0 ? box.x1 : box.x0;
    const farY = cosYaw > 0 ? box.y1 : box.y0;
    return { box, scale, project, farX, farY, width, height };
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
    if (front) {
      context.strokeStyle = colors.accent;
      context.globalAlpha = .5;
      context.beginPath(); context.arc(centre.x, centre.y, front * frame.scale, 0, 2 * Math.PI); context.stroke();
      context.globalAlpha = 1;
    }
  }

  function drawHandle(context, handle, colors, selected, usable) {
    const color = { start: colors.start, end: colors.end, source: colors.start, receiver: colors.receiver }[handle.role];
    const shadowPlanes = planes().filter(plane => usable.has(plane.name) && !(handle.onGround && plane.fixed === 'z'));
    context.globalAlpha = selected ? .7 : .4;
    for (const plane of shadowPlanes) {
      const p = frame.project(onPlane(handle.point, plane));
      context.fillStyle = color;
      context.beginPath(); context.arc(p.x, p.y, 2.5, 0, 2 * Math.PI); context.fill();
    }
    context.globalAlpha = 1;
    const p = frame.project(handle.point);
    context.fillStyle = color;
    context.strokeStyle = selected ? colors.ink : color;
    context.lineWidth = selected ? 1.5 : 1;
    context.beginPath();
    if (handle.role === 'receiver') {
      context.moveTo(p.x, p.y - 7); context.lineTo(p.x + 6, p.y + 4); context.lineTo(p.x - 6, p.y + 4); context.closePath();
    } else if (handle.role === 'start') {
      context.rect(p.x - HANDLE_RADIUS, p.y - HANDLE_RADIUS, 2 * HANDLE_RADIUS, 2 * HANDLE_RADIUS);
    } else {
      context.arc(p.x, p.y, HANDLE_RADIUS, 0, 2 * Math.PI);
    }
    context.fill();
    if (selected) context.stroke();
  }

  function draw() {
    if (!scene) return;
    const { context, width, height } = fitCanvas(canvas);
    const colors = palette();
    if (!drag || !frame) frame = computeFrame(width, height);
    const state = animation?.() ?? null;
    const usable = new Set(planes().filter(planeUsable).map(plane => plane.name));

    drawBox(context, colors);
    for (const emitter of scene.emitters) {
      const selected = selection?.type === 'emitter' && selection.id === emitter.id;
      context.globalAlpha = emitter.enabled ? 1 : .35;
      if (emitter.kind === 'storm') drawStorm(context, emitter, colors, selected);
      if (emitter.kind === 'blast') drawBlast(context, emitter, colors, state);
      else drawChannels(context, emitter, colors, selected, state?.strokes.get(emitter.id));
      context.globalAlpha = 1;
    }
    for (const receiver of scene.receivers) {
      const level = state?.receivers.get(receiver.id) ?? 0;
      if (level > 0) {
        const p = frame.project(receiver.positionMetres);
        context.fillStyle = colors.accent;
        context.globalAlpha = .2 + .5 * level;
        context.beginPath(); context.arc(p.x, p.y, 6 + 14 * level, 0, 2 * Math.PI); context.fill();
        context.globalAlpha = 1;
      }
    }
    for (const handle of handles(scene)) {
      const selected = selection?.type === handle.type && selection.id === handle.id;
      const owner = handle.type === 'emitter' ? scene.emitters.find(emitter => emitter.id === handle.id) : null;
      context.globalAlpha = owner && !owner.enabled ? .35 : 1;
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
    for (const handle of handles(scene)) {
      const candidates = [{ point: handle.point, plane: { name: 'own', fixed: 'z', value: handle.point.z, free: ['x', 'y'] } }];
      for (const plane of usable) {
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

  canvas.addEventListener('pointerdown', event => {
    if (!scene || !frame) return;
    const { x, y } = localPoint(event);
    const target = hit(x, y);
    canvas.setPointerCapture(event.pointerId);
    event.preventDefault();
    if (target) {
      onSelect({ type: target.type, id: target.id });
      const grabbed = fromScreen(target.plane, onPlane(target.point, target.plane), x, y);
      if (grabbed) drag = { kind: 'point', ...target, origin: { ...target.point }, grabbed };
      else drag = null;
    } else {
      drag = { kind: 'rotate', x, y, view: { ...view } };
    }
  });
  canvas.addEventListener('pointermove', event => {
    if (!scene || !frame) return;
    const { x, y } = localPoint(event);
    if (!drag) {
      canvas.style.cursor = hit(x, y) ? 'grab' : 'move';
      return;
    }
    if (drag.kind === 'rotate') {
      const [low, high] = PITCH_RANGE;
      view = {
        ...view,
        yaw: drag.view.yaw - (x - drag.x) * ROTATE_RADIANS_PER_PIXEL,
        pitch: Math.min(high, Math.max(low, drag.view.pitch + (y - drag.y) * ROTATE_RADIANS_PER_PIXEL))
      };
      frame = null;
      draw();
      return;
    }
    const solved = fromScreen(drag.plane, onPlane(drag.origin, drag.plane), x, y);
    if (!solved) return;
    const clamp = (value, limit, minimum = -limit) => Math.min(limit, Math.max(minimum, value));
    const point = { ...drag.origin };
    for (const axis of drag.plane.free) {
      const moved = drag.origin[axis] + solved[axis] - drag.grabbed[axis];
      if (axis === 'z') {
        if (!drag.onGround) point.z = Math.round(clamp(moved, MAXIMUM_HEIGHT_METRES, 0) * 10) / 10;
      } else point[axis] = Math.round(clamp(moved, SCENE_EXTENT_METRES));
    }
    drag.point = point;
    onMove(drag, point);
  });
  const finish = () => {
    if (!drag) return;
    const finished = drag;
    drag = null;
    if (finished.kind === 'rotate') { onView(view); frame = null; draw(); } else onCommit(finished);
  };
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', finish);
  canvas.addEventListener('wheel', event => {
    event.preventDefault();
    const [low, high] = ZOOM_RANGE;
    view = { ...view, zoom: Math.min(high, Math.max(low, view.zoom * ZOOM_PER_WHEEL ** -event.deltaY)) };
    frame = null;
    draw();
    onView(view);
  }, { passive: false });
  canvas.addEventListener('dblclick', () => {
    view = { ...DEFAULT_CUBE_VIEW };
    frame = null;
    draw();
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
    setView(next) { view = { ...DEFAULT_CUBE_VIEW, ...next }; frame = null; draw(); },
    draw,
    setAnimation(source) { animation = source; }
  };
}
