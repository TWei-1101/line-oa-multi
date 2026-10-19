import { mkdir, open, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export class ImageSender {
  private staging: Promise<void> = Promise.resolve();
  constructor(private readonly tmpDir: string, private readonly maxFileBytes: number, private readonly maxTotalBytes: number) {}

  async init(): Promise<void> { await mkdir(this.tmpDir, { recursive: true, mode: 0o700 }); await this.cleanup(); }

  validate(buffer: Buffer, mime: string): void {
    if (!['image/jpeg', 'image/png'].includes(mime)) throw new Error('IMAGE_TYPE_NOT_ALLOWED');
    if (buffer.length === 0 || buffer.length > this.maxFileBytes) throw new Error('IMAGE_SIZE_LIMIT');
    const jpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    const png = buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    if ((mime === 'image/jpeg' && !jpeg) || (mime === 'image/png' && !png)) throw new Error('IMAGE_SIGNATURE_INVALID');
  }

  async stage(buffer: Buffer, mime: string): Promise<string> {
    this.validate(buffer, mime);
    // Checking and writing share one queue, so concurrent uploads cannot each
    // spend the same available space. Failed attempts do not block the queue.
    const pending = this.staging.then(async () => {
      const current = await this.totalBytes();
      if (current + buffer.length > this.maxTotalBytes) throw new Error('TEMP_CAPACITY_LIMIT');
      const path = join(this.tmpDir, `${randomUUID()}${mime === 'image/png' ? '.png' : '.jpg'}`);
      const handle = await open(path, 'wx', 0o600);
      try {
        await handle.writeFile(buffer);
        await handle.close();
        return path;
      } catch (error) {
        await handle.close().catch(() => undefined);
        await unlink(path).catch(() => undefined);
        throw error;
      }
    });
    this.staging = pending.then(() => undefined, () => undefined);
    return pending;
  }

  async remove(path: string): Promise<void> { await unlink(path).catch(() => undefined); }
  async cleanup(): Promise<void> { for (const name of await readdir(this.tmpDir).catch(() => [] as string[])) await unlink(join(this.tmpDir, name)).catch(() => undefined); }
  async totalBytes(): Promise<number> {
    let total = 0;
    for (const name of await readdir(this.tmpDir)) {
      try { total += (await stat(join(this.tmpDir, name))).size; }
      catch (error) {
        // A completed send may remove its file during this scan. Other errors
        // leave capacity unknown and must refuse staging instead of assuming 0.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return total;
  }
}
