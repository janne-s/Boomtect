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

/** Overlap-add transforms this many kernel lengths at a time (numerical, not a model value). */
const BLOCK_KERNELS = 4;

/** Whether a block of samples is all zero, so that its convolution adds nothing. */
export function silent(samples, from, to) {
  for (let index = from, end = Math.min(to, samples.length); index < end; index += 1) if (samples[index] !== 0) return false;
  return true;
}

/** The transform size for overlap-add of a signal with a kernel: a few kernels long, or the whole if it is shorter. */
export function overlapSize(signalLength, kernelLength) {
  return Math.min(BLOCK_KERNELS * nextPowerOfTwo(kernelLength), nextPowerOfTwo(signalLength + kernelLength));
}

/**
 * Adds the linear convolution of each signal with one real `kernel` into its target from the first
 * sample, as far as the target reaches. Overlap-add in blocks a few kernels long, so that minutes of
 * sound need no transform of their whole length; two signals share each transform as its real and
 * imaginary parts, which a real kernel keeps apart. Silent blocks are skipped.
 */
export function convolveAdd(targets, signals, kernel) {
  const length = Math.max(0, ...signals.map(signal => signal.length));
  if (!length || !kernel.length) return;
  const size = overlapSize(length, kernel.length);
  const block = size - kernel.length + 1;
  const kernelRe = new Float64Array(size);
  const kernelIm = new Float64Array(size);
  kernelRe.set(kernel);
  fft(kernelRe, kernelIm);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let pair = 0; pair < signals.length; pair += 2) {
    const [first, second] = [signals[pair], signals[pair + 1]];
    const [firstTarget, secondTarget] = [targets[pair], targets[pair + 1]];
    for (let start = 0; start < length; start += block) {
      if (silent(first, start, start + block) && (!second || silent(second, start, start + block))) continue;
      re.fill(0);
      im.fill(0);
      re.set(first.subarray(start, start + block));
      if (second) im.set(second.subarray(start, start + block));
      fft(re, im);
      for (let bin = 0; bin < size; bin += 1) {
        const productRe = re[bin] * kernelRe[bin] - im[bin] * kernelIm[bin];
        im[bin] = re[bin] * kernelIm[bin] + im[bin] * kernelRe[bin];
        re[bin] = productRe;
      }
      fft(re, im, true);
      for (let index = 0, end = Math.min(size, firstTarget.length - start); index < end; index += 1) firstTarget[start + index] += re[index];
      if (second) for (let index = 0, end = Math.min(size, secondTarget.length - start); index < end; index += 1) secondTarget[start + index] += im[index];
    }
  }
}
