import { pressureDecibels } from '../domain/levels.js';

const CHARGE_UNITS = Object.freeze([[1e9, 'Mt'], [1e6, 'kt'], [1e3, 't'], [1, 'kg'], [1e-3, 'g']]);

export const formatDecibels = decibels => `${Number.isFinite(decibels) ? Math.round(decibels) : '−∞'} dB`;

export const formatPressure = pa => `${+pa.toPrecision(3)} Pa (${formatDecibels(pressureDecibels(pa))})`;

export const formatAtKilometre = text => `${text} at 1 km`;

export function formatCharge(kilograms) {
  const [factor, unit] = CHARGE_UNITS.find(([size]) => kilograms >= size) ?? CHARGE_UNITS.at(-1);
  return `${+(kilograms / factor).toPrecision(3)} ${unit} TNT`;
}

export const formatMicrophoneLevels = ({ peakPa, loudestDecibelsA }) =>
  `Peak ${formatPressure(peakPa)} · Loudest ${formatDecibels(loudestDecibelsA).replace(/ dB$/, ' dB(A)')}`;
