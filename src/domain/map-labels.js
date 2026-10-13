/** OpenMapTiles labels in MVT 1/2 tiles. No rendering or network dependencies.
 * Format: https://github.com/mapbox/vector-tile-spec/tree/master/2.1
 * Layers: https://openmaptiles.org/docs/schema/
 */
const MAXIMUM_TILE_BYTES = 16 * 1024 * 1024;
const LABEL_LAYERS = new Set(['place', 'mountain_peak', 'water_name']);
const PLACE_KINDS = new Set(['city', 'town', 'village', 'hamlet', 'locality']);
const text = new TextDecoder('utf-8', { fatal: true });
const signed = value => value % 2 ? -(value + 1) / 2 : value / 2;

class Reader {
  constructor(bytes) { this.bytes = bytes; this.at = 0; }
  take(length) {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.bytes.length - this.at) throw new Error('Truncated map tile.');
    const value = this.bytes.subarray(this.at, this.at + length);
    this.at += length;
    return value;
  }
  number() {
    let value = 0;
    let scale = 1;
    for (let byte = 0; byte < 10; byte += 1) {
      const next = this.take(1)[0];
      value += (next & 127) * scale;
      if (!(next & 128)) return value;
      scale *= 128;
    }
    throw new Error('Invalid map tile integer.');
  }
  *fields() {
    while (this.at < this.bytes.length) {
      const tag = this.number();
      const field = Math.floor(tag / 8);
      const wire = tag % 8;
      if (!field) throw new Error('Invalid map tile field.');
      if (wire === 0) yield [field, this.number(), wire];
      else if (wire === 2) yield [field, this.take(this.number()), wire];
      else if (wire === 1 || wire === 5) yield [field, this.take(wire === 1 ? 8 : 4), wire];
      else throw new Error('Unsupported map tile field.');
    }
  }
}

function valueOf(bytes) {
  for (const [field, value, wire] of new Reader(bytes).fields()) {
    if (field === 1 && wire === 2) return text.decode(value);
    if ((field === 2 && wire === 5) || (field === 3 && wire === 1)) {
      const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
      return field === 2 ? view.getFloat32(0, true) : view.getFloat64(0, true);
    }
    if (wire === 0 && field >= 4 && field <= 7) return field === 6 ? signed(value) : field === 7 ? Boolean(value) : value;
  }
  return null;
}

function packed(bytes) {
  const reader = new Reader(bytes);
  const values = [];
  while (reader.at < bytes.length) values.push(reader.number());
  return values;
}

/** A point label, or the midpoint along the longest water label line. */
function labelPoint(commands, type) {
  let x = 0; let y = 0;
  const lines = [];
  let line = null;
  for (let at = 0; at < commands.length;) {
    const command = commands[at++];
    const id = command % 8;
    const count = Math.floor(command / 8);
    if (!count || ![1, 2, 7].includes(id)) throw new Error('Invalid map label geometry.');
    if (id === 7) continue;
    if (count > (commands.length - at) / 2) throw new Error('Truncated map label geometry.');
    for (let vertex = 0; vertex < count; vertex += 1) {
      x += signed(commands[at++]); y += signed(commands[at++]);
      if (type === 1) return { x, y };
      if (id === 1) { line = []; lines.push(line); }
      if (!line) throw new Error('Invalid map label line.');
      line.push({ x, y });
    }
  }
  const distance = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
  const length = line => line.slice(1).reduce((sum, point, index) => sum + distance(line[index], point), 0);
  lines.sort((a, b) => length(b) - length(a));
  line = lines[0];
  if (!line?.length) return null;
  let remaining = length(line) / 2;
  for (let index = 1; index < line.length; index += 1) {
    const a = line[index - 1]; const b = line[index];
    const metres = distance(a, b);
    if (metres && remaining <= metres) return { x: a.x + (b.x - a.x) * remaining / metres, y: a.y + (b.y - a.y) * remaining / metres };
    remaining -= metres;
  }
  return line[0];
}

function readLayer(bytes, tile) {
  let name; let extent = 4096; let version = 1;
  const keys = []; const values = []; const features = [];
  for (const [field, value, wire] of new Reader(bytes).fields()) {
    if (field === 1 && wire === 2) name = text.decode(value);
    if (field === 2 && wire === 2) features.push(value);
    if (field === 3 && wire === 2) keys.push(text.decode(value));
    if (field === 4 && wire === 2) values.push(value);
    if (field === 5 && wire === 0) extent = value;
    if (field === 15 && wire === 0) version = value;
  }
  if (!LABEL_LAYERS.has(name)) return [];
  if (![1, 2].includes(version) || !Number.isSafeInteger(extent) || extent <= 0) throw new Error('Unsupported map label layer.');
  const decodedValues = values.map(valueOf);
  const labels = [];
  for (const bytes of features) {
    const tags = []; const geometry = [];
    let type = 0;
    for (const [field, value, wire] of new Reader(bytes).fields()) {
      if (field === 2 && wire === 2) for (const number of packed(value)) tags.push(number);
      if (field === 3 && wire === 0) type = value;
      if (field === 4 && wire === 2) for (const number of packed(value)) geometry.push(number);
    }
    if (tags.length % 2) throw new Error('Invalid map label tags.');
    const properties = Object.create(null);
    for (let index = 0; index < tags.length; index += 2) {
      if (tags[index] >= keys.length || tags[index + 1] >= decodedValues.length) throw new Error('Invalid map label dictionary.');
      properties[keys[tags[index]]] = decodedValues[tags[index + 1]];
    }
    const kind = name === 'mountain_peak' ? 'peak' : name === 'water_name' ? 'water'
      : properties.class === 'isolated_dwelling' ? 'locality' : properties.class;
    if (!PLACE_KINDS.has(kind) && !['peak', 'water'].includes(kind)) continue;
    if (kind === 'water' && properties.class !== 'lake') continue;
    if (typeof properties.name !== 'string' || !properties.name || ![1, 2].includes(type)) continue;
    const point = labelPoint(geometry, type);
    if (!point) continue;
    const worldX = (tile.x + point.x / extent) / 2 ** tile.zoom;
    const worldY = (tile.y + point.y / extent) / 2 ** tile.zoom;
    labels.push({
      name: properties.name.slice(0, 80), kind,
      longitude: worldX * 360 - 180,
      latitude: Math.atan(Math.sinh(Math.PI * (1 - 2 * worldY))) * 180 / Math.PI,
      elevationMetres: kind === 'peak' && Number.isFinite(properties.ele) ? properties.ele : null
    });
  }
  return labels;
}

export function mapLabels(buffer, tile) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length > MAXIMUM_TILE_BYTES) throw new Error('A map tile is too large.');
  const labels = [];
  for (const [field, value, wire] of new Reader(bytes).fields()) {
    if (field === 3 && wire === 2) labels.push(...readLayer(value, tile));
  }
  return labels;
}
