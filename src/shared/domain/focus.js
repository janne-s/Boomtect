import { GAMMA_AIR } from './constants.js';
import { fft, nextPowerOfTwo } from './fft.js';
import { FOCUS_SAMPLES, FOCUS_TABLE } from './focus-table.js';

const AIR_NONLINEARITY = (GAMMA_AIR + 1) / 2;
const SPECTRUM_PADDING = 8;

export const FOCUS_RANGE = Object.freeze({
  lowest: FOCUS_TABLE.heights.first,
  highest: FOCUS_TABLE.heights.first + (FOCUS_TABLE.heights.count - 1) * FOCUS_TABLE.heights.step,
  startTau: FOCUS_TABLE.tau.first
});

/**
 * Class B: a fold caustic in the nonlinear Tricomi scaling of Auger & Coulouvrat (2002), as given in Wyle WR 12-21 §6.1.
 * Near the fold the arrival time in emission time s is T₀ + c s + a s³, with c the slope and 6a the third derivative
 * there; b = −c sign a is positive on the lit side, where the two arrivals are ±√(b/3|a|) apart. A ray's curvature
 * T″ = 2√(3|a|b) gives the geometric focusing, so the incoming wave is P z̄^(−1/4) with z̄ = b / (T^⅔ (3|a|)^⅓), T the
 * N-wave's half length. The diffraction layer is δ = T^⅔ (3|a|)^⅓ / |∇b|, and μ = 2β (P / γp) (δ / cT)².
 */
export function foldScaling({ slope, third, halfSeconds, flatPa, steadyCurvature, slopeGradient, groundPressurePa, groundSoundSpeed }) {
  const cubic = 3 * Math.abs(third / 6);
  if (!(cubic > 0 && halfSeconds > 0 && slopeGradient > 0)) return null;
  const unit = halfSeconds ** (2 / 3) * Math.cbrt(cubic);
  const height = -slope * Math.sign(third) / unit;
  const referencePa = flatPa * Math.sqrt(steadyCurvature / (2 * cubic ** (2 / 3) * Math.cbrt(halfSeconds)));
  const layerMetres = unit / slopeGradient;
  const mu = 2 * AIR_NONLINEARITY * referencePa / (GAMMA_AIR * groundPressurePa) * (layerMetres / (groundSoundSpeed * halfSeconds)) ** 2;
  return { height, mu, referencePa, layerMetres };
}

let decoded = null;
function rows() {
  if (decoded) return decoded;
  const text = atob(FOCUS_SAMPLES);
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index);
  decoded = new Int16Array(bytes.buffer);
  return decoded;
}

function storedRow(muIndex, heightIndex) {
  const { heights, tau, scales } = FOCUS_TABLE;
  const row = muIndex * heights.count + heightIndex;
  const scale = scales[row];
  return Float64Array.from(rows().subarray(row * tau.count, (row + 1) * tau.count), value => value * scale);
}

/** The waveform at height z̄ for μ, in units of the incoming wave's z̄ = 1 amplitude, from τ = FOCUS_RANGE.startTau; μ between the table's is taken on log μ, z̄ at the nearest row. */
export function focusWaveform(mu, height) {
  const { mus, heights } = FOCUS_TABLE;
  if (!(height >= FOCUS_RANGE.lowest && height <= FOCUS_RANGE.highest)) return null;
  const heightIndex = Math.round((height - heights.first) / heights.step);
  const position = Math.max(0, Math.min(mus.length - 1, (Math.log(mu) - Math.log(mus[0])) / (Math.log(mus[1]) - Math.log(mus[0]))));
  const lower = Math.min(mus.length - 2, Math.floor(position));
  const share = position - lower;
  const a = storedRow(lower, heightIndex);
  const b = storedRow(lower + 1, heightIndex);
  return Float64Array.from(a, (value, index) => value + (b[index] - value) * share);
}

const spectra = new Map();

/** The waveform's spectrum ∫ W e^(−iΩτ) dτ, τ from the window's start, on an even grid of Ω. */
export function focusSpectrum(mu, height) {
  const key = `${Math.round(Math.log(mu) * 200)}:${Math.round((height - FOCUS_TABLE.heights.first) / FOCUS_TABLE.heights.step)}`;
  if (spectra.has(key)) return spectra.get(key);
  const waveform = focusWaveform(mu, height);
  if (!waveform) return null;
  const step = FOCUS_TABLE.tau.step;
  const size = nextPowerOfTwo(waveform.length * SPECTRUM_PADDING);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  re.set(waveform);
  fft(re, im);
  const half = size / 2;
  const spectrum = { re: re.subarray(0, half).map(value => value * step), im: im.subarray(0, half).map(value => value * step), omegaStep: 2 * Math.PI / (size * step) };
  if (spectra.size > 64) spectra.clear();
  spectra.set(key, spectrum);
  return spectrum;
}

/** The spectrum at Ω, linearly between its grid points, nothing above the table's band. */
export function focusSpectrumAt(spectrum, omega, out) {
  const position = omega / spectrum.omegaStep;
  const lower = Math.floor(position);
  if (!(lower >= 0 && lower + 1 < spectrum.re.length)) { out[0] = 0; out[1] = 0; return out; }
  const share = position - lower;
  out[0] = spectrum.re[lower] + (spectrum.re[lower + 1] - spectrum.re[lower]) * share;
  out[1] = spectrum.im[lower] + (spectrum.im[lower + 1] - spectrum.im[lower]) * share;
  return out;
}
