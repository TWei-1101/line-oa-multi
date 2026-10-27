import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { RecoveryTrigger } from './line-client.js';
import { MemoryLogger, localTimestamp } from './logger.js';
import { atomicWriteJson, readJsonSafe } from './storage.js';

export const AUTO_LOGIN_HISTORY_LIMIT = 200;
const triggers = new Set<RecoveryTrigger>(['scheduled_check', 'startup_check', 'manual_check', 'send', 'contacts']);
interface AutoLoginEntry {
  id: string;
  trigger: RecoveryTrigger;
  startedAt: string;
  completedAt?: string;
  result: 'STARTED' | 'SUCCESS' | 'FAILED' | 'INTERRUPTED';
  error?: string;
}
interface HistoryFile { version: 1; entries: AutoLoginEntry[] }
const timestamp = (value: unknown): value is string => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
function validEntry(value: unknown): value is AutoLoginEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as AutoLoginEntry;
  return typeof entry.id === 'string' && /^[0-9a-f-]{36}$/.test(entry.id) && triggers.has(entry.trigger) &&
    timestamp(entry.startedAt) && (entry.completedAt === undefined || timestamp(entry.completedAt)) &&
    ['STARTED', 'SUCCESS', 'FAILED', 'INTERRUPTED'].includes(entry.result) &&
    (entry.error === undefined || /^[A-Z][A-Z0-9_]{1,80}$/.test(entry.error));
}

/** A small, durable audit of actual recovery attempts; never stores HTTP bodies or credentials. */
export class AutoLoginHistory {
  private entries: AutoLoginEntry[] = [];
  private readonly path: string;
  constructor(dataDir: string, private readonly logger: MemoryLogger) { this.path = join(dataDir, 'auto-login-history.json'); }

  async load(): Promise<void> {
    const loaded = await readJsonSafe<HistoryFile>(this.path, { version: 1, entries: [] },
      (value): value is HistoryFile => !!value && typeof value === 'object' && (value as HistoryFile).version === 1 &&
        Array.isArray((value as HistoryFile).entries) && (value as HistoryFile).entries.length <= AUTO_LOGIN_HISTORY_LIMIT &&
        (value as HistoryFile).entries.every(validEntry));
    // Select known fields even when loading a manually edited file.
    this.entries = loaded.value.entries.map(({ id, trigger, startedAt, completedAt, result, error }) => ({
      id, trigger, startedAt, completedAt, result: result === 'STARTED' ? 'INTERRUPTED' : result,
      ...(result === 'STARTED' ? { error: 'SERVICE_RESTARTED' } : error ? { error } : {})
    }));
    if (loaded.warning) this.logger.add('AUTO_LOGIN_HISTORY', 'WARNING', undefined, 'AUTO_LOGIN_HISTORY_INVALID');
    await this.save();
  }

  list() {
    return this.entries.map(entry => ({ ...entry, timezone: this.logger.timezone,
      startedLocalTime: localTimestamp(new Date(entry.startedAt), this.logger.timezone),
      ...(entry.completedAt ? { completedLocalTime: localTimestamp(new Date(entry.completedAt), this.logger.timezone),
        durationMs: Math.max(0, Date.parse(entry.completedAt) - Date.parse(entry.startedAt)) } : {}) }));
  }

  async run<T>(trigger: RecoveryTrigger, action: () => Promise<T>): Promise<T> {
    const entry: AutoLoginEntry = { id: randomUUID(), trigger, startedAt: new Date().toISOString(), result: 'STARTED' };
    this.entries.unshift(entry);
    this.entries.length = Math.min(this.entries.length, AUTO_LOGIN_HISTORY_LIMIT);
    await this.save();
    this.logger.add('AUTO_LOGIN', 'STARTED', trigger);
    try {
      const value = await action();
      entry.result = 'SUCCESS';
      return value;
    } catch (error) {
      entry.result = 'FAILED';
      entry.error = error instanceof Error && /^(?:LOGIN_[A-Z0-9_]{1,74}|SESSION_CHANGED)$/.test(error.message)
        ? error.message : 'LOGIN_RECOVERY_FAILED';
      throw error;
    } finally {
      entry.completedAt = new Date().toISOString();
      await this.save();
      this.logger.add('AUTO_LOGIN', entry.result, trigger, entry.error);
    }
  }

  private async save(): Promise<void> {
    try { await atomicWriteJson(this.path, { version: 1, entries: structuredClone(this.entries) } satisfies HistoryFile); }
    catch { this.logger.add('AUTO_LOGIN_HISTORY', 'WARNING', undefined, 'AUTO_LOGIN_HISTORY_WRITE_FAILED'); }
  }
}
