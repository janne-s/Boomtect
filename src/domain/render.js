import { prepareScene as prepareWith } from '../shared/domain/render.js';
import { SOURCE_KINDS } from './sources.js';

export * from '../shared/domain/render.js';

export const prepareScene = scene => prepareWith(scene, SOURCE_KINDS);
