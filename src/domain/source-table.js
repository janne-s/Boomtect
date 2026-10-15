const SOURCE_COLUMNS = Object.freeze({
  x: Float64Array, y: Float64Array, z: Float64Array,
  dx: Float64Array, dy: Float64Array, dz: Float64Array, directed: Uint8Array,
  elementMetres: Float64Array, emissionSeconds: Float64Array, amplitudePaMetres: Float64Array,
  pulse: Uint8Array, noiseSeed: Uint32Array,
  secondaryDelaySeconds: Float64Array, secondaryCubeRoot: Float64Array,
  flight: Uint8Array,
  durationSeconds: Float64Array, decay: Float64Array, spanSeconds: Float64Array, linearRadiusMetres: Float64Array,
  relaxationRadius: Float64Array, sourcePeriodSeconds: Float64Array, limitRadii: Float64Array
});

export function sourceTableBuilder(capacity = 1024) {
  let room = Math.max(1, capacity);
  let length = 0;
  let columns = Object.fromEntries(Object.entries(SOURCE_COLUMNS).map(([key, Type]) => [key, new Type(room)]));
  const grow = () => {
    room = Math.ceil(room * 1.5);
    columns = Object.fromEntries(Object.entries(columns).map(([key, array]) => {
      const larger = new array.constructor(room);
      larger.set(array);
      return [key, larger];
    }));
  };
  return {
    push(source) {
      if (length >= room) grow();
      const index = length;
      const { positionMetres: p, direction: d } = source;
      columns.x[index] = p.x;
      columns.y[index] = p.y;
      columns.z[index] = p.z;
      if (d) {
        columns.dx[index] = d.x;
        columns.dy[index] = d.y;
        columns.dz[index] = d.z;
        columns.directed[index] = 1;
      }
      columns.elementMetres[index] = source.elementMetres;
      columns.emissionSeconds[index] = source.emissionSeconds;
      columns.amplitudePaMetres[index] = source.amplitudePaMetres;
      columns.pulse[index] = PULSE_CODES[source.pulse];
      columns.noiseSeed[index] = source.noiseSeed ?? 0;
      columns.flight[index] = source.flight ? 1 : 0;
      if (source.secondaryShock) {
        columns.secondaryDelaySeconds[index] = source.secondaryShock.delaySeconds;
        columns.secondaryCubeRoot[index] = source.secondaryShock.cubeRootKilograms;
      }
      columns.durationSeconds[index] = source.durationSeconds;
      columns.decay[index] = source.decay;
      columns.spanSeconds[index] = source.spanSeconds;
      columns.linearRadiusMetres[index] = source.linearRadiusMetres;
      if (source.weakShock) {
        columns.relaxationRadius[index] = source.weakShock.relaxationRadius;
        columns.sourcePeriodSeconds[index] = source.weakShock.sourcePeriodSeconds;
        columns.limitRadii[index] = source.weakShock.limitRadii;
      }
      length += 1;
    },
    table() {
      return { length, ...Object.fromEntries(Object.entries(columns).map(([key, array]) => [key, array.subarray(0, length)])) };
    }
  };
}

export function sourceTable(sources) {
  const builder = sourceTableBuilder(sources.length);
  for (const source of sources) builder.push(source);
  return builder.table();
}

export const PULSE_NWAVE = 0;
export const PULSE_FRIEDLANDER = 1;
export const PULSE_NOISE = 2;
export const PULSE_TRIPLE = 3;
const PULSE_CODES = Object.freeze({ 'n-wave': PULSE_NWAVE, friedlander: PULSE_FRIEDLANDER, noise: PULSE_NOISE, triple: PULSE_TRIPLE });

export const sourcePosition = (table, index) => ({ x: table.x[index], y: table.y[index], z: table.z[index] });
