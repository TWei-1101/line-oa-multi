import { join } from 'node:path';
import { atomicWriteJson, ensurePrivateDir } from '../src/storage.js';
import { validSession } from '../src/session.js';

const dataDir = process.env.DATA_DIR || '/var/lib/line-oa-gateway';
let raw = '';
for await (const chunk of process.stdin) { raw += chunk; if (Buffer.byteLength(raw) > 65_536) throw new Error('INPUT_LIMIT'); }
let value: unknown;
try { value = JSON.parse(raw); } catch { throw new Error('INVALID_JSON'); }
if (!validSession(value)) throw new Error('INVALID_SESSION_SCHEMA');
await ensurePrivateDir(join(dataDir, 'secrets'));
await atomicWriteJson(join(dataDir, 'secrets', 'line-session.json'), value, 0o600);
raw = '';
process.stdout.write('Session 已安全匯入；請重新啟動服務後手動驗證。\n');
