import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { GatewayConfig } from './types.js';
import { atomicWriteJson, ensurePrivateDir, readJsonSafe } from './storage.js';

export const DATA_DIR = process.env.DATA_DIR || '/data';

export const DEFAULT_CONFIG: GatewayConfig = {
  instanceId: '',
  listenHost: '0.0.0.0',
  port: 8787,
  contactsCacheTtlMs: 600_000,
  uiAuthEnabled: false,
  apiEnabled: false,
  secureCookies: false,
  rateLimitPerMinute: 0,
  duplicateWindowMs: 60_000,
  maxImageBytes: 10 * 1024 * 1024,
  maxTempBytes: 20 * 1024 * 1024,
  requestTimeoutMs: 15_000
};

function validConfig(value: unknown): value is GatewayConfig {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.listenHost === 'string' && Number.isInteger(v.port) && typeof v.apiEnabled === 'boolean' &&
    (v.instanceId === undefined || typeof v.instanceId === 'string');
}

export async function loadConfig(dataDir = DATA_DIR): Promise<{ config: GatewayConfig; warning?: string }> {
  await ensurePrivateDir(dataDir);
  await ensurePrivateDir(join(dataDir, 'secrets'));
  await ensurePrivateDir(join(dataDir, 'tmp'));
  const path = join(dataDir, 'config.json');
  const loaded = await readJsonSafe(path, DEFAULT_CONFIG, validConfig);
  if (loaded.warning) throw new Error('CONFIG_CORRUPT_RESTORE_BACKUP');
  if (!loaded.warning && loaded.value === DEFAULT_CONFIG) await atomicWriteJson(path, DEFAULT_CONFIG);
  const config = { ...DEFAULT_CONFIG, ...loaded.value };
  if (config.instanceId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(config.instanceId)) throw new Error('INSTANCE_ID_CORRUPT_RESTORE_BACKUP');
  const configChanged = !config.instanceId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(config.instanceId);
  if (configChanged) config.instanceId = randomUUID();
  config.listenHost = '0.0.0.0';
  config.port = 8787;
  config.apiEnabled = true;
  config.uiAuthEnabled = false;
  const rateLimitChanged = config.rateLimitPerMinute !== 0;
  config.rateLimitPerMinute = 0;

  if (config.port < 1024 || config.port > 65535) config.port = DEFAULT_CONFIG.port;
  if (configChanged || rateLimitChanged) await atomicWriteJson(path, config);
  return { config, warning: loaded.warning };
}
