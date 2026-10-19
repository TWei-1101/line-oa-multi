import { randomBytes, timingSafeEqual } from 'node:crypto';
import { AuthManager } from './auth.js';

export const BOOTSTRAP_TTL_MS = 10 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export class PairingError extends Error {
  constructor(public readonly status: number, code: string) { super(code); }
}

/** The bootstrap is held only in RAM and is distributed exclusively by Supervisor. */
export class PairingManager {
  private bootstrap?: { token: string; expires: number };
  private busy = false;
  private attempts: number[] = [];
  private lastAuthenticatedAt?: number;
  constructor(private readonly auth: AuthManager, public readonly instanceId: string,
    private readonly now: () => number = Date.now) {}

  discovery(): Record<string, unknown> {
    if (this.auth.apiKeyConfigured()) return { pairing_required: false };
    if (!this.bootstrap || this.bootstrap.expires <= this.now()) {
      this.bootstrap = { token: randomBytes(32).toString('base64url'), expires: this.now() + BOOTSTRAP_TTL_MS };
    }
    return { pairing_required: true, bootstrap_token: this.bootstrap.token,
      bootstrap_expires_at: new Date(this.bootstrap.expires).toISOString() };
  }

  status(): Record<string, unknown> {
    return { paired: this.auth.apiKeyConfigured(), pairing_available: !this.auth.apiKeyConfigured(),
      hacs_connected: !!this.lastAuthenticatedAt && this.now() - this.lastAuthenticatedAt < 120_000,
      last_authenticated_at: this.lastAuthenticatedAt ? new Date(this.lastAuthenticatedAt).toISOString() : null };
  }
  authenticated(): void { this.lastAuthenticatedAt = this.now(); }

  async exchange(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.attempts = this.attempts.filter(at => this.now() - at < 60_000);
    if (this.attempts.length >= 5) throw new PairingError(429, 'PAIRING_RATE_LIMITED');
    this.attempts.push(this.now());
    if (typeof body.instance_id !== 'string' || !UUID.test(body.instance_id) ||
        typeof body.request_id !== 'string' || !UUID.test(body.request_id) ||
        body.client !== 'homeassistant-line_oa' || typeof body.bootstrap_token !== 'string' ||
        !/^[A-Za-z0-9_-]{43}$/.test(body.bootstrap_token)) throw new PairingError(400, 'INVALID_PAIRING_REQUEST');
    const bootstrap = this.bootstrap;
    if (this.busy || this.auth.apiKeyConfigured() || !bootstrap || bootstrap.expires <= this.now() ||
        body.instance_id !== this.instanceId ||
        !timingSafeEqual(Buffer.from(body.bootstrap_token), Buffer.from(bootstrap.token))) {
      throw new PairingError(401, 'PAIRING_REJECTED');
    }
    // Lock BEFORE the first await: one token cannot produce concurrent credentials.
    this.busy = true;
    try {
      const generated = await this.auth.generateApiKey();
      this.bootstrap = undefined;
      return { instance_id: this.instanceId, api_key: generated.apiKey, api_version: 1 };
    } finally { this.busy = false; }
  }

  async revoke(): Promise<void> {
    if (this.busy) throw new PairingError(409, 'PAIRING_BUSY');
    this.busy = true;
    try {
      await this.auth.revokeApiKey();
      this.bootstrap = undefined;
      this.lastAuthenticatedAt = undefined;
    } finally { this.busy = false; }
  }
}
