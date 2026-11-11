import { deepSeekBroker, verifyWorkerImage } from '../../../packages/dsh-adapter/src/index.ts';
import { createApp } from './app.ts';
import { readLocalWebImage } from './local-image.ts';

const stop = new AbortController();
const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
const abort = () => stop.abort();
for (const signal of signals) process.on(signal, abort);

let app: Awaited<ReturnType<typeof createApp>> | undefined;
try {
  const dataRoot = process.env.AI_OFFICE_DATA_ROOT;
  if (!dataRoot) throw new Error('请设置 AI_OFFICE_DATA_ROOT');
  const port = Number(process.env.AI_OFFICE_PORT ?? '3088');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('AI_OFFICE_PORT 必须是 1024–65535 的端口');
  const loopback = 'http://127.0.0.1:' + port;
  const origin = process.env.AI_OFFICE_ORIGIN ?? loopback;
  const publicOrigin = new URL(origin);
  if (publicOrigin.origin !== origin || (origin !== loopback && publicOrigin.protocol !== 'https:')) {
    throw new Error('AI_OFFICE_ORIGIN 必须是本机 HTTP 入口或完整的 HTTPS origin');
  }

  const key = process.env.DEEPSEEK_API_KEY ?? '';
  delete process.env.DEEPSEEK_API_KEY;
  if (!key.trim()) throw new Error('需要 DeepSeek API Key');
  const image = readLocalWebImage();
  if (!image) throw new Error('请先运行 pnpm setup:local');
  await verifyWorkerImage(image);
  stop.signal.throwIfAborted();

  app = await createApp({
    dataRoot, origin, serveWeb: true, sessionCookie: 'office_native_session',
    nativeWeb: { image, skills: true, model: deepSeekBroker(key) },
  });
  if (!stop.signal.aborted) {
    await app.listen({ host: '127.0.0.1', port });
    console.log('AI Office 2.0 · DeepSeek Harness · ' + origin);
    if (!stop.signal.aborted) await new Promise<void>(resolve => stop.signal.addEventListener('abort', () => resolve(), { once: true }));
  }
} catch (error) {
  if (!stop.signal.aborted) {
    const code = (error as NodeJS.ErrnoException).code;
    console.error(code === 'EADDRINUSE' ? '本机端口已占用，请用 AI_OFFICE_PORT 指定空闲端口。' :
      error instanceof Error ? error.message : '本地启动失败');
    process.exitCode = 1;
  }
} finally {
  try { await app?.close(); }
  catch {
    console.error('关闭失败，请核对容器与数据目录锁。');
    process.exitCode = 1;
  } finally {
    for (const signal of signals) process.off(signal, abort);
  }
}
