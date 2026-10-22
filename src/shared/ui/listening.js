export const LISTENING_LABELS = Object.freeze({
  none: 'No microphone',
  mono: 'Mono',
  pair: 'Stereo pair',
  surround: 'Surround',
  binaural: 'Binaural',
  mix: 'Mix'
});

/** When the first wavefront reaches a microphone: its earliest path. Nothing before it is sound, only the render's numerics. */
export function firstArrivalSeconds(result) {
  const arrivals = result?.arrivals;
  if (!arrivals?.count) return result?.startSeconds ?? Infinity;
  let first = Infinity;
  for (let index = 0; index < arrivals.count; index += 1) first = Math.min(first, arrivals.seconds[index]);
  return Math.max(result.startSeconds, first);
}

function aligned(results, channelCount) {
  const heard = results.filter(result => result.samples.length);
  const startSeconds = Math.min(...heard.map(result => result.startSeconds));
  const sampleRate = heard[0].sampleRate;
  const end = Math.max(...heard.map(result => result.startSeconds + result.samples.length / sampleRate));
  const length = Math.max(1, Math.ceil((end - startSeconds) * sampleRate));
  const place = (result, channel) => {
    const target = new Float32Array(length);
    if (result.samples.length) target.set(result.channels[channel], Math.round((result.startSeconds - startSeconds) * sampleRate));
    return target;
  };
  return { startSeconds, sampleRate, length, place, channelCount };
}

export function listeningKind(receivers, ambisonicOrder) {
  const heads = receivers.filter(receiver => receiver.listen && receiver.type === 'binaural' && ambisonicOrder > 0);
  const omnis = receivers.filter(receiver => receiver.listen && !heads.includes(receiver));
  if (!heads.length && !omnis.length) return { kind: 'none', heads, omnis };
  if (!heads.length) return { kind: omnis.length === 1 ? 'mono' : omnis.length === 2 ? 'pair' : 'surround', heads, omnis };
  return { kind: heads.length === 1 && !omnis.length ? 'binaural' : 'mix', heads, omnis };
}

export function composeListening(scene, results) {
  const { kind, heads, omnis } = listeningKind(scene.receivers, scene.render.ambisonicOrder);
  const listening = [...heads, ...omnis];
  const rendered = listening.map(receiver => results?.get(receiver.id));
  if (kind === 'none' || rendered.some(result => !result) || rendered.every(result => !result.samples.length)) return null;
  const order = scene.render.ambisonicOrder;
  const fieldChannels = (order + 1) ** 2;
  const timeline = aligned(listening.map(receiver => results.get(receiver.id)), fieldChannels);
  const peakPa = Math.max(...listening.map(receiver => results.get(receiver.id).peakPa));
  const centre = omnis.reduce((sum, receiver) => ({ x: sum.x + receiver.positionMetres.x / omnis.length, y: sum.y + receiver.positionMetres.y / omnis.length }), { x: 0, y: 0 });
  return {
    kind,
    label: kind === 'surround' ? `${LISTENING_LABELS.surround} · ${omnis.length} ch` : LISTENING_LABELS[kind],
    order,
    sampleRate: timeline.sampleRate,
    startSeconds: timeline.startSeconds,
    firstSoundSeconds: Math.max(timeline.startSeconds, Math.min(...listening.map(receiver => firstArrivalSeconds(results.get(receiver.id))))),
    length: timeline.length,
    heads: heads.map(receiver => ({
      receiverId: receiver.id,
      name: receiver.name,
      headingDegrees: receiver.headingDegrees,
      pitchDegrees: receiver.pitchDegrees,
      channels: Array.from({ length: fieldChannels }, (_, channel) => timeline.place(results.get(receiver.id), channel))
    })),
    omnis: omnis.map(receiver => ({
      receiverId: receiver.id,
      name: receiver.name,
      bearing: Math.atan2(receiver.positionMetres.x - centre.x, receiver.positionMetres.y - centre.y),
      channel: timeline.place(results.get(receiver.id), 0)
    })),
    peakPa,
    parts: listening.length
  };
}
