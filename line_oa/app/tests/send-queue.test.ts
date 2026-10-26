import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { SendQueue } from '../src/send-queue.js';
import { MessageSender } from '../src/sender.js';
import { SessionManager } from '../src/session.js';
import type { ContactService } from '../src/contacts.js';
import type { LineClient } from '../src/line-client.js';
import { MemoryLogger } from '../src/logger.js';
import { RequestDeduplicator } from '../src/api-v1.js';
import type { ImageSender } from '../src/images.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
const sent = { result: 'SUBMITTED' as const, sendId: 'synthetic', status: 200 };

test('FIFO runs mixed jobs one at a time; rejection and UNKNOWN do not stall or retry', async () => {
  const queue = new SendQueue();
  const gate = deferred();
  const order: string[] = [];
  const first = queue.run(async () => { order.push('text-1'); await gate.promise; return { result: 'UNKNOWN' }; }, 1);
  const second = queue.run(async () => { order.push('image'); throw new Error('synthetic'); }, 1);
  const secondFailure = assert.rejects(second, /synthetic/);
  const third = queue.run(async () => { order.push('text-2'); return 'done'; }, 1);
  await nextTurn(); assert.deepEqual(order, ['text-1']); assert.equal(queue.isBusy(), true);
  gate.resolve();
  assert.deepEqual(await first, { result: 'UNKNOWN' });
  await secondFailure; assert.equal(await third, 'done'); await nextTurn();
  assert.deepEqual(order, ['text-1', 'image', 'text-2']); assert.equal(queue.isBusy(), false);
});

test('queue bounds count/bytes and releases reservations when waiting requests cancel', async () => {
  const queue = new SendQueue({ maxItems: 2, maxBytes: 10 });
  const gate = deferred(), controller = new AbortController(); let cancelledRan = false;
  const first = queue.run(() => gate.promise, 6);
  await assert.rejects(queue.run(async () => undefined, 5), /SEND_QUEUE_FULL/);
  const waiting = queue.run(async () => { cancelledRan = true; }, 4, controller.signal);
  const cancelled = assert.rejects(waiting, /SEND_QUEUE_CANCELLED/);
  await assert.rejects(queue.run(async () => undefined, 0), /SEND_QUEUE_FULL/);
  controller.abort(); await cancelled;
  const next = queue.run(async () => 'next', 4);
  gate.resolve(); await first; assert.equal(await next, 'next'); assert.equal(cancelledRan, false);
});

test('wait timeout cancels an unstarted job; stopping rejects pending and future jobs', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const queue = new SendQueue({ waitMs: 10 });
  const gate = deferred(); let ran = false;
  const first = queue.run(() => gate.promise, 0);
  const expired = assert.rejects(queue.run(async () => { ran = true; }, 0), /SEND_QUEUE_TIMEOUT/);
  t.mock.timers.tick(10); await expired;
  const stopped = assert.rejects(queue.run(async () => { ran = true; }, 0), /SEND_QUEUE_STOPPED/);
  queue.stop(); await stopped;
  await assert.rejects(queue.run(async () => undefined, 0), /SEND_QUEUE_STOPPED/);
  gate.resolve(); await first; assert.equal(ran, false);
});

test('disconnect after a job started does not retry or abort an ambiguous submission', async () => {
  const queue = new SendQueue(); const gate = deferred(), controller = new AbortController(); let calls = 0;
  const active = queue.run(async () => { calls++; await gate.promise; return 'UNKNOWN'; }, 0, controller.signal);
  await nextTurn(); controller.abort(); gate.resolve();
  assert.equal(await active, 'UNKNOWN'); assert.equal(calls, 1);
});

test('pending request IDs survive TTL/capacity and are not submitted twice', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const cache = new RequestDeduplicator<string>(100, 1); const gate = deferred(); let calls = 0;
  const action = async () => { calls++; await gate.promise; return 'submitted'; };
  const first = cache.run('id', 'same', action);
  await nextTurn(); t.mock.timers.tick(1000);
  const duplicate = cache.run('id', 'same', action);
  await assert.rejects(cache.run('other', 'other', action), /REQUEST_CACHE_FULL/);
  await assert.rejects(cache.run('id', 'changed', action), /REQUEST_ID_CONFLICT/);
  gate.resolve();
  assert.deepEqual(await first, { value: 'submitted', duplicate: false });
  assert.deepEqual(await duplicate, { value: 'submitted', duplicate: true });
  assert.equal(calls, 1);
  t.mock.timers.tick(99); assert.equal((await cache.run('id', 'same', action)).duplicate, true);
  t.mock.timers.tick(1); assert.equal((await cache.run('id', 'same', action)).duplicate, false); assert.equal(calls, 2);
});

test('sender shares FIFO for text/images, rejects duplicates while waiting, and has no configured minute cap', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'line-oa-send-queue-'));
  const sessions = new SessionManager(dir);
  await sessions.importCredentials({ version: 1, botId: `U${'a'.repeat(32)}`, importedAt: new Date().toISOString(), cookies: [{ name: '__Host-chat-ses', value: 'synthetic' }] });
  const gate = deferred(); let validations = 0;
  const order: string[] = [];
  const client = { validate: async () => { if (++validations === 1) await gate.promise; },
    sendText: async (_id: string, message: string) => { order.push(message); return sent; },
    sendImage: async () => { order.push('image'); return sent; } } as unknown as LineClient;
  const contacts = { resolve: () => ({ chatId: `U${'b'.repeat(32)}`, name: 'synthetic' }) } as unknown as ContactService;
  const sender = new MessageSender(client, sessions, contacts, new MemoryLogger(), 60_000, 0);
  try {
    const first = sender.send('home', 'first');
    const image = sender.sendImage('home', Buffer.from('synthetic'), 'image/png');
    const later = Array.from({ length: 8 }, (_, i) => sender.send('home', `next-${i}`));
    await assert.rejects(sender.send('home', 'next-0'), /DUPLICATE_BLOCKED/);
    await nextTurn(); assert.equal(validations, 1); assert.deepEqual(order, []);
    gate.resolve(); await Promise.all([first, image, ...later]); await nextTurn();
    assert.deepEqual(order, ['first', 'image', ...Array.from({ length: 8 }, (_, i) => `next-${i}`)]);
    assert.equal(sender.submittedCount, 10); assert.equal(sender.isBusy(), false);
  } finally { gate.resolve(); sender.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('queued sends cannot use a revoked/rebound alias or a different login', async () => {
  for (const change of ['revoke', 'rebind', 'login'] as const) {
    const dir = await mkdtemp(join(tmpdir(), 'line-oa-queue-context-'));
    const sessions = new SessionManager(dir);
    const credentials = { version: 1 as const, botId: `U${'a'.repeat(32)}`, importedAt: new Date().toISOString(), cookies: [{ name: '__Host-chat-ses' as const, value: 'synthetic' }] };
    await sessions.importCredentials(credentials);
    const gate = deferred(); let deliveries = 0, valid = true, chatId = `U${'b'.repeat(32)}`;
    const contacts = { resolve: () => valid ? { chatId, name: 'synthetic' } : undefined } as unknown as ContactService;
    const client = { validate: () => gate.promise, sendText: async () => { deliveries++; return sent; } } as unknown as LineClient;
    const sender = new MessageSender(client, sessions, contacts, new MemoryLogger(), 60_000, 0);
    try {
      const active = sender.send('home', 'active');
      const pending = sender.send('home', 'waiting');
      const expected = change === 'login' ? /SEND_CONTEXT_CHANGED/ : /TARGET_NOT_ALLOWED/;
      const failed = [assert.rejects(active, expected), assert.rejects(pending, expected)];
      await nextTurn();
      if (change === 'revoke') valid = false;
      else if (change === 'rebind') chatId = `U${'c'.repeat(32)}`;
      else await sessions.importCredentials({ ...credentials, botId: `U${'c'.repeat(32)}` });
      gate.resolve(); await Promise.all(failed); assert.equal(deliveries, 0);
    } finally { gate.resolve(); sender.stop(); await rm(dir, { recursive: true, force: true }); }
  }
});

test('an account change during image staging cancels delivery and removes the staged file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'line-oa-image-context-'));
  const sessions = new SessionManager(dir);
  const credentials = { version: 1 as const, botId: `U${'a'.repeat(32)}`, importedAt: new Date().toISOString(), cookies: [{ name: '__Host-chat-ses' as const, value: 'synthetic' }] };
  await sessions.importCredentials(credentials);
  const gate = deferred(), staged = deferred(); let cleaned = false, sentImage = false;
  const images = { stage: async () => { staged.resolve(); await gate.promise; return 'synthetic-path'; }, remove: async () => { cleaned = true; } } as unknown as ImageSender;
  const client = { validate: async () => undefined, sendImage: async () => { sentImage = true; return sent; } } as unknown as LineClient;
  const contacts = { resolve: () => ({ chatId: `U${'b'.repeat(32)}`, name: 'synthetic' }) } as unknown as ContactService;
  const sender = new MessageSender(client, sessions, contacts, new MemoryLogger(), 60_000, 0, undefined, {}, images);
  try {
    const failure = assert.rejects(sender.sendImage('home', Buffer.from('synthetic'), 'image/png'), /SEND_CONTEXT_CHANGED/);
    await staged.promise; await sessions.importCredentials({ ...credentials, botId: `U${'c'.repeat(32)}` });
    gate.resolve(); await failure; assert.equal(sentImage, false); assert.equal(cleaned, true);
  } finally { gate.resolve(); sender.stop(); await rm(dir, { recursive: true, force: true }); }
});
