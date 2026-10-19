// Isolated measurement: no saved LINE session, no Supervisor, no outbound LINE calls.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { createGateway } from '../line_oa/app/dist/src/server.js';
const dir = await mkdtemp(join(tmpdir(), 'line-oa-memory-'));
const gateway = await createGateway({ dataDir: dir, lineRequest: async () => { throw new Error('MOCK_ONLY'); } });
try {
  await gateway.start(0, 0, '127.0.0.1');
  const values = [];
  for (let n = 0; n < 5; n++) { await setTimeout(1000); values.push(process.memoryUsage().rss); }
  console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch,
    idleRssMiB: values.map(v => Number((v / 1048576).toFixed(2))),
    note: 'Native empty-session process; not HAOS/container RSS or live LINE login.' }, null, 2));
} finally { await gateway.stop(); await rm(dir, { recursive: true, force: true }); }
