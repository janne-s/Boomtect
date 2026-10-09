const PANEL_WIDTH_RANGE = Object.freeze([260, 680]);
const RESULTS_HEIGHT_MINIMUM = 120;
const RESULTS_HEIGHT_MAXIMUM_SHARE = .7;
const KEYBOARD_STEP = 16;

/**
 * Lets the parameter column and the result row be resized by dragging or with the arrow keys.
 * Sizes are CSS pixels on the layout element and are reported back for storage.
 */
export function attachSplitters(layout, { column, row }, sizes, onChange) {
  const apply = next => {
    const [low, high] = PANEL_WIDTH_RANGE;
    const panelWidth = Math.round(Math.min(high, Math.max(low, next.panelWidth)));
    const resultsHeight = Math.round(Math.min(layout.clientHeight * RESULTS_HEIGHT_MAXIMUM_SHARE, Math.max(RESULTS_HEIGHT_MINIMUM, next.resultsHeight)));
    layout.style.setProperty('--panel-width', `${panelWidth}px`);
    layout.style.setProperty('--results-height', `${resultsHeight}px`);
    return { panelWidth, resultsHeight };
  };
  let current = apply(sizes);

  function bind(element, measure, key, direction) {
    element.addEventListener('pointerdown', event => {
      element.setPointerCapture(event.pointerId);
      element.classList.add('dragging');
      event.preventDefault();
    });
    element.addEventListener('pointermove', event => {
      if (!element.hasPointerCapture(event.pointerId)) return;
      current = apply({ ...current, [key]: measure(event, layout.getBoundingClientRect()) });
    });
    const finish = event => {
      if (!element.hasPointerCapture(event.pointerId)) return;
      element.releasePointerCapture(event.pointerId);
      element.classList.remove('dragging');
      onChange(current);
    };
    element.addEventListener('pointerup', finish);
    element.addEventListener('pointercancel', finish);
    element.addEventListener('keydown', event => {
      const delta = { ArrowLeft: 1, ArrowUp: 1, ArrowRight: -1, ArrowDown: -1 }[event.key];
      if (!delta) return;
      event.preventDefault();
      current = apply({ ...current, [key]: current[key] + delta * direction * KEYBOARD_STEP });
      onChange(current);
    });
  }

  const padding = () => parseFloat(getComputedStyle(layout).paddingRight) || 0;
  bind(column, (event, rect) => rect.right - padding() - event.clientX, 'panelWidth', 1);
  bind(row, (event, rect) => rect.bottom - padding() - event.clientY, 'resultsHeight', 1);
  window.addEventListener('resize', () => { current = apply(current); });
}
