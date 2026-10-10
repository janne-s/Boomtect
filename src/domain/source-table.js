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
    /** 1 for a Friedlander pulse, 0 for an N-wave. */
    friedlander: new Uint8Array(length),
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
    table.friedlander[index] = source.pulse === 'friedlander' ? 1 : 0;
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

export const sourcePosition = (table, index) => ({ x: table.x[index], y: table.y[index], z: table.z[index] });
