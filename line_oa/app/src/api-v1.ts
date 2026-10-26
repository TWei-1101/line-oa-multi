import { createHash, randomUUID } from 'node:crypto';
import type { SendResult, SessionState } from './types.js';

export type ApiSessionStatus = 'ready' | 'auth_required' | 'expired' | 'disconnected' | 'error' | 'unknown';
export type ApiSendStatus = 'submitted' | 'confirmed' | 'failed' | 'unknown';

export interface ApiSendResponse {
  request_id: string;
  status: ApiSendStatus;
  message_id: null;
  error?: { code: string; message: string };
}

export function healthResponse(version: string): { status: 'ok'; version: string; api_version: number } {
  return { status: 'ok', version, api_version: 1 };
}

export function mapSessionState(state: SessionState): { sessionStatus: ApiSessionStatus; lineLoggedIn: boolean | null } {
  switch (state) {
    case 'CONNECTED': return { sessionStatus: 'ready', lineLoggedIn: true };
    case 'AUTH_REQUIRED': return { sessionStatus: 'auth_required', lineLoggedIn: false };
    case 'EXPIRED': return { sessionStatus: 'expired', lineLoggedIn: false };
    case 'DISCONNECTED': return { sessionStatus: 'disconnected', lineLoggedIn: null };
    case 'ERROR': return { sessionStatus: 'error', lineLoggedIn: null };
    default: return { sessionStatus: 'unknown', lineLoggedIn: null };
  }
}

export function statusResponse(input: {
  instanceId: string;
  version: string;
  state: SessionState;
  accountName?: string;
  lastError?: string;
  loginRequiredReason?: string;
  now?: Date;
}): Record<string, unknown> {
  const mapped = mapSessionState(input.state);
  const safeError = input.lastError?.replace(/[\r\n]/g, ' ').slice(0, 180) ?? null;
  return {
    instance_id: input.instanceId,
    api_version: 1,
    version: input.version,
    gateway_status: 'online',
    line_logged_in: mapped.lineLoggedIn,
    session_status: mapped.sessionStatus,
    ...(input.loginRequiredReason ? { login_required_reason: input.loginRequiredReason } : {}),
    account_name: input.accountName ?? null,
    last_error: safeError,
    updated_at: (input.now ?? new Date()).toISOString()
  };
}

export function parseRequestId(value: unknown): string {
  if (value === undefined || value === null || value === '') return randomUUID();
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error('INVALID_REQUEST_ID');
  }
  return value.toLowerCase();
}

export function requestFingerprint(parts: Array<string | Buffer>): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    const value = Buffer.isBuffer(part) ? part : Buffer.from(part);
    hash.update(String(value.length)); hash.update('\0'); hash.update(value); hash.update('\0');
  }
  return hash.digest('hex');
}

export function sendResponse(requestId: string, result: SendResult): ApiSendResponse {
  if (result.result === 'SUBMITTED') return { request_id: requestId, status: 'submitted', message_id: null };
  if (result.result === 'CONFIRMED') return { request_id: requestId, status: 'confirmed', message_id: null };
  if (result.result === 'UNKNOWN') return {
    request_id: requestId,
    status: 'unknown',
    message_id: null,
    error: { code: 'SEND_UNKNOWN', message: '發送結果不明，為避免重複訊息不會自動重送' }
  };
  const restricted = result.error === 'RATE_LIMIT' || result.error === 'REJECTED';
  return {
    request_id: requestId,
    status: 'failed',
    message_id: null,
    error: restricted
      ? { code: 'LINE_RESTRICTED', message: 'LINE 拒絕或限制此次發送' }
      : { code: 'SEND_FAILED', message: 'LINE 明確回報發送失敗' }
  };
}

interface RequestEntry<T> { fingerprint: string; expires: number; pending: boolean; promise: Promise<T> }

export class RequestDeduplicator<T> {
  private entries = new Map<string, RequestEntry<T>>();
  constructor(private readonly ttlMs: number, private readonly maxEntries = 256) {}

  async run(requestId: string, fingerprint: string, action: () => Promise<T>): Promise<{ value: T; duplicate: boolean }> {
    this.prune();
    const existing = this.entries.get(requestId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error('REQUEST_ID_CONFLICT');
      return { value: await existing.promise, duplicate: true };
    }
    if (this.entries.size >= this.maxEntries) {
      const settled = [...this.entries].find(([, entry]) => !entry.pending);
      if (!settled) throw new Error('REQUEST_CACHE_FULL');
      this.entries.delete(settled[0]);
    }
    const entry: RequestEntry<T> = { fingerprint, expires: Infinity, pending: true, promise: Promise.resolve().then(action) };
    const finish = () => { entry.pending = false; entry.expires = Date.now() + this.ttlMs; };
    entry.promise.then(finish, finish);
    this.entries.set(requestId, entry);
    const promise = entry.promise;
    return { value: await promise, duplicate: false };
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, value] of this.entries) if (!value.pending && value.expires <= now) this.entries.delete(key);
  }
}
