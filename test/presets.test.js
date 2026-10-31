import assert from 'node:assert/strict';
import test from 'node:test';
import { ADD_EMITTERS, KIND_PANELS } from '../src/ui/kinds.js';
import { defaultBlast, defaultFlight, defaultFormation, defaultGasExplosion, defaultMeteor, defaultScene, defaultShower, defaultVolcano, readScene } from '../src/domain/scene.js';

const loaded = (scene, emitter, { values, flight }) => {
  const next = structuredClone(scene);
  const target = next.emitters.find(item => item.id === emitter.id);
  if (values) KIND_PANELS[emitter.kind].preset.give(target, structuredClone(values));
  if (flight) KIND_PANELS[emitter.kind].preset.giveFlight(target, structuredClone(flight));
  return readScene(next).emitters.find(item => item.id === emitter.id);
};

test('every kind\'s device and flight together are all of it but its name, seed and identity', () => {
  for (const [prefix, { create }] of Object.entries(ADD_EMITTERS)) {
    const emitter = create(`${prefix}-1`, 'Source', 1);
    const { take, takeFlight } = KIND_PANELS[emitter.kind].preset;
    const device = take(emitter);
    const flight = takeFlight(emitter);
    for (const key of ['id', 'name', 'kind', 'enabled', 'seed']) assert.equal(key in device || key in flight, false, `${prefix} ${key}`);
    for (const key of Object.keys(flight)) assert.equal(key in device, false, `${prefix} ${key} in both`);
    assert.deepEqual(new Set([...Object.keys(device), ...Object.keys(flight)]), new Set(Object.keys(emitter).filter(key => !['id', 'name', 'kind', 'enabled', 'seed'].includes(key))), prefix);
  }
});

test('a blast\'s device changes the charge and leaves where and when it goes off', () => {
  const scene = defaultScene('blast');
  const source = { ...defaultBlast('blast-9', 'Source', 7), chargeKilograms: 900, explosive: 'anfo', positionMetres: { x: 50, y: 60, z: 3 } };
  const target = { ...defaultBlast('blast-1', 'Target', 2), positionMetres: { x: -400, y: 300, z: 1 }, startSeconds: 2 };
  scene.emitters = [target];
  const result = loaded(scene, target, { values: KIND_PANELS.blast.preset.take(source) });
  assert.equal(result.chargeKilograms, 900);
  assert.equal(result.explosive, 'anfo');
  for (const key of ['positionMetres', 'startSeconds', 'name', 'seed']) assert.deepEqual(result[key], target[key], key);
});

test('a place loads between point kinds, and a flight\'s path into a formation leaves its body and its own spacing', () => {
  const scene = defaultScene('blast');
  const volcano = { ...defaultVolcano('volcano-1', 'Volcano', 1), positionMetres: { x: 700, y: -200, z: 900 }, startSeconds: 4 };
  const gas = defaultGasExplosion('gas-explosion-1', 'Gas', 2);
  scene.emitters = [volcano, gas];
  assert.equal(KIND_PANELS.volcano.preset.flightSection, KIND_PANELS.gasExplosion.preset.flightSection);
  const placed = loaded(scene, gas, { flight: KIND_PANELS.volcano.preset.takeFlight(volcano) });
  assert.deepEqual(placed.positionMetres, volcano.positionMetres);
  assert.equal(placed.startSeconds, 4);
  assert.equal(placed.cloudCubicMetres, gas.cloudCubicMetres);

  const sonic = defaultScene('sonic');
  const flight = { ...defaultFlight('flight-1', 'Flight', 1), mach: 2.2, headingDegrees: 120, startMetres: { x: 1, y: 2, z: 15000 }, body: 'bomber' };
  const formation = defaultFormation('formation-1', 'Formation', 2);
  sonic.emitters = [flight, formation];
  const flown = loaded(sonic, formation, { flight: KIND_PANELS.flight.preset.takeFlight(flight) });
  for (const key of ['mach', 'headingDegrees', 'startMetres']) assert.deepEqual(flown[key], flight[key], key);
  for (const key of ['body', 'memberCount', 'lateralSpacingMetres']) assert.deepEqual(flown[key], formation[key], key);
});

test('a meteoroid loads into a shower and back, and only a shower carries its count', () => {
  const scene = defaultScene('sonic');
  const shower = { ...defaultShower('shower-1', 'Shower', 3), meteorCount: 12, diameterMetres: 2 };
  const meteor = { ...defaultMeteor('meteor-1', 'Meteor', 4), diameterMetres: 7 };
  scene.emitters = [meteor, shower];
  assert.equal(KIND_PANELS.meteor.preset.section, KIND_PANELS.shower.preset.section);
  const intoShower = loaded(scene, shower, { values: KIND_PANELS.meteor.preset.take(meteor) });
  assert.equal(intoShower.diameterMetres, 7);
  assert.equal(intoShower.meteorCount, 12);
  const intoMeteor = loaded(scene, meteor, { values: KIND_PANELS.shower.preset.take(shower) });
  assert.equal(intoMeteor.diameterMetres, 2);
  assert.equal('meteorCount' in intoMeteor, false);
});

test('a preset from another version loads: a missing field keeps the emitter\'s, one out of range is brought in', () => {
  const scene = defaultScene('blast');
  const blast = defaultBlast();
  scene.emitters = [blast];
  const result = loaded(scene, blast, { values: { chargeKilograms: 1e30, unknown: 1 } });
  assert.ok(Number.isFinite(result.chargeKilograms) && result.chargeKilograms < 1e30);
  assert.equal(result.explosive, blast.explosive);
  assert.equal('unknown' in result, false);
});
