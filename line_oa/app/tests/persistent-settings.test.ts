import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createGateway, type GatewayOptions } from '../src/server.js';
import { DEFAULT_CONFIG, loadConfig } from '../src/config.js';
import { atomicWriteJson } from '../src/storage.js';
import { ContactService } from '../src/contacts.js';
import type { LineClient } from '../src/line-client.js';
import type { BusinessQrLogin } from '../src/qr-login.js';
import { AutoLoginHistory, AUTO_LOGIN_HISTORY_LIMIT } from '../src/auto-login-history.js';
import { MemoryLogger } from '../src/logger.js';

const botId = `U${'a'.repeat(32)}`, chatId = `U${'b'.repeat(32)}`;
const contact = { chatId, name: '合成測試聯絡人', kind: 'user' as const, friend: true, chatAvailable: true };
const session = () => ({ version: 1, botId, importedAt: '2026-10-19T01:00:00Z', csrfToken: 'synthetic-csrf',
  cookies: [{ name: '__Host-chat-ses', value: 'synthetic-old-cookie' }] });
const ingress = { 'X-Ingress-Path': '/api/hassio_ingress/synthetic' };
async function seed(dir: string, minutes = 0) {
  await atomicWriteJson(join(dir, 'config.json'), { ...DEFAULT_CONFIG, instanceId: randomUUID(), sessionCheckIntervalMinutes: minutes });
  await atomicWriteJson(join(dir, 'secrets/line-session.json'), session());
  await atomicWriteJson(join(dir, 'contacts.json'), { version: 2, accountId: botId, updatedAt: new Date().toISOString(), contacts: [contact] });
  await atomicWriteJson(join(dir, 'aliases.json'), { home: { chatId, name: contact.name } });
}
async function running(dir: string, options: GatewayOptions = {}) {
  const gateway = await createGateway({ ...options, dataDir: dir, ingressTrust: () => true });
  await gateway.start(0, 0, '127.0.0.1');
  const address = (server: typeof gateway.apiServer) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const ui = address(gateway.uiServer), api = address(gateway.apiServer);
  const response = await fetch(`${ui}/api/auth/session`, { headers: ingress });
  const body = await response.json() as { csrfToken: string };
  const headers = { ...ingress, Cookie: response.headers.get('set-cookie')!.split(';')[0]!,
    'X-CSRF-Token': body.csrfToken, 'Content-Type': 'application/json' };
  return { gateway, ui, api, headers };
}
async function pair(gateway: Awaited<ReturnType<typeof createGateway>>) {
  const result = await gateway.pairing.exchange({ instance_id: gateway.pairing.instanceId,
    bootstrap_token: gateway.pairing.discovery().bootstrap_token, request_id: randomUUID(), client: 'homeassistant-line_oa' });
  return { Authorization: `Bearer ${result.api_key}` };
}

test('contacts, aliases and pairing survive a gateway restart with zero upstream requests', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'line-oa-contact-restart-'));
  let calls = 0;
  const options = { lineRequest: async () => { calls++; throw new Error('NO_UPSTREAM_EXPECTED'); } };
  let h: Awaited<ReturnType<typeof running>> | undefined;
  try {
    await seed(dir);
    h = await running(dir, options);
    const key = await pair(h.gateway), identity = h.gateway.pairing.instanceId;
    assert.equal(h.gateway.contacts.count(), 1);
    await h.gateway.stop(); h = await running(dir, options);
    const cached = await (await fetch(`${h.ui}/api/contacts/cache`, { headers: h.headers })).json() as { list: unknown[] };
    assert.deepEqual(cached.list, [contact]);
    assert.equal(h.gateway.contacts.count(), 1);
    assert.equal(h.gateway.contacts.resolve('home')?.chatId, chatId);
    assert.equal(h.gateway.pairing.instanceId, identity);
    assert.equal(h.gateway.auth.validApiKey(key.Authorization), true);
    assert.equal(calls, 0);
    assert.equal((await stat(join(dir, 'contacts.json'))).mode & 0o777, 0o600);
    const response = await fetch(`${h.ui}/api/session/logout`, { method: 'POST', headers: h.headers, body: '{}' });
    assert.equal(response.status, 200);
    await h.gateway.stop(); h = await running(dir, options);
    assert.equal(h.gateway.contacts.count(), 0);
    assert.equal(h.gateway.contacts.resolve('home')?.chatId, chatId);
    assert.equal(calls, 0);
  } finally { await h?.gateway.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('refresh persists new contacts; switching account or clearing during refresh cannot resurrect old contacts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'line-oa-contact-races-'));
  let account: string | null = botId, release!: () => void, calls = 0;
  let pending = false;
  const client = { async getContacts() {
    calls++;
    if (pending) await new Promise<void>(resolve => { release = resolve; });
    return { list: [contact] };
  } } as unknown as LineClient;
  try {
    const cache = new ContactService(client, dir, 0, () => account); await cache.load();
    await cache.search('', true); await cache.setAlias('home', chatId);
    const restored = new ContactService(client, dir, 0, () => account); await restored.load();
    assert.deepEqual(restored.allCached(), [contact]); assert.equal(calls, 1);
    pending = true;
    const fetching = restored.search('', true);
    const rejected = assert.rejects(fetching, /SESSION_CHANGED/);
    await nextTurn(); await restored.clearCache(); release(); await rejected;
    const cleared = new ContactService(client, dir, 0, () => account); await cleared.load();
    assert.equal(cleared.count(), 0);
    pending = false; await cleared.search('', true);
    account = `U${'c'.repeat(32)}`;
    assert.equal(cleared.count(), 0);
    const switched = new ContactService(client, dir, 0, () => account); await switched.load();
    assert.equal(switched.count(), 0); assert.ok(switched.resolve('home'));
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'contacts.json'), 'utf8')).contacts, []);
  } finally { release?.(); await rm(dir, { recursive: true, force: true }); }
});

test('settings require browser session and CSRF, validate minutes, persist atomically and retain pairing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'line-oa-settings-'));
  let h: Awaited<ReturnType<typeof running>> | undefined;
  try {
    await seed(dir);
    h = await running(dir, { lineRequest: async () => { throw new Error('NO_UPSTREAM_EXPECTED'); } });
    const key = await pair(h.gateway);
    const identity = h.gateway.pairing.instanceId;
    const url = `${h.ui}/api/settings`;
    const put = (value: unknown, headers = h!.headers) => fetch(url, { method: 'PUT', headers, body: JSON.stringify(value) });
    assert.equal((await fetch(url, { headers: ingress })).status, 401);
    assert.equal((await fetch(`${h.api}/api/settings`, { headers: key })).status, 404);
    assert.equal((await put({ sessionCheckIntervalMinutes: 30 }, { ...h.headers, 'X-CSRF-Token': '' })).status, 403);
    for (const value of [-1, 0.5, '30', null, 10_081, 1e20]) assert.equal((await put({ sessionCheckIntervalMinutes: value })).status, 400);
    assert.equal((await put({ sessionCheckIntervalMinutes: 10, listenHost: 'bad' })).status, 400);
    assert.equal((await loadConfig(dir)).config.sessionCheckIntervalMinutes, 0);
    const saves = await Promise.all([5, 0, 1440].map(sessionCheckIntervalMinutes => put({ sessionCheckIntervalMinutes })));
    assert.ok(saves.every(response => response.status === 200));
    const view = await (await fetch(url, { headers: h.headers })).json();
    const saved = (await loadConfig(dir)).config;
    assert.deepEqual(view, { sessionCheckIntervalMinutes: saved.sessionCheckIntervalMinutes });
    assert.equal(saved.instanceId, identity);
    assert.equal((await put({ sessionCheckIntervalMinutes: 0 })).status, 200);
    await h.gateway.stop(); h = await running(dir, { lineRequest: async () => { throw new Error('NO_UPSTREAM_EXPECTED'); } });
    assert.equal((await loadConfig(dir)).config.sessionCheckIntervalMinutes, 0);
    assert.equal(h.gateway.auth.validApiKey(key.Authorization), true);
    assert.equal(h.gateway.pairing.instanceId, identity);
  } finally { await h?.gateway.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('disabled checks send directly and recover only explicit unauthenticated text/image rejection; history survives restart', async t => {
  for (const suffix of ['/send', '/uploadFile', '/bulkSendFiles']) await t.test(suffix, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'line-oa-send-recovery-log-'));
    let calls: string[] = [], recoveries = 0, rejected = false, unknown = false;
    let h: Awaited<ReturnType<typeof running>> | undefined;
    const qr = { close() {}, async recover(expected) {
      recoveries++;
      await h!.gateway.sessions.renewCredentials({ ...expected,
        cookies: [{ name: '__Host-chat-ses', value: 'synthetic-fresh-cookie' }] }, expected);
    } } as BusinessQrLogin;
    const options: GatewayOptions = { qrLogin: qr, lineRequest: async (method, path, headers) => {
      calls.push(`${method} ${path}`);
      assert.equal(method, 'POST', 'no startup or send preflight GET when interval is zero');
      if (unknown) throw new Error('synthetic timeout');
      if (!rejected && path.endsWith(suffix)) { rejected = true; return { status: 401, contentType: 'application/json', body: { code: 'not_login' } }; }
      if (rejected && path.endsWith(suffix)) assert.match(headers.Cookie!, /synthetic-fresh-cookie/);
      return { status: 200, contentType: 'application/json', body: path.endsWith('/uploadFile') ? { contentMessageToken: 'synthetic-upload-token' } : {} };
    } };
    try {
      await seed(dir); h = await running(dir, options); const key = await pair(h.gateway);
      assert.equal(calls.length, 0);
      const sendText = (message: string) => fetch(`${h!.api}/api/v1/messages/text`, { method: 'POST',
        headers: { ...key, 'Content-Type': 'application/json' }, body: JSON.stringify({ who: 'home', message, request_id: randomUUID() }) });
      let response: Response;
      if (suffix === '/send') response = await sendText('合成測試');
      else {
        const form = new FormData(); form.set('who', 'home'); form.set('request_id', randomUUID());
        form.set('image', new Blob([Buffer.from([137,80,78,71,13,10,26,10,1])], { type: 'image/png' }), 'synthetic.png');
        response = await fetch(`${h.api}/api/v1/messages/image`, { method: 'POST', headers: key, body: form });
      }
      assert.equal(response.status, 202); assert.equal((await response.json() as { status: string }).status, 'submitted');
      assert.equal(recoveries, 1);
      assert.equal(h.gateway.sessions.getStatus().state, 'CONNECTED');
      assert.equal(calls.filter(path => path.endsWith(suffix)).length, 2);
      unknown = true; const beforeUnknown = calls.length;
      const failed = await sendText('合成不明結果');
      assert.equal((await failed.json() as { status: string }).status, 'unknown');
      assert.equal(calls.length, beforeUnknown + 1); assert.equal(recoveries, 1);
      await h.gateway.stop(); h = await running(dir, options);
      const history = await (await fetch(`${h.ui}/api/auto-login/logs`, { headers: h.headers })).json() as { logs: Array<Record<string, unknown>> };
      assert.equal(history.logs.length, 1); const entry = history.logs[0]!;
      assert.equal(entry.trigger, 'send'); assert.equal(entry.result, 'SUCCESS');
      assert.ok(entry.startedAt); assert.ok(entry.completedAt); assert.ok(entry.startedLocalTime); assert.ok(entry.completedLocalTime);
      const raw = await readFile(join(dir, 'auto-login-history.json'), 'utf8');
      assert.doesNotMatch(raw, /synthetic-(old|fresh)-cookie|synthetic-csrf|synthetic-upload-token|Cookie|headers/);
      assert.equal((await stat(join(dir, 'auto-login-history.json'))).mode & 0o777, 0o600);
      assert.equal((await fetch(`${h.ui}/api/auto-login/logs`, { headers: ingress })).status, 401);
      assert.equal((await fetch(`${h.api}/api/auto-login/logs`, { headers: key })).status, 404);
    } finally { await h?.gateway.stop(); await rm(dir, { recursive: true, force: true }); }
  });
});

test('automatic login history records failures, bounds disk usage, and marks unfinished attempts after restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'line-oa-auto-history-'));
  try {
    const history = new AutoLoginHistory(dir, new MemoryLogger()); await history.load();
    await assert.rejects(history.run('manual_check', async () => { throw new Error('LOGIN_REAUTH_REQUIRED'); }));
    assert.equal(history.list()[0]!.error, 'LOGIN_REAUTH_REQUIRED');
    const raw = JSON.parse(await readFile(join(dir, 'auto-login-history.json'), 'utf8'));
    const entry = { ...raw.entries[0], result: 'STARTED', completedAt: undefined, error: undefined };
    await atomicWriteJson(join(dir, 'auto-login-history.json'), { version: 1,
      entries: Array.from({ length: AUTO_LOGIN_HISTORY_LIMIT }, () => ({ ...entry, id: randomUUID() })) });
    const restored = new AutoLoginHistory(dir, new MemoryLogger()); await restored.load();
    assert.equal(restored.list()[0]!.result, 'INTERRUPTED');
    await assert.rejects(restored.run('send', async () => { throw new Error('secret-cookie=do-not-save'); }));
    assert.equal(restored.list().length, AUTO_LOGIN_HISTORY_LIMIT);
    assert.equal(restored.list()[0]!.error, 'LOGIN_RECOVERY_FAILED');
    const saved = await readFile(join(dir, 'auto-login-history.json'), 'utf8');
    assert.doesNotMatch(saved, /secret-cookie|do-not-save/);
    assert.ok(Buffer.byteLength(saved) < 128 * 1024);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('old configuration migrates to 45 minutes without changing permanent identity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'line-oa-settings-migration-'));
  try {
    const { sessionCheckIntervalMinutes: _unused, ...legacy } = DEFAULT_CONFIG;
    const instanceId = randomUUID();
    await atomicWriteJson(join(dir, 'config.json'), { ...legacy, instanceId });
    const loaded = await loadConfig(dir);
    assert.equal(loaded.config.instanceId, instanceId);
    assert.equal(loaded.config.sessionCheckIntervalMinutes, 45);
    assert.equal(JSON.parse(await readFile(join(dir, 'config.json'), 'utf8')).sessionCheckIntervalMinutes, 45);
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test('saving settings controls the live timer; scheduled and manual recoveries have distinct sources', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'line-oa-live-timer-'));
  let h: Awaited<ReturnType<typeof running>> | undefined, calls = 0, expired = true, delayMs = 20;
  const qr = { close() {}, async recover() { expired = false; } } as unknown as BusinessQrLogin;
  const waitFor = async (predicate: () => boolean) => {
    for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(predicate());
  };
  try {
    await seed(dir);
    h = await running(dir, { qrLogin: qr, sessionCheckDelayMs: () => delayMs, lineRequest: async (_method, path) => {
      calls++;
      return { status: expired ? 401 : 200, contentType: 'application/json',
        body: expired ? { code: 'not_login' } : path.includes('csrfToken') ? { token: 'synthetic-csrf' } : { list: [] } };
    } });
    assert.equal(calls, 0);
    const save = (minutes: number) => fetch(`${h!.ui}/api/settings`, { method: 'PUT', headers: h!.headers,
      body: JSON.stringify({ sessionCheckIntervalMinutes: minutes }) });
    assert.equal((await save(1)).status, 200);
    await waitFor(() => h!.gateway.sessions.getStatus().state === 'CONNECTED');
    assert.equal((await save(0)).status, 200);
    // Finish any already-running check before checking that no new timer fires.
    await new Promise(resolve => setTimeout(resolve, 30)); const stoppedCalls = calls;
    await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(calls, stoppedCalls);
    expired = true; delayMs = 3_600_000;
    assert.equal((await save(1)).status, 200);
    const response = await fetch(`${h.ui}/api/session/validate`, { method: 'POST', headers: h.headers, body: '{}' });
    assert.equal(response.status, 200);
    const history = await (await fetch(`${h.ui}/api/auto-login/logs`, { headers: h.headers })).json() as { logs: Array<{ trigger: string; result: string }> };
    assert.deepEqual(history.logs.map(entry => entry.trigger), ['manual_check', 'scheduled_check']);
    assert.ok(history.logs.every(entry => entry.result === 'SUCCESS'));
  } finally { await h?.gateway.stop(); await rm(dir, { recursive: true, force: true }); }
});


test('zero permits recovery only for a failed send, not manual validation or contact refresh', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'line-oa-zero-recovery-policy-'));
  let h: Awaited<ReturnType<typeof running>> | undefined, recoveries = 0, ready = false;
  const qr = { close() {}, async recover() { recoveries++; ready = true; } } as unknown as BusinessQrLogin;
  try {
    await seed(dir);
    h = await running(dir, { qrLogin: qr, lineRequest: async () => ({ status: ready ? 200 : 401,
      contentType: 'application/json', body: ready ? {} : { code: 'not_login' } }) });
    assert.equal((await fetch(`${h.ui}/api/session/validate`, { method: 'POST', headers: h.headers, body: '{}' })).status, 503);
    assert.equal((await fetch(`${h.ui}/api/contacts/refresh`, { method: 'POST', headers: h.headers, body: '{}' })).status, 502);
    assert.equal(recoveries, 0);
    assert.equal(h.gateway.sessions.getStatus().state, 'EXPIRED');
    const key = await pair(h.gateway);
    const sent = await fetch(`${h.api}/api/v1/messages/text`, { method: 'POST', headers: { ...key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ who: 'home', message: '合成測試', request_id: randomUUID() }) });
    assert.equal(sent.status, 202); assert.equal(recoveries, 1);
    const history = JSON.parse(await readFile(join(dir, 'auto-login-history.json'), 'utf8')).entries;
    assert.equal(history.length, 1); assert.equal(history[0].trigger, 'send');
  } finally { await h?.gateway.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('real text and image API handlers reset the shared background idle deadline', { timeout: 10_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'line-oa-api-idle-'));
  let h: Awaited<ReturnType<typeof running>> | undefined, csrfChecks = 0, contactChecks = 0;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const contactWaiters = new Map<number, () => void>();
  const settleContacts = async (expected: number) => {
    if (contactChecks < expected) await new Promise<void>(resolve => contactWaiters.set(expected, resolve));
    assert.equal(contactChecks, expected); await nextTurn();
  };
  try {
    await seed(dir, 45);
    h = await running(dir, { sessionCheckDelayMs: () => 60_000, lineRequest: async (_method, path) => {
      if (path.includes('csrfToken')) { csrfChecks++; return { status: 200, contentType: 'application/json', body: { token: 'synthetic-csrf' } }; }
      if (path.includes('/contacts?')) { contactChecks++; contactWaiters.get(contactChecks)?.(); contactWaiters.delete(contactChecks); return { status: 200, contentType: 'application/json', body: { list: [] } }; }
      return { status: 200, contentType: 'application/json', body: path.endsWith('/uploadFile') ? { contentMessageToken: 'synthetic-upload' } : {} };
    } });
    const key = await pair(h.gateway); await settleContacts(1);
    t.mock.timers.tick(59_000);
    const text = await fetch(`${h.api}/api/v1/messages/text`, { method: 'POST', headers: { ...key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ who: 'home', message: 'synthetic idle test', request_id: randomUUID() }) });
    assert.equal(text.status, 202); assert.equal(csrfChecks, 2);
    t.mock.timers.tick(1000); await nextTurn(); assert.equal(csrfChecks, 2, 'old startup deadline must be cancelled');
    t.mock.timers.tick(58_000);
    const form = new FormData(); form.set('who', 'home'); form.set('request_id', randomUUID());
    form.set('image', new Blob([Buffer.from([137,80,78,71,13,10,26,10,1])], { type: 'image/png' }), 'synthetic.png');
    const image = await fetch(`${h.api}/api/v1/messages/image`, { method: 'POST', headers: key, body: form });
    assert.equal(image.status, 202); assert.equal(csrfChecks, 3);
    t.mock.timers.tick(59_999); await nextTurn(); assert.equal(csrfChecks, 3, 'image must replace the text idle deadline');
    t.mock.timers.tick(1); assert.equal(csrfChecks, 4); await settleContacts(4);
  } finally { await h?.gateway.stop(); await rm(dir, { recursive: true, force: true }); }
});
