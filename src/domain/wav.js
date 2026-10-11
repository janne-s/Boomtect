const BYTES_PER_SAMPLE = 4;
const FORMAT_CODE_IEEE_FLOAT = 3;
const FORMAT_CODE_EXTENSIBLE = 0xfffe;
/** KSDATAFORMAT_SUBTYPE_IEEE_FLOAT, 00000003-0000-0010-8000-00aa00389b71, as stored. */
const SUBFORMAT_IEEE_FLOAT = Object.freeze([0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71]);
const RIFF_MAXIMUM_BYTES = 0xffffffff;

/**
 * More than two channels are written as WAVE_FORMAT_EXTENSIBLE, as Microsoft asks of them, with no
 * speaker positions (channel mask 0): an AmbiX file's channels are components of the field, not
 * speakers.
 */
const extensible = channelCount => channelCount > 2;
const formatBytes = channelCount => (extensible(channelCount) ? 40 : 16);
const headerBytes = channelCount => 12 + 8 + formatBytes(channelCount) + 8;

export const wavByteLength = (frameCount, channelCount) => headerBytes(channelCount) + frameCount * channelCount * BYTES_PER_SAMPLE;

/** Encodes equal-length Float32Array channels as an IEEE float 32-bit WAV, samples unchanged. */
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
