const twiddles = new Map();

function twiddleTable(length) {
  let table = twiddles.get(length);
  if (table) return table;
  table = { cos: new Float64Array(length / 2), sin: new Float64Array(length / 2) };
  for (let index = 0; index < length / 2; index += 1) {
    table.cos[index] = Math.cos(2 * Math.PI * index / length);
    table.sin[index] = Math.sin(2 * Math.PI * index / length);
  }
  twiddles.set(length, table);
  return table;
}

export const isPowerOfTwo = value => Number.isInteger(value) && value > 0 && (value & (value - 1)) === 0;

export function nextPowerOfTwo(value) {
  let length = 1;
  while (length < value) length *= 2;
  return length;
}

/**
 * In-place radix-2 complex FFT. Forward uses e^(−iωt); inverse uses e^(+iωt) and divides by the
 * length, so inverse(forward(x)) = x.
 */
export function fft(real, imaginary, inverse = false) {
  const length = real.length;
  if (!isPowerOfTwo(length) || imaginary.length !== length) throw new RangeError('FFT length must be a power of two.');
  for (let index = 1, reversed = 0; index < length; index += 1) {
    let bit = length >> 1;
    for (; reversed & bit; bit >>= 1) reversed ^= bit;
    reversed ^= bit;
    if (index < reversed) {
      let swap = real[index]; real[index] = real[reversed]; real[reversed] = swap;
      swap = imaginary[index]; imaginary[index] = imaginary[reversed]; imaginary[reversed] = swap;
    }
  }
  const table = twiddleTable(length);
  const direction = inverse ? 1 : -1;
  for (let size = 2; size <= length; size *= 2) {
    const half = size / 2;
    const stride = length / size;
    for (let start = 0; start < length; start += size) {
      for (let offset = 0; offset < half; offset += 1) {
        const cosine = table.cos[offset * stride];
        const sine = direction * table.sin[offset * stride];
        const even = start + offset;
        const odd = even + half;
        const oddReal = real[odd] * cosine - imaginary[odd] * sine;
        const oddImaginary = real[odd] * sine + imaginary[odd] * cosine;
        real[odd] = real[even] - oddReal;
        imaginary[odd] = imaginary[even] - oddImaginary;
        real[even] += oddReal;
        imaginary[even] += oddImaginary;
      }
    }
  }
  if (inverse) for (let index = 0; index < length; index += 1) { real[index] /= length; imaginary[index] /= length; }
}

/**
 * Adds the linear convolution of `signal` with `kernel` into `target` from its first sample, as far
 * as `target` reaches.
 */
export function convolveAdd(target, signal, kernel) {
  const size = nextPowerOfTwo(signal.length + kernel.length);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  re.set(signal);
  im.set(kernel);
  // Both real inputs in one transform: X = (Z(k) + Z*(−k))/2, K = (Z(k) − Z*(−k))/(2i).
  fft(re, im);
  const productRe = new Float64Array(size);
  const productIm = new Float64Array(size);
  for (let bin = 0; bin < size; bin += 1) {
    const mirror = (size - bin) % size;
    const xRe = (re[bin] + re[mirror]) / 2;
    const xIm = (im[bin] - im[mirror]) / 2;
    const kRe = (im[bin] + im[mirror]) / 2;
    const kIm = (re[mirror] - re[bin]) / 2;
    productRe[bin] = xRe * kRe - xIm * kIm;
    productIm[bin] = xRe * kIm + xIm * kRe;
  }
  fft(productRe, productIm, true);
  const length = Math.min(target.length, signal.length + kernel.length - 1);
  for (let index = 0; index < length; index += 1) target[index] += productRe[index];
}
