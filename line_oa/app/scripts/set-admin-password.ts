import { randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { atomicWriteJson, ensurePrivateDir } from '../src/storage.js';

const scrypt = promisify(scryptCallback);
const dataDir = process.env.DATA_DIR || '/var/lib/line-oa-gateway';
await ensurePrivateDir(join(dataDir, 'secrets'));
let password = '';
if (process.argv.includes('--generate')) password = randomBytes(18).toString('base64url');
else {
  for await (const chunk of process.stdin) { password += chunk; if (password.length > 1024) throw new Error('INPUT_LIMIT'); }
  password = password.trimEnd();
}
if (password.length < 12) throw new Error('密碼至少需要 12 個字元');
const salt = randomBytes(16);
const hash = await scrypt(password, salt, 32) as Buffer;
await atomicWriteJson(join(dataDir, 'secrets', 'admin-password.json'), { version: 1, salt: salt.toString('hex'), hash: hash.toString('hex') }, 0o600);
if (process.argv.includes('--generate')) process.stdout.write(`${password}\n`);
else process.stdout.write('管理者密碼已更新。\n');
password = '';
