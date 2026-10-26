const BYTES_PER_SAMPLE = 4;
const FORMAT_CODE_IEEE_FLOAT = 3;
const FORMAT_CODE_EXTENSIBLE = 0xfffe;
const SUBFORMAT_IEEE_FLOAT = Object.freeze([0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71]);
const RIFF_MAXIMUM_BYTES = 0xffffffff;

/** WAVE_FORMAT_EXTENSIBLE with channel mask 0: AmbiX channels are field components, not speakers. */
const extensible = channelCount => channelCount > 2;
const formatBytes = channelCount => (extensible(channelCount) ? 40 : 16);
const headerBytes = channelCount => 12 + 8 + formatBytes(channelCount) + 8;

export const wavByteLength = (frameCount, channelCount) => headerBytes(channelCount) + frameCount * channelCount * BYTES_PER_SAMPLE;

export function encodeFloat32Wav(channels, sampleRate) {
  if (!Array.isArray(channels) || channels.length < 1) throw new Error('WAV export needs at least one channel.');
  const frameCount = channels[0].length;
  if (channels.some(channel => !(channel instanceof Float32Array) || channel.length !== frameCount)) {
    throw new Error('WAV channels must be equal-length Float32Array values.');
  }
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) throw new Error('WAV sample rate must be a positive integer.');
  const channelCount = channels.length;
  if (wavByteLength(frameCount, channelCount) - 8 > RIFF_MAXIMUM_BYTES) throw new Error('WAV export exceeds the RIFF 4 GB limit.');

  const frameBytes = channelCount * BYTES_PER_SAMPLE;
  const buffer = new ArrayBuffer(wavByteLength(frameCount, channelCount));
  const view = new DataView(buffer);
  const writeText = (offset, value) => [...value].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)));
  writeText(0, 'RIFF');
  view.setUint32(4, buffer.byteLength - 8, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  view.setUint32(16, formatBytes(channelCount), true);
  view.setUint16(20, extensible(channelCount) ? FORMAT_CODE_EXTENSIBLE : FORMAT_CODE_IEEE_FLOAT, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * frameBytes, true);
  view.setUint16(32, frameBytes, true);
  view.setUint16(34, BYTES_PER_SAMPLE * 8, true);
  if (extensible(channelCount)) {
    view.setUint16(36, 22, true);
    view.setUint16(38, BYTES_PER_SAMPLE * 8, true);
    view.setUint32(40, 0, true);
    SUBFORMAT_IEEE_FLOAT.forEach((byte, index) => view.setUint8(44 + index, byte));
  }
  const data = headerBytes(channelCount) - 8;
  writeText(data, 'data');
  view.setUint32(data + 4, frameCount * frameBytes, true);
  let offset = headerBytes(channelCount);
  for (let frame = 0; frame < frameCount; frame += 1) {
    for (const channel of channels) {
      view.setFloat32(offset, channel[frame], true);
      offset += BYTES_PER_SAMPLE;
    }
  }
  return buffer;
}

export function decodeFloat32Wav(buffer) {
  const view = new DataView(buffer instanceof ArrayBuffer ? buffer : buffer.buffer, buffer.byteOffset ?? 0, buffer.byteLength);
  const text = (offset, length) => String.fromCharCode(...Array.from({ length }, (_, index) => view.getUint8(offset + index)));
  if (text(0, 4) !== 'RIFF' || text(8, 4) !== 'WAVE') throw new Error('This is not a WAV file.');
  let format = null;
  for (let offset = 12; offset + 8 <= view.byteLength;) {
    const id = text(offset, 4);
    const size = view.getUint32(offset + 4, true);
    if (id === 'fmt ') {
      const code = view.getUint16(offset + 8, true);
      format = { float: code === FORMAT_CODE_IEEE_FLOAT || (code === FORMAT_CODE_EXTENSIBLE && view.getUint16(offset + 32, true) === FORMAT_CODE_IEEE_FLOAT), channelCount: view.getUint16(offset + 10, true), sampleRate: view.getUint32(offset + 12, true), bits: view.getUint16(offset + 22, true) };
    } else if (id === 'data') {
      if (!format?.float || format.bits !== BYTES_PER_SAMPLE * 8) throw new Error('Only 32-bit float WAV is read.');
      const frameCount = Math.floor(size / (format.channelCount * BYTES_PER_SAMPLE));
      const channels = Array.from({ length: format.channelCount }, () => new Float32Array(frameCount));
      let at = offset + 8;
      for (let frame = 0; frame < frameCount; frame += 1) for (const channel of channels) { channel[frame] = view.getFloat32(at, true); at += BYTES_PER_SAMPLE; }
      return { channels, sampleRate: format.sampleRate };
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error('The WAV file has no data.');
}
