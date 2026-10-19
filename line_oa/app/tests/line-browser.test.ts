import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lineUserAgent, LINE_USER_AGENT } from '../src/line-browser.js';
import { BusinessQrLogin } from '../src/qr-login.js';
import { LineClient } from '../src/line-client.js';
import { SessionManager } from '../src/session.js';

test('supported architectures use standard Windows or macOS Chrome desktop identities', () => {
  assert.match(lineUserAgent('x64'), /\(Windows NT 10\.0; Win64; x64\)/);
  assert.match(lineUserAgent('arm64'), /\(Macintosh; Intel Mac OS X 10_15_7\)/);
  for (const arch of ['x64', 'arm64'] as const) {
    assert.match(lineUserAgent(arch), /Chrome\/140\.0\.0\.0 Safari\/537\.36$/);
    assert.doesNotMatch(lineUserAgent(arch), /Linux|Node\.js/);
  }
  assert.equal(lineUserAgent(), LINE_USER_AGENT);
});

test('QR login keeps a consistent identity and real LINE Business ID origin across redirects', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'line-oa-browser-'));
  const original = globalThis.fetch;
  const seen: { url: string; method: string; headers: Headers }[] = [];
  const login = new BusinessQrLogin(new SessionManager(dir));
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    seen.push({ url, method: init?.method ?? 'GET', headers: new Headers(init?.headers) });
    if (seen.length === 1) return new Response(null, { status: 302, headers: { location: 'https://account.line.biz/login' } });
    if (seen.length === 2) return new Response('<form method="POST" action="/login/line"><input name="_csrf" value="synthetic-csrf"></form>', { headers: { 'content-type': 'text/html' } });
    if (seen.length === 3) return new Response(null, { status: 302, headers: { location: 'https://access.line.me/oauth2/v2.1/login' } });
    // Stop before generating a QR or starting long polling. All responses are synthetic.
    return new Response('<html>Incomplete mock login page</html>', { headers: { 'content-type': 'text/html' } });
  };
  try {
    const state = await login.start('synthetic-owner');
    assert.equal(state.status, 'error');
    assert.equal(seen.length, 4);
    for (const request of seen) assert.equal(request.headers.get('user-agent'), LINE_USER_AGENT);
    assert.equal(seen[0]!.url, 'https://chat.line.biz/');
    assert.equal(seen[1]!.url, 'https://account.line.biz/login');
    assert.equal(seen[1]!.headers.get('referer'), 'https://chat.line.biz/');
    assert.equal(seen[2]!.url, 'https://account.line.biz/login/line');
    assert.equal(seen[2]!.method, 'POST');
    assert.equal(seen[2]!.headers.get('origin'), 'https://account.line.biz');
    assert.equal(seen[2]!.headers.get('referer'), 'https://account.line.biz/login');
    assert.equal(seen[3]!.headers.get('referer'), 'https://account.line.biz/login/line');
  } finally { login.close(); globalThis.fetch = original; await rm(dir, { recursive: true, force: true }); }
});

test('authenticated validation and text/image requests reuse the QR identity and chat origin', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'line-oa-browser-api-'));
  const headers: Record<string, string>[] = [];
  try {
    const sessions = new SessionManager(dir);
    await sessions.importCredentials({ version: 1, botId: `U${'a'.repeat(32)}`, importedAt: new Date().toISOString(),
      cookies: [{ name: '__Host-chat-ses', value: 'synthetic-session' }] });
    const client = new LineClient(sessions, 1000, async (_method, path, requestHeaders) => {
      headers.push(requestHeaders);
      return { status: 200, contentType: 'application/json', body: path.includes('csrfToken') ? { token: 'synthetic-csrf' }
        : path.includes('uploadFile') ? { contentMessageToken: 'synthetic-upload' } : { list: [] } };
    });
    await client.validate();
    await client.sendText(`U${'b'.repeat(32)}`, 'synthetic');
    await client.sendImage(`U${'b'.repeat(32)}`, Buffer.from('synthetic'), 'image/png');
    assert.equal(headers.length, 5);
    for (const request of headers) {
      assert.equal(request['User-Agent'], LINE_USER_AGENT);
      assert.equal(request.Origin, 'https://chat.line.biz');
      assert.equal(request.Referer, 'https://chat.line.biz/');
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
