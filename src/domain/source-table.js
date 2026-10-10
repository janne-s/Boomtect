/**
 * Point sources as parallel typed arrays. Emitters produce sources as objects, which also keep
 * their flash geometry alive through shared references; the renderer holds this table instead,
 * about 140 bytes per source against roughly 700 for the objects and their geometry. Units follow
 * the source objects: metres, seconds, pascal-metres.
 */
export function sourceTable(sources) {
  const length = sources.length;
  const table = {
    length,
    x: new Float64Array(length),
    y: new Float64Array(length),
    z: new Float64Array(length),
    /** Unit direction of the radiating line element; directed is 0 for a point without one. */
    dx: new Float64Array(length),
    dy: new Float64Array(length),
    dz: new Float64Array(length),
    directed: new Uint8Array(length),
    elementMetres: new Float64Array(length),
    emissionSeconds: new Float64Array(length),
    amplitudePaMetres: new Float64Array(length),
    /** PULSE_NWAVE, PULSE_FRIEDLANDER, or PULSE_NOISE (a blast's roar, from its seed). */
    pulse: new Uint8Array(length),
    noiseSeed: new Uint32Array(length),
    /** A secondary shock's delay factors (`explosives.js`); 0 for any other source. */
    secondaryDelaySeconds: new Float64Array(length),
    secondaryCubeRoot: new Float64Array(length),
    durationSeconds: new Float64Array(length),
    decay: new Float64Array(length),
    spanSeconds: new Float64Array(length),
    linearRadiusMetres: new Float64Array(length),
    /** The weak-shock parameters; relaxationRadius is 0 for a source without a weak shock. */
    relaxationRadius: new Float64Array(length),
    sourcePeriodSeconds: new Float64Array(length),
    limitRadii: new Float64Array(length)
  };
  sources.forEach((source, index) => {
    const { positionMetres: p, direction: d } = source;
    table.x[index] = p.x;
    table.y[index] = p.y;
    table.z[index] = p.z;
    if (d) {
      table.dx[index] = d.x;
      table.dy[index] = d.y;
      table.dz[index] = d.z;
      table.directed[index] = 1;
    }
    table.elementMetres[index] = source.elementMetres;
    table.emissionSeconds[index] = source.emissionSeconds;
    table.amplitudePaMetres[index] = source.amplitudePaMetres;
    table.pulse[index] = PULSE_CODES[source.pulse];
    table.noiseSeed[index] = source.noiseSeed ?? 0;
    if (source.secondaryShock) {
      table.secondaryDelaySeconds[index] = source.secondaryShock.delaySeconds;
      table.secondaryCubeRoot[index] = source.secondaryShock.cubeRootKilograms;
    }
    table.durationSeconds[index] = source.durationSeconds;
    table.decay[index] = source.decay;
    table.spanSeconds[index] = source.spanSeconds;
    table.linearRadiusMetres[index] = source.linearRadiusMetres;
    if (source.weakShock) {
      table.relaxationRadius[index] = source.weakShock.relaxationRadius;
      table.sourcePeriodSeconds[index] = source.weakShock.sourcePeriodSeconds;
      table.limitRadii[index] = source.weakShock.limitRadii;
    }
  });
  return table;
}

export const PULSE_NWAVE = 0;
export const PULSE_FRIEDLANDER = 1;
export const PULSE_NOISE = 2;
const PULSE_CODES = Object.freeze({ 'n-wave': PULSE_NWAVE, friedlander: PULSE_FRIEDLANDER, noise: PULSE_NOISE });

export const sourcePosition = (table, index) => ({ x: table.x[index], y: table.y[index], z: table.z[index] });
