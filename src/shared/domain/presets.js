export const ENVIRONMENT_PRESETS = 'environment';
const NAME_LENGTH = 64;
const VERSION = 1;

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sameSlot = (a, b) => a.section === b.section && a.name === b.name;

export const emptyLibrary = tect => ({ kind: `${tect}.presets`, version: VERSION, presets: [] });

export const presetName = text => String(text).trim().slice(0, NAME_LENGTH);

/** A flight preset of an emitter is listed apart from its devices, under its kind's flight section. */
export const flightSection = section => `${section}-flight`;

/**
 * Every library goes through here, from the browser or a file. `values` holds a device or the air and ground, and
 * `flight` an emitter's path; a preset without a name, a section, or either of them is dropped, and of two with one
 * name in a section the later is kept. A library of another kind is refused whole.
 */
export function readLibrary(value, tect) {
  if (!isRecord(value) || value.kind !== `${tect}.presets` || !Array.isArray(value.presets)) throw new Error(`This is not a ${tect[0].toUpperCase()}${tect.slice(1)} preset library.`);
  const presets = [];
  for (const item of value.presets) {
    if (!isRecord(item) || typeof item.section !== 'string' || !(isRecord(item.values) || isRecord(item.flight))) continue;
    const name = presetName(item.name ?? '');
    if (!name) continue;
    const preset = { section: item.section, name, ...(isRecord(item.values) ? { values: item.values } : {}), ...(isRecord(item.flight) ? { flight: item.flight } : {}) };
    const index = presets.findIndex(other => sameSlot(other, preset));
    if (index >= 0) presets.splice(index, 1);
    presets.push(preset);
  }
  return { kind: `${tect}.presets`, version: VERSION, presets };
}

export const presetsIn = (library, section) => library.presets.filter(preset => preset.section === section).sort((a, b) => a.name.localeCompare(b.name));

export const withPreset = (library, preset) => ({ ...library, presets: [...library.presets.filter(other => !sameSlot(other, preset)), preset] });

export const withoutPreset = (library, section, name) => ({ ...library, presets: library.presets.filter(preset => !sameSlot(preset, { section, name })) });

/** An imported preset replaces one of its name in its section. */
export const mergedLibraries = (library, incoming) => incoming.presets.reduce(withPreset, library);

/** The air and every ground value, switches included: an inversion night without refraction is another night. */
export const environmentValues = scene => structuredClone({ air: scene.air, ground: scene.ground });

export function withEnvironment(scene, values) {
  if (isRecord(values.air)) scene.air = { ...scene.air, ...values.air };
  if (isRecord(values.ground)) scene.ground = { ...scene.ground, ...values.ground };
  return scene;
}
