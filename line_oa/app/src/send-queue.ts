export interface SendQueueOptions {
  maxItems?: number;
  maxBytes?: number;
  waitMs?: number;
}

interface Entry {
  bytes: number;
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
  signal?: AbortSignal;
  abort?: () => void;
}

/** One shared FIFO for text/images. Only jobs that have not started can cancel. */
export class SendQueue {
  private pending: Entry[] = [];
  private active = false;
  private bytes = 0;
  private stopped = false;
  private readonly maxItems: number;
  private readonly maxBytes: number;
  private readonly waitMs: number;

  constructor(options: SendQueueOptions = {}) {
    this.maxItems = options.maxItems ?? 32;
    this.maxBytes = options.maxBytes ?? 20 * 1024 * 1024;
    // Return a known-unsent failure before the existing HACS 30s text timeout.
    this.waitMs = options.waitMs ?? 10_000;
  }

  isBusy(): boolean { return this.active || this.pending.length > 0; }

  run<T>(action: () => Promise<T>, bytes: number, signal?: AbortSignal): Promise<T> {
    if (this.stopped) return Promise.reject(new Error('SEND_QUEUE_STOPPED'));
    if (signal?.aborted) return Promise.reject(new Error('SEND_QUEUE_CANCELLED'));
    if (this.pending.length + Number(this.active) >= this.maxItems || this.bytes + bytes > this.maxBytes) {
      return Promise.reject(new Error('SEND_QUEUE_FULL'));
    }
    return new Promise<T>((resolve, reject) => {
      const entry: Entry = { run: action, bytes, resolve: value => resolve(value as T), reject, signal };
      entry.abort = () => this.cancel(entry, 'SEND_QUEUE_CANCELLED');
      entry.timer = setTimeout(() => this.cancel(entry, 'SEND_QUEUE_TIMEOUT'), this.waitMs);
      signal?.addEventListener('abort', entry.abort, { once: true });
      this.bytes += bytes;
      this.pending.push(entry);
      this.pump();
    });
  }

  stop(): void {
    this.stopped = true;
    for (const entry of [...this.pending]) this.cancel(entry, 'SEND_QUEUE_STOPPED');
  }

  private detach(entry: Entry): void {
    clearTimeout(entry.timer);
    if (entry.abort) entry.signal?.removeEventListener('abort', entry.abort);
  }

  private cancel(entry: Entry, code: string): void {
    const index = this.pending.indexOf(entry);
    if (index < 0) return;
    this.pending.splice(index, 1);
    this.detach(entry);
    this.bytes -= entry.bytes;
    entry.reject(new Error(code));
  }

  private pump(): void {
    if (this.active || this.stopped) return;
    const entry = this.pending.shift();
    if (!entry) return;
    this.detach(entry);
    this.active = true;
    void Promise.resolve().then(entry.run).then(entry.resolve, entry.reject).finally(() => {
      this.bytes -= entry.bytes;
      this.active = false;
      this.pump();
    });
  }
}
