import { createFields } from '../shared/ui/fields.js';
import { PARAMETERS } from '../domain/scene.js';

const DISPLAY = Object.freeze({
  energyJoulesPerMetre: { scale: 1e-3, unit: 'kJ/m' },
  acousticEfficiency: { scale: 100, unit: '%' },
  channelSpeedMetresPerSecond: { scale: 1e-3, unit: 'km/s' },
  inCloudSpeedMetresPerSecond: { scale: 1e-3, unit: 'km/s' },
  currentDecayHeightMetres: { scale: 1e-3, unit: 'km' },
  inCloudLengthMetres: { scale: 1e-3, unit: 'km' },
  inCloudEnergyRatio: { scale: 100, unit: '%' },
  branchLengthRatio: { scale: 100, unit: '% of channel' },
  branchEnergyRatio: { scale: 100, unit: '%' },
  groundFlashShare: { scale: 100, unit: '%' },
  newTerminationProbability: { scale: 100, unit: '% of strokes' },
  radiusMetres: { scale: 1e-3, unit: 'km' },
  cloudBaseMetres: { scale: 1e-3, unit: 'km' },
  cloudTopMetres: { scale: 1e-3, unit: 'km' },
  strokeIntervalSeconds: { scale: 1e3, unit: 'ms' },
  subsequentStrokeEnergyRatio: { scale: 100, unit: '%' },
  durationSecondsPerCubeRootKilogram: { scale: 1e3, unit: 'ms/kg^⅓' },
  riseTimeSeconds: { scale: 1e3, unit: 'ms' }
});

export const { actionField, checkboxField, numberField, pointFields, seedField, selectField, textField } = createFields(PARAMETERS, DISPLAY);
