import assert from 'node:assert/strict';
import test from 'node:test';
import { ADD_EMITTERS, KIND_PANELS } from '../src/ui/kinds.js';
import { defaultScene, parseScene } from '../src/domain/scene.js';
import { createRandom } from '../src/shared/domain/random.js';
import { randomiseControls, randomiseEnvironment } from '../src/shared/domain/randomise.js';

const ANCHORS = ['positionMetres', 'centreMetres', 'padMetres', 'startMetres', 'baseMetres'];
const ground = point => point && { x: point.x, y: point.y };

test('a full roll of every kind\'s quick controls is a valid scene and with its default locks leaves where and when it is', () => {
  for (const [prefix, { create, mode }] of Object.entries(ADD_EMITTERS)) {
    for (let seed = 1; seed <= 40; seed += 1) {
      const scene = defaultScene(mode);
      const emitter = create(`${prefix}-2`, 'Rolled', 1);
      scene.emitters = [emitter];
      const before = structuredClone(emitter);
      randomiseControls(emitter, KIND_PANELS[emitter.kind].macros(emitter, { onset: true }), { random: createRandom(seed), amount: 1, locked: control => Boolean(control.lockedByDefault) });
      randomiseEnvironment(scene, { random: createRandom(seed + 1000), amount: 1, upperWind: true });
      assert.doesNotThrow(() => parseScene(scene), `${prefix} seed ${seed}`);
      assert.equal(emitter.startSeconds, before.startSeconds, `${prefix} onset`);
      if ('headingDegrees' in before && emitter.kind !== 'tankFarm') assert.equal(emitter.headingDegrees, before.headingDegrees, `${prefix} heading`);
      if (emitter.kind === 'flight' || emitter.kind === 'formation') assert.equal(emitter.durationSeconds, before.durationSeconds, `${prefix} flight time`);
      for (const key of ANCHORS) if (key in before) assert.deepEqual(ground(emitter[key]), ground(before[key]), `${prefix} ${key}`);
      if ('positionMetres' in before) assert.equal(emitter.positionMetres.z, before.positionMetres.z, `${prefix} height`);
    }
  }
});
