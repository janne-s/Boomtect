import { BOOSTER, FLIGHT } from './constants.js';
import { emitterSourceTable } from './emitters.js';
import { fireballSamples } from './fireball.js';
import { boosterPath, flightBooms, flightMembers, whipBody, whipPath } from './flight.js';
import { flightPath, withApproach } from '../shared/domain/trajectory.js';
import { meteorBooms, meteorTrack, showerMembers } from './meteor.js';
import { secondaryBooms } from './secondary.js';
import { codaSamples } from './volcano.js';
import { followedPath } from '../shared/domain/follower.js';

const table = (emitter, scene, surface) => emitterSourceTable(emitter, scene.air, surface, scene.render.quality);

function track(body, path, booms, { secondary = false, shape, caustics = true } = {}) {
  return {
    shape,
    arrivals: (receiver, profile, air) => [...booms(path, body, receiver, profile, air, { caustics }), ...(secondary ? secondaryBooms(path, body, receiver, air) : [])]
  };
}

const flights = (emitter, scene) => ({
  tracks: emitter.paths
    ? emitter.paths.map(saved => track(emitter, withApproach(followedPath(saved), scene.air), flightBooms, { secondary: true }))
    : flightMembers(emitter).map(flight => track(flight, withApproach(flightPath(flight, scene.air), scene.air), flightBooms, { secondary: true }))
});

function meteors(emitter, scene, surface, rows) {
  const tracks = showerMembers(emitter).map(meteor => track(meteor, meteorTrack(meteor), meteorBooms));
  return { tracks, echoRows: rows.slice(tracks.length) };
}

const moving = tracks => ({ sources: table, tracks, turbulentFront: FLIGHT.turbulentFront });
const blasting = { sources: table, noise: fireballSamples };

export const SOURCE_KINDS = Object.freeze({
  lightning: { sources: table },
  storm: { sources: table },
  blast: blasting,
  barrage: blasting,
  fireworks: blasting,
  volcano: { sources: table, noise: codaSamples },
  flight: moving(flights),
  formation: moving(flights),
  meteor: moving(meteors),
  shower: moving(meteors),
  whip: moving((emitter, scene, surface) => ({ tracks: [track(whipBody(emitter), whipPath(emitter, scene.air, surface), flightBooms, { caustics: false })] })),
  booster: moving((emitter, scene, surface) => ({
    tracks: [track(emitter, boosterPath(emitter, scene.air, surface), flightBooms, { secondary: true, shape: { pulse: 'triple', middleShare: BOOSTER.middleShare, middleRatio: BOOSTER.middleRatio } })]
  }))
});
