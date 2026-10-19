import { join } from 'node:path';
import type { SessionCredentials, SessionState } from './types.js';
import { atomicWriteJson, readJsonSafe } from './storage.js';
import { MemoryCookieJar, validLoginCookies } from './cookie-jar.js';

export function validSession(value: unknown): value is SessionCredentials {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<SessionCredentials>;
  const allowed = new Set(['ses', '__Host-chat-ses', 'XSRF-TOKEN']);
  const cookiesValid = Array.isArray(v.cookies) && v.cookies.some(c => c.name === '__Host-chat-ses') &&
    v.cookies.every(c => allowed.has(c.name) && typeof c.value === 'string' && !!c.value && !/[\r\n;]/.test(c.value)) &&
    new Set(v.cookies.map(c => c.name)).size === v.cookies.length;
  return v.version === 1 && /^U[0-9a-f]{32}$/.test(v.botId ?? '') && cookiesValid &&
    (v.loginCookies === undefined || validLoginCookies(v.loginCookies)) &&
    typeof v.importedAt === 'string' && Number.isFinite(Date.parse(v.importedAt)) &&
    (v.csrfToken === undefined || (typeof v.csrfToken === 'string' && !!v.csrfToken && !/[\r\n;]/.test(v.csrfToken))) &&
    (v.clientVersion === undefined || (typeof v.clientVersion === 'string' && v.clientVersion.length <= 100 && !/[\r\n]/.test(v.clientVersion)));
}

export class SessionManager {
  private credentials?: SessionCredentials;
  private generation = 0;
  private cookieUpdates: Promise<void> = Promise.resolve();
  private state: SessionState = 'AUTH_REQUIRED';
  private authRequiredReason: 'not_logged_in' | 'logged_out' = 'not_logged_in';
  private reason = '尚未登入 LINE，請先登入';
  private lastValidatedAt?: string;
  private readonly path: string;

  constructor(dataDir: string) { this.path = join(dataDir, 'secrets', 'line-session.json'); }

  async load(): Promise<void> {
    const loaded = await readJsonSafe<SessionCredentials | null>(this.path, null, (v): v is SessionCredentials | null => v === null || validSession(v));
    if (loaded.value) {
      this.credentials = loaded.value;
      this.state = 'VALIDATING';
      this.reason = 'Session 已載入，正在確認 LINE 連線';
    } else if (loaded.warning) {
      this.state = 'ERROR';
      this.reason = 'Session 檔案格式無效，請重新登入';
    }
  }

  getCredentials(): SessionCredentials | undefined { return this.credentials; }
  getStatus(): { state: SessionState; reason: string; loginRequiredReason?: 'expired' | 'not_logged_in' | 'logged_out'; lastValidatedAt?: string; lastLoginAt?: string; loginAgeDays?: number; accountName?: string; botIdConfigured: boolean } {
    const lastLoginAt = this.credentials?.importedAt;
    const loginAgeDays = lastLoginAt ? Math.max(0, Math.floor((Date.now() - Date.parse(lastLoginAt)) / 86_400_000)) : undefined;
    const loginRequiredReason = this.state === 'EXPIRED' ? 'expired' : this.state === 'AUTH_REQUIRED' ? this.authRequiredReason : undefined;
    return { state: this.state, reason: this.reason, loginRequiredReason, lastValidatedAt: this.lastValidatedAt, lastLoginAt, loginAgeDays, accountName: this.credentials?.accountName, botIdConfigured: !!this.credentials };
  }

  mark(state: SessionState, reason: string): void {
    if (!this.credentials) return;
    this.state = state;
    this.reason = reason;
    if (state === 'CONNECTED') this.lastValidatedAt = new Date().toISOString();
  }

  async logout(): Promise<void> {
    ++this.generation;
    this.credentials = undefined;
    this.state = 'AUTH_REQUIRED';
    this.authRequiredReason = 'logged_out';
    this.reason = '已登出 LINE，請重新登入';
    this.lastValidatedAt = undefined;
    // Queue a tombstone after pending writes so no older import/refresh can restore credentials.
    await atomicWriteJson(this.path, null, 0o600);
  }

  async updateCsrf(token: string, expected?: SessionCredentials): Promise<void> {
    if (!this.credentials || (expected && expected !== this.credentials)) throw new Error('SESSION_CHANGED');
    this.credentials.csrfToken = token;
    const cookie = this.credentials.cookies.find(c => c.name === 'XSRF-TOKEN');
    if (cookie) cookie.value = token;
    else this.credentials.cookies.push({ name: 'XSRF-TOKEN', value: token });
    await atomicWriteJson(this.path, this.credentials, 0o600);
  }

  async renewCredentials(next: SessionCredentials, expected: SessionCredentials): Promise<void> {
    const generation = this.generation;
    const update = this.cookieUpdates.then(() => this.commitRenewal(next, expected, generation));
    this.cookieUpdates = update.catch(() => undefined);
    return update;
  }

  private async commitRenewal(next: SessionCredentials, expected: SessionCredentials, generation: number): Promise<void> {
    if (this.credentials !== expected || next.botId !== expected.botId) throw new Error('SESSION_CHANGED');
    if (generation !== this.generation) throw new Error('SESSION_CHANGED');
    if (!validSession(next)) throw new Error('INVALID_SESSION');
    await atomicWriteJson(this.path, next, 0o600);
    if (generation !== this.generation || this.credentials !== expected) throw new Error('SESSION_CHANGED');
    // Keep the identity used by pending validation/logout guards.
    Object.assign(expected, structuredClone(next));
    ++this.generation;
  }

  async updateCookies(headers: string[], expected: SessionCredentials, sentCookie?: string): Promise<void> {
    const update = this.cookieUpdates.then(async () => {
      if (!headers.length || this.credentials !== expected || (sentCookie !== undefined &&
        sentCookie !== expected.cookies.map(c => `${c.name}=${c.value}`).join('; '))) return;
      const jar = this.cookieJar(expected);
      const url = new URL('https://chat.line.biz/');
      for (const header of headers) jar.set(url, header);
      const cookies = (['ses', '__Host-chat-ses', 'XSRF-TOKEN'] as const).flatMap(name => {
        const value = jar.value(name, url);
        return value ? [{ name, value }] : [];
      });
      // A clearing response must not destroy the last recoverable authentication state.
      if (!cookies.some(c => c.name === '__Host-chat-ses')) return;
      await this.commitRenewal({ ...expected, cookies, loginCookies: jar.snapshot() }, expected, this.generation);
    });
    this.cookieUpdates = update.catch(() => undefined);
    return update;
  }

  cookieJar(credentials: SessionCredentials): MemoryCookieJar {
    const jar = new MemoryCookieJar();
    jar.restore(credentials.loginCookies ?? []);
    const url = new URL('https://chat.line.biz/');
    for (const c of credentials.cookies) {
      if (jar.value(c.name, url) !== c.value) jar.set(url, `${c.name}=${c.value}; Path=/; Secure${c.name === 'ses' ? '; Domain=line.biz' : ''}`);
    }
    return jar;
  }

  async importCredentials(credentials: SessionCredentials): Promise<void> {
    if (!validSession(credentials)) throw new Error('INVALID_SESSION');
    const generation = ++this.generation;
    await atomicWriteJson(this.path, credentials, 0o600);
    if (generation !== this.generation) throw new Error('SESSION_CHANGED');
    this.credentials = structuredClone(credentials);
    this.state = 'VALIDATING';
    this.reason = 'QR 登入完成，正在驗證 Session';
    this.lastValidatedAt = undefined;
  }
}
