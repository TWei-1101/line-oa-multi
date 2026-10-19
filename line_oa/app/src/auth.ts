import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { unlink, open } from 'node:fs/promises';
import { atomicWriteJson, ensurePrivateDir, readJsonSafe } from './storage.js';

const scrypt = promisify(scryptCallback);
type PasswordRecord = { version: 1; salt: string; hash: string };
type ApiRecord = { version: 1; hash: string } | { version: 2; hash: string; createdAt: string };

function validPassword(value: unknown): value is PasswordRecord {
  const v = value as Partial<PasswordRecord> | null;
  return !!v && v.version === 1 && /^[a-f0-9]{32}$/.test(v.salt ?? '') && /^[a-f0-9]{64}$/.test(v.hash ?? '');
}
function validApi(value: unknown): value is ApiRecord {
  const v = value as Partial<ApiRecord> | null;
  return !!v && (v.version === 1 || (v.version === 2 && typeof v.createdAt === 'string' && Number.isFinite(Date.parse(v.createdAt)))) &&
    /^[a-f0-9]{64}$/.test(v.hash ?? '');
}

export class AuthManager {
  private password?: PasswordRecord;
  private api?: ApiRecord;
  private sessions = new Map<string, { csrf: string; expires: number }>();
  private failures = new Map<string, number[]>();
  constructor(private readonly dataDir: string, private readonly secureCookies: boolean, private readonly cookiePath = '/') {}

  async load(): Promise<void> {
    this.password = (await readJsonSafe<PasswordRecord | null>(join(this.dataDir, 'secrets', 'admin-password.json'), null, (v): v is PasswordRecord | null => v === null || validPassword(v))).value ?? undefined;
    const loaded = await readJsonSafe<ApiRecord | null>(join(this.dataDir, 'secrets', 'api-key.json'), null, (v): v is ApiRecord | null => v === null || validApi(v));
    if (loaded.warning) throw new Error('API_CREDENTIAL_CORRUPT_RESTORE_BACKUP');
    this.api = loaded.value ?? undefined;
  }
  setupRequired(): boolean { return !this.password; }
  apiKeyConfigured(): boolean { return !!this.api; }
  apiKeyInfo(): { configured: boolean; createdAt?: string } {
    return { configured: !!this.api, ...(this.api?.version === 2 ? { createdAt: this.api.createdAt } : {}) };
  }

  async generateApiKey(): Promise<{ apiKey: string; createdAt: string }> {
    const apiKey = `loagw_${randomBytes(32).toString('base64url')}`;
    const createdAt = new Date().toISOString();
    const record: ApiRecord = { version: 2, hash: createHash('sha256').update(apiKey).digest('hex'), createdAt };
    await atomicWriteJson(join(this.dataDir, 'secrets', 'api-key.json'), record, 0o600);
    this.api = record;
    return { apiKey, createdAt };
  }

  async revokeApiKey(): Promise<void> {
    await unlink(join(this.dataDir, 'secrets', 'api-key.json')).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
    await ensurePrivateDir(join(this.dataDir, 'secrets'));
    const directory = await open(join(this.dataDir, 'secrets'), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
    this.api = undefined;
  }

  anonymousSession(): { cookie: string; csrf: string } {
    this.prune();
    const token = randomBytes(32).toString('base64url');
    const csrf = randomBytes(24).toString('base64url');
    this.sessions.set(token, { csrf, expires: Date.now() + 8 * 60 * 60_000 });
    const secure = this.secureCookies ? '; Secure' : '';
    return { cookie: `loagw_session=${token}; Path=${this.cookiePath}; HttpOnly; SameSite=Strict; Max-Age=28800${secure}`, csrf };
  }

  private prune(): void {
    const now = Date.now();
    for (const [token, session] of this.sessions) if (session.expires < now) this.sessions.delete(token);
  }

  async login(password: string, address: string): Promise<{ cookie: string; csrf: string }> {
    if (!this.password) throw new Error('SETUP_REQUIRED');
    const now = Date.now();
    const failures = (this.failures.get(address) ?? []).filter(at => now - at < 15 * 60_000);
    if (failures.length >= 5) throw new Error('LOGIN_RATE_LIMITED');
    const actual = await scrypt(password, Buffer.from(this.password.salt, 'hex'), 32) as Buffer;
    const expected = Buffer.from(this.password.hash, 'hex');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      failures.push(now); this.failures.set(address, failures); throw new Error('INVALID_CREDENTIALS');
    }
    this.failures.delete(address); this.prune();
    return this.anonymousSession();
  }

  browserSession(cookieHeader?: string): { token: string; csrf: string } | undefined {
    this.prune();
    const prefix = 'loagw_session=';
    const token = cookieHeader?.split(';').map(v => v.trim()).find(v => v.startsWith(prefix))?.slice(prefix.length);
    if (!token) return undefined;
    const session = this.sessions.get(token);
    return session ? { token, csrf: session.csrf } : undefined;
  }
  logout(token: string): void { this.sessions.delete(token); }
  clearCookie(): string { return `loagw_session=; Path=${this.cookiePath}; HttpOnly; SameSite=Strict; Max-Age=0${this.secureCookies ? '; Secure' : ''}`; }
  validCsrf(session: { csrf: string }, header?: string): boolean { return !!header && Buffer.byteLength(header) === Buffer.byteLength(session.csrf) && timingSafeEqual(Buffer.from(header), Buffer.from(session.csrf)); }

  validApiKey(authorization?: string): boolean {
    if (!this.api || !authorization?.startsWith('Bearer ')) return false;
    const token = authorization.slice(7);
    if (token.length < 32 || token.length > 256) return false;
    const actual = createHash('sha256').update(token).digest();
    const expected = Buffer.from(this.api.hash, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
}
