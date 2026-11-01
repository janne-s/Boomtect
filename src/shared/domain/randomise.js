import { GROUND_TYPES } from './ground.js';
import { PARAMETERS } from './scene.js';

export const RANDOMISE = Object.freeze({ defaultAmount: .5, historyLength: 10 });

const clamp01 = value => Math.min(1, Math.max(0, value));

/** Moves a control's 0–1 position toward a random one; `amount` 1 lands on it, small amounts vary around where the control is. */
export const rolled = (position, random, amount) => clamp01(position + amount * (random() - position));

/** Rolls each unlocked control of `item` in order, so that a control that depends on an earlier one sees the new value. */
export function randomiseControls(item, controls, { random, amount, locked = () => false }) {
  for (const control of controls) {
    if (locked(control)) continue;
    if (control.dual) {
      const [low, high] = control.read(item).map(position => rolled(position, random, amount));
      control.write(item, Math.min(low, high), Math.max(low, high));
    } else control.write(item, rolled(control.read(item), random, amount));
  }
  return item;
}

const tidy = value => +value.toPrecision(3);

/** Class C: spans of everyday weather, narrower than the fields' ranges, which reach conditions few scenes want. */
const AIR_SPANS = Object.freeze({
  temperatureCelsius: { span: [-25, 35] },
  lapseRateKelvinPerMetre: { span: [-.01, .0098] },
  relativeHumidityPercent: { span: [20, 100] },
  pressureKpa: { span: [97, 104] },
  turbulenceStrength: { span: [1e-7, 2e-5], log: true },
  turbulenceScaleMetres: { span: [.3, 5], log: true },
  shadowFloorDecibels: { span: [15, 40] },
  windSpeedMetresPerSecond: { span: [0, 15] },
  windFromDegrees: { span: [0, 360] },
  windShearPerSecond: { span: [-.004, .01] },
  humidityScaleHeightMetres: { span: [1000, 4000] },
  tropopauseMetres: { span: [9000, 16000] },
  groundLayerMetres: { span: [0, 600] },
  groundLayerLapseKelvinPerMetre: { span: [-.04, .01] },
  upperWindMetresPerSecond: { span: [5, 60] },
  upperWindFromDegrees: { span: [0, 360] }
});

const GROUND_SPANS = Object.freeze({
  treeHeightMetres: { span: [5, 30] },
  forestDensity: { span: [.2, 1] }
});

function spanControl(group, key, { span: [low, high], log = false }, applies) {
  const position = value => clamp01(log ? Math.log(Math.max(low, value) / low) / Math.log(high / low) : (value - low) / (high - low));
  const valueAt = t => (log ? low * (high / low) ** t : low + t * (high - low));
  return {
    key, label: PARAMETERS[key].label, applies,
    read: scene => position(scene[group][key]),
    write: (scene, t) => { scene[group][key] = tidy(valueAt(t)); }
  };
}

const groundType = {
  key: 'groundType', label: 'Ground', applies: () => true,
  read: scene => GROUND_TYPES.indexOf(scene.ground.type) / (GROUND_TYPES.length - 1),
  write: (scene, t) => { scene.ground.type = GROUND_TYPES[Math.round(t * (GROUND_TYPES.length - 1))]; }
};

const refracting = scene => scene.air.refraction;

/** The air and ground of the panel; switches stay as they are, and a control applies only while the panel shows it. */
export const ENVIRONMENT_CONTROLS = Object.freeze([
  ...['temperatureCelsius', 'lapseRateKelvinPerMetre', 'relativeHumidityPercent', 'pressureKpa', 'turbulenceStrength', 'turbulenceScaleMetres']
    .map(key => spanControl('air', key, AIR_SPANS[key], () => true)),
  ...['shadowFloorDecibels', 'windSpeedMetresPerSecond', 'windFromDegrees', 'windShearPerSecond', 'humidityScaleHeightMetres', 'tropopauseMetres', 'groundLayerMetres']
    .map(key => spanControl('air', key, AIR_SPANS[key], refracting)),
  spanControl('air', 'groundLayerLapseKelvinPerMetre', AIR_SPANS.groundLayerLapseKelvinPerMetre, scene => scene.air.refraction && scene.air.groundLayerMetres > 0),
  ...['upperWindMetresPerSecond', 'upperWindFromDegrees']
    .map(key => spanControl('air', key, AIR_SPANS[key], (scene, { upperWind }) => scene.air.refraction && upperWind)),
  groundType,
  ...Object.entries(GROUND_SPANS).map(([key, span]) => spanControl('ground', key, span, scene => scene.ground.forest)),
  spanControl('ground', 'surroundingsSeconds', { span: [1, 12], log: true }, scene => scene.ground.surroundings)
]);

/** Whether a control applies is asked as it comes, so that a ground layer rolled above zero also rolls its lapse. */
export function randomiseEnvironment(scene, { upperWind = false, ...options }) {
  for (const control of ENVIRONMENT_CONTROLS) if (control.applies(scene, { upperWind })) randomiseControls(scene, [control], options);
  return scene;
}

/** A lock is kept per kind of section and control, so that a variant or a new emitter of the kind keeps it. */
export const lockKey = (section, control) => `${section}:${control.key ?? control.label}`;
