import { serveRenders } from './shared/render-service.js';
import { prepareScene } from './domain/render.js';
import { parseScene } from './domain/scene.js';

serveRenders({ parseScene, prepareScene });
