import { fitCanvas, palette } from './canvas.js';

const MARGIN = 12;
/** Degrees of facing and elevation per pixel of drag on the sphere. */
const DEGREES_PER_PIXEL = .8;
const CIRCLE_POINTS = 72;
const toRadians = degrees => degrees * Math.PI / 180;

/** A unit look direction (east, north, up) from compass heading and elevation in degrees. */
export function lookDirection(headingDegrees, pitchDegrees) {
  const heading = toRadians(headingDegrees);
  const pitch = toRadians(pitchDegrees);
  return { x: Math.sin(heading) * Math.cos(pitch), y: Math.cos(heading) * Math.cos(pitch), z: Math.sin(pitch) };
}

/**
 * A small sphere showing a microphone's orientation from the same angle as the scene box: the
 * horizon with the compass points, two meridians, and the look direction. Dragging across it turns
 * the microphone; dragging up and down tilts it.
 */
export function createOrientationBall(canvas, { getView, onChange, onCommit }) {
  let orientation = null;
  let drag = null;
  let geometry = null;

  function project(point) {
    const { yaw, pitch } = getView();
    const { cx, cy, radius } = geometry;
    const a = Math.cos(yaw) * point.x - Math.sin(yaw) * point.y;
    const b = Math.sin(yaw) * point.x + Math.cos(yaw) * point.y;
    return { x: cx + a * radius, y: cy - (point.z * Math.cos(pitch) + b * Math.sin(pitch)) * radius, depth: b * Math.cos(pitch) - point.z * Math.sin(pitch) };
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
    if (!orientation || !canvas.isConnected || canvas.clientWidth < 2 * MARGIN) return;
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
    for (const [label, point] of [['N', { x: 0, y: 1.2, z: 0 }], ['E', { x: 1.2, y: 0, z: 0 }], ['S', { x: 0, y: -1.2, z: 0 }], ['W', { x: -1.2, y: 0, z: 0 }]]) {
      const p = project(point);
      context.fillStyle = p.depth > 0 ? colors.faint : colors.muted;
      context.fillText(label, p.x, p.y);
    }
    const tip = project(lookDirection(orientation.headingDegrees, orientation.pitchDegrees));
    context.strokeStyle = colors.receiver;
    context.fillStyle = colors.receiver;
    context.globalAlpha = tip.depth > 0 ? .45 : 1;
    context.lineWidth = 2;
    context.beginPath(); context.moveTo(cx, cy); context.lineTo(tip.x, tip.y); context.stroke();
    context.beginPath(); context.arc(tip.x, tip.y, 4, 0, 2 * Math.PI); context.fill();
    context.globalAlpha = 1;
  }

  canvas.addEventListener('pointerdown', event => {
    if (!orientation) return;
    drag = { x: event.clientX, y: event.clientY, start: { ...orientation } };
    try { canvas.setPointerCapture(event.pointerId); } catch { /* The drag still follows the pointer while it stays over the sphere. */ }
    event.preventDefault();
  });
  canvas.addEventListener('pointermove', event => {
    if (!drag) return;
    const headingDegrees = Math.round(((drag.start.headingDegrees + (event.clientX - drag.x) * DEGREES_PER_PIXEL) % 360 + 360) % 360);
    const pitchDegrees = Math.round(Math.min(90, Math.max(-90, drag.start.pitchDegrees - (event.clientY - drag.y) * DEGREES_PER_PIXEL)));
    orientation = { headingDegrees, pitchDegrees };
    draw();
    onChange(headingDegrees, pitchDegrees);
  });
  const finish = () => {
    if (drag) onCommit();
    drag = null;
  };
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', finish);
  new ResizeObserver(draw).observe(canvas);

  return {
    set(next) {
      orientation = next ? { headingDegrees: next.headingDegrees, pitchDegrees: next.pitchDegrees } : null;
      draw();
    },
    draw
  };
}
