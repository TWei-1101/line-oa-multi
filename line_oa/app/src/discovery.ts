import { PairingManager } from './pairing.js';

export type SupervisorRequest = (path: string, method?: string, body?: unknown) => Promise<Record<string, unknown>>;
export function supervisorRequest(token: string, base = 'http://supervisor'): SupervisorRequest {
  return async (path, method = 'GET', body) => {
    const response = await fetch(`${base}${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error',
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) throw new Error('SUPERVISOR_UNAVAILABLE');
    const value = await response.json() as { result?: string; data?: Record<string, unknown> };
    if (value.result !== 'ok' || !value.data) throw new Error('SUPERVISOR_INVALID_RESPONSE');
    return value.data;
  };
}

/** Supervisor upserts on (addon, service), retaining one UUID across updates. */
export class DiscoveryPublisher {
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  private stopped = false;
  private host?: string;
  private published = false;
  constructor(private readonly pairing: PairingManager, private readonly request: SupervisorRequest,
    private readonly report: (state: string) => void = () => undefined) {}

  get status(): string { return this.published ? 'published' : 'retrying'; }
  start(): void {
    void this.publish();
    this.timer = setInterval(() => { void this.publish(); }, 30_000);
    this.timer.unref();
  }
  async publish(): Promise<void> {
    if (this.stopped) return;
    if (this.active) { await this.active; return this.publish(); }
    this.active = this.perform();
    try { await this.active; } finally { this.active = undefined; }
  }
  private async perform(): Promise<void> {
    try {
      if (!this.host) {
        const info = await this.request('/addons/self/info');
        if (typeof info.hostname !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(info.hostname)) throw new Error('SUPERVISOR_HOST_INVALID');
        this.host = info.hostname;
      }
      await this.request('/discovery', 'POST', { service: 'line_oa', config: {
        host: this.host, port: 8787, instance_id: this.pairing.instanceId, api_version: 1, ...this.pairing.discovery()
      } });
      if (!this.published) this.report('PUBLISHED');
      this.published = true;
    } catch {
      if (this.published) this.report('RETRYING');
      this.published = false;
    }
  }
  stop(): void { this.stopped = true; clearInterval(this.timer); }
}
