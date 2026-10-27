import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { SessionMonitor, sessionIdleDelayMs, SESSION_JITTER_MIN_MS, SESSION_JITTER_MAX_MS } from '../src/session-monitor.js';
import { MessageSender } from '../src/sender.js';
import type { ContactService } from '../src/contacts.js';
import { SessionManager } from '../src/session.js';
import { LineClient, type RequestFn } from '../src/line-client.js';
import { MemoryLogger } from '../src/logger.js';
import type { SessionCredentials } from '../src/types.js';

const credentials = (): SessionCredentials => ({ version: 1, botId: `U${'a'.repeat(32)}`,
  cookies: [{ name: '__Host-chat-ses', value: 'synthetic-session' }], importedAt: new Date().toISOString() });

async function fixture(request: RequestFn, busy = () => false, intervalMinutes = 45, delay: (minutes: number) => number = minutes => (minutes + 1) * 60_000) {
  const dir = await mkdtemp(join(tmpdir(), 'line-oa-monitor-'));
  const sessions = new SessionManager(dir);
  await sessions.load();
  const client = new LineClient(sessions, 1000, request);
  const monitor = new SessionMonitor(sessions, client, new MemoryLogger(), busy, intervalMinutes, delay);
  return { dir, sessions, client, monitor, async close() { monitor.stop(); await rm(dir, { recursive: true, force: true }); } };
}

test('background monitor checks CSRF and read-only contacts; expiry stops further probes', async () => {
  let status = 200;
  const paths: string[] = [];
  const h = await fixture(async (method, path) => {
    assert.equal(method, 'GET'); paths.push(path);
    return { status, body: path.includes('csrfToken') ? { token: 'synthetic-csrf' } : { list: [] }, contentType: 'application/json' };
  });
  try {
    await h.monitor.check(); assert.equal(paths.length, 0);
    await h.sessions.importCredentials(credentials());
    await h.monitor.check();
    assert.equal(h.sessions.getStatus().state, 'CONNECTED'); assert.equal(paths.length, 2);
    const saved = JSON.parse(await readFile(join(h.dir, 'secrets/line-session.json'), 'utf8'));
    assert.equal(saved.csrfToken, 'synthetic-csrf');
    status = 401; await h.monitor.check();
    assert.equal(h.sessions.getStatus().state, 'EXPIRED');
    assert.equal(h.sessions.getStatus().loginRequiredReason, 'expired');
    await h.monitor.check(); assert.equal(paths.length, 3);
    status = 200; await h.sessions.importCredentials(credentials()); await h.monitor.check();
    assert.equal(h.sessions.getStatus().state, 'CONNECTED');
  } finally { await h.close(); }
});

test('network, CSRF, permission and rate-limit failures do not masquerade as expiry; recover without QR', async () => {
  let status = 0;
  const h = await fixture(async (_method, path) => {
    if (!status) throw new Error('offline');
    return { status, body: path.includes('csrfToken') ? { token: 'synthetic-csrf' } : { list: [] }, contentType: 'application/json' };
  });
  try {
    await h.sessions.importCredentials(credentials()); await h.monitor.check();
    assert.equal(h.sessions.getStatus().state, 'DISCONNECTED');
    for (status of [403, 429, 500]) {
      await h.monitor.check(); assert.equal(h.sessions.getStatus().state, 'ERROR');
      assert.equal(h.sessions.getStatus().loginRequiredReason, undefined);
    }
    status = 200; await h.monitor.check(); assert.equal(h.sessions.getStatus().state, 'CONNECTED');
  } finally { await h.close(); }
});

test('background and foreground validations share a single probe; busy sender skips background', async () => {
  let release!: () => void; let calls = 0; let busy = true;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const h = await fixture(async (_method, path) => {
    calls++; await gate;
    return { status: 200, body: path.includes('csrfToken') ? { token: 'synthetic-csrf' } : { list: [] }, contentType: 'application/json' };
  }, () => busy);
  try {
    await h.sessions.importCredentials(credentials()); await h.monitor.check(); assert.equal(calls, 0);
    busy = false;
    const first = h.monitor.check(); const second = h.monitor.check(); const foreground = h.client.validate();
    assert.equal(calls, 1); release(); await Promise.all([first, second, foreground]);
    assert.equal(calls, 2); assert.equal(h.sessions.getStatus().state, 'CONNECTED');
  } finally { release(); await h.close(); }
});

test('pending background result cannot restore logout or overwrite a new login', async () => {
  for (const action of ['logout', 'login'] as const) {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const h = await fixture(async () => { await gate; return { status: 401, body: {}, contentType: 'application/json' }; });
    try {
      await h.sessions.importCredentials(credentials()); const pending = h.monitor.check();
      if (action === 'logout') await h.sessions.logout();
      else await h.sessions.importCredentials({ ...credentials(), botId: `U${'b'.repeat(32)}` });
      release(); await pending;
      assert.equal(h.sessions.getStatus().state, action === 'logout' ? 'AUTH_REQUIRED' : 'VALIDATING');
      if (action === 'logout') assert.equal(h.sessions.getStatus().loginRequiredReason, 'logged_out');
      else assert.equal(h.sessions.getCredentials()?.botId, `U${'b'.repeat(32)}`);
    } finally { release(); await h.close(); }
  }
});

test('idle interval plus jitter can be changed or disabled without restarting', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const h = await fixture(async (_method, path) => {
    calls++;
    return { status: 200, body: path.includes('csrfToken') ? { token: 'synthetic-csrf' } : { list: [] }, contentType: 'application/json' };
  }, () => false, 45);
  try {
    await h.sessions.importCredentials(credentials()); h.monitor.start(); h.monitor.start();
    t.mock.timers.tick(46 * 60_000 - 1); await nextTurn(); assert.equal(calls, 0);
    t.mock.timers.tick(1); await h.monitor.check(); await nextTurn(); assert.equal(calls, 2);
    h.monitor.configure(5);
    t.mock.timers.tick(6 * 60_000); await h.monitor.check(); await nextTurn(); assert.equal(calls, 4);
    h.monitor.configure(0);
    assert.equal(h.monitor.enabled, false);
    t.mock.timers.tick(7 * 24 * 60 * 60_000); await h.monitor.check(); await nextTurn(); assert.equal(calls, 4);
    h.monitor.configure(2);
    t.mock.timers.tick(3 * 60_000); await h.monitor.check(); await nextTurn(); assert.equal(calls, 6);
    h.monitor.stop(); t.mock.timers.tick(60 * 60_000); await nextTurn(); assert.equal(calls, 6);
  } finally { await h.close(); }
});

test('zero disables startup and scheduled checks; manual validation remains available', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const h = await fixture(async (_method, path) => {
    calls++;
    return { status: 200, body: path.includes('csrfToken') ? { token: 'synthetic-csrf' } : { list: [] }, contentType: 'application/json' };
  }, () => false, 0);
  try {
    await h.sessions.importCredentials(credentials()); h.monitor.start();
    await h.monitor.check('startup_check'); t.mock.timers.tick(7 * 24 * 60 * 60_000); await nextTurn(); assert.equal(calls, 0);
    await h.client.validate(); assert.equal(calls, 2);
  } finally { await h.close(); }
});

test('disabling during a pending check cannot reschedule the old timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let release!: () => void; let calls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const h = await fixture(async (_method, path) => {
    calls++; await gate;
    return { status: 200, body: path.includes('csrfToken') ? { token: 'synthetic-csrf' } : { list: [] }, contentType: 'application/json' };
  }, () => false, 1);
  try {
    await h.sessions.importCredentials(credentials()); h.monitor.start();
    t.mock.timers.tick(2 * 60_000); assert.equal(calls, 1);
    const pending = h.monitor.check();
    h.monitor.configure(0); release(); await pending; await nextTurn();
    assert.equal(calls, 2);
    t.mock.timers.tick(60 * 60_000); await nextTurn(); assert.equal(calls, 2);
  } finally { release(); await h.close(); }
});

test('production delay adds one to ten minutes to every configured idle duration', () => {
  for (const minutes of [1, 45, 10_080]) for (let i = 0; i < 100; i++) {
    const value = sessionIdleDelayMs(minutes);
    assert.ok(value >= minutes * 60_000 + SESSION_JITTER_MIN_MS);
    assert.ok(value <= minutes * 60_000 + SESSION_JITTER_MAX_MS);
  }
});

test('text, image and unknown sends reset idle deadline; local rejection does not', async t => {
  for (const kind of ['text', 'image', 'unknown', 'rejected'] as const) await t.test(kind, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let calls = 0;
    const h = await fixture(async (method, path) => {
      calls++;
      if (method === 'POST' && kind === 'unknown') throw new Error('synthetic timeout');
      return { status: 200, body: path.includes('csrfToken') ? { token: 'synthetic-csrf' }
        : path.includes('uploadFile') ? { contentMessageToken: 'synthetic-upload' } : { list: [] }, contentType: 'application/json' };
    });
    const contacts = { resolve: (alias: string) => alias === 'home' ? { chatId: `U${'b'.repeat(32)}` } : undefined } as unknown as ContactService;
    const sender = new MessageSender(h.client, h.sessions, contacts, new MemoryLogger(), 60_000, 0, () => h.monitor.messageSent());
    try {
      await h.sessions.importCredentials(credentials()); h.monitor.start();
      t.mock.timers.tick(45 * 60_000); assert.equal(calls, 0);
      if (kind === 'rejected') await assert.rejects(sender.send('missing', 'synthetic'), /TARGET_NOT_ALLOWED/);
      else if (kind === 'image') assert.equal((await sender.sendImage('home', Buffer.from('synthetic'), 'image/png')).result, 'SUBMITTED');
      else assert.equal((await sender.send('home', 'synthetic')).result, kind === 'unknown' ? 'UNKNOWN' : 'SUBMITTED');
      const afterSend = calls;
      t.mock.timers.tick(60_000);
      if (kind === 'rejected') {
        assert.equal(calls, afterSend + 1); await h.monitor.check(); await nextTurn();
      } else {
        await nextTurn(); assert.equal(calls, afterSend);
        t.mock.timers.tick(45 * 60_000 - 1); await nextTurn(); assert.equal(calls, afterSend);
        t.mock.timers.tick(1); assert.equal(calls, afterSend + 1); await h.monitor.check(); await nextTurn();
      }
      assert.equal(calls, afterSend + 2);
    } finally { sender.stop(); await h.close(); }
  });
});

test('each new idle window draws a fresh delay; a pending check cannot overwrite a later send deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let release!: () => void, calls = 0, selections = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const h = await fixture(async (_method, path) => {
    calls++; await gate;
    return { status: 200, body: path.includes('csrfToken') ? { token: 'synthetic-csrf' } : { list: [] }, contentType: 'application/json' };
  }, () => false, 45, minutes => (minutes + (++selections === 1 ? 1 : 10)) * 60_000);
  try {
    await h.sessions.importCredentials(credentials()); h.monitor.start();
    t.mock.timers.tick(46 * 60_000); assert.equal(calls, 1);
    const pending = h.monitor.check();
    t.mock.timers.tick(5 * 60_000); h.monitor.messageSent();
    release(); await pending; await nextTurn();
    assert.equal(calls, 2); assert.equal(selections, 2);
    t.mock.timers.tick(55 * 60_000 - 1); await nextTurn(); assert.equal(calls, 2);
    t.mock.timers.tick(1); assert.equal(calls, 3); await h.monitor.check(); await nextTurn(); assert.equal(calls, 4);
    h.monitor.stop(); h.monitor.messageSent(); t.mock.timers.tick(120 * 60_000); await nextTurn(); assert.equal(calls, 4);
  } finally { release(); await h.close(); }
});

test('continuous sends postpone checks, and zero cannot be re-enabled by a send callback', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const h = await fixture(async (_method, path) => {
    calls++;
    return { status: 200, body: path.includes('csrfToken') ? { token: 'synthetic-csrf' } : { list: [] }, contentType: 'application/json' };
  });
  try {
    await h.sessions.importCredentials(credentials()); h.monitor.start();
    for (let i = 0; i < 10; i++) { t.mock.timers.tick(30 * 60_000); h.monitor.messageSent(); await nextTurn(); assert.equal(calls, 0); }
    t.mock.timers.tick(46 * 60_000 - 1); await nextTurn(); assert.equal(calls, 0);
    t.mock.timers.tick(1); await h.monitor.check(); await nextTurn(); assert.equal(calls, 2);
    h.monitor.configure(0); h.monitor.messageSent();
    t.mock.timers.tick(7 * 24 * 60 * 60_000); await h.monitor.check(); await nextTurn(); assert.equal(calls, 2);
  } finally { await h.close(); }
});
