/**
 * Secure LINE Messaging API webhook ingestion for the multi-account Add-on.
 * No direct public listener: Home Assistant webhook integration forwards the
 * exact request bytes and X-Line-Signature through the authenticated API.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { atomicWriteJson, readJsonSafe } from './storage.js';

const ACCOUNT = /^[a-z][a-z0-9_-]{0,31}$/;
const DEST = /^U[0-9a-f]{32}$/i;
const MAX_INBOX = 2000;
const MAX_EVENTS = 100;
const MAX_BODY = 256 * 1024;

export type HookSettings = { enabled: boolean; channelSecret: string; destination?: string };
type StoredHooks = { version: 1; accounts: Record<string, HookSettings> };
export type ReceivedEvent = {
  sequence: number;
  account: string;
  webhook_event_id: string;
  type: string;
  message_type?: string;
  message_id?: string;
  text?: string;
  source_type?: string;
  user_id?: string;
  group_id?: string;
  room_id?: string;
  timestamp?: number;
  is_redelivery: boolean;
};
type Inbox = { version: 1; nextSequence: number; events: ReceivedEvent[] };
type HookLineEvent = {
  webhookEventId?: unknown;
  type?: unknown;
  timestamp?: unknown;
  deliveryContext?: { isRedelivery?: unknown };
  message?: { type?: unknown; text?: unknown; id?: unknown };
  source?: { type?: unknown; userId?: unknown; groupId?: unknown; roomId?: unknown };
};
const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const validSettings = (x: unknown): x is StoredHooks => isObject(x) && x.version === 1 &&
  isObject(x.accounts) && Object.entries(x.accounts).length <= 20 &&
  Object.entries(x.accounts).every(([id, value]) => ACCOUNT.test(id) && isObject(value) &&
    typeof value.enabled === 'boolean' && typeof value.channelSecret === 'string' &&
    /^[A-Za-z0-9_-]{16,128}$/.test(value.channelSecret) &&
    (value.destination === undefined || (typeof value.destination === 'string' && DEST.test(value.destination))));
const validInbox = (x: unknown): x is Inbox => isObject(x) && x.version === 1 &&
  Number.isSafeInteger(x.nextSequence) && (x.nextSequence as number) > 0 &&
  Array.isArray(x.events) && x.events.length <= MAX_INBOX &&
  x.events.every((v: unknown) => isObject(v) &&
    Number.isSafeInteger(v.sequence) && typeof v.account === 'string' &&
    typeof v.webhook_event_id === 'string' && typeof v.type === 'string');

export class WebhookError extends Error {
  constructor(public readonly code: string, public readonly status: number) {
    super(code);
  }
}

export function verifyLineSignature(secret: string, body: Buffer, signature: string): boolean {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(signature)) return false;
  const claimed = Buffer.from(signature, 'base64');
  const computed = createHmac('sha256', secret).update(body).digest();
  return claimed.length === computed.length && timingSafeEqual(claimed, computed);
}

export class MultiWebhook {
  private settings: StoredHooks = { version: 1, accounts: {} };
  private inbox: Inbox = { version: 1, nextSequence: 1, events: [] };
  private pending: Promise<void> = Promise.resolve();
  constructor(private readonly dataDir: string,
    private readonly enqueue?: (events: ReceivedEvent[]) => void) {}
  async load(): Promise<void> {
    const a = await readJsonSafe<StoredHooks>(join(this.dataDir, 'webhook-settings.json'),
      { version: 1, accounts: {} }, validSettings);
    const b = await readJsonSafe<Inbox>(join(this.dataDir, 'webhook-inbox.json'),
      { version: 1, nextSequence: 1, events: [] }, validInbox);
    if (a.warning || b.warning) throw new Error('WEBHOOK_DATA_CORRUPT_RESTORE_BACKUP');
    this.settings = a.value;
    this.inbox = b.value;
  }
  status(account: string): { account: string; enabled: boolean; configured: boolean } {
    const settings = this.settings.accounts[account];
    return { account, enabled: !!settings?.enabled, configured: !!settings?.channelSecret };
  }
  private async serialized<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.pending;
    let release!: () => void;
    this.pending = new Promise<void>(resolve => { release = resolve; });
    await prev;
    try { return await fn(); }
    finally { release(); }
  }
  async set(account: string, enabled: boolean, secret?: string): Promise<void> {
    if (!ACCOUNT.test(account)) throw new WebhookError('INVALID_ACCOUNT', 400);
    if (typeof enabled !== 'boolean') throw new WebhookError('INVALID_WEBHOOK_SETTINGS', 400);
    if (secret !== undefined && !/^[A-Za-z0-9_-]{16,128}$/.test(secret))
      throw new WebhookError('INVALID_CHANNEL_SECRET', 400);
    await this.serialized(async () => {
      const old = this.settings.accounts[account];
      const channelSecret = secret ?? old?.channelSecret;
      if (!channelSecret) throw new WebhookError('CHANNEL_SECRET_REQUIRED', 400);
      if (Object.entries(this.settings.accounts).some(([id, cfg]) => id !== account && cfg.channelSecret === channelSecret))
        throw new WebhookError('CHANNEL_SECRET_ALREADY_USED', 409);
      // A replaced Channel Secret represents a potentially different
      // Messaging API channel, so its previously learned destination must not
      // carry over. Enable/disable operations preserve the binding.
      const destination = old && (secret === undefined || secret === old.channelSecret)
        ? old.destination : undefined;
      const next = { version: 1 as const, accounts: {
        ...this.settings.accounts,
        [account]: { enabled, channelSecret, ...(destination ? { destination } : {}) }
      } };
      await atomicWriteJson(join(this.dataDir, 'webhook-settings.json'), next, 0o600);
      this.settings = next;
    });
  }
  async remove(account: string): Promise<void> {
    await this.serialized(async () => {
      const nextInbox: Inbox = { ...this.inbox, events: this.inbox.events.filter(e => e.account !== account) };
      await atomicWriteJson(join(this.dataDir, 'webhook-inbox.json'), nextInbox, 0o600);
      this.inbox = nextInbox;
      const accounts = { ...this.settings.accounts };
      delete accounts[account];
      const next: StoredHooks = { version: 1, accounts };
      await atomicWriteJson(join(this.dataDir, 'webhook-settings.json'), next, 0o600);
      this.settings = next;
    });
  }
  async receive(rawBody: Buffer, signature: string): Promise<{accepted: number; duplicates: number}> {
    if (rawBody.length > MAX_BODY) throw new WebhookError('WEBHOOK_TOO_LARGE', 413);
    return this.serialized(async () => {
      // Verify original bytes before parsing. Never trust the inbound destination
      // to select an account or bypass its own Channel Secret.
      const candidates = Object.entries(this.settings.accounts)
        .filter(([, v]) => v.enabled && verifyLineSignature(v.channelSecret, rawBody, signature));
      if (candidates.length !== 1) throw new WebhookError('INVALID_LINE_SIGNATURE', 401);
      const [account, settings] = candidates[0]!;
      let packet: unknown;
      try { packet = JSON.parse(rawBody.toString('utf8')); }
      catch { throw new WebhookError('INVALID_LINE_BODY', 400); }
      if (!isObject(packet) || typeof packet.destination !== 'string' || !DEST.test(packet.destination)
          || (settings.destination !== undefined && packet.destination !== settings.destination))
        throw new WebhookError('LINE_DESTINATION_MISMATCH', 403);
      if (!Array.isArray(packet.events) || packet.events.length > MAX_EVENTS)
        throw new WebhookError('INVALID_LINE_EVENTS', 400);
      const next: Inbox = { version: 1, nextSequence: this.inbox.nextSequence, events: [...this.inbox.events] };
      const known = new Set(next.events.map(v => `${v.account}:${v.webhook_event_id}`));
      let accepted = 0, duplicates = 0;
      const fresh: ReceivedEvent[] = [];
      for (const value of packet.events) {
        if (!isObject(value)) throw new WebhookError('INVALID_LINE_EVENTS', 400);
        const e = value as HookLineEvent;
        if (typeof e.webhookEventId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(e.webhookEventId)
            || typeof e.type !== 'string' || e.type.length > 64)
          throw new WebhookError('INVALID_LINE_EVENTS', 400);
        const key = `${account}:${e.webhookEventId}`;
        if (known.has(key)) { duplicates++; continue; }
        known.add(key);
        const src = e.source;
        const msg = e.message;
        const received: ReceivedEvent = {
          sequence: next.nextSequence++, account, webhook_event_id: e.webhookEventId,
          type: e.type,
          ...(typeof msg?.type === 'string' ? {message_type: msg.type.slice(0,32)} : {}),
          ...(typeof msg?.id === 'string' && /^[0-9]{1,64}$/.test(msg.id) ? {message_id:msg.id} : {}),
          ...(msg?.type === 'text' && typeof msg.text === 'string' ? {text: msg.text.slice(0,5000)} : {}),
          ...(typeof src?.type === 'string' ? {source_type:src.type.slice(0,32)} : {}),
          ...(typeof src?.userId === 'string' ? {user_id:src.userId.slice(0,128)} : {}),
          ...(typeof src?.groupId === 'string' ? {group_id:src.groupId.slice(0,128)} : {}),
          ...(typeof src?.roomId === 'string' ? {room_id:src.roomId.slice(0,128)} : {}),
          ...(typeof e.timestamp === 'number' && Number.isSafeInteger(e.timestamp) ? {timestamp:e.timestamp} : {}),
          is_redelivery: e.deliveryContext?.isRedelivery === true
        };
        next.events.push(received);
        fresh.push(received);
        accepted++;
      }
      // The Channel Secret authenticates the LINE channel. Bind its signed
      // destination on first contact, then reject any later destination drift.
      // The unofficial OA Manager session ID is intentionally not used here:
      // live LINE accounts have shown that it is not always the Messaging API
      // bot user ID.
      if (settings.destination === undefined) {
        const nextSettings: StoredHooks = { version: 1, accounts: {
          ...this.settings.accounts,
          [account]: { ...settings, destination: packet.destination }
        } };
        await atomicWriteJson(join(this.dataDir, 'webhook-settings.json'), nextSettings, 0o600);
        this.settings = nextSettings;
      }
      // Durable enqueue before returning 2xx. Bounded inbox stores last 2000.
      if (accepted) {
        // Bridge commits first. If the inbox write then fails, LINE can retry:
        // the bridge's durable event IDs prevent a second enqueue/send.
        this.enqueue?.(fresh);
        next.events = next.events.slice(-MAX_INBOX);
        await atomicWriteJson(join(this.dataDir, 'webhook-inbox.json'), next, 0o600);
        this.inbox = next;
      }
      return {accepted, duplicates};
    });
  }
  recentSources(account: string): Array<{source_type: string; source_id: string}> {
    const result = new Map<string,{source_type:string;source_id:string}>();
    for (const e of this.inbox.events.filter(e=>e.account===account).slice(-100).reverse()) {
      const id=e.source_type==='group'?e.group_id:e.source_type==='room'?e.room_id:e.user_id;
      if (id && e.source_type) result.set(`${e.source_type}:${id}`,{source_type:e.source_type,source_id:id});
    }
    return [...result.values()];
  }
  events(after: number): {events: ReceivedEvent[]; last_sequence: number; oldest_sequence: number} {
    if (!Number.isSafeInteger(after) || after < 0) throw new WebhookError('INVALID_CURSOR',400);
    return {events: this.inbox.events.filter(x=>x.sequence>after).slice(0,100),
      last_sequence:this.inbox.nextSequence-1,
      oldest_sequence:this.inbox.events[0]?.sequence ?? this.inbox.nextSequence};
  }
}
