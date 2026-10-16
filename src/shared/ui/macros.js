export const logPosition = (value, [low, high]) => Math.log(value / low) / Math.log(high / low);
export const logValue = (t, [low, high]) => low * (high / low) ** t;
export const clamp01 = value => Math.min(1, Math.max(0, value));

export const percent = t => `${Math.round(t * 100)} %`;
export const kilo = (value, unit) => (value >= 1000 ? `${+(value / 1000).toPrecision(3)} k${unit}` : `${+value.toPrecision(3)} ${unit}`);
export const metres = value => (value >= 1000 ? `${+(value / 1000).toPrecision(3)} km` : value >= 10 ? `${Math.round(value)} m` : `${+value.toPrecision(2)} m`);

export const METRES = Object.freeze({ factors: Object.freeze({ m: 1, km: 1000 }), show: metres });

export function entryText(entry, item) {
  const value = entry.get(item);
  if (entry.units) return entry.units.show(value);
  return `${+value.toPrecision(6)}${entry.unit ? ` ${entry.unit}` : ''}`;
}

export function parseEntry(entry, text, item) {
  const match = /^\s*([-+]?(?:\d+[.,]?\d*|[.,]\d+)(?:e[-+]?\d+)?)\s*(.*?)\s*$/i.exec(text);
  if (!match) throw new Error(`${text.trim() || 'An empty value'} is not a number.`);
  let value = Number(match[1].replace(',', '.'));
  const unit = match[2];
  if (entry.units) {
    const { factors } = entry.units;
    const shown = entryText(entry, item).split(' ').at(-1);
    const factor = factors[unit || shown];
    if (factor === undefined) throw new Error(`Use ${Object.keys(factors).join(', ')}.`);
    value *= factor;
  } else if (unit && unit !== entry.unit) throw new Error(entry.unit ? `Use ${entry.unit}.` : 'Give a plain number.');
  if (!Number.isFinite(value)) throw new Error(`${text.trim()} is not a number.`);
  return entry.integer ? Math.round(value) : value;
}
