import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { SessionMonitor, sessionIdleDelayMs, SESSION_IDLE_DELAY_MS, SESSION_IDLE_JITTER_MS } from '../src/session-monitor.js';
import { MessageSender } from '../src/sender.js';
import type { ContactService } from '../src/contacts.js';
import { SessionManager } from '../src/session.js';
import { LineClient, type RequestFn } from '../src/line-client.js';
import { MemoryLogger } from '../src/logger.js';
import type { SessionCredentials } from '../src/types.js';

const credentials = (): SessionCredentials => ({ version: 1, botId: `U${'a'.repeat(32)}`,
  cookies: [{ name: '__Host-chat-ses', value: 'synthetic-session' }], importedAt: new Date().toISOString() });

async function fixture(request: RequestFn, busy = () => false, nextDelay = () => SESSION_IDLE_DELAY_MS) {
  const dir = await mkdtemp(join(tmpdir(), 'line-oa-monitor-'));
  const sessions = new SessionManager(dir);
  await sessions.load();
  const client = new LineClient(sessions, 1000, request);
  const monitor = new SessionMonitor(sessions, client, new MemoryLogger(), busy, nextDelay);
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

test('idle delay stays within 30 to 60 minutes', () => {
  for (let i = 0; i < 100; i++) {
    const delay = sessionIdleDelayMs();
    assert.ok(delay >= SESSION_IDLE_DELAY_MS);
    assert.ok(delay <= SESSION_IDLE_DELAY_MS + SESSION_IDLE_JITTER_MS);
  }
});

test('startup waits; successive idle checks use freshly selected delays; expiry stops probes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let status = 200; let calls = 0;
  const delays = [30, 60, 45]; let selected = 0;
  const h = await fixture(async (_method, path) => {
    calls++;
    return { status, body: path.includes('csrfToken') ? { token: 'synthetic-csrf' } : { list: [] }, contentType: 'application/json' };
  }, () => false, () => (delays[selected++] ?? 30) * 60_000);
  try {
    await h.sessions.importCredentials(credentials()); h.monitor.start(); h.monitor.start();
    await nextTurn(); assert.equal(calls, 0); assert.equal(selected, 1);
    t.mock.timers.tick(30 * 60_000 - 1); await nextTurn(); assert.equal(calls, 0);
    t.mock.timers.tick(1); assert.equal(calls, 1); await h.monitor.check(); await nextTurn();
    assert.equal(h.sessions.getStatus().state, 'CONNECTED'); assert.equal(calls, 2);
    status = 401;
    t.mock.timers.tick(60 * 60_000 - 1); await nextTurn(); assert.equal(calls, 2);
    t.mock.timers.tick(1); assert.equal(calls, 3); await h.monitor.check(); await nextTurn();
    assert.equal(h.sessions.getStatus().state, 'EXPIRED');
    t.mock.timers.tick(45 * 60_000); await nextTurn(); assert.equal(calls, 3);
    h.monitor.stop(); t.mock.timers.tick(90 * 60_000); await nextTurn(); assert.equal(calls, 3);
  } finally { await h.close(); }
});

test('frequent sends keep postponing idle checks; stopping prevents further scheduling', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const h = await fixture(async (_method, path) => {
    calls++;
    return { status: 200, body: path.includes('csrfToken') ? { token: 'synthetic-csrf' } : { list: [] }, contentType: 'application/json' };
  });
  try {
    await h.sessions.importCredentials(credentials()); h.monitor.start();
    for (let i = 0; i < 10; i++) {
      t.mock.timers.tick(10 * 60_000); h.monitor.messageSent();
      await nextTurn(); assert.equal(calls, 0);
    }
    t.mock.timers.tick(30 * 60_000 - 1); await nextTurn(); assert.equal(calls, 0);
    t.mock.timers.tick(1); assert.equal(calls, 1); await h.monitor.check(); await nextTurn();
    assert.equal(calls, 2);
    h.monitor.stop(); h.monitor.messageSent(); h.monitor.start();
    t.mock.timers.tick(90 * 60_000); await nextTurn(); assert.equal(calls, 2);
  } finally { await h.close(); }
});

test('an older in-flight check cannot replace the new send deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let release!: () => void; let calls = 0; let selections = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const h = await fixture(async (_method, path) => {
    calls++; await gate;
    return { status: 200, body: path.includes('csrfToken') ? { token: 'synthetic-csrf' } : { list: [] }, contentType: 'application/json' };
  }, () => false, () => (++selections === 1 ? 30 : 60) * 60_000);
  try {
    await h.sessions.importCredentials(credentials()); h.monitor.start();
    t.mock.timers.tick(30 * 60_000); assert.equal(calls, 1);
    t.mock.timers.tick(10 * 60_000); h.monitor.messageSent();
    release(); await h.monitor.check(); await nextTurn();
    assert.equal(calls, 2); assert.equal(selections, 2);
    t.mock.timers.tick(60 * 60_000 - 1); await nextTurn(); assert.equal(calls, 2);
    t.mock.timers.tick(1); assert.equal(calls, 3); await h.monitor.check(); await nextTurn();
    assert.equal(calls, 4);
  } finally { release(); await h.close(); }
});

test('text, image and unknown sends reset idle checks; rejected local requests do not', async t => {
  for (const kind of ['text', 'image', 'unknown', 'rejected'] as const) {
    await t.test(kind, async t => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      let calls = 0;
      const h = await fixture(async (method, path) => {
        calls++;
        if (method === 'POST' && kind === 'unknown') throw new Error('synthetic timeout');
        return { status: 200, body: path.includes('csrfToken') ? { token: 'synthetic-csrf' }
          : path.includes('uploadFile') ? { contentMessageToken: 'synthetic-upload' } : { list: [] }, contentType: 'application/json' };
      });
      const contacts = { resolve: (alias: string) => alias === 'home' ? { chatId: `U${'b'.repeat(32)}` } : undefined } as ContactService;
      const sender = new MessageSender(h.client, h.sessions, contacts, new MemoryLogger(), 60_000, 5, () => h.monitor.messageSent());
      try {
        await h.sessions.importCredentials(credentials()); h.monitor.start();
        t.mock.timers.tick(25 * 60_000); assert.equal(calls, 0);
        if (kind === 'rejected') await assert.rejects(sender.send('missing', 'test'), /TARGET_NOT_ALLOWED/);
        else if (kind === 'image') assert.equal((await sender.sendImage('home', Buffer.from('synthetic'), 'image/png')).result, 'SUBMITTED');
        else assert.equal((await sender.send('home', 'synthetic')).result, kind === 'unknown' ? 'UNKNOWN' : 'SUBMITTED');
        const afterSend = calls;
        t.mock.timers.tick(5 * 60_000);
        if (kind === 'rejected') {
          assert.equal(calls, afterSend + 1); await h.monitor.check(); await nextTurn();
        } else {
          await nextTurn(); assert.equal(calls, afterSend);
          t.mock.timers.tick(25 * 60_000 - 1); await nextTurn(); assert.equal(calls, afterSend);
          t.mock.timers.tick(1); assert.equal(calls, afterSend + 1); await h.monitor.check(); await nextTurn();
        }
        assert.equal(calls, afterSend + 2);
      } finally { await h.close(); }
    });
  }
});
