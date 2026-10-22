import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DEFAULT_PLACE, defaultScene, MODES, PARAMETERS, parseScene, readScene, SceneError, serializeScene } from '../src/domain/scene.js';
import { syntheticTerrain } from './terrain-fixture.js';

// Saved by the version each file names and never regenerated: every one must keep opening.
const FIXTURES = ['v28', 'v29', 'v30'].flatMap(version => MODES.map(mode => `scene-${version}-${mode}`));
const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));

test('every saved scene version opens', () => {
  for (const name of FIXTURES) {
    const scene = readScene(fixture(name));
    assert.ok(scene.emitters.length > 1, name);
    assert.deepEqual(readScene(JSON.parse(serializeScene(scene))), scene, name);
  }
});

test('a current scene reads as it was saved', () => {
  for (const mode of MODES) {
    const scene = defaultScene(mode);
    assert.deepEqual(readScene(JSON.parse(serializeScene(scene))), scene);
  }
  const terrain = { ...defaultScene(), terrain: syntheticTerrain(() => 100) };
  assert.deepEqual(readScene(JSON.parse(serializeScene(terrain))), parseScene(terrain));
});

test('the version number neither blocks nor changes reading', () => {
  for (const version of [1, 27, 999, undefined]) {
    const scene = readScene({ ...fixture('scene-v28-thunder'), version });
    assert.deepEqual(scene, readScene(fixture('scene-v28-thunder')));
    assert.equal(scene.version, defaultScene().version);
  }
});

test('a field the scene lacks takes its default', () => {
  const saved = fixture('scene-v28-sonic');
  delete saved.air.temperatureCelsius;
  delete saved.render.quality;
  delete saved.ground;
  delete saved.emitters[0].mach;
  delete saved.emitters[4].crackerShapeFactor;
  delete saved.receivers[1].pitchDegrees;
  const scene = readScene(saved);
  const defaults = defaultScene('sonic');
  assert.equal(scene.air.temperatureCelsius, defaults.air.temperatureCelsius);
  assert.deepEqual(scene.render.quality, defaults.render.quality);
  assert.deepEqual(scene.ground, defaults.ground);
  assert.equal(scene.emitters[0].mach, defaults.emitters[0].mach);
  assert.equal(typeof scene.emitters[4].crackerShapeFactor, 'number');
  assert.equal(scene.receivers[1].pitchDegrees, 0);
  const cloud = fixture('scene-v28-thunder');
  delete cloud.emitters[1].baseMetres;
  assert.notEqual(readScene(cloud).emitters[1].baseMetres.z, 0, 'a cloud flash takes a cloud flash default');
  const terrain = JSON.parse(serializeScene({ ...defaultScene(), terrain: syntheticTerrain(() => 100) }));
  delete terrain.terrain.echoLimit;
  delete terrain.terrain.shielding;
  assert.equal(readScene(terrain).terrain.echoLimit, 500);
  assert.equal(readScene(terrain).terrain.shielding, true);
});

test('a field the scene does not know is dropped', () => {
  const saved = fixture('scene-v28-blast');
  saved.weather = { cloudCover: 1 };
  saved.air.ozone = 3;
  saved.emitters[0].colour = 'red';
  saved.receivers[0].gainDecibels = 6;
  const scene = readScene(saved);
  assert.deepEqual(scene, readScene(fixture('scene-v28-blast')));
});

test('a number outside its range is brought into it, a fraction to a whole number where one is needed', () => {
  const saved = fixture('scene-v28-thunder');
  saved.air.temperatureCelsius = 100;
  saved.receivers[0].positionMetres.z = -1;
  saved.emitters[0].strokeCount = 2.6;
  const scene = readScene(saved);
  assert.equal(scene.air.temperatureCelsius, PARAMETERS.temperatureCelsius.maximum);
  assert.equal(scene.receivers[0].positionMetres.z, PARAMETERS.heightMetres.minimum);
  assert.equal(scene.emitters[0].strokeCount, 3);
  assert.throws(() => parseScene(saved), SceneError, 'an edit outside the range is still refused');
});

test('only what is not a Boomtect scene, or is broken, is refused', () => {
  const broken = [
    null, 'scene', [], {}, { ...defaultScene(), format: 'echotect-project' },
    { ...defaultScene(), mode: 'opera' },
    { ...defaultScene(), emitters: [{ kind: 'volcano' }] },
    { ...defaultScene(), air: { ...defaultScene().air, temperatureCelsius: 'warm' } },
    { ...defaultScene(), receivers: [] },
    { ...defaultScene(), terrain: { place: 'Koli' } }
  ];
  for (const value of broken) assert.throws(() => readScene(value), SceneError);
});

test('every scene has a place, with or without terrain, and its terrain lies there', () => {
  assert.deepEqual(readScene(fixture('scene-v28-thunder')).place, DEFAULT_PLACE);
  const elsewhere = { ...defaultScene(), place: { name: 'Nuuksio', latitude: 60.3, longitude: 24.5 } };
  assert.deepEqual(readScene(JSON.parse(serializeScene(elsewhere))).place, elsewhere.place);
  const terrain = syntheticTerrain(() => 100);
  assert.throws(() => parseScene({ ...elsewhere, terrain }), SceneError);
  const read = readScene({ ...elsewhere, terrain });
  assert.deepEqual([read.place.latitude, read.place.longitude], [terrain.latitude, terrain.longitude]);
  assert.equal(read.place.name, '63.0964, 29.8061');
  assert.throws(() => readScene({ ...defaultScene(), place: { ...DEFAULT_PLACE, latitude: 'north' } }), SceneError);
});
