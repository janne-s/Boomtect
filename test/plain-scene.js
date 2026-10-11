import { defaultScene } from '../src/domain/scene.js';

/** A default scene without the forest and the surroundings, for tests of the sound that arrives. */
export function plainScene(mode) {
  const scene = defaultScene(mode);
  scene.ground = { ...scene.ground, forest: false, surroundings: false };
  return scene;
}
