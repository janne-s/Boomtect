/**
 * An exact PNG decoder for elevation tiles. Adopted from Echotect `src/terrain-tiles.js` at
 * commit cb712ef: elevation is data, not an image, and reading it back through a canvas lets
 * colour management and anti-fingerprinting noise alter the channels.
 */

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const PNG_CHANNELS = Object.freeze({ 2: 3, 3: 1, 6: 4 });

function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  if (toLeft <= toUp && toLeft <= toUpLeft) return left;
  return toUp <= toUpLeft ? up : upLeft;
}

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Decodes an 8-bit, non-interlaced RGB, RGBA, or palette PNG to its exact RGB bytes; one step in red is 256 m. */
export async function decodePngRgb(buffer) {
  const bytes = new Uint8Array(buffer);
  if (!PNG_SIGNATURE.every((value, index) => bytes[index] === value)) throw new Error('Terrain tile is not a PNG.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0; let height = 0; let colourType = -1; let palette = null;
  const data = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = view.getUint32(offset + 8); height = view.getUint32(offset + 12);
      colourType = body[9];
      if (body[8] !== 8 || body[12] !== 0 || !(colourType in PNG_CHANNELS)) throw new Error('Terrain tile PNG format is unsupported.');
    } else if (type === 'PLTE') palette = body;
    else if (type === 'IDAT') data.push(body);
    else if (type === 'IEND') break;
    offset += length + 12;
  }
  const channels = PNG_CHANNELS[colourType];
  const stride = width * channels;
  const raw = await inflate(new Uint8Array(await new Blob(data).arrayBuffer()));
  if (raw.length < height * (stride + 1)) throw new Error('Terrain tile PNG data is truncated.');
  const pixels = new Uint8Array(height * stride);
  for (let row = 0; row < height; row += 1) {
    const filter = raw[row * (stride + 1)];
    const source = row * (stride + 1) + 1;
    const target = row * stride;
    for (let column = 0; column < stride; column += 1) {
      const left = column >= channels ? pixels[target + column - channels] : 0;
      const up = row ? pixels[target - stride + column] : 0;
      const upLeft = row && column >= channels ? pixels[target - stride + column - channels] : 0;
      const value = raw[source + column];
      const predicted = filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : filter === 4 ? paeth(left, up, upLeft) : 0;
      pixels[target + column] = (value + predicted) & 255;
    }
  }
  if (colourType === 2) return { width, height, rgb: pixels };
  const rgb = new Uint8Array(width * height * 3);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const from = colourType === 6 ? pixels.subarray(pixel * 4, pixel * 4 + 3) : palette.subarray(pixels[pixel] * 3, pixels[pixel] * 3 + 3);
    rgb.set(from, pixel * 3);
  }
  return { width, height, rgb };
}
