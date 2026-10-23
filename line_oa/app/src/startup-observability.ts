import { types } from 'node:util';

export const STARTUP_PHASES = ['webhook', 'registry', 'control', 'accounts', 'bridge', 'api-listen', 'ui-listen'] as const;
export type StartupPhase = typeof STARTUP_PHASES[number];
type DisplayPhase = StartupPhase | 'unknown';
type StartupCode = 'STARTUP_UNKNOWN' | 'STARTUP_PORT_IN_USE' | 'STARTUP_WEBHOOK_CORRUPT' | 'STARTUP_REGISTRY_CORRUPT' | 'STARTUP_CONFIG_CORRUPT';

function normalizePhase(value: unknown): DisplayPhase {
  if (typeof value !== 'string') return 'unknown';
  return (STARTUP_PHASES as readonly string[]).includes(value) ? value as StartupPhase : 'unknown';
}

function ownString(value: unknown, key: string): string | undefined {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return undefined;
  try {
    if (types.isProxy(value)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor && typeof descriptor.value === 'string' ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

export function startupFailureCode(phase: unknown, cause: unknown): StartupCode {
  const normalizedPhase = normalizePhase(phase);
  const code = ownString(cause, 'code');
  const message = ownString(cause, 'message');
  if ((normalizedPhase === 'api-listen' || normalizedPhase === 'ui-listen') && code === 'EADDRINUSE') return 'STARTUP_PORT_IN_USE';
  if (normalizedPhase === 'webhook' && message === 'WEBHOOK_DATA_CORRUPT_RESTORE_BACKUP') return 'STARTUP_WEBHOOK_CORRUPT';
  if (normalizedPhase === 'registry' && message === 'MULTI_ACCOUNT_REGISTRY_CORRUPT_RESTORE_BACKUP') return 'STARTUP_REGISTRY_CORRUPT';
  if (normalizedPhase === 'control' && (message === 'CONFIG_CORRUPT_RESTORE_BACKUP' || message === 'INSTANCE_ID_CORRUPT_RESTORE_BACKUP')) return 'STARTUP_CONFIG_CORRUPT';
  return 'STARTUP_UNKNOWN';
}

export function formatStartupFailure(phase: unknown, cause: unknown): string {
  const normalizedPhase = normalizePhase(phase);
  return `LINE OA Multi startup failed (${normalizedPhase}/${startupFailureCode(normalizedPhase, cause)}); inspect protected Add-on logs and backup.\n`;
}
