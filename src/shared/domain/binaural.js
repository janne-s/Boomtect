import { channelCount, orientationRotation } from './ambisonics.js';
import { convolveAdd } from './fft.js';
import { SADIE_HRIR } from './sadie-hrir.js';

const negativeDegree = acn => {
  const degree = Math.floor(Math.sqrt(acn));
  return acn - degree * degree - degree < 0;
};

function pcm16Channels(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = offset => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  let channels = 1;
  for (let offset = 12; offset + 8 <= bytes.length; offset += 8 + view.getUint32(offset + 4, true)) {
    if (tag(offset) === 'fmt ') channels = view.getUint16(offset + 10, true);
    if (tag(offset) !== 'data') continue;
    const frames = view.getUint32(offset + 4, true) / (2 * channels);
    return Array.from({ length: channels }, (_, channel) => Float64Array.from({ length: frames }, (__, frame) => view.getInt16(offset + 8 + 2 * (frame * channels + channel), true) / 32768));
  }
  throw new Error('The HRIR holds no data.');
}

const filters = new Map();
function hrirs(order) {
  if (!filters.has(order)) {
    const decoded = SADIE_HRIR[order].flatMap(text => pcm16Channels(Uint8Array.from(atob(text), character => character.charCodeAt(0))));
    filters.set(order, decoded.slice(0, channelCount(order)));
  }
  return filters.get(order);
}

/** The app's headphone listening: the head's rotation, then Omnitone's SADIE decoder as its graph wires it. In the browser its higher orders come out mirrored, which the app undoes; here they follow AmbiX. */
export function binauralChannels(channels, order, headingDegrees = 0, pitchDegrees = 0) {
  const length = channels[0].length;
  const rotated = Array.from({ length: channelCount(order) }, () => new Float64Array(length));
  for (const { from, to, gain } of orientationRotation(headingDegrees, pitchDegrees, order)) {
    const [source, target] = [channels[from], rotated[to]];
    for (let index = 0; index < length; index += 1) target[index] += gain * source[index];
  }
  const kernels = hrirs(order);
  const ears = [new Float64Array(length + kernels[0].length - 1), new Float64Array(length + kernels[0].length - 1)];
  kernels.forEach((kernel, acn) => {
    const signal = rotated[acn];
    convolveAdd(ears, [signal, negativeDegree(acn) ? signal.map(value => -value) : signal], kernel);
  });
  return ears;
}
