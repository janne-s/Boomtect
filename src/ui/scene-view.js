import { MAXIMUM_HEIGHT_METRES, SCENE_EXTENT_METRES } from '../domain/constants.js';
import { lightningChannelPoints } from '../domain/emitters.js';
import { fitCanvas, formatMetres, niceStep, palette } from './canvas.js';

const MARGIN = 32;
const HANDLE_RADIUS = 5;
const HIT_RADIUS = 11;
const MINIMUM_SPAN_METRES = 50;
/** Axis labels stay below the view caption. */
const LABEL_CLEARANCE = 26;

const channelCache = new Map();

/** The channel polyline of a lightning emitter, cached by the parameters that shape it. */
export function channelPoints(emitter) {
  const key = JSON.stringify([emitter.baseMetres, emitter.topMetres, emitter.segmentLengthMetres, emitter.tortuosityDegrees, emitter.seed]);
  const cached = channelCache.get(emitter.id);
  if (cached?.key === key) return cached.points;
  let points;
  try { points = lightningChannelPoints(emitter); } catch { points = [emitter.baseMetres, emitter.topMetres]; }
  channelCache.set(emitter.id, { key, points });
  return points;
}

/** Draggable points of a scene: blast positions, channel ends, and receivers. */
function handles(scene) {
  const list = [];
  for (const emitter of scene.emitters) {
    if (emitter.kind === 'blast') list.push({ type: 'emitter', id: emitter.id, field: 'positionMetres', point: emitter.positionMetres });
    else {
      list.push({ type: 'emitter', id: emitter.id, field: 'baseMetres', point: emitter.baseMetres });
      list.push({ type: 'emitter', id: emitter.id, field: 'topMetres', point: emitter.topMetres });
    }
  }
  for (const receiver of scene.receivers) list.push({ type: 'receiver', id: receiver.id, field: 'positionMetres', point: receiver.positionMetres });
  return list;
}

/**
 * One projection of the 3D scene: elevation (x horizontal, z up) or plan (x east, y north).
 * Equal metres per pixel on both axes. The frame is fixed while a point is dragged.
 */
export function createSceneView(canvas, { vertical, onSelect, onMove, onCommit }) {
  let scene = null;
  let selection = null;
  let frame = null;
  let drag = null;
  let animation = null;

  function bounds() {
    const xs = [];
    const vs = [];
    const include = point => { xs.push(point.x); vs.push(point[vertical]); };
    for (const emitter of scene.emitters) {
      if (emitter.kind === 'blast') include(emitter.positionMetres);
      else channelPoints(emitter).forEach(include);
    }
    scene.receivers.forEach(receiver => include(receiver.positionMetres));
    if (vertical === 'z') vs.push(0);
    let minX = Math.min(...xs); let maxX = Math.max(...xs);
    let minV = Math.min(...vs); let maxV = Math.max(...vs);
    const grow = (low, high) => {
      const middle = (low + high) / 2;
      const half = Math.max(MINIMUM_SPAN_METRES, high - low) / 2;
      return [middle - half, middle + half];
    };
    [minX, maxX] = grow(minX, maxX);
    if (vertical === 'z') maxV = Math.max(MINIMUM_SPAN_METRES, maxV);
    else [minV, maxV] = grow(minV, maxV);
    if (vertical === 'z') minV = 0;
    return { minX, maxX, minV, maxV };
  }

  function computeFrame(width, height) {
    const { minX, maxX, minV, maxV } = bounds();
    const bottom = vertical === 'z' ? height - MARGIN : height / 2;
    const usableHeight = height - 2 * MARGIN;
    const scale = Math.min((width - 2 * MARGIN) / ((maxX - minX) * 1.08), usableHeight / ((maxV - minV) * 1.08));
    const centreX = (minX + maxX) / 2;
    const anchorV = vertical === 'z' ? 0 : (minV + maxV) / 2;
    return {
      scale,
      toScreen: point => ({ x: width / 2 + (point.x - centreX) * scale, y: bottom - (point[vertical] - anchorV) * scale }),
      toWorld: (x, y) => ({ x: centreX + (x - width / 2) / scale, v: anchorV + (bottom - y) / scale })
    };
  }

  function draw() {
    if (!scene) return;
    const { context, width, height } = fitCanvas(canvas);
    const colors = palette();
    if (!drag || !frame) frame = computeFrame(width, height);
    const { toScreen, toWorld, scale } = frame;
    const state = animation?.() ?? null;

    drawGrid(context, width, height, colors, toWorld, toScreen, scale);

    for (const emitter of scene.emitters) {
      const selected = selection?.type === 'emitter' && selection.id === emitter.id;
      const flash = state?.flash.get(emitter.id) ?? 0;
      const alpha = emitter.enabled ? 1 : .35;
      context.globalAlpha = alpha;
      if (emitter.kind === 'lightning') {
        const points = channelPoints(emitter).map(toScreen);
        context.lineJoin = 'round';
        if (flash > 0) {
          context.shadowColor = colors.accent;
          context.shadowBlur = 24 * flash;
          context.strokeStyle = colors.ink;
          context.lineWidth = 1.5 + 2.5 * flash;
          strokePolyline(context, points);
          context.shadowBlur = 0;
        }
        context.strokeStyle = selected ? colors.accent : colors.muted;
        context.lineWidth = selected ? 1.6 : 1.1;
        strokePolyline(context, points);
        drawHandle(context, toScreen(emitter.baseMetres), selected ? colors.accent : colors.muted, false);
        drawHandle(context, toScreen(emitter.topMetres), selected ? colors.accent : colors.muted, false);
      } else {
        const centre = toScreen(emitter.positionMetres);
        if (flash > 0) {
          context.fillStyle = colors.ink;
          context.shadowColor = colors.accent;
          context.shadowBlur = 30 * flash;
          context.beginPath(); context.arc(centre.x, centre.y, 4 + 10 * flash, 0, 2 * Math.PI); context.fill();
          context.shadowBlur = 0;
        }
        const front = state?.fronts.get(emitter.id);
        if (front) {
          context.strokeStyle = colors.accent;
          context.globalAlpha = alpha * front.opacity;
          context.lineWidth = 1;
          context.beginPath(); context.arc(centre.x, centre.y, front.radiusMetres * scale, 0, 2 * Math.PI); context.stroke();
          context.globalAlpha = alpha;
        }
        drawHandle(context, centre, selected ? colors.accent : colors.muted, true);
      }
      context.globalAlpha = 1;
      label(context, emitter.name, toScreen(emitter.kind === 'blast' ? emitter.positionMetres : emitter.topMetres), colors.faint);
    }

    for (const receiver of scene.receivers) {
      const selected = selection?.type === 'receiver' && selection.id === receiver.id;
      const centre = toScreen(receiver.positionMetres);
      const level = state?.receivers.get(receiver.id) ?? 0;
      if (level > 0) {
        context.fillStyle = colors.accent;
        context.globalAlpha = .25 + .5 * level;
        context.beginPath(); context.arc(centre.x, centre.y, 6 + 14 * level, 0, 2 * Math.PI); context.fill();
        context.globalAlpha = 1;
      }
      context.fillStyle = selected ? colors.accent : colors.secondary;
      context.beginPath();
      context.moveTo(centre.x, centre.y - 7); context.lineTo(centre.x + 6, centre.y + 4); context.lineTo(centre.x - 6, centre.y + 4);
      context.closePath(); context.fill();
      label(context, receiver.name, centre, colors.faint);
    }
  }

  function drawGrid(context, width, height, colors, toWorld, toScreen, scale) {
    const step = niceStep(width / scale, 6);
    const topLeft = toWorld(0, 0);
    const bottomRight = toWorld(width, height);
    context.font = '10px system-ui, sans-serif';
    context.lineWidth = 1;
    context.strokeStyle = colors.raised;
    context.fillStyle = colors.faint;
    for (let x = Math.ceil(topLeft.x / step) * step; x <= bottomRight.x; x += step) {
      const screen = toScreen({ x, [vertical]: 0 }).x;
      context.beginPath(); context.moveTo(screen, 0); context.lineTo(screen, height); context.stroke();
      context.fillText(formatMetres(x), screen + 3, height - 6);
    }
    for (let v = Math.ceil(bottomRight.v / step) * step; v <= topLeft.v; v += step) {
      if (vertical === 'z' && v < 0) continue;
      const screen = toScreen({ x: 0, [vertical]: v }).y;
      context.beginPath(); context.moveTo(0, screen); context.lineTo(width, screen); context.stroke();
      if (screen > LABEL_CLEARANCE) context.fillText(formatMetres(v), 4, screen - 3);
    }
    if (vertical === 'z') {
      const ground = toScreen({ x: 0, z: 0 }).y;
      context.fillStyle = colors.ground;
      context.fillRect(0, ground, width, height - ground);
      context.strokeStyle = colors.line;
      context.beginPath(); context.moveTo(0, ground); context.lineTo(width, ground); context.stroke();
    }
  }

  function hit(x, y) {
    const { toScreen } = frame;
    let best = null;
    for (const handle of handles(scene)) {
      const screen = toScreen(handle.point);
      const distance = Math.hypot(screen.x - x, screen.y - y);
      if (distance <= HIT_RADIUS && (!best || distance < best.distance)) best = { ...handle, distance };
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
    if (!target) return;
    onSelect({ type: target.type, id: target.id });
    drag = target;
    canvas.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  canvas.addEventListener('pointermove', event => {
    if (!scene || !frame) return;
    const { x, y } = localPoint(event);
    if (!drag) {
      canvas.style.cursor = hit(x, y) ? 'grab' : 'default';
      return;
    }
    const world = frame.toWorld(x, y);
    const clamp = (value, limit, minimum = -limit) => Math.min(limit, Math.max(minimum, value));
    const point = {
      ...drag.point,
      x: Math.round(clamp(world.x, SCENE_EXTENT_METRES)),
      [vertical]: vertical === 'z'
        ? Math.round(clamp(world.v, MAXIMUM_HEIGHT_METRES, 0) * 10) / 10
        : Math.round(clamp(world.v, SCENE_EXTENT_METRES))
    };
    drag.point = point;
    onMove(drag, point);
  });
  const finish = () => {
    if (!drag) return;
    const committed = drag;
    drag = null;
    onCommit(committed);
  };
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', finish);
  new ResizeObserver(() => { frame = null; draw(); }).observe(canvas);

  return {
    update(nextScene, nextSelection) {
      scene = nextScene;
      selection = nextSelection;
      if (!drag) frame = null;
      draw();
    },
    draw,
    setAnimation(source) { animation = source; }
  };
}

function strokePolyline(context, points) {
  context.beginPath();
  points.forEach((point, index) => (index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y)));
  context.stroke();
}

function drawHandle(context, point, color, filled) {
  context.beginPath();
  context.arc(point.x, point.y, HANDLE_RADIUS, 0, 2 * Math.PI);
  context.lineWidth = 1.5;
  context.strokeStyle = color;
  context.fillStyle = color;
  if (filled) context.fill(); else context.stroke();
}

function label(context, text, point, color) {
  context.font = '11px system-ui, sans-serif';
  context.fillStyle = color;
  context.fillText(text, point.x + 9, point.y - 8);
}
