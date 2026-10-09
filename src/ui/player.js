/** Seconds between pressing Play and the start of the timeline, so scheduling never lands in the past. */
const SCHEDULE_LEAD_SECONDS = .08;
/** Without the real delay, the first sound starts this long after playback begins. */
const SHORTENED_LEAD_SECONDS = .5;

/**
 * Web Audio playback of one rendered receiver on the scene timeline (seconds since the emission
 * origin). With the real delay the timeline starts at zero; without it, the silent lead-in before
 * the first sound is skipped and earlier flashes are shown at once. The audio context is created on
 * the first Play so it starts from a user gesture.
 */
export function createPlayer() {
  let context = null;
  let source = null;
  let clock = null;

  function stop() {
    if (source) {
      source.onended = null;
      try { source.stop(); } catch { /* Already stopped. */ }
      source.disconnect();
    }
    source = null;
    clock = null;
  }

  async function play(result, gain, { realDelay, onEnded }) {
    context ??= new AudioContext({ sampleRate: result.sampleRate });
    await context.resume();
    stop();
    const buffer = context.createBuffer(1, result.samples.length, result.sampleRate);
    const channel = buffer.getChannelData(0);
    for (let index = 0; index < channel.length; index += 1) channel[index] = result.samples[index] * gain;
    source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    const skipped = realDelay ? 0 : Math.max(0, result.startSeconds - SHORTENED_LEAD_SECONDS);
    const origin = context.currentTime + SCHEDULE_LEAD_SECONDS - skipped;
    const when = origin + result.startSeconds;
    if (when >= context.currentTime) source.start(when);
    else source.start(context.currentTime, context.currentTime - when);
    const current = source;
    source.onended = () => {
      if (source !== current) return;
      stop();
      onEnded?.();
    };
    clock = { skippedSeconds: skipped, sceneSeconds: () => context.currentTime - origin };
  }

  return { play, stop, clock: () => clock, playing: () => source !== null };
}
