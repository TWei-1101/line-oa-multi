import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createGateway } from '../src/server.js';
import { atomicWriteJson } from '../src/storage.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'line-oa-api-queue-'));
  const gate = deferred(), started = deferred();
  const order: string[] = [];
  const instanceId = randomUUID(), chatId = `U${'b'.repeat(32)}`;
  await atomicWriteJson(join(dir, 'config.json'), { instanceId, listenHost: '0.0.0.0', port: 8787, apiEnabled: true, rateLimitPerMinute: 5 });
  await atomicWriteJson(join(dir, 'secrets/line-session.json'), { version: 1, botId: `U${'a'.repeat(32)}`, importedAt: new Date().toISOString(), cookies: [{ name: '__Host-chat-ses', value: 'synthetic' }] });
  const gateway = await createGateway({ dataDir: dir, lineRequest: async (method, path, _headers, body) => {
    if (path.includes('csrfToken')) return { status: 200, contentType: 'application/json', body: { token: 'synthetic-csrf' } };
    if (path.includes('/contacts?')) return { status: 200, contentType: 'application/json', body: { list: [{ contactId: chatId, profile: { name: 'synthetic' }, friend: true }] } };
    assert.equal(method, 'POST');
    if (path.endsWith('/messages/send')) {
      const message = JSON.parse(String(body)).text as string;
      order.push(message);
      if (message === 'first') { started.resolve(); await gate.promise; }
    } else if (path.endsWith('/uploadFile')) {
      order.push('image-upload');
      return { status: 200, contentType: 'application/json', body: { contentMessageToken: 'synthetic-image' } };
    } else { assert.ok(path.endsWith('/bulkSendFiles')); order.push('image-send'); }
    return { status: 200, contentType: 'application/json', body: {} };
  } });
  await gateway.contacts.search('', true); await gateway.contacts.setAlias('home', chatId);
  const paired = await gateway.pairing.exchange({ instance_id: gateway.pairing.instanceId,
    bootstrap_token: gateway.pairing.discovery().bootstrap_token, request_id: randomUUID(), client: 'homeassistant-line_oa' });
  await gateway.start(0, 0, '127.0.0.1');
  const url = `http://127.0.0.1:${(gateway.apiServer.address() as AddressInfo).port}`;
  const headers = { Authorization: `Bearer ${paired.api_key}`, 'Content-Type': 'application/json' };
  const text = (message: string, signal?: AbortSignal) => fetch(url + '/api/v1/messages/text', {
    method: 'POST', headers, signal, body: JSON.stringify({ who: 'home', message, request_id: randomUUID() }) });
  function observeNextBody() {
    const arrived = deferred(), closed = deferred();
    gateway.apiServer.once('request', (req, res) => {
      req.once('end', () => { void nextTurn().then(arrived.resolve); });
      res.once('close', closed.resolve);
    });
    return { arrived: arrived.promise, closed: closed.promise };
  }
  return { dir, gateway, url, headers, text, order, gate, started: started.promise, observeNextBody, instanceId,
    async close() { gate.resolve(); await gateway.stop(); await rm(dir, { recursive: true, force: true }); } };
}

test('real HTTP mixed text/image FIFO and concurrent request-ID reuse submit each message once', async () => {
  const h = await fixture();
  try {
    const first = h.text('first'); await h.started;
    const id = randomUUID();
    const image = () => {
      const form = new FormData(); form.set('who', 'home'); form.set('request_id', id);
      form.set('image', new Blob([Buffer.from([137,80,78,71,13,10,26,10,1])], { type: 'image/png' }), 'synthetic.png');
      return fetch(h.url + '/api/v1/messages/image', { method: 'POST', headers: { Authorization: h.headers.Authorization }, body: form });
    };
    let observed = h.observeNextBody(); const middle = image(); await observed.arrived;
    observed = h.observeNextBody(); const last = h.text('last'); await observed.arrived;
    observed = h.observeNextBody(); const duplicate = image(); await observed.arrived;
    assert.deepEqual(h.order, ['first']);
    assert.deepEqual(await readdir(join(h.dir, 'tmp')), [], 'waiting images are not staged yet');
    h.gate.resolve();
    for (const response of await Promise.all([first, middle, last, duplicate])) {
      assert.equal(response.status, 202);
      assert.equal((await response.json() as { status: string }).status, 'submitted');
    }
    assert.deepEqual(h.order, ['first', 'image-upload', 'image-send', 'last']);
    assert.deepEqual(await readdir(join(h.dir, 'tmp')), []);
  } finally { await h.close(); }
});

test('a disconnected HTTP caller cancels its queued message before it reaches LINE', async () => {
  const h = await fixture();
  try {
    const first = h.text('first'); await h.started;
    const controller = new AbortController(), observed = h.observeNextBody();
    const cancelled = assert.rejects(h.text('cancelled', controller.signal), error => error instanceof Error && error.name === 'AbortError');
    await observed.arrived; controller.abort(); await cancelled; await observed.closed;
    h.gate.resolve(); assert.equal((await first).status, 202);
    assert.equal((await h.text('next')).status, 202);
    assert.deepEqual(h.order, ['first', 'next']);
  } finally { await h.close(); }
});

test('service shutdown returns a known-unsent 503 for waiting messages, without LINE-rejected errors', async () => {
  const h = await fixture();
  try {
    const first = h.text('first'); await h.started;
    const observed = h.observeNextBody(), waiting = h.text('waiting'); await observed.arrived;
    const stopping = h.gateway.stop();
    const response = await waiting;
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: { code: 'GATEWAY_BUSY', message: '服務正在停止，訊息尚未送出' } });
    h.gate.resolve(); assert.equal((await first).status, 202); await stopping;
    assert.deepEqual(h.order, ['first']);
  } finally { await h.close(); }
});

test('upgrading old five-per-minute settings preserves identity and accepts a burst above five via API', async () => {
  const h = await fixture();
  try {
    const config = JSON.parse(await readFile(join(h.dir, 'config.json'), 'utf8'));
    assert.equal(config.instanceId, h.instanceId); assert.equal(config.rateLimitPerMinute, 0);
    const responses = await Promise.all(Array.from({ length: 9 }, (_, i) => h.text(`burst-${i}`)));
    assert.ok(responses.every(response => response.status === 202));
    assert.equal(h.order.length, 9);
    assert.equal(new Set(h.order).size, 9);
  } finally { await h.close(); }
});
