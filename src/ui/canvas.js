/** Sizes a canvas backing store to its CSS box and returns a context in CSS pixels. */
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

/** CSS custom properties as canvas colors, read once per draw. */
export function palette() {
  const style = getComputedStyle(document.documentElement);
  const read = name => style.getPropertyValue(name).trim();
  return {
    bg: read('--bg'), panel: read('--panel'), raised: read('--raised'), line: read('--line'), ink: read('--ink'),
    muted: read('--muted'), faint: read('--faint'), accent: read('--accent'), secondary: read('--data-secondary'), ground: read('--ground'), cloud: read('--cloud')
  };
}

/** A round step of 1, 2, or 5 times a power of ten that gives roughly `count` ticks over `span`. */
export function niceStep(span, count) {
  const raw = span / Math.max(1, count);
  const power = 10 ** Math.floor(Math.log10(raw));
  const mantissa = raw / power;
  return (mantissa < 1.5 ? 1 : mantissa < 3.5 ? 2 : mantissa < 7.5 ? 5 : 10) * power;
}

export function formatMetres(value) {
  return Math.abs(value) >= 1000 ? `${+(value / 1000).toFixed(2)} km` : `${+value.toFixed(1)} m`;
}

export function formatSeconds(value) {
  return Math.abs(value) >= 1 ? `${+value.toFixed(2)} s` : `${+(value * 1000).toFixed(1)} ms`;
}
