import { defaultScene } from '../src/domain/scene.js';

export function plainScene(mode) {
  const scene = defaultScene(mode);
  scene.ground = { ...scene.ground, forest: false, surroundings: false };
  scene.render = { ...scene.render, lowCutHz: 0 };
  return scene;
}
