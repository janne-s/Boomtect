import { GROUND } from './constants.js';
import { faddeeva } from './faddeeva.js';

/** Class A for a calm surface. */
const REFLECTING_GROUNDS = Object.freeze(['rigid', 'water']);
export const isReflecting = groundType => REFLECTING_GROUNDS.includes(groundType);

export const GROUND_TYPES = Object.freeze([...REFLECTING_GROUNDS, ...Object.keys(GROUND.flowResistivity)]);

export const GROUND_LABELS = Object.freeze({
  rigid: 'Rigid',
  water: 'Water',
  snow: 'Snow',
  forestFloor: 'Forest floor',
  grass: 'Grass',
  soil: 'Soil',
  stonyGround: 'Stony ground'
});

const SQRT_PI = Math.sqrt(Math.PI);

/** Class B: Delany–Bazley, e^(−iωt) convention. */
export function delanyBazleyImpedance(frequencyHz, flowResistivityKpaSecondsPerSquareMetre) {
  const ratio = frequencyHz / flowResistivityKpaSecondsPerSquareMetre;
  return [1 + 9.08 * ratio ** -.75, 11.9 * ratio ** -.73];
}

/** Class B, e^(−iωt) convention. */
function planeWave(frequencyHz, groundType, cosIncidence) {
  const flowResistivity = GROUND.flowResistivity[groundType];
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

/** Class B. */
export function planeReflectionMagnitude(frequencyHz, groundType, cosIncidence) {
  if (isReflecting(groundType) || frequencyHz <= 0) return 1;
  const { planeRe, planeIm } = planeWave(frequencyHz, groundType, cosIncidence);
  return Math.hypot(planeRe, planeIm);
}

/** Class B: Weyl–Van der Pol (Attenborough, Li & Horoshenkov 2007), in the e^(+iωt) convention of `fft.js`. */
export function sphericalReflectionCoefficient(frequencyHz, groundType, cosIncidence, imagePathMetres, speedOfSound) {
  if (isReflecting(groundType) || frequencyHz <= 0) return [1, 0];
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
