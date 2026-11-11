import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request as upstream } from 'node:http';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { createApp } from '../../apps/api/src/app.ts';
import { hashPassword, temporaryPassword } from '../../apps/api/src/security.ts';
import { Store } from '../../apps/api/src/store.ts';

const root = mkdtempSync(join(tmpdir(), 'office-p4-https-'));
const dataRoot = join(root, 'data');
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let proxy: ReturnType<typeof createServer> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let backendPort: number | undefined;
let stage = 'TLS proxy setup';
try {
  const keyFile = join(root, 'test.pem');
  const certFile = join(root, 'test-cert.pem');
  execFileSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-keyout', keyFile, '-out', certFile], { stdio: 'ignore' });
  proxy = createServer({ key: readFileSync(keyFile), cert: readFileSync(certFile) }, (request, response) => {
    if (backendPort === undefined) {
      response.writeHead(503).end();
      return;
    }
    const connection = upstream({
      host: '127.0.0.1', port: backendPort, path: request.url, method: request.method, headers: request.headers,
    }, result => {
      response.writeHead(result.statusCode ?? 502, result.headers);
      result.pipe(response);
    });
    connection.on('error', () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    response.on('close', () => connection.destroy());
    request.pipe(connection);
  });
  const tls = proxy;
  await new Promise<void>((resolve, reject) => {
    tls.once('error', reject);
    tls.listen(0, '127.0.0.1', resolve);
  });
  const address = tls.address();
  assert.ok(address && typeof address === 'object');
  const origin = 'https://127.0.0.1:' + address.port;
  const password = temporaryPassword();
  const replacement = temporaryPassword();
  const store = new Store(dataRoot);
  store.createUser({ username: 'https-test', displayName: 'HTTPS test', passwordHash: await hashPassword(password) }, 'USER');
  store.close();
  app = await createApp({ dataRoot, origin, serveWeb: true });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const backend = app.server.address();
  assert.ok(backend && typeof backend === 'object');
  backendPort = backend.port;
  browser = await chromium.launch({
    executablePath: process.env.OFFICE_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true, chromiumSandbox: true,
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, acceptDownloads: true });
  const page = await context.newPage();
  stage = 'HTTPS login and secure cookie';
  await page.goto(origin);
  await page.getByLabel('用户名').fill('https-test');
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByLabel('临时密码').fill(password);
  await page.getByLabel('新密码').fill(replacement);
  await page.getByRole('button', { name: '保存密码' }).click();
  await page.getByLabel('会话标题').waitFor();
  const cookie = (await context.cookies()).find(item => item.name === 'office_session');
  assert.ok(cookie?.httpOnly && cookie.secure && cookie.sameSite === 'Strict');
  console.log('PASS HTTPS secure, HttpOnly and Strict session cookie');

  stage = 'HTTPS upload, download, conversation, SSE';
  await page.getByLabel('会话标题').fill('HTTPS test');
  await page.getByRole('button', { name: '新建会话' }).click();
  await page.getByRole('status').filter({ hasText: '会话已连接' }).waitFor();
  await page.getByLabel('消息', { exact: true }).fill('HTTPS fixture');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.locator('.messages .assistant').getByText('Mock Agent 已收到消息：HTTPS fixture').waitFor();
  await page.getByLabel('上传文件').setInputFiles({ name: 'sample.txt', mimeType: 'text/plain', buffer: Buffer.from('HTTPS upload') });
  await page.getByRole('button', { name: '上传', exact: true }).click();
  const [download] = await Promise.all([
    page.waitForEvent('download'), page.getByRole('link', { name: '下载 sample.txt' }).click(),
  ]);
  assert.equal(readFileSync((await download.path())!, 'utf8'), 'HTTPS upload');
  console.log('PASS HTTPS upload, download and SSE through the local TLS reverse proxy');
} catch (error) {
  console.error(JSON.stringify({ status: 'FAIL', stage, type: error instanceof Error ? error.name : 'Unknown',
    ...(error instanceof Error ? { diagnostic: error.message.slice(0, 900) } : {}) }));
  process.exitCode = 1;
} finally {
  await browser?.close();
  await app?.close();
  if (proxy) await new Promise<void>(resolve => proxy!.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
}
