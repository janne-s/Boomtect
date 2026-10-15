import { VIEW } from '../domain/constants.js';
import { PATH_DIRECT, PATH_SHADOW } from '../domain/refraction.js';
import { fitCanvas, formatSeconds, niceStep, palette } from './canvas.js';

function resultWindow(result) {
  return { start: result.startSeconds, end: result.startSeconds + result.samples.length / result.sampleRate };
}

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
    const x = VIEW.plots.leftPixels + (t - window.start) / span * (width - VIEW.plots.leftPixels - VIEW.plots.rightPixels);
    context.beginPath(); context.moveTo(x, VIEW.plots.topPixels); context.lineTo(x, height - VIEW.plots.bottomPixels); context.stroke();
    context.fillText(formatSeconds(t), x + 3, height - 6);
  }
}

function playhead(context, width, height, window, seconds, colors) {
  if (seconds == null || seconds < window.start || seconds > window.end) return;
  const x = VIEW.plots.leftPixels + (seconds - window.start) / (window.end - window.start) * (width - VIEW.plots.leftPixels - VIEW.plots.rightPixels);
  context.strokeStyle = colors.accent;
  context.beginPath(); context.moveTo(x, VIEW.plots.topPixels); context.lineTo(x, height - VIEW.plots.bottomPixels); context.stroke();
}

function traceStyles(traces, soloId, colors) {
  const single = traces.length === 1;
  return traces
    .map(trace => {
      const emphasized = soloId ? trace.id === soloId : trace.listening;
      const alpha = single ? 1 : soloId ? (emphasized ? VIEW.plots.solo : VIEW.plots.dimmed) : emphasized ? VIEW.plots.overlapping : VIEW.plots.muted;
      return { trace, emphasized, single, color: single ? colors.ink : colors.mics[trace.index % colors.mics.length], alpha };
    })
    .sort((a, b) => Number(a.emphasized) - Number(b.emphasized));
}

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

export function plotSeconds(canvas, clientX, clamp = false) {
  const entry = cache.get(canvas);
  if (!entry?.window) return null;
  const box = canvas.getBoundingClientRect();
  const share = (clientX - box.left - VIEW.plots.leftPixels) / (box.width - VIEW.plots.leftPixels - VIEW.plots.rightPixels);
  if (!clamp && (share < 0 || share > 1)) return null;
  const { start, end } = entry.window;
  return start + Math.min(1, Math.max(0, share)) * (end - start);
}

export function drawWaveform(canvas, { key, traces, soloId }, playheadSeconds = null) {
  cachedPlot(canvas, key, (context, width, height) => {
    const live = traces.filter(trace => trace.result?.samples.length);
    if (!live.length) return null;
    const colors = palette();
    const window = sharedWindow(live);
    timeAxis(context, width, height, window, colors);
    const peakPa = Math.max(...live.map(trace => trace.result.peakPa));
    const middle = (VIEW.plots.topPixels + height - VIEW.plots.bottomPixels) / 2;
    const half = (height - VIEW.plots.bottomPixels - VIEW.plots.topPixels) / 2;
    const columns = width - VIEW.plots.leftPixels - VIEW.plots.rightPixels;
    const span = window.end - window.start;
    const y = value => middle - Math.max(-1, Math.min(1, value / peakPa)) * half;
    context.strokeStyle = colors.line;
    context.beginPath(); context.moveTo(VIEW.plots.leftPixels, middle); context.lineTo(width - VIEW.plots.rightPixels, middle); context.stroke();
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
        const x = VIEW.plots.leftPixels + column + .5;
        context.moveTo(x, y(high));
        context.lineTo(x, y(low) + .5);
      }
      context.stroke();
    }
    context.globalCompositeOperation = 'source-over';
    context.globalAlpha = 1;
    context.fillStyle = colors.faint;
    context.fillText(`±${peakPa.toPrecision(3)} Pa`, width - VIEW.plots.rightPixels - 70, VIEW.plots.topPixels - 6);
    return window;
  }, playheadSeconds);
}

const COMPASS = Object.freeze(['N', 'E', 'S', 'W', 'N']);

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
    const plotWidth = width - VIEW.plots.leftPixels - VIEW.plots.rightPixels;
    const plotHeight = height - VIEW.plots.topPixels - VIEW.plots.bottomPixels;
    const vertical = (arrivals, index) => (byDirection ? arrivals.bearings[index] / 360 : 1 - arrivals.heights[index] / maximumHeight);
    if (byDirection) {
      context.fillStyle = colors.faint;
      context.strokeStyle = colors.raised;
      COMPASS.forEach((label, quarter) => {
        const y = VIEW.plots.topPixels + quarter / 4 * plotHeight;
        context.beginPath(); context.moveTo(VIEW.plots.leftPixels, y); context.lineTo(width - VIEW.plots.rightPixels, y); context.stroke();
        if (quarter > 0 && quarter < 4) context.fillText(label, VIEW.plots.leftPixels + 3, y - 3);
      });
    }
    for (const { trace, single, color, alpha } of traceStyles(live, soloId, colors)) {
      const { arrivals } = trace.result;
      for (const reflected of [true, false]) {
        context.fillStyle = single ? (reflected ? colors.reflected : colors.direct) : color;
        const strength = !single && reflected ? alpha / 2 : alpha;
        for (let index = 0; index < arrivals.count; index += 1) {
          if ((arrivals.kinds[index] !== PATH_DIRECT && arrivals.kinds[index] !== PATH_SHADOW) !== reflected) continue;
          const x = VIEW.plots.leftPixels + (arrivals.seconds[index] - window.start) / (window.end - window.start) * plotWidth;
          const y = VIEW.plots.topPixels + vertical(arrivals, index) * plotHeight;
          context.globalAlpha = strength * Math.max(.12, Math.min(1, 1 + (arrivals.levels[index] - strongest) / 40));
          context.fillRect(x - 1, y - 1, 2, 2);
        }
      }
    }
    context.globalAlpha = 1;
    context.fillStyle = colors.faint;
    if (!byDirection) context.fillText(`${Math.round(maximumHeight)} m`, width - VIEW.plots.rightPixels - 50, VIEW.plots.topPixels - 6);
    return window;
  }, playheadSeconds);
}
