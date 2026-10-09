/** Seconds between pressing Play and the emission, so scheduling never lands in the past. */
const SCHEDULE_LEAD_SECONDS = .08;
/** With a shortened delay, the sound starts this long after the emission. */
const SHORTENED_DELAY_SECONDS = .5;

/**
 * Web Audio playback of one rendered receiver. The context is created on the first Play so it
 * starts from a user gesture. The scene clock maps scene time (seconds since the first emission)
 * to audio-context time for the flash, the playhead, and the receiver display.
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
    const emission = context.currentTime + SCHEDULE_LEAD_SECONDS;
    const audioStart = emission + (realDelay ? result.startSeconds : SHORTENED_DELAY_SECONDS);
    source.start(audioStart);
    const current = source;
    source.onended = () => {
      if (source !== current) return;
      stop();
      onEnded?.();
    };
    clock = {
      emission,
      audioStart,
      flashSeconds: () => context.currentTime - emission,
      soundSeconds: () => result.startSeconds + context.currentTime - audioStart
    };
  }

  return { play, stop, clock: () => clock, playing: () => source !== null };
}
