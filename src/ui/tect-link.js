import { TECT_MESSAGES } from '../domain/handoff.js';

/** Echotect beside Boomtect on GitHub Pages; when Boomtect runs locally, Echotect is expected on port 8001. */
export const ECHOTECT_URL = ['localhost', '127.0.0.1'].includes(location.hostname) ? 'http://127.0.0.1:8001/' : 'https://janne-s.github.io/Echotect/';
const READY_SECONDS = 30;
const ANSWER_SECONDS = 30;

const links = new Map();

/**
 * A link to another tect's window, opened or greeted at once, so it can be called from a click
 * before any waiting: a browser lets a page open a window only then. `send` waits until the tect is
 * ready, posts the message, and resolves when the tect has taken it.
 */
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
