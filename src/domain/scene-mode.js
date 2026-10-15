import { parseScene } from './scene.js';

export function sceneInMode(current, saved) {
  return parseScene({ ...saved, place: current.place, terrain: current.terrain });
}
