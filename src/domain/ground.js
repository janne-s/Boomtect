import { faddeeva } from './faddeeva.js';

/**
 * Effective flow resistivity of natural ground in kPa·s/m² (cgs rayls): the mean of each range in
 * FHWA TNM ground types (Embleton, Piercy & Daigle 1983). Adopted from Echotect `src/materials.js`
 * at commit cb712ef6. Rigid ground reflects without loss.
 */
export const GROUND_FLOW_RESISTIVITY = Object.freeze({
  snow: 20,
  forestFloor: 50,
  grass: 212.5,
  soil: 278,
  stonyGround: 550
});

export const GROUND_TYPES = Object.freeze(['rigid', ...Object.keys(GROUND_FLOW_RESISTIVITY)]);

export const GROUND_LABELS = Object.freeze({
  rigid: 'Rigid',
  snow: 'Snow',
  forestFloor: 'Forest floor',
  grass: 'Grass',
  soil: 'Soil',
  stonyGround: 'Stony ground'
});

const SQRT_PI = Math.sqrt(Math.PI);

/**
 * Class B: Delany–Bazley normalized surface impedance of a locally reacting porous ground,
 * in the e^(−iωt) convention, where its imaginary part is positive.
 */
export function delanyBazleyImpedance(frequencyHz, flowResistivityKpaSecondsPerSquareMetre) {
  const ratio = frequencyHz / flowResistivityKpaSecondsPerSquareMetre;
  return [1 + 9.08 * ratio ** -.75, 11.9 * ratio ** -.73];
}

/**
 * Class B: spherical-wave reflection coefficient Q = Rp + (1 − Rp)·F(w) of a locally reacting
 * ground (Weyl–Van der Pol; see Attenborough, Li & Horoshenkov, Predicting Outdoor Sound, 2007).
 * Returned as [re, im] in the e^(+iωt) convention of `fft.js`, so it multiplies a forward spectrum.
 * `cosIncidence` is the cosine of the angle from the ground normal; `imagePathMetres` is the
 * image-source path length R2.
 */
/**
 * Class B: plane-wave reflection coefficient Rp = (cos θ − β)/(cos θ + β) of a locally reacting
 * ground with normalized admittance β, as [re, im] in the e^(−iωt) convention, and β itself.
 */
function planeWave(frequencyHz, groundType, cosIncidence) {
  const flowResistivity = GROUND_FLOW_RESISTIVITY[groundType];
  if (!flowResistivity) throw new RangeError(`Unknown ground type: ${groundType}`);
  const [zRe, zIm] = delanyBazleyImpedance(frequencyHz, flowResistivity);
  const zScale = zRe * zRe + zIm * zIm;
  const betaRe = zRe / zScale;
  const betaIm = -zIm / zScale;
  const sumRe = cosIncidence + betaRe;
  const differenceRe = cosIncidence - betaRe;
  const sumScale = sumRe * sumRe + betaIm * betaIm;
  return { planeRe: (differenceRe * sumRe - betaIm * betaIm) / sumScale, planeIm: (-betaIm * sumRe - differenceRe * betaIm) / sumScale, betaRe, betaIm, sumRe };
}

/** |Rp|, the share of the incident amplitude a ground reflects at a given incidence (class B). */
export function planeReflectionMagnitude(frequencyHz, groundType, cosIncidence) {
  if (groundType === 'rigid' || frequencyHz <= 0) return 1;
  const { planeRe, planeIm } = planeWave(frequencyHz, groundType, cosIncidence);
  return Math.hypot(planeRe, planeIm);
}

/**
 * Class B: spherical-wave reflection coefficient Q = Rp + (1 − Rp)·F(w) of a locally reacting
 * ground (Weyl–Van der Pol; see Attenborough, Li & Horoshenkov, Predicting Outdoor Sound, 2007).
 * Returned as [re, im] in the e^(+iωt) convention of `fft.js`, so it multiplies a forward spectrum.
 * `cosIncidence` is the cosine of the angle from the ground normal; `imagePathMetres` is the
 * image-source path length R2.
 */
export function sphericalReflectionCoefficient(frequencyHz, groundType, cosIncidence, imagePathMetres, speedOfSound) {
  if (groundType === 'rigid' || frequencyHz <= 0) return [1, 0];
  const { planeRe, planeIm, betaIm, sumRe } = planeWave(frequencyHz, groundType, cosIncidence);

  const root = Math.sqrt(2 * Math.PI * frequencyHz / speedOfSound * imagePathMetres) / 2;
  const wRe = root * (sumRe - betaIm);
  const wIm = root * (sumRe + betaIm);
  const [faddeevaRe, faddeevaIm] = faddeeva(wRe, wIm);
  const productRe = wRe * faddeevaRe - wIm * faddeevaIm;
  const productIm = wRe * faddeevaIm + wIm * faddeevaRe;
  const boundaryRe = 1 - SQRT_PI * productIm;
  const boundaryIm = SQRT_PI * productRe;

  const restRe = 1 - planeRe;
  const restIm = -planeIm;
  const qRe = planeRe + restRe * boundaryRe - restIm * boundaryIm;
  const qIm = planeIm + restRe * boundaryIm + restIm * boundaryRe;
  if (!Number.isFinite(qRe) || !Number.isFinite(qIm)) return [planeRe, -planeIm];
  return [qRe, -qIm];
}
