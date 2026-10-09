import { fitCanvas, formatSeconds, niceStep, palette } from './canvas.js';

const LEFT = 8;
const RIGHT = 8;
const TOP = 22;
const BOTTOM = 20;

/** Scene-time window of a result: from its first rendered sample to its last. */
export function resultWindow(result) {
  return { start: result.startSeconds, end: result.startSeconds + result.samples.length / result.sampleRate };
}

function timeAxis(context, width, height, window, colors) {
  const span = window.end - window.start;
  const step = niceStep(span, Math.max(2, Math.floor(width / 90)));
  context.font = '10px system-ui, sans-serif';
  context.fillStyle = colors.faint;
  context.strokeStyle = colors.raised;
  for (let t = Math.ceil(window.start / step) * step; t <= window.end; t += step) {
    const x = LEFT + (t - window.start) / span * (width - LEFT - RIGHT);
    context.beginPath(); context.moveTo(x, TOP); context.lineTo(x, height - BOTTOM); context.stroke();
    context.fillText(formatSeconds(t), x + 3, height - 6);
  }
}

function playhead(context, width, height, window, seconds, colors) {
  if (seconds == null || seconds < window.start || seconds > window.end) return;
  const x = LEFT + (seconds - window.start) / (window.end - window.start) * (width - LEFT - RIGHT);
  context.strokeStyle = colors.accent;
  context.beginPath(); context.moveTo(x, TOP); context.lineTo(x, height - BOTTOM); context.stroke();
}

/** Min/max envelope of the pressure signal per pixel column, in pascals. */
export function drawWaveform(canvas, result, playheadSeconds = null) {
  const { context, width, height } = fitCanvas(canvas);
  const colors = palette();
  if (!result?.samples.length) return;
  const window = resultWindow(result);
  timeAxis(context, width, height, window, colors);
  const { samples, peakPa } = result;
  const middle = (TOP + height - BOTTOM) / 2;
  const half = (height - BOTTOM - TOP) / 2;
  const columns = width - LEFT - RIGHT;
  context.strokeStyle = colors.ink;
  context.beginPath();
  for (let column = 0; column < columns; column += 1) {
    const from = Math.floor(column / columns * samples.length);
    const to = Math.max(from + 1, Math.floor((column + 1) / columns * samples.length));
    let low = Infinity;
    let high = -Infinity;
    for (let index = from; index < to && index < samples.length; index += 1) {
      if (samples[index] < low) low = samples[index];
      if (samples[index] > high) high = samples[index];
    }
    const x = LEFT + column + .5;
    context.moveTo(x, middle - high / peakPa * half);
    context.lineTo(x, middle - low / peakPa * half + .5);
  }
  context.stroke();
  context.strokeStyle = colors.line;
  context.beginPath(); context.moveTo(LEFT, middle); context.lineTo(width - RIGHT, middle); context.stroke();
  context.fillStyle = colors.faint;
  context.fillText(`±${peakPa.toPrecision(3)} Pa`, width - RIGHT - 70, TOP - 6);
  playhead(context, width, height, window, playheadSeconds, colors);
}

/** Every path's arrival time against its source height; ground paths in the secondary color. */
export function drawArrivals(canvas, result, playheadSeconds = null) {
  const { context, width, height } = fitCanvas(canvas);
  const colors = palette();
  const arrivals = result?.arrivals;
  if (!arrivals?.count) return;
  const window = resultWindow(result);
  timeAxis(context, width, height, window, colors);
  let maximumHeight = 1;
  let strongest = -Infinity;
  for (let index = 0; index < arrivals.count; index += 1) {
    maximumHeight = Math.max(maximumHeight, arrivals.heights[index]);
    strongest = Math.max(strongest, arrivals.levels[index]);
  }
  const plotWidth = width - LEFT - RIGHT;
  const plotHeight = height - TOP - BOTTOM;
  for (const kind of [1, 0]) {
    context.fillStyle = kind === 0 ? colors.direct : colors.reflected;
    for (let index = 0; index < arrivals.count; index += 1) {
      if (arrivals.kinds[index] !== kind) continue;
      const x = LEFT + (arrivals.seconds[index] - window.start) / (window.end - window.start) * plotWidth;
      const y = height - BOTTOM - arrivals.heights[index] / maximumHeight * plotHeight;
      context.globalAlpha = Math.max(.12, Math.min(1, 1 + (arrivals.levels[index] - strongest) / 40));
      context.fillRect(x - 1, y - 1, 2, 2);
    }
  }
  context.globalAlpha = 1;
  context.fillStyle = colors.faint;
  context.fillText(`${Math.round(maximumHeight)} m`, width - RIGHT - 50, TOP - 6);
  playhead(context, width, height, window, playheadSeconds, colors);
}
