import { PATH_DIRECT, PATH_SHADOW } from '../domain/refraction.js';
import { fitCanvas, formatSeconds, niceStep, palette } from './canvas.js';

const LEFT = 8;
const RIGHT = 8;
const TOP = 22;
const BOTTOM = 20;
/** Opacity of microphones other than the solo one, of muted ones, and of the rest, which may overlap. */
const DIMMED = .4;
const MUTED = .35;
const OVERLAPPING = .6;
const SOLO = .85;

/** Scene-time window of a result: from its first rendered sample to its last. */
function resultWindow(result) {
  return { start: result.startSeconds, end: result.startSeconds + result.samples.length / result.sampleRate };
}

/** The window covering every result, so all microphones share one time axis. */
function sharedWindow(traces) {
  const windows = traces.map(trace => resultWindow(trace.result));
  return { start: Math.min(...windows.map(window => window.start)), end: Math.max(...windows.map(window => window.end)) };
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

/**
 * How a microphone's trace is drawn: each in its own color, the solo one opaque over the dimmed
 * rest, or with none soloed the listening ones slightly transparent so that overlaps show, over
 * the muted ones. Emphasized traces are drawn last. A single microphone keeps the plain colors.
 */
function traceStyles(traces, soloId, colors) {
  const single = traces.length === 1;
  return traces
    .map(trace => {
      const emphasized = soloId ? trace.id === soloId : trace.listening;
      const alpha = single ? 1 : soloId ? (emphasized ? SOLO : DIMMED) : emphasized ? OVERLAPPING : MUTED;
      return { trace, emphasized, single, color: single ? colors.ink : colors.mics[trace.index % colors.mics.length], alpha };
    })
    .sort((a, b) => Number(a.emphasized) - Number(b.emphasized));
}

/**
 * Draws the static part of a plot once per key into a backing canvas and copies it on every
 * animation frame, so the playhead does not rescan the signal.
 */
const cache = new WeakMap();

function cachedPlot(canvas, key, drawStatic, playheadSeconds) {
  const { context, width, height } = fitCanvas(canvas);
  const ratio = window.devicePixelRatio || 1;
  const fullKey = `${key}|${width}x${height}@${ratio}`;
  let entry = cache.get(canvas);
  if (entry?.key !== fullKey) {
    const backing = document.createElement('canvas');
    backing.width = canvas.width;
    backing.height = canvas.height;
    const backingContext = backing.getContext('2d');
    backingContext.setTransform(ratio, 0, 0, ratio, 0, 0);
    const window = drawStatic(backingContext, width, height);
    entry = { key: fullKey, backing, window };
    cache.set(canvas, entry);
  }
  context.drawImage(entry.backing, 0, 0, width, height);
  if (entry.window) playhead(context, width, height, entry.window, playheadSeconds, palette());
}

/**
 * Min/max envelope of each microphone's pressure per pixel column, in pascals, on one time axis
 * and one scale, the largest peak of them all.
 */
export function drawWaveform(canvas, { key, traces, soloId }, playheadSeconds = null) {
  cachedPlot(canvas, key, (context, width, height) => {
    const live = traces.filter(trace => trace.result?.samples.length);
    if (!live.length) return null;
    const colors = palette();
    const window = sharedWindow(live);
    timeAxis(context, width, height, window, colors);
    // One scale for every microphone, so their levels compare; a solo only brings one forward.
    const peakPa = Math.max(...live.map(trace => trace.result.peakPa));
    const middle = (TOP + height - BOTTOM) / 2;
    const half = (height - BOTTOM - TOP) / 2;
    const columns = width - LEFT - RIGHT;
    const span = window.end - window.start;
    const y = value => middle - Math.max(-1, Math.min(1, value / peakPa)) * half;
    context.strokeStyle = colors.line;
    context.beginPath(); context.moveTo(LEFT, middle); context.lineTo(width - RIGHT, middle); context.stroke();
    // Overlapping microphones add up like light, so one stays visible through another.
    context.globalCompositeOperation = live.length > 1 ? 'screen' : 'source-over';
    for (const { trace, color, alpha } of traceStyles(live, soloId, colors)) {
      const { samples, sampleRate, startSeconds } = trace.result;
      context.strokeStyle = color;
      context.globalAlpha = alpha;
      context.beginPath();
      for (let column = 0; column < columns; column += 1) {
        const from = Math.max(0, Math.floor((window.start + column / columns * span - startSeconds) * sampleRate));
        const to = Math.min(samples.length, Math.max(from + 1, Math.floor((window.start + (column + 1) / columns * span - startSeconds) * sampleRate)));
        if (from >= samples.length || to <= 0) continue;
        let low = Infinity;
        let high = -Infinity;
        for (let index = from; index < to; index += 1) {
          if (samples[index] < low) low = samples[index];
          if (samples[index] > high) high = samples[index];
        }
        const x = LEFT + column + .5;
        context.moveTo(x, y(high));
        context.lineTo(x, y(low) + .5);
      }
      context.stroke();
    }
    context.globalCompositeOperation = 'source-over';
    context.globalAlpha = 1;
    context.fillStyle = colors.faint;
    context.fillText(`±${peakPa.toPrecision(3)} Pa`, width - RIGHT - 70, TOP - 6);
    return window;
  }, playheadSeconds);
}

const COMPASS = Object.freeze(['N', 'E', 'S', 'W', 'N']);

/**
 * Every path's arrival time for each microphone against its source height, or with `byDirection`
 * against the compass direction it comes from, north at the top and again at the bottom; ground
 * paths and echoes in the secondary color.
 */
export function drawArrivals(canvas, { key, traces, soloId, byDirection = false }, playheadSeconds = null) {
  cachedPlot(canvas, key, (context, width, height) => {
    const live = traces.filter(trace => trace.result?.arrivals?.count);
    if (!live.length) return null;
    const colors = palette();
    const window = sharedWindow(live);
    timeAxis(context, width, height, window, colors);
    let maximumHeight = 1;
    let strongest = -Infinity;
    for (const { result: { arrivals } } of live) {
      for (let index = 0; index < arrivals.count; index += 1) {
        maximumHeight = Math.max(maximumHeight, arrivals.heights[index]);
        strongest = Math.max(strongest, arrivals.levels[index]);
      }
    }
    const plotWidth = width - LEFT - RIGHT;
    const plotHeight = height - TOP - BOTTOM;
    const vertical = (arrivals, index) => (byDirection ? arrivals.bearings[index] / 360 : 1 - arrivals.heights[index] / maximumHeight);
    if (byDirection) {
      context.fillStyle = colors.faint;
      context.strokeStyle = colors.raised;
      COMPASS.forEach((label, quarter) => {
        const y = TOP + quarter / 4 * plotHeight;
        context.beginPath(); context.moveTo(LEFT, y); context.lineTo(width - RIGHT, y); context.stroke();
        if (quarter > 0 && quarter < 4) context.fillText(label, LEFT + 3, y - 3);
      });
    }
    for (const { trace, single, color, alpha } of traceStyles(live, soloId, colors)) {
      const { arrivals } = trace.result;
      // Ground reflections and echoes behind, in the secondary color or at half strength of the microphone's color.
      for (const reflected of [true, false]) {
        context.fillStyle = single ? (reflected ? colors.reflected : colors.direct) : color;
        const strength = !single && reflected ? alpha / 2 : alpha;
        for (let index = 0; index < arrivals.count; index += 1) {
          if ((arrivals.kinds[index] !== PATH_DIRECT && arrivals.kinds[index] !== PATH_SHADOW) !== reflected) continue;
          const x = LEFT + (arrivals.seconds[index] - window.start) / (window.end - window.start) * plotWidth;
          const y = TOP + vertical(arrivals, index) * plotHeight;
          context.globalAlpha = strength * Math.max(.12, Math.min(1, 1 + (arrivals.levels[index] - strongest) / 40));
          context.fillRect(x - 1, y - 1, 2, 2);
        }
      }
    }
    context.globalAlpha = 1;
    context.fillStyle = colors.faint;
    if (!byDirection) context.fillText(`${Math.round(maximumHeight)} m`, width - RIGHT - 50, TOP - 6);
    return window;
  }, playheadSeconds);
}
