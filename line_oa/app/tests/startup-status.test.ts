import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { createGateway } from '../src/server.js';
import { atomicWriteJson } from '../src/storage.js';
import type { BusinessQrLogin } from '../src/qr-login.js';

test('restart resolves HACS status without a send, manual validation, or idle timer', async t => {
  for (const scenario of ['ready', 'recovered', 'expired', 'offline', 'forbidden', 'empty'] as const) {
    await t.test(scenario, async () => {
      const dir = await mkdtemp(join(tmpdir(), 'line-oa-startup-'));
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      let calls = 0, recoveries = 0, recovered = false;
      const session = { version: 1, botId: `U${'a'.repeat(32)}`, importedAt: new Date().toISOString(),
        csrfToken: 'synthetic-csrf', cookies: [{ name: '__Host-chat-ses', value: 'synthetic-session' }] };
      if (scenario !== 'empty') await atomicWriteJson(join(dir, 'secrets/line-session.json'), session);
      const qr = { close() {}, async recover() {
        recoveries++;
        if (scenario === 'expired') throw new Error('LOGIN_REAUTH_REQUIRED');
        recovered = true;
      } } as unknown as BusinessQrLogin;
      const options = { dataDir: dir, qrLogin: qr, sessionCheckDelayMs: () => 60 * 60_000 };
      // Pair before restart: the existing HA key and instance must remain valid.
      const original = await createGateway(options);
      const paired = await original.pairing.exchange({ instance_id: original.pairing.instanceId,
        bootstrap_token: original.pairing.discovery().bootstrap_token,
        request_id: '00000000-0000-4000-8000-000000000001', client: 'homeassistant-line_oa' });
      await original.stop();
      const gateway = await createGateway({ ...options, lineRequest: async (method, path) => {
        calls++;
        assert.equal(method, 'GET');
        assert.match(path, /\/contacts\?|\/api\/v1\/csrfToken$/);
        await gate;
        if (scenario === 'offline') throw new Error('synthetic network failure');
        if (path === '/api/v1/csrfToken') return { status: 200, contentType: 'application/json', body: { token: 'synthetic-csrf' } };
        const status = scenario === 'expired' || (scenario === 'recovered' && !recovered) ? 401
          : scenario === 'forbidden' ? 403 : 200;
        return { status, contentType: 'application/json', body: status === 401 ? { code: 'not_login' } : { list: [] } };
      } });
      try {
        await gateway.start(0, 0, '127.0.0.1');
        const api = `http://127.0.0.1:${(gateway.apiServer.address() as AddressInfo).port}`;
        const getStatus = async () => {
          const response = await fetch(`${api}/api/v1/status`, { headers: { Authorization: `Bearer ${paired.api_key}` } });
          assert.equal(response.status, 200);
          const body = await response.json() as Record<string, unknown>;
          assert.equal(body.instance_id, paired.instance_id);
          return body;
        };
        // Health/status must remain responsive during LINE authentication.
        assert.equal((await fetch(`${api}/api/v1/health`)).status, 200);
        const pending = await getStatus();
        assert.equal(pending.session_status, scenario === 'empty' ? 'auth_required' : 'unknown');
        assert.equal(calls, scenario === 'empty' ? 0 : 1);
        release();
        let status = pending;
        for (let i = 0; i < 100 && status.session_status === 'unknown'; i++) {
          await new Promise(resolve => setTimeout(resolve, 10));
          status = await getStatus();
        }
        const expected = scenario === 'recovered' ? 'ready' : scenario === 'offline' ? 'disconnected'
          : scenario === 'forbidden' ? 'error' : scenario === 'empty' ? 'auth_required' : scenario;
        assert.equal(status.session_status, expected);
        assert.equal(status.line_logged_in, expected === 'ready' ? true
          : ['expired', 'auth_required'].includes(expected) ? false : null);
        assert.equal(recoveries, ['recovered', 'expired'].includes(scenario) ? 1 : 0);
        const checkedCalls = calls;
        await getStatus(); await getStatus();
        assert.equal(calls, checkedCalls, 'HA polling must not trigger LINE checks');
      } finally { release(); await gateway.stop(); await rm(dir, { recursive: true, force: true }); }
    });
  }
});
