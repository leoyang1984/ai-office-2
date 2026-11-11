import { cleanupOfficeWorkers, deepSeekBroker, verifyWorkerImage } from '../../../packages/dsh-adapter/src/index.ts';
import { createApp } from './app.ts';
import { lockDataRoot } from './data-lock.ts';
import { hashBytes } from './security.ts';
import { openDataRoot } from './storage.ts';

const dataRoot = process.env.AI_OFFICE_DATA_ROOT;
if (!dataRoot) throw new Error('Set AI_OFFICE_DATA_ROOT to a dedicated absolute directory');
const origin = process.env.AI_OFFICE_ORIGIN ?? 'http://127.0.0.1:3000';
const mode = process.env.AI_OFFICE_AGENT_MODE ?? 'mock';
if (mode !== 'mock' && mode !== 'dsh') throw new Error('AI_OFFICE_AGENT_MODE must be mock or dsh');
const runtime = mode === 'dsh' ? {
  image: 'sha256:015fabdf2a516a0593ba12fcbda06535dbd261539b8d0f72bfc3af4d069212e7',
  model: deepSeekBroker(process.env.DEEPSEEK_API_KEY ?? ''),
} : undefined;
const root = openDataRoot(dataRoot);
const release = lockDataRoot(root, Boolean(runtime));
let app: Awaited<ReturnType<typeof createApp>> | undefined;
try {
  if (runtime) {
    await verifyWorkerImage(runtime.image);
    await cleanupOfficeWorkers(hashBytes(root));
  }
  app = await createApp({ dataRoot: root, origin, serveWeb: true, runtime });
  await app.listen({ host: '127.0.0.1', port: 3000 });
  console.log('AI Office 2.0 · ' + (runtime ? 'DSH' : 'Mock Agent') + ' · http://127.0.0.1:3000');
} catch (error) {
  try { await app?.close(); } finally { release(); }
  throw error;
}
const server = app;
let closing = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    if (closing) return;
    closing = true;
    void server.close().catch(() => {
      console.error('服务关闭时出现错误，请检查 Worker 状态');
      process.exitCode = 1;
    }).finally(release);
  });
}
