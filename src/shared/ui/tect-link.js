import { TECT_MESSAGES } from '../domain/handoff.js';

const PAGES = 'https://janne-s.github.io';
const LOCAL_PORTS = Object.freeze({ Boomtect: 8000, Echotect: 8001, Rumbletect: 8002 });
const LOOPBACK = ['localhost', '127.0.0.1'].includes(location.hostname);
// A tect served by its own local server, by localhost or by the machine's address in the local network, finds the others on the same host.
const LOCAL = LOOPBACK || (location.protocol === 'http:' && Object.values(LOCAL_PORTS).includes(Number(location.port)));
const HOST = LOOPBACK ? '127.0.0.1' : location.hostname;

export const tectUrl = name => (LOCAL ? `http://${HOST}:${LOCAL_PORTS[name]}/` : `${PAGES}/${name}/`);
export const tectOrigins = names => Object.freeze([PAGES, ...names.flatMap(name => [...new Set(['127.0.0.1', 'localhost', location.hostname])].map(host => `http://${host}:${LOCAL_PORTS[name]}`))]);
export const ECHOTECT_URL = tectUrl('Echotect');

const READY_SECONDS = 30;
const ANSWER_SECONDS = 30;

const links = new Map();

/** Opened at once from the click: a browser lets a page open a window only then. */
export function openTect(url, name) {
  const origin = new URL(url).origin;
  let target = links.get(url);
  const reused = Boolean(target && !target.closed);
  if (!reused) {
    target = window.open(url, name);
    if (!target) throw new Error(`The browser blocked opening ${name}. Allow pop-ups for this page and try again.`);
    links.set(url, target);
  }
  const fromTarget = event => event.origin === origin && event.source === target && event.data && typeof event.data.type === 'string';
  const waitFor = (types, seconds, what) => new Promise((resolve, reject) => {
    const done = (handler, timer) => { window.removeEventListener('message', handler); clearTimeout(timer); };
    const handler = event => {
      if (!fromTarget(event) || !types.includes(event.data.type)) return;
      done(handler, timer);
      resolve(event.data);
    };
    const timer = setTimeout(() => { done(handler, timer); reject(new Error(`${name} did not ${what} within ${seconds} s.`)); }, seconds * 1000);
    window.addEventListener('message', handler);
  });
  // Listening starts now, so a tect that loads while the sound is prepared is not missed.
  const ready = waitFor([TECT_MESSAGES.ready], READY_SECONDS, 'open');
  ready.catch(() => {});
  if (reused) {
    target.focus();
    target.postMessage({ type: TECT_MESSAGES.hello }, origin);
  }
  return {
    async send(message, transfer = []) {
      await ready;
      if (target.closed) throw new Error(`${name} was closed.`);
      const answer = waitFor([TECT_MESSAGES.received, TECT_MESSAGES.refused], ANSWER_SECONDS, 'answer');
      target.postMessage(message, origin, transfer);
      const reply = await answer;
      if (reply.type === TECT_MESSAGES.refused) throw new Error(`${name} refused the sound: ${typeof reply.reason === 'string' ? reply.reason : 'no reason given'}.`);
      target.focus();
    }
  };
}
