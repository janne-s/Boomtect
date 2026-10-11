import assert from 'node:assert/strict';
import test from 'node:test';
import { entryText, macrosFor, parseEntry } from '../src/ui/macros.js';
import { defaultBarrage, defaultBlast, parseScene, defaultScene } from '../src/domain/scene.js';

const macro = (emitter, label) => macrosFor(emitter).find(item => item.label === label);

test('a typed charge reads in g, kg, t, or kt, and in the shown unit when none is given', () => {
  const blast = { ...defaultBlast(), chargeKilograms: 3.5e8 };
  const { entry } = macro(blast, 'Charge');
  assert.equal(entryText(entry, blast), '350 kt');
  assert.equal(parseEntry(entry, '350 kt', blast), 3.5e8);
  assert.equal(parseEntry(entry, '1,5', blast), 1.5e6);
  assert.equal(parseEntry(entry, '250 g', blast), .25);
  assert.equal(parseEntry(entry, '2t', blast), 2000);
  assert.throws(() => parseEntry(entry, '3 lb', blast), /g, kg, t, kt/);
  assert.throws(() => parseEntry(entry, 'lots', blast), /not a number/);
});

test('a typed height takes m or km, and a plain unit may be left out', () => {
  const blast = { ...defaultBlast(), positionMetres: { x: 0, y: 0, z: 1500 } };
  const height = macro(blast, 'Height').entry;
  assert.equal(entryText(height, blast), '1.5 km');
  assert.equal(parseEntry(height, '2', blast), 2000);
  assert.equal(parseEntry(height, '30 m', blast), 30);
  const fireball = macro(blast, 'Fireball').entry;
  assert.equal(parseEntry(fireball, '-12 dB', blast), -12);
  assert.equal(parseEntry(fireball, '-12', blast), -12);
  assert.throws(() => parseEntry(fireball, '-12 s', blast), /dB/);
});

test('typed counts are whole, and a typed value beyond the slider is left to the scene to check', () => {
  const barrage = defaultBarrage();
  const rounds = macro(barrage, 'Rounds').entry;
  assert.equal(parseEntry(rounds, '12.4', barrage), 12);
  const scene = defaultScene('blast');
  const blast = scene.emitters[0];
  macro(blast, 'Height').entry.set(blast, parseEntry(macro(blast, 'Height').entry, '8 km', blast));
  assert.equal(parseScene(scene).emitters[0].positionMetres.z, 8000);
  macro(blast, 'Charge').entry.set(blast, parseEntry(macro(blast, 'Charge').entry, '400 kt', blast));
  assert.throws(() => parseScene(scene), /chargeKilograms/);
});
