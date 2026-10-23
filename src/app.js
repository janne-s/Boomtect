import { APP_VERSION, MODEL_VERSION } from './domain/constants.js';
import { prepareScene } from './domain/render.js';
import { defaultScene, emitterAnchor, MODES, PARAMETERS, parseScene, readScene, sceneInMode, serializeScene } from './domain/scene.js';
import * as fields from './ui/fields.js';
import { kindViews } from './ui/kind-views.js';
import { ADD_EMITTERS, followerFlight, KIND_PANELS } from './ui/kinds.js';
import { startFrame } from './shared/ui/frame.js';

startFrame({
  storage: 'boomtect',
  appVersion: APP_VERSION,
  modelVersion: MODEL_VERSION,
  onsetName: 'the flash',
  worker: new URL('./render-worker.js', import.meta.url),
  scene: { MODES, PARAMETERS, defaultScene, parseScene, readScene, sceneInMode, serializeScene },
  prepareScene,
  linkModes: { Rumbletect: { sonic: 'jet', blast: 'volcano', thunder: 'jet' } },
  follower: followerFlight,
  fields,
  kinds: KIND_PANELS,
  views: kindViews(),
  anchor: emitterAnchor,
  add: ADD_EMITTERS,
  modes: {
    thunder: { label: 'Thunder', button: 'fa-bolt', icon: 'fa-bolt' },
    blast: { label: 'Blast', button: 'fa-explosion', icon: 'fa-explosion', arrivalsByDirection: true },
    sonic: { label: 'Sonic', button: 'fa-wave-square', icon: 'fa-jet-fighter', upperWind: true }
  },
  preferences: { cone: true, clouds: true },
  toggles: {
    cone: {
      label: 'Mach cone',
      icon: '<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><ellipse cx="18" cy="12" rx="3" ry="8" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M18 4 3 12l15 8M3 12h15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
      hidden: scene => scene.mode !== 'sonic'
    },
    clouds: { label: 'Cloud', icon: '<i class="fa-solid fa-cloud" aria-hidden="true"></i>', hidden: scene => !scene.emitters.some(emitter => emitter.kind === 'storm') }
  }
});
