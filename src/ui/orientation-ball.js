import { fitCanvas, palette } from './canvas.js';

const MARGIN = 14;
const HIT_RADIUS = 12;
const ROTATE_RADIANS_PER_PIXEL = .012;
const PITCH_RANGE = Object.freeze([-1.4, 1.4]);
const CIRCLE_POINTS = 72;
const toRadians = degrees => degrees * Math.PI / 180;
const toDegrees = radians => radians * 180 / Math.PI;

/** A unit look direction (east, north, up) from compass heading and elevation in degrees. */
export function lookDirection(headingDegrees, pitchDegrees) {
  const heading = toRadians(headingDegrees);
  const pitch = toRadians(pitchDegrees);
  return { x: Math.sin(heading) * Math.cos(pitch), y: Math.cos(heading) * Math.cos(pitch), z: Math.sin(pitch) };
}

/**
 * A small turnable sphere showing a microphone's orientation: the horizon with the compass points,
 * two meridians, and the look direction. Drag the arrow's tip to aim; drag elsewhere to turn the
 * sphere.
 */
export function createOrientationBall(canvas, { headingDegrees, pitchDegrees, onChange, onCommit }) {
  let orientation = { headingDegrees, pitchDegrees };
  let view = { yaw: -.55, pitch: .4 };
  let drag = null;
  let geometry = null;

  function project(point) {
    const { cx, cy, radius } = geometry;
    const a = Math.cos(view.yaw) * point.x - Math.sin(view.yaw) * point.y;
    const b = Math.sin(view.yaw) * point.x + Math.cos(view.yaw) * point.y;
    return {
      x: cx + a * radius,
      y: cy - (point.z * Math.cos(view.pitch) + b * Math.sin(view.pitch)) * radius,
      depth: b * Math.cos(view.pitch) - point.z * Math.sin(view.pitch)
    };
  }

  /** The point on the sphere's near side under a screen point, as a unit vector. */
  function unproject(x, y) {
    const { cx, cy, radius } = geometry;
    let a = (x - cx) / radius;
    let up = (cy - y) / radius;
    const length = Math.hypot(a, up);
    if (length > 1) { a /= length; up /= length; }
    const depth = -Math.sqrt(Math.max(0, 1 - a * a - up * up));
    const b = up * Math.sin(view.pitch) + depth * Math.cos(view.pitch);
    const z = up * Math.cos(view.pitch) - depth * Math.sin(view.pitch);
    return { x: Math.cos(view.yaw) * a + Math.sin(view.yaw) * b, y: -Math.sin(view.yaw) * a + Math.cos(view.yaw) * b, z };
  }

  function circle(context, pointAt, front, back) {
    let previous = null;
    for (let index = 0; index <= CIRCLE_POINTS; index += 1) {
      const p = project(pointAt(2 * Math.PI * index / CIRCLE_POINTS));
      if (previous) {
        context.strokeStyle = p.depth + previous.depth > 0 ? back : front;
        context.beginPath(); context.moveTo(previous.x, previous.y); context.lineTo(p.x, p.y); context.stroke();
      }
      previous = p;
    }
  }

  function draw() {
    if (!canvas.isConnected || canvas.clientWidth < 2 * MARGIN) return;
    const { context, width, height } = fitCanvas(canvas);
    const colors = palette();
    geometry = { cx: width / 2, cy: height / 2, radius: Math.min(width, height) / 2 - MARGIN };
    const { cx, cy, radius } = geometry;
    context.fillStyle = colors.wall;
    context.beginPath(); context.arc(cx, cy, radius, 0, 2 * Math.PI); context.fill();
    context.lineWidth = 1;
    circle(context, t => ({ x: Math.cos(t), y: Math.sin(t), z: 0 }), colors.muted, colors.grid);
    circle(context, t => ({ x: 0, y: Math.cos(t), z: Math.sin(t) }), colors.line, colors.grid);
    circle(context, t => ({ x: Math.cos(t), y: 0, z: Math.sin(t) }), colors.line, colors.grid);
    context.font = '10px system-ui, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    for (const [label, point] of [['N', { x: 0, y: 1.18, z: 0 }], ['E', { x: 1.18, y: 0, z: 0 }], ['S', { x: 0, y: -1.18, z: 0 }], ['W', { x: -1.18, y: 0, z: 0 }]]) {
      const p = project(point);
      context.fillStyle = p.depth > 0 ? colors.faint : colors.muted;
      context.fillText(label, p.x, p.y);
    }
    const tip = project(lookDirection(orientation.headingDegrees, orientation.pitchDegrees));
    context.strokeStyle = colors.end;
    context.fillStyle = colors.end;
    context.globalAlpha = tip.depth > 0 ? .45 : 1;
    context.lineWidth = 2;
    context.beginPath(); context.moveTo(cx, cy); context.lineTo(tip.x, tip.y); context.stroke();
    context.beginPath(); context.arc(tip.x, tip.y, 5, 0, 2 * Math.PI); context.fill();
    context.globalAlpha = 1;
    context.fillStyle = colors.receiver;
    context.beginPath(); context.arc(cx, cy, 2.5, 0, 2 * Math.PI); context.fill();
  }

  function local(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  canvas.addEventListener('pointerdown', event => {
    if (!geometry) return;
    const { x, y } = local(event);
    const tip = project(lookDirection(orientation.headingDegrees, orientation.pitchDegrees));
    drag = Math.hypot(tip.x - x, tip.y - y) <= HIT_RADIUS ? { kind: 'aim' } : { kind: 'turn', x, y, view: { ...view } };
    canvas.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  canvas.addEventListener('pointermove', event => {
    const { x, y } = local(event);
    if (!drag) {
      if (geometry) {
        const tip = project(lookDirection(orientation.headingDegrees, orientation.pitchDegrees));
        canvas.style.cursor = Math.hypot(tip.x - x, tip.y - y) <= HIT_RADIUS ? 'grab' : 'move';
      }
      return;
    }
    if (drag.kind === 'turn') {
      const [low, high] = PITCH_RANGE;
      view = { yaw: drag.view.yaw - (x - drag.x) * ROTATE_RADIANS_PER_PIXEL, pitch: Math.min(high, Math.max(low, drag.view.pitch + (y - drag.y) * ROTATE_RADIANS_PER_PIXEL)) };
      draw();
      return;
    }
    const direction = unproject(x, y);
    orientation = {
      headingDegrees: Math.round((toDegrees(Math.atan2(direction.x, direction.y)) + 360) % 360),
      pitchDegrees: Math.round(toDegrees(Math.asin(Math.max(-1, Math.min(1, direction.z)))))
    };
    draw();
    onChange(orientation.headingDegrees, orientation.pitchDegrees);
  });
  const finish = () => {
    if (drag?.kind === 'aim') onCommit(orientation.headingDegrees, orientation.pitchDegrees);
    drag = null;
  };
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', finish);
  new ResizeObserver(draw).observe(canvas);

  return {
    set(next) {
      orientation = { ...next };
      draw();
    }
  };
}
