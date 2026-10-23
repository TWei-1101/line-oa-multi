import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHmac } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { OpenClawBridge } from '../src/openclaw.js';
import { MultiWebhook, type ReceivedEvent } from '../src/webhook.js';

const destination = 'U' + 'a'.repeat(32);
const group = 'C' + 'b'.repeat(32);
const otherGroup = 'C' + 'c'.repeat(32);
const senderA = 'U' + 'd'.repeat(32);
const senderB = 'U' + 'e'.repeat(32);
const secret = 'x'.repeat(32);
const endpoint = { mode: 'override' as const, url: 'http://family.local/v1/responses', token: 'family-token', agent: 'family-line', timeout_seconds: 30, protocol: 'family-text-v1' as const };

function familyEvent(id: string, text: string, userId?: string, groupId = group, mention = false): ReceivedEvent {
  return { sequence: 1, account: 'family', webhook_event_id: id, type: 'message', message_type: 'text', text, source_type: 'group', group_id: groupId, ...(userId === undefined ? {} : { user_id: userId }), destination, is_redelivery: false, ...(mention ? { mentions: [{ index: 0, length: 4, type: 'user', isSelf: true }] } : {}) };
}

async function fixture() {
  const root = await mkdtemp(tmpdir() + '/family-followup-');
  let now = 0;
  const deps = {
    boundDestination: () => destination,
    hasAlias: () => true,
    sender: () => ({ send: async () => ({ result: 'SUBMITTED' as const, sendId: 'test' }), sendImage: async () => ({ result: 'SUBMITTED' as const, sendId: 'test' }) }),
    now: () => now,
  };
  let bridge = new OpenClawBridge(root, deps);
  await bridge.load();
  bridge.configure({ enabled: true, channel_access_token: 'line-token', expected_destination: destination, admission: 'keyword-or-followup', endpoint, routes: [
    { source_type: 'group', source_id: group, who: 'family' },
    { source_type: 'group', source_id: otherGroup, who: 'family' },
  ] }, 'family');
  return { root, get bridge() { return bridge; }, setNow(value: number) { now = value; }, async restart() { await bridge.stop(); bridge = new OpenClawBridge(root, deps); await bridge.load(); }, async close() { await bridge.stop(); await rm(root, { recursive: true, force: true }); } };
}

test('followup windows are side-effect-free, per sender and group, and expire from fake time zero', async () => {
  const f = await fixture();
  try {
    const wakeA = familyEvent('followup-wake-a', '@bot help', senderA, group, true);
    const aFollowup = familyEvent('followup-a-followup', 'what about tomorrow?', senderA);
    const bFollowup = familyEvent('followup-b-followup', 'what about tomorrow?', senderB);
    const otherGroupFollowup = familyEvent('followup-other-group', 'what about tomorrow?', senderA, otherGroup);

    assert.equal(f.bridge.isAdmitted(wakeA), true);
    assert.equal(f.bridge.isAdmitted(aFollowup), false, 'admission predicate must not open the window');
    f.bridge.enqueue([wakeA]);
    assert.equal(f.bridge.isAdmitted(aFollowup), true);
    assert.equal(f.bridge.isAdmitted(bFollowup), false, 'B must not borrow A window');
    assert.equal(f.bridge.isAdmitted(otherGroupFollowup), false, 'another group must not borrow A window');

    const wakeB = familyEvent('followup-wake-b', '喵 help', senderB);
    assert.equal(f.bridge.isAdmitted(wakeB), true);
    f.bridge.enqueue([wakeB]);
    assert.equal(f.bridge.isAdmitted(bFollowup), true, 'B can independently open a window');

    f.setNow(179_000);
    f.bridge.enqueue([{ ...wakeA, is_redelivery: true }]);
    f.setNow(180_000);
    assert.equal(f.bridge.isAdmitted(aFollowup), false, 'deduplicated redelivery must not extend the window');
    assert.equal(f.bridge.isAdmitted(bFollowup), false, 'the three-minute expiry must work when activity began at fake time zero');
  } finally {
    await f.close();
  }
});

test('missing or malformed group sender cannot open or borrow a followup window', async () => {
  const f = await fixture();
  try {
    const validWake = familyEvent('followup-valid-sender-wake', '@bot help', senderA, group, true);
    const noSenderWake = familyEvent('followup-no-sender-wake', '@bot help', undefined, group, true);
    const noSenderFollowup = familyEvent('followup-no-sender-followup', 'ordinary message');
    const badSenderWake = familyEvent('followup-bad-sender-wake', '喵 help', 'not-a-line-user');
    const badSenderFollowup = familyEvent('followup-bad-sender-followup', 'ordinary message', 'not-a-line-user');

    f.bridge.enqueue([validWake]);
    assert.equal(f.bridge.isAdmitted(noSenderFollowup), false, 'missing sender cannot borrow A window');
    assert.equal(f.bridge.isAdmitted(badSenderFollowup), false, 'malformed sender cannot borrow A window');
    assert.equal(f.bridge.isAdmitted(noSenderWake), true, 'explicit mention still works without sender metadata');
    f.bridge.enqueue([noSenderWake]);
    assert.equal(f.bridge.isAdmitted(noSenderFollowup), false);
    assert.equal(f.bridge.isAdmitted(badSenderWake), true, 'explicit keyword still works with malformed sender metadata');
    f.bridge.enqueue([badSenderWake]);
    assert.equal(f.bridge.isAdmitted(badSenderFollowup), false);
  } finally {
    await f.close();
  }
});

test('webhook callback preserves a valid group sender and drops malformed sender metadata', async () => {
  const root = await mkdtemp(tmpdir() + '/family-sender-webhook-');
  try {
    const forwarded: ReceivedEvent[] = [];
    const hook = new MultiWebhook(root, events => forwarded.push(...events));
    await hook.load();
    await hook.set('family', true, secret);
    const packet = { destination, events: [
      { webhookEventId: 'sender-valid-1', type: 'message', source: { type: 'group', groupId: group, userId: senderA }, message: { type: 'text', text: '喵 help' } },
      { webhookEventId: 'sender-bad-02', type: 'message', source: { type: 'group', groupId: group, userId: 'not-a-line-user' }, message: { type: 'text', text: '喵 help' } },
    ] };
    const raw = Buffer.from(JSON.stringify(packet));
    await hook.receive(raw, createHmac('sha256', secret).update(raw).digest('base64'));
    assert.equal(forwarded[0]?.user_id, senderA);
    assert.equal(forwarded[1]?.user_id, undefined);
    assert.equal(hook.events(0).events[0]?.user_id, senderA);
    assert.equal(hook.events(0).events[1]?.user_id, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test('production callback routes same-batch A followup to bridge and B ordinary text to HA once', async () => {
  const f = await fixture();
  try {
    const forwarded: Buffer[] = [];
    const hook = new MultiWebhook(f.root, events => f.bridge.enqueue(events), {
      isAdmitted: event => f.bridge.isAdmitted(event),
      forwarder: async (_url, body) => { forwarded.push(body); return { status: 200, ok: true }; }
    });
    await hook.load();
    await hook.set('family', true, secret, 'http://homeassistant:8123/api/webhook/family');
    const packet = { destination, events: [
      { webhookEventId: 'batch-wake-a', type: 'message', source: { type: 'group', groupId: group, userId: senderA }, message: { type: 'text', text: '@bot help', mention: { mentionees: [{ index: 0, length: 4, type: 'user', isSelf: true }] } } },
      { webhookEventId: 'batch-followup-a', type: 'message', source: { type: 'group', groupId: group, userId: senderA }, message: { type: 'text', text: 'what about tomorrow?' } },
      { webhookEventId: 'batch-ordinary-b', type: 'message', source: { type: 'group', groupId: group, userId: senderB }, message: { type: 'text', text: 'ordinary group chat' } },
    ] };
    const raw = Buffer.from(JSON.stringify(packet));
    await hook.receive(raw, createHmac('sha256', secret).update(raw).digest('base64'));

    assert.equal(f.bridge.status('family').jobs.length, 2, 'A wake and A same-batch followup queue exactly once');
    assert.equal(forwarded.length, 1, 'B ordinary text forwards exactly once');
    assert.deepEqual(JSON.parse(forwarded[0]!.toString('utf8')).events.map((event: { webhookEventId: string }) => event.webhookEventId), ['batch-ordinary-b']);
  } finally {
    await f.close();
  }
});

test('rolled-back batch never publishes a followup window', async () => {
  const f = await fixture();
  try {
    const hook = new MultiWebhook(f.root, events => f.bridge.enqueue(events), { isAdmitted: event => f.bridge.isAdmitted(event) });
    await hook.load();
    await hook.set('family', true, secret);
    const db = new DatabaseSync(join(f.root, 'openclaw.sqlite'));
    db.exec("CREATE TRIGGER fail_followup_job BEFORE INSERT ON jobs BEGIN SELECT RAISE(ABORT, 'test rollback'); END");
    db.close();
    const packet = { destination, events: [{ webhookEventId: 'rollback-wake-a', type: 'message', source: { type: 'group', groupId: group, userId: senderA }, message: { type: 'text', text: '@bot help', mention: { mentionees: [{ index: 0, length: 4, type: 'user', isSelf: true }] } } }] };
    const raw = Buffer.from(JSON.stringify(packet));
    await assert.rejects(hook.receive(raw, createHmac('sha256', secret).update(raw).digest('base64')));
    const cleanup = new DatabaseSync(join(f.root, 'openclaw.sqlite'));
    cleanup.exec('DROP TRIGGER fail_followup_job');
    cleanup.close();
    assert.equal(f.bridge.isAdmitted(familyEvent('rollback-followup-a', 'ordinary message', senderA)), false);
  } finally {
    await f.close();
  }
});

test('expired duplicate AI followup stays bridge-owned after restart while a fresh B message reaches HA', async () => {
  const f = await fixture();
  try {
    const wire = (forwarded: Buffer[]) => new MultiWebhook(f.root, events => f.bridge.enqueue(events), {
      isAdmitted: event => f.bridge.isAdmitted(event),
      ownsEvent: (account, webhookEventId) => f.bridge.ownsEvent(account, webhookEventId),
      forwarder: async (_url, body) => { forwarded.push(body); return { status: 200, ok: true }; }
    });
    const firstForwarded: Buffer[] = [];
    const first = wire(firstForwarded);
    await first.load();
    await first.set('family', true, secret, 'http://homeassistant:8123/api/webhook/family');
    const wakeAndFollowup = { destination, events: [
      { webhookEventId: 'durable-wake-a', type: 'message', source: { type: 'group', groupId: group, userId: senderA }, message: { type: 'text', text: '@bot help', mention: { mentionees: [{ index: 0, length: 4, type: 'user', isSelf: true }] } } },
      { webhookEventId: 'durable-followup-a', type: 'message', source: { type: 'group', groupId: group, userId: senderA }, message: { type: 'text', text: 'what about tomorrow?' } },
    ] };
    const firstRaw = Buffer.from(JSON.stringify(wakeAndFollowup));
    await first.receive(firstRaw, createHmac('sha256', secret).update(firstRaw).digest('base64'));
    assert.equal(f.bridge.status('family').jobs.length, 2);

    await f.restart();
    f.setNow(180_000);
    const forwarded: Buffer[] = [];
    const retry = wire(forwarded);
    await retry.load();
    const duplicateOnly = { destination, events: [wakeAndFollowup.events[1]] };
    const duplicateRaw = Buffer.from(JSON.stringify(duplicateOnly));
    const duplicateResult = await retry.receive(duplicateRaw, createHmac('sha256', secret).update(duplicateRaw).digest('base64'));
    assert.deepEqual(duplicateResult, { accepted: 0, duplicates: 1 });
    assert.equal(f.bridge.status('family').jobs.length, 2);
    assert.equal(forwarded.length, 0, 'expired duplicate AI followup must not fall through to HA');

    const mixed = { destination, events: [
      wakeAndFollowup.events[1],
      { webhookEventId: 'durable-fresh-b', type: 'message', source: { type: 'group', groupId: group, userId: senderB }, message: { type: 'text', text: 'ordinary group chat' } },
    ] };
    const mixedRaw = Buffer.from(JSON.stringify(mixed));
    const mixedResult = await retry.receive(mixedRaw, createHmac('sha256', secret).update(mixedRaw).digest('base64'));
    assert.deepEqual(mixedResult, { accepted: 1, duplicates: 1 });
    assert.equal(forwarded.length, 1);
    assert.deepEqual(JSON.parse(forwarded[0]!.toString('utf8')).events.map((event: { webhookEventId: string }) => event.webhookEventId), ['durable-fresh-b']);
  } finally {
    await f.close();
  }
});

test('duplicate non-AI event remains forwardable after HA failure', async () => {
  const f = await fixture();
  try {
    let fail = true;
    let calls = 0;
    const hook = new MultiWebhook(f.root, events => f.bridge.enqueue(events), {
      isAdmitted: event => f.bridge.isAdmitted(event),
      forwarder: async () => { calls++; return fail ? { status: 502, ok: false } : { status: 200, ok: true }; }
    });
    await hook.load();
    await hook.set('family', true, secret, 'http://homeassistant:8123/api/webhook/family');
    const packet = { destination, events: [{ webhookEventId: 'ha-retry-b', type: 'message', source: { type: 'group', groupId: group, userId: senderB }, message: { type: 'text', text: 'ordinary group chat' } }] };
    const raw = Buffer.from(JSON.stringify(packet));
    const signature = createHmac('sha256', secret).update(raw).digest('base64');
    await assert.rejects(hook.receive(raw, signature), /UPSTREAM_FORWARD_FAILED/);
    fail = false;
    assert.deepEqual(await hook.receive(raw, signature), { accepted: 0, duplicates: 1 });
    assert.equal(calls, 2);
  } finally {
    await f.close();
  }
});


test('durable ownership survives actual 2000-event inbox eviction without refreshing followup', async () => {
  const f = await fixture();
  try {
    const forwarded: Buffer[] = [];
    let fail = false;
    const wire = () => new MultiWebhook(f.root, events => f.bridge.enqueue(events), {
      isAdmitted: event => f.bridge.isAdmitted(event),
      ownsEvent: (account, id) => f.bridge.ownsEvent(account, id),
      forwarder: async (_url, body) => { forwarded.push(body); return { status: fail ? 502 : 200, ok: !fail }; }
    });
    let hook = wire();
    await hook.load();
    await hook.set('family', true, secret, 'http://homeassistant:8123/api/webhook/family');
    const event = (id: string, text: string, userId: string) => ({ webhookEventId: id, type: 'message', source: { type: 'group', groupId: group, userId }, message: { type: 'text', text } });
    const send = async (events: (ReturnType<typeof event> & { deliveryContext?: { isRedelivery: boolean } })[]) => {
      const raw = Buffer.from(JSON.stringify({ destination, events }));
      return hook.receive(raw, createHmac('sha256', secret).update(raw).digest('base64'));
    };
    const wake = event('eviction-wake-a', '喵 help', senderA);
    const followup = event('eviction-followup-a', 'what about tomorrow?', senderA);
    await send([wake, followup]);
    assert.equal(f.bridge.status('family').jobs.length, 2);
    // Exercise real bounded inbox writes, not a fabricated inbox fixture.
    for (let batch = 0; batch < 20; batch++) {
      await send(Array.from({ length: 100 }, (_, i) => event('eviction-filler-' + (batch * 100 + i), 'ordinary chat', senderB)));
    }
    assert.equal(hook.events(0).oldest_sequence, 3, 'both original A events were actually evicted');
    assert.equal(f.bridge.ownsEvent('family', followup.webhookEventId), true);
    await f.restart();
    f.setNow(180_000);
    hook = wire();
    await hook.load();
    forwarded.length = 0;
    const redelivery = { ...followup, deliveryContext: { isRedelivery: true } };
    assert.deepEqual(await send([redelivery]), { accepted: 1, duplicates: 0 });
    assert.equal(forwarded.length, 0, 'inbox-fresh but bridge-owned expired followup must never reach HA');
    assert.equal(f.bridge.status('family').jobs.length, 2, 'redelivery must not create another job');
    assert.equal(f.bridge.isAdmitted(familyEvent('eviction-new-a', 'ordinary message', senderA)), false, 'redelivery must not refresh A window');
    await send([{ ...wake, deliveryContext: { isRedelivery: true } }, event('eviction-fresh-b', 'ordinary chat', senderB)]);
    assert.equal(forwarded.length, 1);
    assert.deepEqual(JSON.parse(forwarded[0]!.toString()).events.map((e: { webhookEventId: string }) => e.webhookEventId), ['eviction-fresh-b']);
    assert.equal(f.bridge.status('family').jobs.length, 2);
    assert.equal(f.bridge.isAdmitted(familyEvent('eviction-newer-a', 'ordinary message', senderA)), false, 'evicted wake redelivery must not refresh A window');
    const retryB = event('eviction-retry-b', 'ordinary chat', senderB);
    fail = true;
    await assert.rejects(send([retryB]), /UPSTREAM_FORWARD_FAILED/);
    fail = false;
    assert.deepEqual(await send([retryB]), { accepted: 0, duplicates: 1 });
    assert.equal(forwarded.length, 3, 'non-AI B remains retryable with durable ownership enabled');
  } finally {
    await f.close();
  }
});
