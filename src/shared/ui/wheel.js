import { VIEW } from '../domain/constants.js';

/** A browser cannot tell a mouse wheel from two-finger scrolling, so the viewer chooses what scrolling does; a pinch arrives with ctrlKey. */
export function wheelGesture({ deltaX, deltaY, deltaMode, ctrlKey, shiftKey }, scrollPans) {
  const scale = deltaMode === 1 ? VIEW.box.wheelLinePixels : 1;
  const x = deltaX * scale;
  const y = deltaY * scale;
  if (ctrlKey) return { zoomPixels: 2 * y };
  if (scrollPans || shiftKey) return { panX: x, panY: y };
  return { zoomPixels: y };
}
