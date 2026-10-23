const LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);

export const LINKED_TECTS = Object.freeze({
  Boomtect: LOCAL ? 'http://127.0.0.1:8000/' : 'https://janne-s.github.io/Boomtect/',
  Rumbletect: LOCAL ? 'http://127.0.0.1:8002/' : 'https://janne-s.github.io/Rumbletect/'
});

const ORIGINS = Object.freeze(['https://janne-s.github.io', 'http://127.0.0.1:8000', 'http://localhost:8000', 'http://127.0.0.1:8002', 'http://localhost:8002']);
const PREFIX = 'tect.link.';
const MESSAGE = Object.freeze({
  present: `${PREFIX}present`, hello: `${PREFIX}hello`, offer: `${PREFIX}offer`, accept: `${PREFIX}accept`, bye: `${PREFIX}bye`,
  scene: `${PREFIX}scene`, emitters: `${PREFIX}emitters`, mix: `${PREFIX}mix`, request: `${PREFIX}request`, reply: `${PREFIX}reply`, select: `${PREFIX}select`, focus: `${PREFIX}focus`
});
const HEARTBEAT_MILLISECONDS = 3000;
// A background tab may run its timers once a minute, so a link over the channel waits this long before it counts as gone.
const CHANNEL_SILENT_MILLISECONDS = 180000;
const OFFER_MILLISECONDS = 500;
const OFFER_SECONDS = 30;
const REQUEST_SECONDS = 600;
const SESSION_KEY = 'tect.link.partner';

const instanceId = () => crypto.randomUUID();

function windowPeer(target, origin) {
  return {
    window: target,
    channel: false,
    send(message, transfer = []) {
      if (target.closed) return;
      if (origin) target.postMessage(message, origin, transfer);
      else for (const each of ORIGINS) target.postMessage(message, each);
    },
    alive: () => !target.closed
  };
}

function channelPeer(channel, to) {
  return { window: null, channel: true, send: message => channel.postMessage({ ...message, to }), alive: () => true };
}

/** A window opened under `name` earlier is taken over as it is; only a new, blank one is sent to `url`. */
function namedWindow(url, name) {
  const target = window.open('', name);
  if (!target) throw new Error(`The browser blocked opening ${name}. Allow pop-ups for this page and try again.`);
  let blank;
  try { blank = target.location.href === 'about:blank'; } catch { blank = false; }
  if (blank) target.location.href = url;
  return target;
}

/**
 * Links this tect's window with one other tect's: a window it opened, the one that opened it, or in the same origin any
 * open tect found over a BroadcastChannel. Messages are plain objects; audio goes as transferred buffers where it can.
 */
export function createPartnerLink({ app, handlers }) {
  const self = instanceId();
  const others = Object.keys(LINKED_TECTS).filter(name => name !== app);
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('tect.link') : null;
  const present = new Map();
  const pending = new Map();
  let partner = null;
  let offering = null;
  let lastHeard = 0;

  const remembered = () => { try { return sessionStorage.getItem(SESSION_KEY); } catch { return null; } };
  const remember = name => { try { if (name) sessionStorage.setItem(SESSION_KEY, name); else sessionStorage.removeItem(SESSION_KEY); } catch {} };

  const base = () => ({ app, instance: self });
  const changed = () => handlers.onStatus?.();

  function adopt(name, instance, peer) {
    const fresh = !partner || partner.instance !== instance;
    partner = { app: name, instance, peer };
    lastHeard = Date.now();
    remember(name);
    clearInterval(offering?.timer);
    offering = null;
    changed();
    if (fresh) handlers.onLinked?.(name);
  }

  /** `forget` ends the link for good; otherwise, as when a window reloads or goes quiet, it is taken up again when the partner is heard. */
  function drop({ tell = false, forget = false } = {}) {
    if (!partner) return;
    if (tell) partner.peer.send({ ...base(), type: MESSAGE.bye, forget });
    const name = partner.app;
    partner = null;
    if (forget) remember(null);
    for (const { reject } of pending.values()) reject(new Error(`${name} is no longer linked.`));
    pending.clear();
    changed();
    handlers.onUnlinked?.(name);
  }

  function peerFor(data, source, origin) {
    if (source && typeof source.postMessage === 'function') return windowPeer(source, origin);
    return channelPeer(channel, data.instance);
  }

  async function receive(data, source, origin) {
    if (!data || typeof data.type !== 'string' || !data.type.startsWith(PREFIX) || data.instance === self) return;
    if (!others.includes(data.app)) return;
    if (data.to && data.to !== self) return;
    const fromPartner = partner && partner.instance === data.instance;
    if (fromPartner) lastHeard = Date.now();
    switch (data.type) {
      case MESSAGE.present:
        if (!present.has(data.app)) { present.set(data.app, { instance: data.instance, at: Date.now() }); changed(); }
        else present.get(data.app).at = Date.now();
        if (data.ask) channel?.postMessage({ ...base(), type: MESSAGE.present });
        return;
      case MESSAGE.hello:
        if (fromPartner) {
          if (data.with !== self) partner.peer.send({ ...base(), type: MESSAGE.accept, resumed: true });
          return;
        }
        if (!partner && data.linked && remembered() === data.app) {
          adopt(data.app, data.instance, peerFor(data, source, origin));
          partner.peer.send({ ...base(), type: MESSAGE.accept, resumed: true });
        }
        return;
      case MESSAGE.offer:
        adopt(data.app, data.instance, peerFor(data, source, origin));
        partner.peer.send({ ...base(), type: MESSAGE.accept });
        handlers.onOffer?.(data.shared, typeof data.mode === 'string' ? data.mode : null);
        return;
      case MESSAGE.accept:
        if (!fromPartner && !(offering && offering.app === data.app && (!offering.window || offering.window === source)) && !(data.resumed && remembered() === data.app)) return;
        adopt(data.app, data.instance, peerFor(data, source, origin));
        return;
      case MESSAGE.bye:
        if (fromPartner) drop({ forget: Boolean(data.forget) });
        return;
      default:
    }
    if (!fromPartner) return;
    switch (data.type) {
      case MESSAGE.scene: handlers.onShared?.(data.shared); break;
      case MESSAGE.emitters: handlers.onEmitters?.(data.emitters); break;
      case MESSAGE.mix: handlers.onMix?.(data); break;
      case MESSAGE.select: handlers.onSelect?.(data.id); window.focus(); break;
      case MESSAGE.focus: window.focus(); break;
      case MESSAGE.request: {
        let reply;
        try {
          reply = { results: await handlers.onRequest(data.variant, data.key) };
        } catch (error) {
          reply = { error: error instanceof Error ? error.message : String(error) };
        }
        if (!partner || partner.instance !== data.instance) return;
        const transfer = (reply.results ?? []).flatMap(result => result.channels.map(samples => samples.buffer));
        partner.peer.send({ ...base(), type: MESSAGE.reply, id: data.id, ...reply }, transfer);
        break;
      }
      case MESSAGE.reply: {
        const waiting = pending.get(data.id);
        if (!waiting) return;
        pending.delete(data.id);
        if (data.error) waiting.reject(new Error(`${partner.app}: ${data.error}`)); else waiting.resolve(data.results);
        break;
      }
      default:
    }
  }

  window.addEventListener('message', event => {
    if (!ORIGINS.includes(event.origin)) return;
    receive(event.data, event.source, event.origin);
  });
  channel?.addEventListener('message', event => receive(event.data, null, null));
  channel?.postMessage({ ...base(), type: MESSAGE.present, ask: true });

  setInterval(() => {
    channel?.postMessage({ ...base(), type: MESSAGE.present });
    for (const [name, entry] of present) if (Date.now() - entry.at > CHANNEL_SILENT_MILLISECONDS) { present.delete(name); changed(); }
    if (partner) {
      if (!partner.peer.alive() || (partner.peer.channel && Date.now() - lastHeard > CHANNEL_SILENT_MILLISECONDS)) { drop(); return; }
      partner.peer.send({ ...base(), type: MESSAGE.hello, linked: true, with: partner.instance });
    } else greetRemembered();
  }, HEARTBEAT_MILLISECONDS);
  greetRemembered();
  window.addEventListener('pagehide', () => drop({ tell: true }));

  function greetRemembered() {
    const name = remembered();
    if (!name) return;
    if (window.opener) windowPeer(window.opener, null).send({ ...base(), type: MESSAGE.hello, linked: true });
    const found = present.get(name);
    if (found && channel) channelPeer(channel, found.instance).send({ ...base(), type: MESSAGE.hello, linked: true });
  }

  return {
    others,
    partner: () => partner?.app ?? null,
    offering: () => offering?.app ?? null,
    present: name => present.has(name),

    /** Call it from the click: a browser lets a page open a window only then. */
    open(name, shared, mode = null) {
      if (partner?.app === name) {
        if (partner.peer.window) partner.peer.window.focus();
        else partner.peer.send({ ...base(), type: MESSAGE.focus });
        return;
      }
      if (partner) drop({ tell: true, forget: true });
      clearInterval(offering?.timer);
      const found = present.get(name);
      let peer;
      let target = null;
      if (found && channel) peer = channelPeer(channel, found.instance);
      else {
        target = namedWindow(LINKED_TECTS[name], `tect-${name.toLowerCase()}`);
        peer = windowPeer(target, new URL(LINKED_TECTS[name]).origin);
        target.focus();
      }
      const started = Date.now();
      const offer = () => {
        if (Date.now() - started > OFFER_SECONDS * 1000) { clearInterval(offering.timer); offering = null; changed(); handlers.onError?.(`${name} did not answer within ${OFFER_SECONDS} s.`); return; }
        peer.send({ ...base(), type: MESSAGE.offer, shared, mode });
      };
      offering = { app: name, window: target, timer: setInterval(offer, OFFER_MILLISECONDS) };
      offer();
      changed();
    },

    unlink: () => drop({ tell: true, forget: true }),

    send(type, payload, transfer = []) {
      if (partner) partner.peer.send({ ...base(), type: MESSAGE[type], ...payload }, transfer);
    },

    request(variant, key) {
      if (!partner) return Promise.resolve(null);
      const id = instanceId();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${partner?.app ?? 'The linked tect'} did not answer within ${REQUEST_SECONDS / 60} minutes.`)); }, REQUEST_SECONDS * 1000);
        pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
        partner.peer.send({ ...base(), type: MESSAGE.request, id, variant, key });
      });
    }
  };
}
