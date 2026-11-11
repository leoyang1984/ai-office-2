import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { createApp } from '../../apps/api/src/app.ts';
import { hashPassword, temporaryPassword } from '../../apps/api/src/security.ts';
import { Store } from '../../apps/api/src/store.ts';
import { deepSeekBroker } from '../../packages/dsh-adapter/src/index.ts';
import type { ModelBroker } from '../../packages/dsh-adapter/src/index.ts';

const cloud = process.argv[2] === 'cloud';
const key = cloud ? process.env.DEEPSEEK_API_KEY?.trim() : undefined;
if (cloud && !key) {
  console.error('BLOCKED: DEEPSEEK_API_KEY unavailable');
  process.exit(2);
}
const image = execFileSync('docker', [
  '--context', 'desktop-linux', 'image', 'inspect', '--format', '{{.Id}}',
  process.env.OFFICE_TEST_IMAGE ?? 'ai-office-2-dsh:p3-0.2.2-rc.1',
], { encoding: 'utf8', timeout: 8000 }).trim();
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGP4KiFBEmIY1TCqYfhqAACiXyUQK381/QAAAABJRU5ErkJggg==', 'base64');
const root = mkdtempSync(join(tmpdir(), 'office-p3-browser-'));
const dataRoot = join(root, 'data');
let sawImage = false;
let usedWrite = false;
let stage = 'setup';

const frame = (type: string, fields: object) => 'event: ' + type + '\ndata: ' + JSON.stringify({ type, ...fields }) + '\n\n';
function stream(model: string, block: object, delta: object, reason: string) {
  return new Response(
    frame('message_start', { message: { id: 'msg_' + randomUUID(), type: 'message', role: 'assistant',
      model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 8, output_tokens: 1 } } }) +
    frame('content_block_start', { index: 0, content_block: block }) +
    frame('content_block_delta', { index: 0, delta }) +
    frame('content_block_stop', { index: 0 }) +
    frame('message_delta', { delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 8 } }) +
    frame('message_stop', {}), { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}
const fixture: ModelBroker = async body => {
  const input = JSON.parse(body) as { model: string; messages: { content: unknown }[] };
  const last = JSON.stringify(input.messages.at(-1));
  if (last.includes('tool_result')) {
    assert.doesNotMatch(last, /"is_error":true/);
    usedWrite = true;
    return stream(input.model, { type: 'text', text: '' }, { type: 'text_delta', text: 'Image recognized: RED' }, 'end_turn');
  }
  const all = JSON.stringify(input.messages);
  assert.ok(all.includes('"type":"image"'));
  assert.ok(all.includes('"media_type":"image/png"'));
  assert.ok(all.includes(png.toString('base64')));
  sawImage = true;
  const match = all.match(/relative directory (export-[a-f0-9-]{36})\//);
  assert.ok(match?.[1]);
  return stream(input.model, { type: 'tool_use', id: 'tool_' + randomUUID(), name: 'write', input: {} }, {
    type: 'input_json_delta',
    partial_json: JSON.stringify({ file_path: match[1] + '/report.txt', content: 'RED\n' }),
  }, 'tool_use');
};

const port = await new Promise<number>((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    server.close(error => error ? reject(error) : resolve(address.port));
  });
});
const origin = 'http://127.0.0.1:' + port;
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const initial = temporaryPassword();
  const password = temporaryPassword();
  const store = new Store(dataRoot);
  const account = store.createUser({ username: 'tester', displayName: 'Tester', passwordHash: await hashPassword(initial) }, 'USER');
  store.close();

  app = await createApp({ dataRoot, origin, serveWeb: true, runtime: { image, model: key ? deepSeekBroker(key) : fixture } });
  await app.listen({ host: '127.0.0.1', port });
  browser = await chromium.launch({
    executablePath: process.env.OFFICE_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true, chromiumSandbox: true,
  });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
  const page = await context.newPage();
  stage = 'sign in and change temporary password';
  await page.goto(origin);
  await page.getByLabel('用户名').fill('tester');
  await page.getByLabel('密码', { exact: true }).fill(initial);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByLabel('临时密码').fill(initial);
  await page.getByLabel('新密码').fill(password);
  await page.getByRole('button', { name: '保存密码' }).click();

  stage = 'upload and preview image';
  await page.getByLabel('会话标题').fill('图片验收');
  await page.getByRole('button', { name: '新建会话' }).click();
  await page.getByLabel('上传文件').setInputFiles({ name: 'sample.png', mimeType: 'image/png', buffer: png });
  await page.getByRole('button', { name: '上传', exact: true }).click();
  await page.getByRole('button', { name: '预览 sample.png' }).click();
  await page.waitForFunction(() => document.querySelector<HTMLImageElement>('img[alt="sample.png"]')?.naturalWidth === 16);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  console.log('PASS mobile browser upload and image preview');

  stage = 'send image to DSH and generate file';
  await page.getByLabel('图片附件（可选）').selectOption({ label: 'sample.png' });
  await page.getByLabel('消息', { exact: true }).fill(
    'What is the color of the attached solid-color image? Use the write tool to create report.txt in the specified export directory. Write RED if the image is red, otherwise its actual color. In your final response include the same color.',
  );
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const downloadLink = page.getByRole('link', { name: '下载 report.txt' });
  await downloadLink.waitFor({ timeout: 115_000 });
  const [download] = await Promise.all([page.waitForEvent('download'), downloadLink.click()]);
  assert.equal(download.suggestedFilename(), 'report.txt');
  assert.match(readFileSync((await download.path())!, 'utf8'), /\bred\b/i);
  const outputs = (await (await page.request.get(origin + '/api/v1/files')).json()) as { id: string; source: string; name: string }[];
  const report = outputs.find(file => file.source === 'output' && file.name === 'report.txt');
  assert.ok(report);
  assert.match(readFileSync(join(dataRoot, 'users', account.id, 'workspace/outputs', report.id), 'utf8'), /\bred\b/i);
  if (!cloud) assert.ok(sawImage && usedWrite);
  console.log('PASS DSH image input and generated file download');

  stage = 'log out and resume history';
  await page.getByRole('button', { name: '退出' }).click();
  await page.getByRole('heading', { name: '登录办公室' }).waitFor();
  assert.equal((await page.request.get(origin + '/api/v1/files/' + report.id + '/download')).status(), 401);
  await page.getByLabel('用户名').fill('tester');
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('button', { name: '图片验收', exact: true }).click();
  await page.locator('.messages .assistant').getByText(/\bred\b/i).waitFor();
  await page.getByRole('status').filter({ hasText: '会话已连接' }).waitFor();
  console.log('PASS logout, login, persisted history and SSE connection');
  console.log('PASS P3 browser ' + (cloud ? 'real cloud model' : 'synthetic model fixture'));
} catch (error) {
  console.error(JSON.stringify({ status: 'FAIL', stage, type: error instanceof Error ? error.name : 'Unknown',
    ...(!cloud && error instanceof Error ? { diagnostic: error.message.slice(0, 900) } : {}) }));
  process.exitCode = 1;
} finally {
  await browser?.close();
  await app?.close();
  rmSync(root, { recursive: true, force: true });
}
