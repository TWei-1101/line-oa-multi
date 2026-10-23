import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { MultiWebhook, type ReceivedEvent, type ForwardResult } from '../src/webhook.js';

const secret = 's'.repeat(32);
const bot = 'U' + 'b'.repeat(32);
const group = 'C' + 'd'.repeat(32);
const sign = (body: Buffer) => createHmac('sha256', secret).update(body).digest('base64');

test('webhook forwardUrl validation and configuration persistence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forward-cfg-'));
  try {
    const hook = new MultiWebhook(dir);
    await hook.load();
    await hook.set('family', true, secret);
    assert.equal(hook.status('family').forward_url, undefined);

    // Reject invalid URLs
    await assert.rejects(
      hook.set('family', true, secret, 'invalid-url'),
      /INVALID_FORWARD_URL/
    );
    await assert.rejects(
      hook.set('family', true, secret, 'ftp://ha.local/webhook'),
      /INVALID_FORWARD_URL/
    );
    await assert.rejects(
      hook.set('family', true, secret, 'http://user:pass@ha.local/webhook'),
      /INVALID_FORWARD_URL/
    );

    // Set valid forward URL
    const forwardUrl = 'http://homeassistant:8123/api/webhook/wei-ha7';
    await hook.set('family', true, secret, forwardUrl);
    assert.equal(hook.status('family').forward_url, forwardUrl);

    // Reload from disk and verify persistence
    const reloaded = new MultiWebhook(dir);
    await reloaded.load();
    assert.equal(reloaded.status('family').forward_url, forwardUrl);

    // Clearing forwardUrl with null
    await reloaded.set('family', true, secret, null);
    assert.equal(reloaded.status('family').forward_url, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('transparent forwarder sends 100% non-AI events with exact raw body and signature to HA', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forward-raw-'));
  try {
    const forwardCalls: Array<{ url: string; body: Buffer; headers: Record<string, string> }> = [];
    const mockForwarder = async (url: string, body: Buffer, headers: Record<string, string>): Promise<ForwardResult> => {
      forwardCalls.push({ url, body, headers });
      return { status: 200, ok: true };
    };

    const enqueued: ReceivedEvent[] = [];
    const hook = new MultiWebhook(
      dir,
      events => enqueued.push(...events),
      {
        isAdmitted: () => false, // Non-AI event (e.g. Quick Reply or DM)
        forwarder: mockForwarder
      }
    );
    await hook.load();
    const forwardUrl = 'http://homeassistant:8123/api/webhook/wei-ha7';
    await hook.set('family', true, secret, forwardUrl);

    // Simulate Quick Reply button click from user
    const payload = {
      destination: bot,
      events: [
        {
          webhookEventId: 'qr-event-001',
          type: 'message',
          message: { type: 'text', id: 'm1', text: '高鐵時刻表' },
          source: { type: 'user', userId: 'U11111111111111111111111111111111' },
          replyToken: 'token-abc-123'
        }
      ]
    };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const sig = sign(rawBody);

    const result = await hook.receive(rawBody, sig);
    assert.equal(result.accepted, 1);
    assert.equal(enqueued.length, 1); // recorded in inbox

    // Verify forwarder called with exact raw body and signature
    assert.equal(forwardCalls.length, 1);
    assert.equal(forwardCalls[0]?.url, forwardUrl);
    assert.equal(forwardCalls[0]?.headers['X-Line-Signature'], sig);
    assert.equal(forwardCalls[0]?.headers['Content-Type'], 'application/json');
    assert.deepEqual(forwardCalls[0]?.body, rawBody);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('transparent forwarder intercepts AI mentions and does NOT forward to HA', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forward-ai-'));
  try {
    const forwardCalls: Array<{ url: string; body: Buffer; headers: Record<string, string> }> = [];
    const mockForwarder = async (url: string, body: Buffer, headers: Record<string, string>): Promise<ForwardResult> => {
      forwardCalls.push({ url, body, headers });
      return { status: 200, ok: true };
    };

    const enqueued: ReceivedEvent[] = [];
    const hook = new MultiWebhook(
      dir,
      events => enqueued.push(...events),
      {
        isAdmitted: e => e.account === 'family' && e.source_type === 'group' && e.text?.includes('@bot') === true,
        forwarder: mockForwarder
      }
    );
    await hook.load();
    const forwardUrl = 'http://homeassistant:8123/api/webhook/wei-ha7';
    await hook.set('family', true, secret, forwardUrl);

    // AI mention in group
    const payload = {
      destination: bot,
      events: [
        {
          webhookEventId: 'ai-event-001',
          type: 'message',
          message: { type: 'text', id: 'm2', text: 'hi @bot' },
          source: { type: 'group', groupId: group }
        }
      ]
    };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const sig = sign(rawBody);

    const result = await hook.receive(rawBody, sig);
    assert.equal(result.accepted, 1);
    assert.equal(enqueued.length, 1);

    // Forwarder must NOT be called
    assert.equal(forwardCalls.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('transparent forwarder partitions mixed batch: AI to bridge, non-AI to HA', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forward-mixed-'));
  try {
    const forwardCalls: Array<{ url: string; body: Buffer; headers: Record<string, string> }> = [];
    const mockForwarder = async (url: string, body: Buffer, headers: Record<string, string>): Promise<ForwardResult> => {
      forwardCalls.push({ url, body, headers });
      return { status: 200, ok: true };
    };

    const hook = new MultiWebhook(
      dir,
      () => {},
      {
        isAdmitted: e => e.webhook_event_id === 'event-ai',
        forwarder: mockForwarder
      }
    );
    await hook.load();
    const forwardUrl = 'http://homeassistant:8123/api/webhook/wei-ha7';
    await hook.set('family', true, secret, forwardUrl);

    const payload = {
      destination: bot,
      events: [
        {
          webhookEventId: 'event-ai',
          type: 'message',
          message: { type: 'text', id: 'm1', text: 'ask ai' },
          source: { type: 'group', groupId: group }
        },
        {
          webhookEventId: 'event-user-menu',
          type: 'message',
          message: { type: 'text', id: 'm2', text: '選單' },
          source: { type: 'user', userId: 'U11111111111111111111111111111111' }
        }
      ]
    };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const sig = sign(rawBody);

    const result = await hook.receive(rawBody, sig);
    assert.equal(result.accepted, 2);

    // Forwarder called once with ONLY the non-AI event
    assert.equal(forwardCalls.length, 1);
    const forwardedPacket = JSON.parse(forwardCalls[0]!.body.toString('utf8'));
    assert.equal(forwardedPacket.events.length, 1);
    assert.equal(forwardedPacket.events[0].webhookEventId, 'event-user-menu');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('transparent forwarder propagates failure when upstream HA fails on 100% non-AI packet', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forward-err-'));
  try {
    const mockForwarder = async (): Promise<ForwardResult> => {
      return { status: 502, ok: false };
    };

    const hook = new MultiWebhook(
      dir,
      () => {},
      {
        isAdmitted: () => false,
        forwarder: mockForwarder
      }
    );
    await hook.load();
    const forwardUrl = 'http://homeassistant:8123/api/webhook/wei-ha7';
    await hook.set('family', true, secret, forwardUrl);

    const payload = {
      destination: bot,
      events: [
        {
          webhookEventId: 'err-event-001',
          type: 'message',
          message: { type: 'text', id: 'm1', text: 'test' },
          source: { type: 'user', userId: 'U11111111111111111111111111111111' }
        }
      ]
    };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const sig = sign(rawBody);

    await assert.rejects(
      hook.receive(rawBody, sig),
      /UPSTREAM_FORWARD_FAILED/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
