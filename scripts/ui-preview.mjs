// LOCAL MOCK ONLY. Never use this proxy in production. It bypasses Ingress
// source validation through an in-process test dependency, not an environment flag.
// All credentials are random and all LINE operations are mocked.
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { createGateway } from '../line_oa/app/dist/src/server.js';
const dir = await mkdtemp(join(tmpdir(), 'line-oa-ui-mock-'));
const prefix = '/api/hassio_ingress/localmock';
const chatId = 'U' + randomBytes(16).toString('hex');
const random = () => randomBytes(32).toString('base64url');
let state = { status: 'idle', hasQr: false };
let gateway;
const qr = { close() { state = { status: 'idle', hasQr: false }; }, cancel() { state = { status: 'idle', hasQr: false }; },
  async start() { state = { status: 'selecting', hasQr: false, choices: [{ id: 'mockchoice123456', label: 'Mock LINE OA' }] }; return state; },
  state() { return state; }, image() {},
  async select() {
    await gateway.sessions.importCredentials({ version: 1, botId: 'U' + randomBytes(16).toString('hex'), accountName: 'Mock LINE OA', importedAt: new Date().toISOString(), cookies: [{ name: '__Host-chat-ses', value: random() }] });
    state = { status: 'ok', hasQr: false }; return state;
  }
};
gateway = await createGateway({ dataDir: dir, ingressTrust: () => true, qrLogin: qr,
  supervisor: async path => path === '/addons/self/info' ? { hostname: 'local-line-oa' } : { uuid: random() },
  lineRequest: async (_method, path) => {
    if (path === '/api/v1/csrfToken') return { status: 200, contentType: 'application/json', body: { token: random() } };
    if (path.includes('/contacts?')) return { status: 200, contentType: 'application/json', body: { list: [{ contactId: chatId, profile: { name: 'Mock friend' }, friend: true }] } };
    if (path.endsWith('/uploadFile')) return { status: 200, contentType: 'application/json', body: { contentMessageToken: random() } };
    if (!path.endsWith('/messages/send') && !path.endsWith('/bulkSendFiles')) throw new Error('UNEXPECTED_MOCK_REQUEST');
    return { status: 200, contentType: 'application/json', body: {} };
  }
});
await gateway.start(0, 0, '127.0.0.1');
const server = http.createServer((req, res) => {
  if (!req.url?.startsWith(prefix + '/')) { res.writeHead(302, { Location: prefix + '/' }); res.end(); return; }
  const upstream = http.request({ host: '127.0.0.1', port: gateway.uiServer.address().port,
    path: req.url.slice(prefix.length), method: req.method,
    headers: { ...req.headers, 'x-ingress-path': prefix, 'x-forwarded-host': req.headers.host, 'x-forwarded-proto': 'http' }
  }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
  upstream.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(upstream);
});
server.listen(18099, '127.0.0.1', () => console.log('MOCK UI: http://127.0.0.1:18099' + prefix + '/'));
async function stop() { server.close(); server.closeAllConnections(); await gateway.stop(); await rm(dir, { recursive: true, force: true }); process.exit(0); }
process.on('SIGTERM', stop); process.on('SIGINT', stop);
