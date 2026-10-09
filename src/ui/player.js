import Omnitone from '../../assets/vendor/omnitone/omnitone.min.esm.js';
import { channelCount, headingRotation } from '../domain/ambisonics.js';

/** Seconds between pressing Play and the start of the timeline, so scheduling never lands in the past. */
const SCHEDULE_LEAD_SECONDS = .08;
/** Without the real delay, the first sound starts this long after playback begins. */
const SHORTENED_LEAD_SECONDS = .5;

export const LISTEN_MODES = Object.freeze(['mono', 'binaural', 'pair']);

/**
 * Omnitone's higher-order decoder mirrors left and right relative to AmbiX: measured with a source
 * in the east and the listener facing north, it puts the source on the left. Its sine components
 * (m < 0) therefore enter with the opposite sign, after the heading rotation, because a mirror
 * and a rotation do not commute. The first-order decoder follows AmbiX.
 */
function omnitoneSign(acn, order) {
  if (order < 2) return 1;
  const degree = Math.floor(Math.sqrt(acn));
  return acn - degree * degree - degree < 0 ? -1 : 1;
}

/**
 * The listener's heading as a yaw rotation of the ambisonic field: a channel splitter, one gain
 * per rotation term, and a channel merger. Changing the heading only changes the gains.
 */
function rotationNetwork(context, order) {
  const count = channelCount(order);
  const splitter = context.createChannelSplitter(count);
  const merger = context.createChannelMerger(count);
  const gains = new Map();
  for (const { from, to } of headingRotation(0, order)) {
    const node = context.createGain();
    splitter.connect(node, from);
    node.connect(merger, 0, to);
    gains.set(`${from}:${to}`, node);
  }
  return {
    input: splitter,
    output: merger,
    setHeading(degrees) {
      for (const { from, to, gain } of headingRotation(degrees, order)) gains.get(`${from}:${to}`).gain.value = gain * omnitoneSign(to, order);
    }
  };
}

const binauralRenderers = new WeakMap();

/** An initialized Omnitone decoder for an order, created once per audio context. */
async function binauralRenderer(context, order) {
  let renderers = binauralRenderers.get(context);
  if (!renderers) binauralRenderers.set(context, renderers = new Map());
  if (!renderers.has(order)) {
    const renderer = order === 1 ? Omnitone.createFOARenderer(context) : Omnitone.createHOARenderer(context, { ambisonicOrder: order });
    renderers.set(order, renderer.initialize().then(() => renderer));
  }
  return renderers.get(order);
}

/**
 * Connects a sound to a destination for a listening mode. Mono plays channel 0; a pair plays two
 * channels as left and right; binaural turns the ambisonic field to the heading and decodes it
 * with Omnitone's HRTFs. Returns the source and, for binaural, the heading control.
 */
async function connectSound(context, sound, gain, { mode, order, heading }, destination) {
  const channels = mode === 'binaural' ? sound.channels.slice(0, channelCount(order)) : mode === 'pair' ? sound.channels.slice(0, 2) : [sound.channels[0]];
  const buffer = context.createBuffer(channels.length, channels[0].length, sound.sampleRate);
  channels.forEach((samples, index) => {
    const data = buffer.getChannelData(index);
    for (let frame = 0; frame < data.length; frame += 1) data[frame] = samples[frame] * gain;
  });
  const source = context.createBufferSource();
  source.buffer = buffer;
  if (mode !== 'binaural') {
    source.connect(destination);
    return { source, rotation: null };
  }
  const renderer = await binauralRenderer(context, order);
  const rotation = rotationNetwork(context, order);
  rotation.setHeading(heading);
  source.connect(rotation.input);
  rotation.output.connect(renderer.input);
  renderer.output.connect(destination);
  return { source, rotation, renderer };
}

/** Renders a sound for a listening mode offline into Float32 channels, as playback would sound. */
export async function renderListening(sound, gain, options) {
  const outputs = options.mode === 'mono' ? 1 : 2;
  const context = new OfflineAudioContext(outputs, sound.channels[0].length, sound.sampleRate);
  const { source } = await connectSound(context, sound, gain, options, context.destination);
  source.start(0);
  const rendered = await context.startRendering();
  return Array.from({ length: outputs }, (_, index) => new Float32Array(rendered.getChannelData(index)));
}

/**
 * Web Audio playback of one sound on the scene timeline (seconds since the emission origin). With
 * the real delay the timeline starts at zero; without it, the silent lead-in before the first
 * sound is skipped. The audio context is created on the first Play so it starts from a user
 * gesture.
 */
export function createPlayer() {
  let context = null;
  let current = null;
  let clock = null;

  function stop() {
    if (current) {
      current.source.onended = null;
      try { current.source.stop(); } catch { /* Already stopped. */ }
      current.source.disconnect();
      current.rotation?.output.disconnect();
      current.renderer?.output.disconnect();
    }
    current = null;
    clock = null;
  }

  async function play(sound, gain, { realDelay, onEnded, ...listening }) {
    context ??= new AudioContext({ sampleRate: sound.sampleRate });
    await context.resume();
    stop();
    const connected = await connectSound(context, sound, gain, listening, context.destination);
    current = connected;
    const skipped = realDelay ? 0 : Math.max(0, sound.startSeconds - SHORTENED_LEAD_SECONDS);
    const origin = context.currentTime + SCHEDULE_LEAD_SECONDS - skipped;
    const when = origin + sound.startSeconds;
    if (when >= context.currentTime) connected.source.start(when);
    else connected.source.start(context.currentTime, context.currentTime - when);
    connected.source.onended = () => {
      if (current !== connected) return;
      stop();
      onEnded?.();
    };
    clock = { skippedSeconds: skipped, sceneSeconds: () => context.currentTime - origin };
  }

  return {
    play,
    stop,
    clock: () => clock,
    playing: () => current !== null,
    setHeading(degrees) { current?.rotation?.setHeading(degrees); }
  };
}
