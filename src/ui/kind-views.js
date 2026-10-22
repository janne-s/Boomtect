import { FIREWORKS, STANDARD_GRAVITY_METRES_PER_SECOND_SQUARED, VIEW } from '../domain/constants.js';
import { airDensityKilogramsPerCubicMetre } from '../shared/domain/air.js';
import { emissionSeconds } from '../domain/lightning.js';
import { createRandom } from '../shared/domain/random.js';
import { cachedFlashes, cachedRounds, cachedTracks } from './geometry-cache.js';

const DISC_POINTS = 64;

const flashPoints = new WeakMap();
const channelPaths = new WeakMap();
const soundTravel = new WeakMap();

function flicker(seed, elapsed) {
  const level = knot => {
    if (knot <= 0) return 1;
    let value = Math.imul((seed >>> 0) ^ Math.imul(knot, 0x9e3779b1), 0x85ebca6b) >>> 0;
    value = Math.imul(value ^ (value >>> 13), 0xc2b2ae35) >>> 0;
    return .35 + .65 * ((value ^ (value >>> 16)) >>> 0) / 4294967296;
  };
  const position = Math.max(0, elapsed) / VIEW.flash.flickerSeconds;
  const knot = Math.floor(position);
  const t = position - knot;
  const eased = t * t * (3 - 2 * t);
  return level(knot) + (level(knot + 1) - level(knot)) * eased;
}


function frontArc(step, elapsed, routeLength) {
  return step.fromArc + elapsed / VIEW.flash.traverseSeconds * routeLength - step.offsetMetres;
}

export function kindViews() {
  let frame; let scene; let view; let canvas; let placed; let ground; let polygon; let strokePoints; let shadowProjectors; let sized; let mixColors; let rgb; let clouds;
  const cloudLayers = new Map();
  let cloudLight = null;
  const use = tools => {
    ({ frame, scene, view, canvas, placed, ground, polygon, strokePoints, shadowProjectors, sized, mixColors, rgb } = tools);
    clouds = () => tools.option('clouds');
    return tools;
  };
  const channelBase = emitter => (emitter.flashType === 'cloud-to-ground' ? placed(emitter.baseMetres) : emitter.baseMetres);
  const flashShadow = emitter => {
    const flashes = cachedFlashes(emitter);
    if (!flashPoints.has(flashes)) flashPoints.set(flashes, flashes.flatMap(flash => flash.channels.flatMap(channel => channel.points)));
    return flashPoints.get(flashes);
  };
  const flashExtent = (emitter, { includeExtent }) => {
    const flashes = cachedFlashes(emitter);
    includeExtent(flashes, () => flashes.flatMap(flash => flash.channels.flatMap(channel => channel.points)));
  };

  function pointsUpTo(channel, fromArc, toArc) {
    const result = [];
    const { points, arcs } = channel;
    for (let index = 0; index < points.length; index += 1) {
      if (arcs[index] < fromArc) continue;
      if (arcs[index] > toArc) {
        if (index > 0 && arcs[index - 1] < toArc) {
          const a = points[index - 1]; const b = points[index];
          const t = (toArc - arcs[index - 1]) / (arcs[index] - arcs[index - 1]);
          result.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });
        }
        break;
      }
      result.push(points[index]);
    }
    return result;
  }


  function drawChannels(context, emitter, colors, selected, strokes) {
    const shadows = shadowProjectors();
    const flashes = cachedFlashes(emitter);
    context.lineJoin = 'round';
    let paths = channelPaths.get(flashes);
    if (paths?.key !== frame.key) {
      const shadowPath = new Path2D();
      const styles = new Map();
      const addLine = (path, points, toScreen) => points.forEach((point, index) => {
        const p = toScreen(point);
        if (index) path.lineTo(p.x, p.y); else path.moveTo(p.x, p.y);
      });
      for (const flash of flashes) {
        for (const channel of flash.channels) {
          if (channel.main) shadows.forEach(shadow => addLine(shadowPath, channel.points, shadow));
          const style = channel.main ? 'main' : channel.level;
          if (!styles.has(style)) styles.set(style, { main: channel.main, level: channel.level, path: new Path2D() });
          addLine(styles.get(style).path, channel.points, frame.project);
        }
      }
      paths = { key: frame.key, shadowPath, styles: [...styles.values()] };
      channelPaths.set(flashes, paths);
    }
    const alpha = context.globalAlpha;
    context.strokeStyle = colors.shadow;
    context.lineWidth = .6;
    context.stroke(paths.shadowPath);
    context.strokeStyle = colors.lightning;
    for (const { main, level, path } of paths.styles) {
      context.globalAlpha = alpha * (main ? 1 : Math.max(.35, .8 - .2 * level));
      context.lineWidth = main ? (selected ? 1.6 : 1.1) : Math.max(.4, .8 - .15 * level);
      context.stroke(path);
    }
    context.globalAlpha = alpha;
    for (const stroke of strokes ?? []) {
      const flash = flashes[stroke.flash];
      if (!flash) continue;
      const routeLength = Math.max(...stroke.route.map(step => step.offsetMetres + flash.channels[step.channel].arcs.at(-1) - step.fromArc));
      const fade = stroke.elapsed > VIEW.flash.traverseSeconds ? Math.exp(-(stroke.elapsed - VIEW.flash.traverseSeconds) / VIEW.flash.fadeSeconds) : 1;
      context.shadowColor = colors.glow;
      context.strokeStyle = colors.flash;
      for (const step of stroke.route) {
        const channel = flash.channels[step.channel];
        const reached = frontArc(step, stroke.elapsed, routeLength);
        if (reached <= step.fromArc) continue;
        const lit = pointsUpTo(channel, step.fromArc, reached);
        if (lit.length < 2) continue;
        context.globalAlpha = fade;
        context.shadowBlur = 18 * fade;
        context.lineWidth = channel.main ? 2.6 : 1.3;
        strokePoints(context, lit);
        context.shadowBlur = 0;
        context.globalAlpha = .35 * fade;
        context.lineWidth = channel.main ? 1.2 : .6;
        shadows.forEach(shadow => strokePoints(context, lit, shadow));
      }
      context.globalAlpha = emitter.enabled ? 1 : .35;
    }
  }

  function drawSoundGlow(context, emitter, colors, sound) {
    const levels = [[], [], [], []];
    const { seconds, travelSeconds, key } = sound;
    const travel = channel => {
      const kept = soundTravel.get(channel);
      if (kept?.key === key) return kept.seconds;
      const values = Float64Array.from(channel.points, travelSeconds);
      soundTravel.set(channel, { key, seconds: values });
      return values;
    };
    const glow = arrival => {
      const age = seconds - arrival;
      return age >= 0 && age < VIEW.soundGlowSeconds ? 1 - age / VIEW.soundGlowSeconds : 0;
    };
    for (const flash of cachedFlashes(emitter)) {
      for (const stroke of flash.strokes) {
        if (seconds < flash.startSeconds + stroke.offsetSeconds) continue;
        for (const step of stroke.route) {
          const channel = flash.channels[step.channel];
          const travelled = travel(channel);
          let previous = null;
          channel.points.forEach((point, index) => {
            const arc = channel.arcs[index];
            if (arc < step.fromArc) return;
            const level = glow(emissionSeconds(flash, stroke, step, arc) + travelled[index]);
            if (previous && level > .02) levels[Math.min(3, Math.floor(level * 4))].push(previous, point);
            previous = point;
          });
        }
      }
    }
    context.strokeStyle = colors.flash;
    context.shadowColor = colors.glow;
    levels.forEach((pairs, level) => {
      if (!pairs.length) return;
      context.globalAlpha = (level + 1) / 4;
      context.shadowBlur = 6 + 4 * level;
      context.lineWidth = 1.2 + .6 * level;
      context.beginPath();
      for (let index = 0; index < pairs.length; index += 2) {
        const a = frame.project(pairs[index]);
        const b = frame.project(pairs[index + 1]);
        context.moveTo(a.x, a.y);
        context.lineTo(b.x, b.y);
      }
      context.stroke();
    });
    context.shadowBlur = 0;
    context.globalAlpha = 1;
  }


  function drawStorm(context, emitter, colors, selected) {
    const { x, y } = emitter.centreMetres;
    const ring = z => Array.from({ length: DISC_POINTS }, (_, index) => {
      const angle = 2 * Math.PI * index / DISC_POINTS;
      return { x: x + emitter.radiusMetres * Math.cos(angle), y: y + emitter.radiusMetres * Math.sin(angle), z };
    });
    if (!clouds()) {
      context.fillStyle = colors.cloud;
      polygon(context, ring(emitter.cloudBaseMetres)); context.fill();
      polygon(context, ring(emitter.cloudTopMetres)); context.fill();
    }
    context.strokeStyle = selected ? colors.accent : colors.lightning;
    context.lineWidth = selected ? 1.4 : 1.2;
    polygon(context, ring(0).map(point => ({ ...point, z: ground(point.x, point.y) }))); context.stroke();
  }

  function cloudPuffs(emitter) {
    const random = createRandom(emitter.seed ^ 0x5c10d);
    const { x, y } = emitter.centreMetres;
    const base = emitter.cloudBaseMetres;
    const depth = emitter.cloudTopMetres - base;
    return Array.from({ length: VIEW.cloud.puffs }, () => {
      const share = random() ** 1.4;
      const reach = emitter.radiusMetres * (.75 + VIEW.cloud.anvilSpread * share ** 4);
      const angle = 2 * Math.PI * random();
      const distance = reach * Math.sqrt(random());
      return {
        centre: { x: x + distance * Math.cos(angle), y: y + distance * Math.sin(angle), z: base + depth * share },
        radius: Math.max(depth * (.22 + .22 * random()), emitter.radiusMetres * .18),
        share
      };
    });
  }

  function drawCloud(context, emitter, colors) {
    const key = [view.yaw, view.pitch, view.zoom, view.panU, view.panV, canvas.width, canvas.height, emitter.seed, emitter.centreMetres.x, emitter.centreMetres.y, emitter.radiusMetres, emitter.cloudBaseMetres, emitter.cloudTopMetres, colors['storm-base'], colors['storm-top'], frame.box.x0, frame.box.x1, frame.box.z1].join('|');
    let layer = cloudLayers.get(emitter.id);
    if (layer?.key !== key) {
      const canvasLayer = sized(layer?.canvas);
      const paint = canvasLayer.getContext('2d');
      const ratio = window.devicePixelRatio || 1;
      paint.setTransform(ratio, 0, 0, ratio, 0, 0);
      const dark = rgb(colors['storm-base']);
      const light = rgb(colors['storm-top']);
      const puffs = cloudPuffs(emitter).map(puff => {
        const p = frame.project(puff.centre);
        const edge = frame.project({ ...puff.centre, z: puff.centre.z + puff.radius });
        return { ...puff, p, size: Math.hypot(edge.x - p.x, edge.y - p.y) };
      }).sort((a, b) => b.p.depth - a.p.depth);
      for (const { p, size, share } of puffs) {
        const [r, g, b] = mixColors(dark, light, share ** 1.5);
        const gradient = paint.createRadialGradient(p.x, p.y, 0, p.x, p.y, size);
        gradient.addColorStop(0, `rgba(${r},${g},${b},${VIEW.cloud.puffAlpha})`);
        gradient.addColorStop(.6, `rgba(${r},${g},${b},${VIEW.cloud.puffAlpha * .5})`);
        gradient.addColorStop(1, `rgba(${r},${g},${b},0)`);
        paint.fillStyle = gradient;
        paint.beginPath();
        paint.arc(p.x, p.y, size, 0, 2 * Math.PI);
        paint.fill();
      }
      layer = { key, canvas: canvasLayer };
      cloudLayers.set(emitter.id, layer);
    }
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.drawImage(layer.canvas, 0, 0);
    context.restore();
  }

  function drawCloudLight(context, emitter, colors, strokes) {
    const layer = cloudLayers.get(emitter.id);
    if (!layer || !strokes?.length) return;
    const flashes = cachedFlashes(emitter);
    const depth = emitter.cloudTopMetres - emitter.cloudBaseMetres;
    cloudLight = { light: sized(cloudLight?.light), mask: sized(cloudLight?.mask) };
    const { light, mask } = cloudLight;
    const ratio = window.devicePixelRatio || 1;
    const glow = light.getContext('2d');
    glow.setTransform(ratio, 0, 0, ratio, 0, 0);
    glow.globalCompositeOperation = 'lighter';
    const [r, g, b] = rgb(colors.flash);
    let lit = false;
    for (const stroke of strokes) {
      const flash = flashes[stroke.flash];
      if (!flash) continue;
      const fade = stroke.elapsed > VIEW.flash.traverseSeconds ? Math.exp(-(stroke.elapsed - VIEW.flash.traverseSeconds) / VIEW.flash.fadeSeconds) : 1;
      const intensity = VIEW.cloud.flashAlpha * fade * flicker(emitter.seed + stroke.flash * 7919, stroke.elapsed);
      if (intensity < .01) continue;
      const routeLength = Math.max(...stroke.route.map(step => step.offsetMetres + flash.channels[step.channel].arcs.at(-1) - step.fromArc));
      const inCloud = stroke.route.flatMap(step => {
        const reached = frontArc(step, stroke.elapsed, routeLength);
        return reached > step.fromArc ? pointsUpTo(flash.channels[step.channel], step.fromArc, reached) : [];
      }).filter(point => point.z >= emitter.cloudBaseMetres);
      const along = inCloud.length ? inCloud : [flash.channels[0].points.at(-1)];
      const random = createRandom((emitter.seed ^ Math.imul(stroke.flash + 1, 0x27d4eb2d)) >>> 0);
      for (let blob = 0; blob < VIEW.cloud.flashBlobs; blob += 1) {
        const at = along[Math.min(along.length - 1, Math.floor((blob + random()) / VIEW.cloud.flashBlobs * along.length))];
        const offset = depth * VIEW.cloud.blobScatter;
        const centre = { x: at.x + offset * (random() - .5), y: at.y + offset * (random() - .5), z: at.z + offset * (random() - .5) };
        const p = frame.project(centre);
        const edge = frame.project({ ...centre, z: centre.z + depth * VIEW.cloud.flashReach * (.6 + .8 * random()) });
        const size = Math.hypot(edge.x - p.x, edge.y - p.y);
        const gradient = glow.createRadialGradient(p.x, p.y, 0, p.x, p.y, size);
        const alpha = intensity / VIEW.cloud.flashBlobs * 2.2;
        gradient.addColorStop(0, `rgba(${r},${g},${b},${alpha})`);
        gradient.addColorStop(.45, `rgba(${r},${g},${b},${alpha * .45})`);
        gradient.addColorStop(1, `rgba(${r},${g},${b},0)`);
        glow.fillStyle = gradient;
        glow.beginPath();
        glow.arc(p.x, p.y, size, 0, 2 * Math.PI);
        glow.fill();
        lit = true;
      }
    }
    if (!lit) return;
    const shape = mask.getContext('2d');
    shape.drawImage(layer.canvas, 0, 0);
    shape.globalCompositeOperation = 'source-in';
    shape.drawImage(light, 0, 0);
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalCompositeOperation = 'lighter';
    context.drawImage(mask, 0, 0);
    context.restore();
  }


  function drawBlast(context, emitter, colors, state) {
    const stroke = state?.strokes.get(emitter.id)?.[0];
    if (stroke) drawBurst(context, frame.project(placed(emitter.positionMetres)), stroke, colors);
  }

  function drawBarrage(context, emitter, colors, selected, state) {
    const { x, y } = emitter.centreMetres;
    context.strokeStyle = selected ? colors.accent : colors.end;
    context.lineWidth = selected ? 1.4 : 1.2;
    polygon(context, Array.from({ length: DISC_POINTS }, (_, index) => {
      const angle = 2 * Math.PI * index / DISC_POINTS;
      const px = x + emitter.radiusMetres * Math.cos(angle);
      const py = y + emitter.radiusMetres * Math.sin(angle);
      return { x: px, y: py, z: ground(px, py) };
    }));
    context.stroke();
    context.fillStyle = colors.end;
    const alpha = context.globalAlpha;
    context.globalAlpha = alpha * .5;
    const rounds = cachedRounds(emitter, scene.air);
    for (const round of rounds) {
      const p = frame.project(placed(round.positionMetres));
      context.beginPath(); context.arc(p.x, p.y, 1.5, 0, 2 * Math.PI); context.fill();
    }
    if (emitter.kind === 'fireworks') {
      context.lineWidth = .8;
      const mortars = new Map(rounds.filter(round => round.id.endsWith(':thump')).map(round => [round.id.slice(0, -':thump'.length), round]));
      context.beginPath();
      for (const round of rounds) {
        const mortar = round.id.endsWith(':burst') ? mortars.get(round.id.slice(0, -':burst'.length)) : null;
        if (!mortar) continue;
        const from = frame.project(placed(mortar.positionMetres));
        const to = frame.project(placed(round.positionMetres));
        context.moveTo(from.x, from.y); context.lineTo(to.x, to.y);
      }
      context.stroke();
    }
    context.globalAlpha = alpha;
    for (const stroke of state?.strokes.get(emitter.id) ?? []) {
      if (stroke.shell === null || stroke.shell === undefined) {
        drawBurst(context, frame.project(placed(stroke.position)), stroke, colors);
        continue;
      }
      const color = colors.fireworks[stroke.shell % colors.fireworks.length];
      drawStars(context, placed(stroke.position), stroke, color);
      drawBurst(context, frame.project(placed(stroke.position)), stroke, colors, color);
    }
  }

  function drawStars(context, centre, stroke, color) {
    const { stars, burnSeconds } = VIEW.fireworks;
    const t = stroke.elapsed;
    if (t >= burnSeconds) return;
    const pull = airDensityKilogramsPerCubicMetre(scene.air.pressureKpa * 1000, scene.air.temperatureCelsius) / (2 * FIREWORKS.starKilogramsPerSquareMetre);
    const reach = Math.log1p(pull * FIREWORKS.starMetresPerSecond * t) / pull;
    const sag = STANDARD_GRAVITY_METRES_PER_SECOND_SQUARED * t * t / 2;
    const turn = stroke.shell / 0x100000000 * 2 * Math.PI;
    const alpha = context.globalAlpha;
    context.globalAlpha = alpha * (1 - t / burnSeconds) ** 1.5;
    context.fillStyle = color;
    context.beginPath();
    for (let star = 0; star < stars; star += 1) {
      const up = 1 - 2 * (star + .5) / stars;
      const around = turn + star * Math.PI * (3 - Math.sqrt(5));
      const across = Math.sqrt(1 - up * up);
      const p = frame.project({ x: centre.x + reach * across * Math.cos(around), y: centre.y + reach * across * Math.sin(around), z: centre.z + reach * up - sag });
      context.moveTo(p.x + 1.6, p.y);
      context.arc(p.x, p.y, 1.6, 0, 2 * Math.PI);
    }
    context.fill();
    context.globalAlpha = alpha;
  }

  function drawFlight(context, emitter, colors, selected, state) {
    context.strokeStyle = selected ? colors.accent : colors.end;
    context.lineWidth = selected ? 1.4 : 1.2;
    for (const path of cachedTracks(emitter, scene.air)) {
      context.beginPath();
      for (let index = 0; index < path.x.length; index += 1) {
        const p = frame.project({ x: path.x[index], y: path.y[index], z: path.z[index] });
        if (index === 0) context.moveTo(p.x, p.y); else context.lineTo(p.x, p.y);
      }
      context.stroke();
    }
    for (const body of state?.flights?.get(emitter.id) ?? []) {
      const p = frame.project(body);
      context.fillStyle = colors.flash;
      context.shadowColor = colors.glow;
      context.shadowBlur = 12;
      context.beginPath(); context.arc(p.x, p.y, 5, 0, 2 * Math.PI); context.fill();
      context.shadowBlur = 0;
    }
    for (const stroke of state?.strokes.get(emitter.id) ?? []) drawBurst(context, frame.project(stroke.position), stroke, colors);
  }


  function drawBurst(context, centre, stroke, colors, glow = colors.glow) {
    const alpha = context.globalAlpha;
    const level = Math.exp(-stroke.elapsed / VIEW.flash.fadeSeconds);
    context.fillStyle = colors.flash;
    context.shadowColor = glow;
    context.shadowBlur = 30 * level;
    context.globalAlpha = alpha * level;
    context.beginPath(); context.arc(centre.x, centre.y, 4 + 12 * level, 0, 2 * Math.PI); context.fill();
    context.shadowBlur = 0;
    context.globalAlpha = alpha;
  }

  const ring = (emitter, groundOnly) => [
    { type: 'emitter', id: emitter.id, field: 'centreMetres', point: placed(emitter.centreMetres), onGround: true, role: 'start' },
    { type: 'emitter', id: emitter.id, field: 'radiusMetres', point: placed({ x: emitter.centreMetres.x + emitter.radiusMetres, y: emitter.centreMetres.y, z: 0 }), onGround: true, role: 'radius' },
    ...(groundOnly ? [] : ['cloudBaseMetres', 'cloudTopMetres'].map(field => ({
      type: 'emitter', id: emitter.id, field, point: { x: emitter.centreMetres.x - emitter.radiusMetres, y: emitter.centreMetres.y, z: emitter[field] }, role: 'level', verticalOnly: true, ownPlaneOnly: true
    })))
  ];

  const trackStart = emitter => (emitter.kind === 'booster' ? placed(emitter.padMetres) : emitter.kind === 'whip' ? placed(emitter.startMetres) : emitter.startMetres);

  const flash = {
    handles: (emitter, box, tools) => {
      use(tools);
      return [
        { type: 'emitter', id: emitter.id, field: 'baseMetres', point: channelBase(emitter), onGround: emitter.flashType === 'cloud-to-ground', role: 'start' },
        { type: 'emitter', id: emitter.id, field: 'topMetres', point: emitter.topMetres, role: 'end' }
      ];
    },
    extent: (emitter, tools) => flashExtent(emitter, tools),
    shadowPoints: emitter => flashShadow(emitter),
    selectedPoints: (emitter, tools) => { use(tools); return [channelBase(emitter), emitter.topMetres]; },
    label: emitter => emitter.topMetres,
    draw(context, emitter, tools, { colors, selected, state }) {
      use(tools);
      drawChannels(context, emitter, colors, selected, state?.strokes.get(emitter.id));
      if (state?.sound && emitter.enabled) drawSoundGlow(context, emitter, colors, state.sound);
    }
  };

  const storm = {
    handles: (emitter, box, tools) => { use(tools); return ring(emitter, false); },
    extent(emitter, tools) {
      const { include } = tools;
      const { x, y } = emitter.centreMetres;
      const r = emitter.radiusMetres;
      include({ x: x - r, y: y - r, z: emitter.cloudTopMetres });
      include({ x: x + r, y: y + r, z: 0 });
      flashExtent(emitter, tools);
    },
    shadowPoints: emitter => flashShadow(emitter),
    selectedPoints: () => [],
    label: (emitter, tools) => use(tools).placed(emitter.centreMetres),
    draw(context, emitter, tools, options) {
      use(tools);
      drawStorm(context, emitter, options.colors, options.selected);
      flash.draw(context, emitter, tools, options);
    },
    overlay(context, emitter, tools, { colors, state }) {
      use(tools);
      if (!clouds() || !emitter.enabled) return;
      drawCloud(context, emitter, colors);
      drawCloudLight(context, emitter, colors, state?.strokes.get(emitter.id));
    }
  };

  const blast = {
    handles: (emitter, box, tools) => { use(tools); return [{ type: 'emitter', id: emitter.id, field: 'positionMetres', point: placed(emitter.positionMetres), role: 'source' }]; },
    extent: (emitter, { include, placed: place }) => include(place(emitter.positionMetres)),
    shadowPoints: (emitter, tools) => [use(tools).placed(emitter.positionMetres)],
    selectedPoints: (emitter, tools) => [use(tools).placed(emitter.positionMetres)],
    label: (emitter, tools) => use(tools).placed(emitter.positionMetres),
    draw(context, emitter, tools, { colors, state }) { use(tools); drawBlast(context, emitter, colors, state); }
  };

  const field = {
    handles: (emitter, box, tools) => { use(tools); return ring(emitter, true); },
    extent(emitter, { include, placed: place, scene: current }) {
      const { x, y } = emitter.centreMetres;
      include({ x: x - emitter.radiusMetres, y: y - emitter.radiusMetres, z: 0 });
      include({ x: x + emitter.radiusMetres, y: y + emitter.radiusMetres, z: 0 });
      cachedRounds(emitter, current.air).forEach(round => include(place(round.positionMetres)));
    },
    shadowPoints: emitter => flashShadow(emitter),
    selectedPoints: () => [],
    label: (emitter, tools) => use(tools).placed(emitter.centreMetres),
    draw(context, emitter, tools, { colors, selected, state }) { use(tools); drawBarrage(context, emitter, colors, selected, state); }
  };

  const track = {
    handles(emitter, box, tools) {
      use(tools);
      const start = trackStart(emitter);
      const list = [emitter.kind === 'booster'
        ? { type: 'emitter', id: emitter.id, field: 'padMetres', point: start, onGround: true, role: 'start' }
        : { type: 'emitter', id: emitter.id, field: 'startMetres', point: start, role: 'start' }];
      const reach = box ? Math.max(box.x1 - box.x0, box.y1 - box.y0) * VIEW.box.facingLengthShare : 1000;
      const heading = emitter.headingDegrees * Math.PI / 180;
      list.push({ type: 'emitter', id: emitter.id, field: 'flightHeading', point: { x: start.x + reach * Math.sin(heading), y: start.y + reach * Math.cos(heading), z: start.z }, role: 'end', ownPlaneOnly: true });
      return list;
    },
    extent(emitter, { includeExtent, scene: current }) {
      const paths = cachedTracks(emitter, current.air);
      includeExtent(paths, () => {
        const points = [];
        for (const path of paths) {
          for (let index = 0; index < path.x.length; index += 10) points.push({ x: path.x[index], y: path.y[index], z: path.z[index] });
          points.push({ x: path.x.at(-1), y: path.y.at(-1), z: path.z.at(-1) });
        }
        return points;
      });
    },
    shadowPoints: emitter => flashShadow(emitter),
    selectedPoints: (emitter, tools) => [emitter.kind === 'booster' ? use(tools).placed(emitter.padMetres) : emitter.startMetres],
    label: (emitter, tools) => (emitter.kind === 'booster' ? use(tools).placed(emitter.padMetres) : emitter.startMetres),
    draw(context, emitter, tools, { colors, selected, state }) { use(tools); drawFlight(context, emitter, colors, selected, state); }
  };

  return {
    lightning: flash, storm, blast, barrage: field, fireworks: field,
    volcano: { ...blast, handles: (emitter, box, tools) => { use(tools); return [{ type: 'emitter', id: emitter.id, field: 'positionMetres', point: placed(emitter.positionMetres), onGround: true, role: 'source' }]; } },
    flight: track, formation: track, meteor: track, shower: track, whip: { ...track, close: true }, booster: track
  };
}
