import type { OperationLog } from './types.js';
import { diagnosticText, redactText } from './diagnostics.js';

export function localTimestamp(date: Date, timezone = Intl.DateTimeFormat().resolvedOptions().timeZone): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset' }).formatToParts(date);
  const part = (name: string) => parts.find(p => p.type === name)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')} ${part('timeZoneName')} [${timezone}]`;
}

export class MemoryLogger {
  private entries: OperationLog[] = [];
  private latestError?: string;
  readonly timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  add(operation: string, result: string, target?: string, error?: string, details?: unknown): void {
    const safeError = error ? redactText(error).replace(/[\r\n]/g, ' ') : undefined;
    const now = new Date();
    const detail = details === undefined ? undefined : diagnosticText(details);
    const entry: OperationLog = { time: now.toISOString(), localTime: localTimestamp(now, this.timezone), timezone: this.timezone,
      operation: redactText(operation).replace(/[\r\n]/g, ' '), result: redactText(result).replace(/[\r\n]/g, ' '),
      ...(target ? { target: redactText(target).replace(/[\r\n]/g, ' ') } : {}),
      ...(safeError ? { error: safeError } : {}), ...(detail ? { details: detail } : {}) };
    this.entries.unshift(entry);
    this.entries.length = Math.min(this.entries.length, 100);
    // Bound retained diagnostics while keeping the entire newest upstream response (max 2 MiB).
    let bytes = 0;
    this.entries = this.entries.filter((item, index) => { bytes += Buffer.byteLength(JSON.stringify(item)); return index === 0 || bytes <= 4 * 1024 * 1024; });
    if (safeError) this.latestError = safeError.slice(0, 180);
    const line = [entry.localTime, entry.operation, entry.result, entry.target && `對象=${entry.target}`, entry.error].filter(Boolean).join(' | ');
    process.stdout.write(`${line}\n${detail ? detail.split('\n').map(line => `  ${line}`).join('\n') + '\n' : ''}`);
  }

  list(): OperationLog[] { return this.entries.map(entry => ({ ...entry })); }
  lastError(): string | undefined { return this.latestError; }
}
