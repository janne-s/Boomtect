import { parseScene } from './scene.js';

/** A mode owns its emitters and acoustics; the active geographic environment travels with it. */
export function sceneInMode(current, saved) {
  return parseScene({ ...saved, place: current.place, terrain: current.terrain });
}
