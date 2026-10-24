export function fitCanvas(canvas) {
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(canvas.clientWidth));
  const height = Math.max(1, Math.round(canvas.clientHeight));
  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
  }
  const context = canvas.getContext('2d');
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  return { context, width, height };
}

const MICROPHONE_COLORS = 8;
const FIREWORK_COLORS = 6;

export function palette() {
  const style = getComputedStyle(document.documentElement);
  const read = name => style.getPropertyValue(name).trim();
  const names = ['bg', 'panel', 'raised', 'line', 'ink', 'muted', 'faint', 'accent', 'ground', 'cloud', 'wall', 'grid', 'shadow',
    'lightning', 'flash', 'glow', 'start', 'end', 'receiver', 'direct', 'reflected', 'cloud-handle', 'storm-base', 'storm-top'];
  const colors = Object.fromEntries(names.map(name => [name, read(`--${name}`)]));
  colors.mics = Array.from({ length: MICROPHONE_COLORS }, (_, index) => read(`--mic-${index + 1}`));
  colors.fireworks = Array.from({ length: FIREWORK_COLORS }, (_, index) => read(`--firework-${index + 1}`));
  return colors;
}

export function niceStep(span, count) {
  const raw = span / Math.max(1, count);
  const power = 10 ** Math.floor(Math.log10(raw));
  const mantissa = raw / power;
  return (mantissa < 1.5 ? 1 : mantissa < 3.5 ? 2 : mantissa < 7.5 ? 5 : 10) * power;
}

export function formatMetres(value) {
  return Math.abs(value) >= 1000 ? `${+(value / 1000).toFixed(2)} km` : `${+value.toFixed(1)} m`;
}

export function formatMetresSpan(from, to) {
  if (Math.max(Math.abs(from), Math.abs(to)) < 1000) return `${Math.round(from)}–${Math.round(to)} m`;
  return `${+(from / 1000).toFixed(2)}–${+(to / 1000).toFixed(2)} km`;
}

export function formatSeconds(value) {
  return Math.abs(value) >= 1 ? `${+value.toFixed(2)} s` : `${+(value * 1000).toFixed(1)} ms`;
}

export const microphoneColor = index => `var(--mic-${index % MICROPHONE_COLORS + 1})`;
