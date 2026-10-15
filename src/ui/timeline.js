export function attachTimelineSeek(input, { seek, play }) {
  const track = input.parentElement;
  let pointer = null;

  function moveTo(seconds) {
    const end = Number(input.max);
    const value = Math.max(0, Math.min(end, seconds));
    input.value = String(value);
    seek(value);
  }

  function position(event) {
    const { left, width } = track.getBoundingClientRect();
    if (width > 0) moveTo((event.clientX - left) / width * Number(input.max));
  }

  track.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !event.isPrimary || pointer !== null) return;
    event.preventDefault();
    event.stopPropagation();
    input.focus({ preventScroll: true });
    pointer = event.pointerId;
    track.setPointerCapture(pointer);
    position(event);
  });
  track.addEventListener('pointermove', event => {
    if (event.pointerId !== pointer) return;
    event.preventDefault();
    position(event);
  });
  track.addEventListener('pointerup', event => {
    if (event.pointerId !== pointer) return;
    event.preventDefault();
    position(event);
    pointer = null;
    track.releasePointerCapture(event.pointerId);
    play();
  });
  const cancel = event => {
    if (event.pointerId === pointer) pointer = null;
  };
  track.addEventListener('pointercancel', cancel);
  track.addEventListener('lostpointercapture', cancel);

  input.addEventListener('keydown', event => {
    const value = Number(input.value);
    const end = Number(input.max);
    const positions = {
      ArrowLeft: value - 1, ArrowDown: value - 1,
      ArrowRight: value + 1, ArrowUp: value + 1,
      PageDown: value - end / 10, PageUp: value + end / 10,
      Home: 0, End: end
    };
    if (!(event.key in positions)) return;
    event.preventDefault();
    moveTo(positions[event.key]);
    play();
  });
  // Assistive technologies can change the native range without pointer or key events.
  input.addEventListener('input', () => { if (pointer === null) seek(Number(input.value)); });
  input.addEventListener('change', () => { if (pointer === null) play(); });
}
