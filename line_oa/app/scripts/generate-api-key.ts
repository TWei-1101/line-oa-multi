import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { atomicWriteJson, ensurePrivateDir } from '../src/storage.js';

const dataDir = process.env.DATA_DIR || '/var/lib/line-oa-gateway';
await ensurePrivateDir(join(dataDir, 'secrets'));
const key = `loagw_${randomBytes(32).toString('base64url')}`;
await atomicWriteJson(join(dataDir, 'secrets', 'api-key.json'), { version: 2, hash: createHash('sha256').update(key).digest('hex'), createdAt: new Date().toISOString() }, 0o600);
process.stdout.write(`${key}\n`);
