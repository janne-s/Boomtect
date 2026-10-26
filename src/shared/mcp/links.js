import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, relative, resolve, sep } from 'node:path';
import { TECT_PORTS } from '../domain/handoff.js';

const HOST = '127.0.0.1';
const RENDER_PORTS = Object.freeze([8090, 8091, 8092, 8093, 8094]);
const TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.wav': 'audio/wav', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8'
});
const LOCAL_PAGE = /^http:\/\/(127\.0\.0\.1|localhost):\d+$/;

function fileIn(root, url) {
  let path;
  try { path = decodeURIComponent(new URL(url, 'http://host').pathname); } catch { return null; }
  const file = resolve(root, `.${path}`);
  if (file !== root && !file.startsWith(root + sep)) return null;
  const target = existsSync(file) && statSync(file).isDirectory() ? join(file, 'index.html') : file;
  return existsSync(target) && statSync(target).isFile() ? target : null;
}

export function fileServer(root) {
  const base = resolve(root);
  return createServer((request, response) => {
    const origin = request.headers.origin;
    if (origin && LOCAL_PAGE.test(origin)) response.setHeader('Access-Control-Allow-Origin', origin);
    const file = request.method === 'GET' || request.method === 'HEAD' ? fileIn(base, request.url) : null;
    if (!file) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Content-Type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    if (request.method === 'HEAD') response.end();
    else createReadStream(file).pipe(response);
  });
}

const listen = (server, port) => new Promise((done, fail) => {
  const failed = error => { server.off('listening', listening); fail(error); };
  const listening = () => { server.off('error', failed); done(port); };
  server.once('error', failed).once('listening', listening).listen(port, HOST);
});

async function listenOnFirstFree(server, ports) {
  for (const port of ports) {
    try { return await listen(server, port); } catch (error) { if (error.code !== 'EADDRINUSE') throw error; }
  }
  throw new Error(`Ports ${ports.join(', ')} are in use, so the renders cannot be opened in an app.`);
}

export function createLinks({ renders }) {
  let rendersOrigin;
  const apps = new Map();
  const servers = [];

  async function serveApp(tect) {
    if (!apps.has(tect.name)) {
      const port = TECT_PORTS[tect.name];
      const server = fileServer(tect.app);
      apps.set(tect.name, listen(server, port).then(() => servers.push(server), error => { if (error.code !== 'EADDRINUSE') throw error; }));
    }
    await apps.get(tect.name);
    return `http://${HOST}:${TECT_PORTS[tect.name]}/`;
  }

  async function link(tect, sceneFile) {
    if (!TECT_PORTS[tect.name]) return null;
    rendersOrigin ??= (() => {
      const server = fileServer(renders);
      servers.push(server);
      return listenOnFirstFree(server, RENDER_PORTS).then(port => `http://${HOST}:${port}`);
    })();
    const [page, files] = await Promise.all([serveApp(tect), rendersOrigin]);
    const path = relative(resolve(renders), sceneFile).split(sep).map(encodeURIComponent).join('/');
    return `${page}?scene=${encodeURIComponent(`${files}/${path}`)}`;
  }

  const close = () => Promise.all(servers.map(server => new Promise(done => server.close(done))));
  return { link, close };
}
