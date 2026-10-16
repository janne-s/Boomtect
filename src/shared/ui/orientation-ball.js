import { VIEW } from '../domain/constants.js';
import { fitCanvas, palette } from './canvas.js';

const CIRCLE_POINTS = 72;
const toRadians = degrees => degrees * Math.PI / 180;

function lookDirection(headingDegrees, pitchDegrees) {
  const heading = toRadians(headingDegrees);
  const pitch = toRadians(pitchDegrees);
  return { x: Math.sin(heading) * Math.cos(pitch), y: Math.cos(heading) * Math.cos(pitch), z: Math.sin(pitch) };
}

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

  function headingAt(x, y) {
    const { yaw, pitch } = getView();
    const { cx, cy, radius } = geometry;
    const a = (x - cx) / radius;
    const b = -(y - cy) / radius / Math.max(.05, Math.sin(pitch));
    const east = Math.cos(yaw) * a + Math.sin(yaw) * b;
    const north = -Math.sin(yaw) * a + Math.cos(yaw) * b;
    return Math.round((Math.atan2(east, north) * 180 / Math.PI + 360) % 360);
  }

  const pitchY = pitchDegrees => geometry.top + (90 - pitchDegrees) / 180 * (geometry.bottom - geometry.top);
  const pitchAt = y => Math.round(Math.min(90, Math.max(-90, 90 - (y - geometry.top) / (geometry.bottom - geometry.top) * 180)));
  const onScale = x => x >= geometry.scaleX - VIEW.orientationBall.scaleGrabPixels;

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

  function handle(context, x, y, color, active) {
    context.fillStyle = color;
    context.beginPath(); context.arc(x, y, VIEW.orientationBall.handleRadius, 0, 2 * Math.PI); context.fill();
    if (active) {
      context.strokeStyle = color;
      context.beginPath(); context.arc(x, y, VIEW.orientationBall.handleRadius + 2.5, 0, 2 * Math.PI); context.stroke();
    }
  }

  function draw() {
    if (!orientation || !canvas.isConnected || canvas.clientWidth < 2 * VIEW.orientationBall.marginPixels) return;
    const { context, width, height } = fitCanvas(canvas);
    const colors = palette();
    const radius = Math.min(height, width - VIEW.orientationBall.scaleSpacePixels) / 2 - VIEW.orientationBall.marginPixels;
    geometry = { cx: VIEW.orientationBall.marginPixels + radius, cy: height / 2, radius, scaleX: width - VIEW.orientationBall.scaleSpacePixels / 2, top: height / 2 - radius, bottom: height / 2 + radius };
    const { cx, cy } = geometry;
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
    context.globalAlpha = tip.depth > 0 ? .45 : 1;
    context.lineWidth = 2;
    context.beginPath(); context.moveTo(cx, cy); context.lineTo(tip.x, tip.y); context.stroke();
    context.globalAlpha = 1;
    const facing = project(lookDirection(orientation.headingDegrees, 0));
    context.lineWidth = 1;
    context.globalAlpha = facing.depth > 0 ? .5 : 1;
    handle(context, facing.x, facing.y, colors.accent, drag?.mode === 'heading');
    context.globalAlpha = 1;
    const { scaleX, top, bottom } = geometry;
    context.strokeStyle = colors.line;
    context.lineWidth = 2;
    context.beginPath(); context.moveTo(scaleX, top); context.lineTo(scaleX, bottom); context.stroke();
    context.strokeStyle = colors.muted;
    context.lineWidth = 1;
    context.beginPath(); context.moveTo(scaleX - 5, pitchY(0)); context.lineTo(scaleX + 5, pitchY(0)); context.stroke();
    handle(context, scaleX, pitchY(orientation.pitchDegrees), colors.accent, drag?.mode === 'pitch');
  }

  function apply(event) {
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (drag.mode === 'pitch') orientation = { ...orientation, pitchDegrees: pitchAt(y) };
    else orientation = { ...orientation, headingDegrees: headingAt(x, y) };
    draw();
    onChange(orientation.headingDegrees, orientation.pitchDegrees);
  }

  canvas.addEventListener('pointerdown', event => {
    if (!orientation || !geometry) return;
    const rect = canvas.getBoundingClientRect();
    drag = { mode: onScale(event.clientX - rect.left) ? 'pitch' : 'heading' };
    try { canvas.setPointerCapture(event.pointerId); } catch {}
    event.preventDefault();
    apply(event);
  });
  canvas.addEventListener('pointermove', event => {
    if (!geometry) return;
    if (!drag) {
      canvas.style.cursor = onScale(event.clientX - canvas.getBoundingClientRect().left) ? 'ns-resize' : 'grab';
      return;
    }
    apply(event);
  });
  const finish = () => {
    if (drag) onCommit();
    drag = null;
    draw();
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
