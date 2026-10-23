import test from 'node:test';
import assert from 'node:assert/strict';
import { formatStartupFailure, startupFailureCode } from '../src/startup-observability.js';

test('startup diagnostics expose only an allowlisted phase/code and fixed text', () => {
  const canary = 'token=canary-secret /Users/twei/private';
  const result = formatStartupFailure('bridge', new Error(canary));
  assert.equal(result, 'LINE OA Multi startup failed (bridge/STARTUP_UNKNOWN); inspect protected Add-on logs and backup.\n');
  assert.ok(!result.includes(canary));
  assert.equal(startupFailureCode('webhook', new Error('WEBHOOK_DATA_CORRUPT_RESTORE_BACKUP')), 'STARTUP_WEBHOOK_CORRUPT');
  assert.equal(startupFailureCode('registry', new Error('MULTI_ACCOUNT_REGISTRY_CORRUPT_RESTORE_BACKUP')), 'STARTUP_REGISTRY_CORRUPT');
  assert.equal(startupFailureCode('control', new Error('CONFIG_CORRUPT_RESTORE_BACKUP')), 'STARTUP_CONFIG_CORRUPT');
  assert.equal(startupFailureCode('api-listen', Object.assign(new Error('busy'), { code: 'EADDRINUSE' })), 'STARTUP_PORT_IN_USE');
});

test('startup diagnostics do not invoke hostile getters or leak their values', () => {
  let reads = 0;
  const hostile = Object.create(null, {
    message: { get() { reads++; throw new Error('canary getter'); } },
    code: { get() { reads++; throw new Error('canary getter'); } }
  });
  const result = formatStartupFailure('bridge', hostile);
  assert.equal(result, 'LINE OA Multi startup failed (bridge/STARTUP_UNKNOWN); inspect protected Add-on logs and backup.\n');
  assert.equal(reads, 0);
  let descriptorTraps = 0;
  const proxy = new Proxy({}, { getOwnPropertyDescriptor() { descriptorTraps++; throw new Error('canary proxy'); } });
  assert.equal(startupFailureCode('bridge', proxy), 'STARTUP_UNKNOWN');
  assert.equal(descriptorTraps, 0, 'Proxy descriptors must never be inspected');
  const { proxy: revoked, revoke } = Proxy.revocable({}, {});
  revoke();
  assert.equal(startupFailureCode('bridge', revoked), 'STARTUP_UNKNOWN');
});

test('startup formatter normalizes runtime phases without coercing hostile values', () => {
  let phaseTraps = 0;
  const phaseProxy = new Proxy({}, { get() { phaseTraps++; throw new Error('phase canary'); } });
  const hostilePhase = { toString() { throw new Error('phase stringification'); } };
  for (const phase of ['not-a-phase', phaseProxy, hostilePhase]) {
    assert.equal(formatStartupFailure(phase as never, new Error('cause canary')),
      'LINE OA Multi startup failed (unknown/STARTUP_UNKNOWN); inspect protected Add-on logs and backup.\n');
  }
  assert.equal(phaseTraps, 0);
});
