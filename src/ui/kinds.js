import { BLAST, FLIGHT, THUNDER, VIEW } from '../domain/constants.js';
import { blastSources, emitterSources } from '../domain/emitters.js';
import { EXPLOSIVE_TYPES } from '../domain/explosives.js';
import { emissionSeconds } from '../domain/lightning.js';
import { BODY_TYPES, carlsonBoom, machCone } from '../domain/flight.js';
import { meteorBoom, showerMembers } from '../domain/meteor.js';
import {
  defaultBarrage, defaultBlast, defaultBooster, defaultCloudFlash, defaultFireworks, defaultFlight, defaultFormation, defaultLightning, defaultMeteor, defaultShower, defaultStorm, defaultWhip, PARAMETERS
} from '../domain/scene.js';
import { newSeed } from '../shared/domain/random.js';
import { formatMetres } from '../shared/ui/canvas.js';
import { checkboxField, numberField, pointFields, seedField, selectField, textField } from './fields.js';
import { cachedBursts, cachedFlashes, cachedRounds, cachedTracks, isFieldKind, isFlightKind, isTrackKind } from './geometry-cache.js';
import { formatCharge, macrosFor } from './macros.js';

const KIND_LABELS = Object.freeze({ blast: 'Blast', storm: 'Storm', barrage: 'Barrage', flight: 'Flight', formation: 'Formation', meteor: 'Meteor', shower: 'Shower', whip: 'Whip', booster: 'Booster', fireworks: 'Fireworks' });
const FLASH_TYPE_LABELS = Object.freeze({ 'cloud-to-ground': 'Ground flash', 'intra-cloud': 'Cloud flash' });

const hasSeed = emitter => !['blast', 'meteor', 'whip', 'booster'].includes(emitter.kind) && !isFlightKind(emitter);

const isBlastKind = emitter => emitter.kind === 'blast' || isFieldKind(emitter);
const isMeteorKind = emitter => emitter.kind === 'meteor' || emitter.kind === 'shower';

function emitterKindLabel(emitter) {
  return emitter.kind === 'lightning' ? FLASH_TYPE_LABELS[emitter.flashType] : KIND_LABELS[emitter.kind];
}

function emitterSummary(emitter) {
  if (emitter.kind === 'blast') return `${formatCharge(emitter.chargeKilograms)} at ${formatMetres(emitter.positionMetres.z)}`;
  if (emitter.kind === 'meteor') return `${+emitter.diameterMetres.toPrecision(3)} m meteoroid at ${emitter.speedKilometresPerSecond} km/s, ${emitter.entryDegrees}° down from ${formatMetres(emitter.startMetres.z)}`;
  if (emitter.kind === 'shower') return `${emitter.meteorCount} meteoroids of about ${+emitter.diameterMetres.toPrecision(3)} m over ${emitter.durationSeconds} s`;
  if (emitter.kind === 'booster') return `From ${formatMetres(emitter.startHeightMetres)} at Mach ${emitter.mach.toFixed(2)}, ${emitter.descentDegrees}° down`;
  if (emitter.kind === 'whip') return `Tip at Mach ${emitter.mach.toFixed(2)}, ${formatMetres(emitter.startMetres.z)} above the ground`;
  if (isFlightKind(emitter)) return `${emitter.kind === 'formation' ? `${emitter.memberCount} × ` : ''}${FLIGHT.bodies[emitter.body].label} at Mach ${emitter.mach.toFixed(2)} and ${formatMetres(emitter.startMetres.z)} for ${emitter.durationSeconds} s`;
  if (emitter.kind === 'fireworks') return `${emitter.shellCount} shells of about ${Math.round(emitter.shellDiameterMillimetres)} mm over ${emitter.durationSeconds} s, ${Math.round(emitter.crackleShare * 100)} % crackling`;
  if (emitter.kind === 'barrage') {
    const salvos = Math.ceil(emitter.roundCount / emitter.salvoSize);
    return `${emitter.roundCount} rounds of ${formatCharge(emitter.chargeKilograms)} in ${salvos} salvo${salvos > 1 ? 's' : ''} over ${emitter.durationSeconds} s`;
  }
  const flashes = cachedFlashes(emitter);
  if (emitter.kind === 'storm') {
    const ground = flashes.filter(flash => flash.type === 'cloud-to-ground').length;
    return `${flashes.length} flashes (${ground} ground, ${flashes.length - ground} cloud) over ${emitter.durationSeconds} s`;
  }
  const [flash] = flashes;
  if (!flash) return '';
  const branches = flash.channels.filter(channel => !channel.main).length;
  const terminations = flash.channels.filter(channel => channel.termination).length;
  return `${formatMetres(flash.channels[0].arcs.at(-1))} channel · ${branches} branches · ${flash.strokes.length} strokes`
    + (terminations ? ` · ${terminations} new ground point${terminations > 1 ? 's' : ''}` : '');
}


function detailSections(emitter, { updateEmitter }) {
  const set = key => value => updateEmitter(emitter.id, item => { item[key] = value; });
  const section = (title, build) => ({ title, build });
  const numbers = keys => container => keys.forEach(key => numberField(container, { key, value: emitter[key], onCommit: set(key) }));
  const placement = container => {
    textField(container, { label: 'Name', value: emitter.name, onCommit: set('name') });
    if (hasSeed(emitter)) seedField(container, { value: emitter.seed, onCommit: set('seed'), onNew: () => set('seed')(newSeed()) });
    numberField(container, { key: 'startSeconds', value: emitter.startSeconds, onCommit: set('startSeconds') });
  };
  const centrePlacement = section('Placement', container => {
    placement(container);
    pointFields(container, { label: 'Centre', point: emitter.centreMetres, axes: ['x', 'y'], onCommit: set('centreMetres') });
  });
  const blastSections = [
    section('Source', container => {
      selectField(container, {
        label: 'Explosive', value: emitter.explosive, reliability: 'B',
        options: EXPLOSIVE_TYPES.map(type => [type, BLAST.explosives[type].label]), onCommit: set('explosive')
      });
      numbers(['chargeKilograms', 'linearScaledDistance', 'durationSecondsPerCubeRootKilogram', 'decay', 'riseTimeSeconds'])(container);
      checkboxField(container, { label: 'Secondary shock', value: emitter.secondaryShock, reliability: 'B', onCommit: set('secondaryShock') });
    }),
    section('Fireball', numbers(['fireballDecibels', 'fireballSecondsPerSixthRootKilogram']))
  ];
  if (emitter.kind === 'lightning') {
    const ground = emitter.flashType === 'cloud-to-ground';
    return [
      section('Placement', container => {
        placement(container);
        selectField(container, {
          label: 'Type', value: emitter.flashType, options: Object.entries(FLASH_TYPE_LABELS),
          onCommit: value => updateEmitter(emitter.id, item => {
            item.flashType = value;
            if (value === 'cloud-to-ground') item.baseMetres = { ...item.baseMetres, z: 0 };
            else item.newTerminationProbability = 0;
          })
        });
        pointFields(container, { label: ground ? 'Ground point' : 'Start', point: emitter.baseMetres, axes: ground ? ['x', 'y'] : ['x', 'y', 'z'], onCommit: set('baseMetres') });
        pointFields(container, { label: ground ? 'Cloud end' : 'End', point: emitter.topMetres, onCommit: set('topMetres') });
      }),
      section('Channel', numbers(['segmentLengthMetres', 'straightLengthMetres', 'tortuosityDegrees', 'macroStepMetres', 'macroTortuosityDegrees',
        'branchCount', 'branchDepth', 'branchLengthRatio', 'branchEnergyRatio'])),
      section('Source', numbers(['energyJoulesPerMetre', 'energyVariation', 'acousticEfficiency', 'periodCoefficient', 'weakShockLimitRadii', 'riseTimeSeconds',
        ...(ground ? ['currentDecayHeightMetres'] : [])])),
      ...(ground ? [section('In cloud', numbers(['inCloudLengthMetres', 'inCloudEnergyRatio', 'inCloudSpeedMetresPerSecond']))] : []),
      section('Strokes', numbers(['channelSpeedMetresPerSecond', 'strokeCount', 'strokeIntervalSeconds', 'strokeIntervalSpread', 'subsequentStrokeEnergyRatio',
        ...(ground ? ['newTerminationProbability'] : [])]))
    ];
  }
  if (emitter.kind === 'meteor' || emitter.kind === 'shower') {
    return [
      ...(emitter.kind === 'shower' ? [section('Shower', numbers(['meteorCount', 'radiusMetres', 'durationSeconds', 'diameterSpread']))] : []),
      section('Placement', container => {
        placement(container);
        pointFields(container, { label: 'Start', point: emitter.startMetres, onCommit: set('startMetres') });
        numbers(['headingDegrees', 'entryDegrees', 'endHeightMetres'])(container);
      }),
      section('Meteoroid', numbers(['speedKilometresPerSecond', 'diameterMetres', 'densityKilogramsPerCubicMetre', 'dragCoefficient', 'riseTimeSeconds'])),
      section('Breakup', numbers(['strengthMegapascals', 'breakupCount', 'breakupShare', 'burstShare']))
    ];
  }
  if (emitter.kind === 'booster') {
    return [
      section('Placement', container => {
        placement(container);
        pointFields(container, { label: 'Pad', point: emitter.padMetres, axes: ['x', 'y'], onCommit: set('padMetres') });
      }),
      section('Descent', numbers(['startHeightMetres', 'mach', 'descentDegrees', 'headingDegrees', 'ballisticKilogramsPerSquareMetre'])),
      section('Body', numbers(['lengthMetres', 'shapeFactor', 'riseTimeSeconds']))
    ];
  }
  if (emitter.kind === 'whip') {
    return [
      section('Placement', container => {
        placement(container);
        pointFields(container, { label: 'Start', point: emitter.startMetres, onCommit: set('startMetres') });
        numbers(['headingDegrees', 'climbDegrees'])(container);
      }),
      section('Tip', container => {
        numberField(container, { key: 'whipMach', value: emitter.mach, onCommit: set('mach') });
        numbers(['crackerLengthMetres', 'crackerShapeFactor', 'riseTimeSeconds'])(container);
      })
    ];
  }
  if (isFlightKind(emitter)) {
    return [
      ...(emitter.kind === 'formation' ? [section('Formation', numbers(['memberCount', 'lateralSpacingMetres', 'trailSpacingMetres']))] : []),
      section('Placement', container => {
        placement(container);
        pointFields(container, { label: 'Start', point: emitter.startMetres, onCommit: set('startMetres') });
      }),
      section('Flight', container => {
        numbers(['headingDegrees', 'climbDegrees', 'mach', 'accelerationMetresPerSecondSquared', 'turnDegreesPerSecond'])(container);
        numberField(container, { key: 'flightSeconds', value: emitter.durationSeconds, onCommit: set('durationSeconds') });
      }),
      section('Body', container => {
        selectField(container, {
          label: 'Body', value: emitter.body, reliability: 'B', options: BODY_TYPES.map(type => [type, FLIGHT.bodies[type].label]),
          onCommit: body => updateEmitter(emitter.id, item => {
            item.body = body;
            if (FLIGHT.bodies[body].lengthMetres) Object.assign(item, { lengthMetres: FLIGHT.bodies[body].lengthMetres, shapeFactor: FLIGHT.bodies[body].shapeFactor });
          })
        });
        for (const key of ['lengthMetres', 'shapeFactor']) {
          numberField(container, { key, value: emitter[key], onCommit: value => updateEmitter(emitter.id, item => { item[key] = value; item.body = 'custom'; }) });
        }
        numbers(['riseTimeSeconds'])(container);
      })
    ];
  }
  if (emitter.kind === 'fireworks') {
    return [
      centrePlacement,
      section('Shells', numbers(['radiusMetres', 'durationSeconds', 'shellCount', 'salvoSize', 'salvoSpreadSeconds', 'shellDiameterMillimetres', 'diameterSpread'])),
      section('Crackle', numbers(['crackleShare', 'starCount', 'popsPerStar', 'popMilligrams'])),
      section('Source', numbers(['riseTimeSeconds']))
    ];
  }
  if (emitter.kind === 'barrage') {
    return [
      centrePlacement,
      section('Rounds', numbers(['radiusMetres', 'durationSeconds', 'roundCount', 'salvoSize', 'salvoSpreadSeconds', 'chargeSpread', 'airburstShare', 'airburstHeightMetres'])),
      ...blastSections
    ];
  }
  if (emitter.kind === 'storm') {
    return [
      centrePlacement,
      section('Extent', numbers(['radiusMetres', 'durationSeconds', 'flashCount', 'groundFlashShare', 'cloudBaseMetres', 'cloudTopMetres', 'newTerminationProbability'])),
      section('Source', numbers(['energyJoulesPerMetre', 'energySpread', 'energyVariation', 'acousticEfficiency', 'periodCoefficient', 'weakShockLimitRadii', 'riseTimeSeconds', 'currentDecayHeightMetres'])),
      section('Ground flashes in cloud', numbers(['inCloudLengthMetres', 'inCloudEnergyRatio', 'inCloudSpeedMetresPerSecond'])),
      section('Channel', numbers(['segmentLengthMetres', 'straightLengthMetres', 'tortuosityDegrees', 'macroStepMetres', 'macroTortuosityDegrees', 'branchCount', 'branchDepth', 'branchEnergyRatio']))
    ];
  }
  return [
    section('Placement', container => {
      placement(container);
      pointFields(container, { label: 'Position', point: emitter.positionMetres, onCommit: set('positionMetres') });
    }),
    ...blastSections
  ];
}


function strokeTimeline(emitter, scene, placedPoint) {
  if (emitter.kind === 'blast') return [{ flash: 0, time: emitter.startSeconds, route: [], position: emitter.positionMetres, from: placedPoint(emitter.positionMetres) }];
  if (isMeteorKind(emitter)) {
    return cachedBursts(emitter, scene.air).flatMap((places, index) => places.map(burst => ({ flash: index, time: burst.emissionSeconds, route: [], position: burst.positionMetres, from: burst.positionMetres })));
  }
  if (isTrackKind(emitter)) return [];
  if (isFieldKind(emitter)) {
    return cachedRounds(emitter, scene.air).map((round, index) => ({
      flash: index, time: round.startSeconds, route: [], position: round.positionMetres, from: placedPoint(round.positionMetres),
      shell: round.id.endsWith(':burst') ? round.seed : null
    }));
  }
  return cachedFlashes(emitter).flatMap((flash, index) => flash.strokes.map(stroke => ({ flash: index, time: flash.startSeconds + stroke.offsetSeconds, route: stroke.route })));
}


function wavefrontAmplitudes(emitter, scene, surface) {
  const { air } = scene;
  const front = (amplitude, durationSeconds) => ({ amplitude, frequencyHz: 1 / Math.max(durationSeconds, 1e-6) });
  const blastFront = blast => { const [shock] = blastSources(blast, air); return front(shock.amplitudePaMetres, shock.durationSeconds); };
  const boomFront = (mach, lengthMetres, shapeFactor, distanceMetres) => {
    const boom = carlsonBoom({ mach, vehiclePressurePa: air.pressureKpa * 1000, groundPressurePa: air.pressureKpa * 1000, vehicleSoundSpeed: 340, lengthMetres, shapeFactor, distanceMetres });
    return front(boom.overpressurePa * distanceMetres, boom.durationSeconds);
  };
  if (emitter.kind === 'blast') return new Map([[emitter.id, blastFront(emitter)]]);
  if (isFlightKind(emitter)) {
    const boom = boomFront(Math.max(1.01, emitter.mach), emitter.lengthMetres, emitter.shapeFactor, 1000);
    return new Map(cachedTracks(emitter, air).map((_, index) => [`${emitter.id}:${index}`, boom]));
  }
  if (emitter.kind === 'booster') {
    return new Map([[`${emitter.id}:0`, boomFront(1.5, emitter.lengthMetres, emitter.shapeFactor, 1000)]]);
  }
  if (emitter.kind === 'whip') {
    return new Map([[`${emitter.id}:0`, boomFront(Math.max(1.01, emitter.mach), emitter.crackerLengthMetres, emitter.crackerShapeFactor, 1)]]);
  }
  if (emitter.kind === 'meteor' || emitter.kind === 'shower') {
    return new Map(showerMembers(emitter).map((meteor, index) => {
      const height = meteor.endHeightMetres;
      const boom = meteorBoom(meteor, air, height, height, air.pressureKpa * 1000);
      return [`${emitter.id}:${index}`, front(boom.overpressurePa * height, boom.durationSeconds)];
    }));
  }
  if (isFieldKind(emitter)) return new Map(cachedRounds(emitter, air).map(round => [round.id, blastFront(round)]));
  const energy = new Map();
  for (const source of emitterSources(emitter, air, surface).sources) {
    const group = `${emitter.id}:${source.flash}`;
    const sum = energy.get(group) ?? { energy: 0, frequency: 0 };
    const share = source.amplitudePaMetres ** 2;
    energy.set(group, { energy: sum.energy + share, frequency: sum.frequency + share / Math.max(source.durationSeconds, 1e-6) });
  }
  return new Map([...energy].map(([group, { energy: total, frequency }]) => [group, { amplitude: Math.sqrt(total), frequencyHz: total > 0 ? frequency / total : 1000 }]));
}


function wavefrontSourcesOf(emitter, scene, placedPoint, candidates) {
  if (emitter.kind === 'blast') { candidates.push({ point: placedPoint(emitter.positionMetres), emitted: emitter.startSeconds, group: emitter.id }); return; }
  if (isTrackKind(emitter)) {
    cachedTracks(emitter, scene.air).forEach((path, member) => {
      const every = Math.max(1, Math.ceil(path.seconds.length / VIEW.wavefront.flightFronts));
      for (let index = 0; index < path.seconds.length; index += every) candidates.push({ point: { x: path.x[index], y: path.y[index], z: path.z[index] }, emitted: path.seconds[index], group: `${emitter.id}:${member}` });
    });
    return;
  }
  if (isFieldKind(emitter)) {
    cachedRounds(emitter, scene.air).forEach(round => candidates.push({ point: placedPoint(round.positionMetres), emitted: round.startSeconds, group: round.id }));
    return;
  }
  for (const [flashIndex, flash] of cachedFlashes(emitter).entries()) {
    const [stroke] = flash.strokes;
    for (const step of stroke.route) {
      const channel = flash.channels[step.channel];
      channel.points.forEach((point, index) => {
        const arc = channel.arcs[index];
        if (arc >= step.fromArc) candidates.push({ point, emitted: emissionSeconds(flash, stroke, step, arc), group: `${emitter.id}:${flashIndex}` });
      });
    }
  }
}

function bounds(emitter, scene, include) {
  if (emitter.kind === 'blast') include(emitter.positionMetres);
  else if (isTrackKind(emitter)) { for (const path of cachedTracks(emitter, scene.air)) path.x.forEach((x, index) => include({ x, y: path.y[index] })); }
  else if (emitter.kind === 'storm' || isFieldKind(emitter)) {
    const { x, y } = emitter.centreMetres;
    include({ x: x - emitter.radiusMetres, y: y - emitter.radiusMetres });
    include({ x: x + emitter.radiusMetres, y: y + emitter.radiusMetres });
  } else for (const flash of cachedFlashes(emitter)) for (const channel of flash.channels) channel.points.forEach(include);
}

function measure(item, scene, at) {
  if (item.kind === 'blast') at(item.positionMetres);
  else if (isFieldKind(item)) cachedRounds(item, scene.air).forEach(round => at(round.positionMetres));
  else if (isTrackKind(item)) { for (const path of cachedTracks(item, scene.air)) path.x.forEach((x, index) => at({ x, y: path.y[index], z: path.z[index] })); }
  else for (const flash of cachedFlashes(item)) for (const channel of flash.channels) channel.points.forEach(at);
}

const anchorName = selected => (selected.kind === 'lightning' ? (selected.flashType === 'cloud-to-ground' ? 'ground point' : 'start') : selected.kind === 'storm' || isFieldKind(selected) ? 'centre' : selected.kind === 'booster' ? 'pad' : isTrackKind(selected) ? 'start' : 'blast');

const info = selected => (selected.kind === 'storm' ? [`Cloud ${formatMetres(selected.cloudBaseMetres)}–${formatMetres(selected.cloudTopMetres)} · ${formatMetres(selected.radiusMetres)} radius`] : []);

function move(handle, item, point) {
  if (handle.field === 'cloudBaseMetres' || handle.field === 'cloudTopMetres') {
    const { cloudBaseMetres: base, cloudTopMetres: top } = PARAMETERS;
    const height = Math.round(point.z / 10) * 10;
    if (handle.field === 'cloudBaseMetres') item.cloudBaseMetres = Math.min(base.maximum, item.cloudTopMetres - THUNDER.minimumCloudDepthMetres, Math.max(base.minimum, height));
    else item.cloudTopMetres = Math.min(top.maximum, Math.max(top.minimum, item.cloudBaseMetres + THUNDER.minimumCloudDepthMetres, height));
    return true;
  }
  if (handle.field === 'radiusMetres') {
    item.radiusMetres = Math.round(Math.min(PARAMETERS.radiusMetres.maximum, Math.hypot(point.x - item.centreMetres.x, point.y - item.centreMetres.y)));
    return true;
  }
  return false;
}

function groundAnchored(field, item) {
  if (field === 'centreMetres' || field === 'padMetres') return true;
  if (field === 'startMetres') return item.kind === 'whip';
  if (field === 'baseMetres') return item.flashType === 'cloud-to-ground';
  return field === 'positionMetres';
}

const KINDS = Object.freeze(['lightning', 'storm', 'blast', 'barrage', 'fireworks', 'flight', 'formation', 'meteor', 'shower', 'whip', 'booster']);

export const KIND_PANELS = Object.freeze(Object.fromEntries(KINDS.map(kind => [kind, Object.freeze({
  label: emitterKindLabel,
  summary: emitterSummary,
  macros: macrosFor,
  details: detailSections,
  seeded: hasSeed,
  anchorName,
  info,
  bounds,
  measure,
  move,
  groundAnchored,
  timeline: strokeTimeline,
  alwaysTimed: emitter => isBlastKind(emitter) || isMeteorKind(emitter),
  tracks: (emitter, scene) => (isTrackKind(emitter) ? cachedTracks(emitter, scene.air) : null),
  cone: machCone,
  amplitudes: wavefrontAmplitudes,
  wavefrontSources: wavefrontSourcesOf,
  mergesSources: kind === 'lightning' || kind === 'storm',
  eventSeconds: VIEW.flash.traverseSeconds + VIEW.flash.visibleSeconds
})])));

export const ADD_EMITTERS = Object.freeze({
  lightning: [defaultLightning, 'Ground flash'], cloud: [defaultCloudFlash, 'Cloud flash'], storm: [defaultStorm, 'Storm'],
  meteor: [defaultMeteor, 'Meteor'], shower: [defaultShower, 'Shower'], formation: [defaultFormation, 'Formation'], booster: [defaultBooster, 'Booster'],
  whip: [defaultWhip, 'Whip'], flight: [defaultFlight, 'Flight'], fireworks: [defaultFireworks, 'Fireworks'], barrage: [defaultBarrage, 'Barrage'], blast: [defaultBlast, 'Blast']
});
