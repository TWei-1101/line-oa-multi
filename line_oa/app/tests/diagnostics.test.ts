import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionManager } from '../src/session.js';
import { LineClient, LineError } from '../src/line-client.js';
import { BusinessQrLogin } from '../src/qr-login.js';
import { diagnosticText } from '../src/diagnostics.js';
import { localTimestamp, MemoryLogger } from '../src/logger.js';

const credentials = () => ({ version: 1 as const, botId: `U${'a'.repeat(32)}`, importedAt: new Date().toISOString(),
  csrfToken: 'known-csrf-credential', cookies: [{ name: '__Host-chat-ses' as const, value: 'known-session-credential' }] });

test('logout wins pending import/CSRF writes and persists across restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'line-oa-logout-'));
  try {
    const sessions = new SessionManager(dir); await sessions.importCredentials(credentials());
    const refresh = sessions.updateCsrf('refreshed-secret');
    const importing = sessions.importCredentials(credentials());
    const rejected = assert.rejects(importing, /SESSION_CHANGED/);
    await sessions.logout(); await refresh; await rejected;
    sessions.mark('CONNECTED', 'late validation');
    assert.equal(sessions.getCredentials(), undefined);
    assert.equal(sessions.getStatus().state, 'AUTH_REQUIRED');
    assert.equal(JSON.parse(await readFile(join(dir, 'secrets/line-session.json'), 'utf8')), null);
    const restarted = new SessionManager(dir); await restarted.load();
    assert.equal(restarted.getCredentials(), undefined);
    assert.equal(restarted.getStatus().state, 'AUTH_REQUIRED');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('LINE failure includes detailed CSRF name and all response fields without credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'line-oa-response-'));
  try {
    const sessions = new SessionManager(dir); await sessions.importCredentials(credentials());
    let logged = '';
    const client = new LineClient(sessions, 1000, async () => ({ status: 403, contentType: 'application/json',
      headers: { 'set-cookie': 'sensitive-response-cookie', 'x-request-id': 'request-123' },
      body: { code: 'INVALID_CSRF', message: 'Denied: known-session-credential', extra: { reason: 'Permission denied', csrfToken: 'new-unknown-token', tail: 'x'.repeat(700) + 'END_OF_RESPONSE' } } }),
      (code, details) => { logged = code + '\n' + details; });
    await assert.rejects(client.refreshCsrf(), (error: unknown) => {
      assert.ok(error instanceof LineError);
      assert.equal(error.code, 'LINE_HTTP_403_CSRF_OR_PERMISSION_DENIED');
      assert.match(error.details!, /END_OF_RESPONSE/);
      return true;
    });
    assert.match(logged, /httpStatus: 403/); assert.match(logged, /Permission denied/); assert.match(logged, /request-123/);
    for (const secret of ['known-session-credential', 'sensitive-response-cookie', 'new-unknown-token']) assert.equal(logged.includes(secret), false);
    assert.doesNotMatch(logged, /[{}]/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('diagnostics redact nested JSON, raw HTML, URL queries, headers and terminal controls', () => {
  const output = diagnosticText({ response: { nested: { accessToken: 'unknown-token', pin: '123456' }, message: 'useful error' },
    html: '<input name="_csrf" value="hidden-value"><script>csrfToken="script-value"</script>',
    url: 'https://access.line.me/qrlogin/v1/qr/qr-secret?loginState=url-secret',
    text: 'Cookie: cookie-secret\nAuthorization: Bearer bearer-secret\n\u001b[31merror' });
  for (const secret of ['unknown-token','123456','hidden-value','script-value','qr-secret','url-secret','cookie-secret','bearer-secret','\u001b']) assert.equal(output.includes(secret), false, secret);
  assert.match(output, /useful error/);
});

test('QR form CSRF failure exposes the actual response and detailed parser error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'line-oa-qr-diagnostic-'));
  const original = globalThis.fetch;
  let count = 0;
  globalThis.fetch = async () => ++count === 1
    ? new Response(null, { status: 302, headers: { location: 'https://account.line.biz/login' } })
    : new Response('<html><form method="POST" action="/login/line"><input name="other" value="hidden-secret"></form><p>LOGIN_SERVER_RESPONSE_END</p></html>',
      { status: 200, headers: { 'content-type': 'text/html', 'set-cookie': 'ses=new-cookie; Path=/; Secure' } });
  try {
    let failed = '';
    const login = new BusinessQrLogin(new SessionManager(dir), (_op, result, _target, code, details) => { if (result === 'FAILED') failed = `${code}\n${details}`; });
    const state = await login.start('browser-owner');
    assert.equal(state.error_name, 'LOGIN_BUSINESS_CSRF_MISSING');
    assert.match(state.details!, /LOGIN_SERVER_RESPONSE_END/);
    assert.match(failed, /httpStatus: 200/);
    assert.equal(failed.includes('hidden-secret'), false); assert.equal(failed.includes('new-cookie'), false);
    assert.equal(state.hasQr, false); login.close();
  } finally { globalThis.fetch = original; await rm(dir, { recursive: true, force: true }); }
});

test('application log uses configured local timezone and plain text fields', () => {
  assert.equal(localTimestamp(new Date('2026-10-17T02:03:04Z'), 'Asia/Taipei'), '2026-10-17 10:03:04 GMT+08:00 [Asia/Taipei]');
  const logger = new MemoryLogger();
  logger.add('MOCK_FAILURE', 'FAILED', undefined, 'LINE_HTTP_403_CSRF_OR_PERMISSION_DENIED', { status: 403, response: { message: 'Denied', token: 'do-not-log' } });
  const entry = logger.list()[0]!;
  assert.match(entry.localTime!, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
  assert.match(entry.details!, /message: Denied/);
  assert.doesNotMatch(entry.details!, /[{}"]|do-not-log/);
});

test('in-flight validation cannot write credentials after logout', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'line-oa-inflight-'));
  try {
    const sessions = new SessionManager(dir); await sessions.importCredentials(credentials());
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const client = new LineClient(sessions, 1000, async () => {
      await pending;
      return { status: 200, contentType: 'application/json', body: { token: 'late-token' } };
    });
    const validation = client.validate();
    const rejected = assert.rejects(validation, /SESSION_CHANGED/);
    await sessions.logout(); finish(); await rejected;
    assert.equal(sessions.getCredentials(), undefined);
    assert.equal(JSON.parse(await readFile(join(dir, 'secrets/line-session.json'), 'utf8')), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('cancelling QR while upstream response is pending cannot recreate a login', async () => {
  const original = globalThis.fetch;
  let finish!: (response: Response) => void;
  globalThis.fetch = () => new Promise(resolve => { finish = resolve; });
  const login = new BusinessQrLogin({} as SessionManager);
  try {
    const started = login.start('owner');
    login.close();
    finish(new Response('cancelled response', { status: 200, headers: { 'content-type': 'text/html' } }));
    assert.equal((await started).status, 'idle');
    assert.equal(login.state('owner').hasQr, false);
  } finally { login.close(); globalThis.fetch = original; }
});
