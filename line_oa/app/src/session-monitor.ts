import { randomInt } from 'node:crypto';
import { LineClient, LineError } from './line-client.js';
import { SessionManager } from './session.js';
import { MemoryLogger } from './logger.js';

export const SESSION_JITTER_MIN_MS = 60_000;
export const SESSION_JITTER_MAX_MS = 10 * 60_000;

export function sessionIdleDelayMs(minutes: number): number {
  return minutes * 60_000 + randomInt(SESSION_JITTER_MIN_MS, SESSION_JITTER_MAX_MS + 1);
}

/** Checks/recovery use read-only chat APIs and never start QR or send messages. */
export class SessionMonitor {
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  private stopped = false;
  private started = false;
  private generation = 0;

  constructor(private readonly sessions: SessionManager, private readonly client: LineClient,
    private readonly logger: MemoryLogger, private readonly busy: () => boolean,
    private intervalMinutes = 45, private readonly nextDelayMs: (minutes: number) => number = sessionIdleDelayMs) {}

  get enabled(): boolean { return this.intervalMinutes > 0; }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.schedule();
  }

  configure(minutes: number): void {
    this.intervalMinutes = minutes;
    ++this.generation;
    if (this.started && !this.stopped) this.schedule();
  }

  /** Restart the idle window only after an actual upstream send attempt. */
  messageSent(): void {
    if (!this.started || this.stopped || !this.enabled) return;
    ++this.generation;
    this.schedule();
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.enabled) return;
    const generation = this.generation;
    this.timer = setTimeout(() => { this.timer = undefined; void this.cycle(generation); },
      this.nextDelayMs(this.intervalMinutes));
    this.timer.unref();
  }

  private async cycle(generation: number): Promise<void> {
    try { await this.check(); }
    finally {
      if (!this.stopped && generation === this.generation) this.schedule();
    }
  }

  async check(trigger: 'scheduled_check' | 'startup_check' = 'scheduled_check'): Promise<void> {
    if (this.stopped || !this.enabled) return;
    if (this.active) return this.active;
    const generation = this.generation;
    const credentials = this.sessions.getCredentials();
    // Confirmed expiry requires human login; sending can still attempt recovery.
    if (!credentials || this.sessions.getStatus().state === 'EXPIRED' || this.busy()) return;
    this.active = (async () => {
      let state: 'CONNECTED' | 'EXPIRED' | 'DISCONNECTED' | 'ERROR' = 'CONNECTED';
      let code: string | undefined;
      try { await this.client.validate(trigger); }
      catch (error) {
        const kind = error instanceof LineError ? error.kind : 'NETWORK';
        state = kind === 'AUTH' ? 'EXPIRED' : kind === 'NETWORK' ? 'DISCONNECTED' : 'ERROR';
        code = error instanceof LineError ? error.code : 'SESSION_VALIDATION_FAILED';
      }
      if (this.stopped || generation !== this.generation || this.sessions.getCredentials() !== credentials) return;
      const changed = this.sessions.getStatus().state !== state;
      this.sessions.mark(state, state === 'CONNECTED' ? '背景 Session 驗證成功' : `背景驗證失敗：${code}`);
      if (changed) this.logger.add('SESSION_BACKGROUND_VALIDATE', state === 'CONNECTED' ? 'SUCCESS' : 'FAILED', undefined, code);
    })();
    try { await this.active; } finally { this.active = undefined; }
  }

  stop(): void { this.stopped = true; ++this.generation; clearTimeout(this.timer); }
}
