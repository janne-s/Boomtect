import { defaultScene } from '../src/domain/scene.js';

export function plainScene(mode) {
  const scene = defaultScene(mode);
  scene.ground = { ...scene.ground, forest: false, surroundings: false };
  return scene;
}
