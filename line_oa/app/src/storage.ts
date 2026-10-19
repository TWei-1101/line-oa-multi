import { mkdir, open, readFile, rename, chmod, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

const writes = new Map<string, Promise<void>>();

export async function ensurePrivateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

export async function readJsonSafe<T>(path: string, fallback: T, validate: (value: unknown) => value is T): Promise<{ value: T; warning?: string }> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!validate(parsed)) return { value: fallback, warning: `INVALID_JSON_SCHEMA:${path}` };
    await chmod(path, 0o600);
    return { value: parsed };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { value: fallback };
    return { value: fallback, warning: `INVALID_JSON:${path}` };
  }
}

export async function atomicWriteJson(path: string, value: unknown, mode = 0o600): Promise<void> {
  const previous = writes.get(path) ?? Promise.resolve();
  const current = previous.then(async () => {
    await ensurePrivateDir(dirname(path));
    const temp = join(dirname(path), `.${randomBytes(12).toString('hex')}.tmp`);
    const handle = await open(temp, 'wx', mode);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temp, mode);
    try {
      await rename(temp, path);
      const directory = await open(dirname(path), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } catch (error) { await unlink(temp).catch(() => undefined); throw error; }
  });
  writes.set(path, current.catch(() => undefined));
  await current;
}
