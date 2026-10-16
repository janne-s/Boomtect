import { APP_VERSION, MODEL_VERSION } from './domain/constants.js';
import { prepareScene } from './domain/render.js';
import { defaultScene, emitterAnchor, MODES, PARAMETERS, parseScene, readScene, sceneInMode, serializeScene } from './domain/scene.js';
import * as fields from './ui/fields.js';
import { kindViews } from './ui/kind-views.js';
import { ADD_EMITTERS, KIND_PANELS } from './ui/kinds.js';
import { startFrame } from './shared/ui/frame.js';

startFrame({
  storage: 'boomtect',
  appVersion: APP_VERSION,
  modelVersion: MODEL_VERSION,
  onsetName: 'the flash',
  worker: new URL('./render-worker.js', import.meta.url),
  scene: { MODES, PARAMETERS, defaultScene, parseScene, readScene, sceneInMode, serializeScene },
  prepareScene,
  fields,
  kinds: KIND_PANELS,
  views: kindViews(),
  anchor: emitterAnchor,
  add: ADD_EMITTERS,
  modes: {
    thunder: { icon: 'fa-bolt' },
    blast: { icon: 'fa-explosion', arrivalsByDirection: true },
    sonic: { icon: 'fa-jet-fighter', upperWind: true }
  },
  preferences: { cone: true, clouds: true },
  toggles: {
    cone: { hidden: scene => scene.mode !== 'sonic' },
    clouds: { hidden: scene => !scene.emitters.some(emitter => emitter.kind === 'storm') }
  }
});
