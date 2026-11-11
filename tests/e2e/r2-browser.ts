import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { createApp } from '../../apps/api/src/app.ts';
import { Store } from '../../apps/api/src/store.ts';
import { hashBytes, hashPassword, temporaryPassword } from '../../apps/api/src/security.ts';
import type { ModelBroker } from '../../packages/dsh-adapter/src/index.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'office-r2-browser-')));
const dataRoot = join(root, 'data');
const docker = (...args: string[]) => execFileSync('docker', ['--context', 'desktop-linux', ...args], { encoding: 'utf8', timeout: 10000 }).trim();
const image = docker('image', 'inspect', '--format={{.Id}}', 'ai-office-2-dsh-web:r2-0.2.2-rc.1');
const containers = () => docker('ps', '-aq', '--filter', 'label=ai-office-2.scope=' + hashBytes(dataRoot));
const port = await new Promise<number>(resolve => {
  const server = createServer();
  server.listen(0, '127.0.0.1', () => {
    const address = server.address(); assert.ok(address && typeof address === 'object');
    server.close(() => resolve(address.port));
  });
});
const origin = 'http://127.0.0.1:' + port;
const initial = temporaryPassword(), password = temporaryPassword();
const attack = '<h1>R2_PREVIEW_CONTENT</h1><script>document.body.setAttribute("data-r2-executed","yes");parent.document.body.setAttribute("data-r2-executed","yes")</script>'
  + '<img src="/missing-r2-image" onerror="document.body.setAttribute(\'data-r2-executed\',\'yes\')">';
const model: ModelBroker = async body => {
  const input = JSON.parse(body);
  const last = JSON.stringify(input.messages.at(-1));
  let name: string | undefined, args: object | undefined;
  if (last.includes('tool_result')) {
    assert.ok(!last.includes('"is_error":true'), 'Preview tool failed');
    if (input.messages.at(-2)?.content?.some((block: { name?: string }) => block.name === 'write')) {
      name = 'present'; args = { files: [{ path: 'r2-preview.html' }] };
    }
  } else if (last.includes('R2_PREVIEW')) {
    name = 'write'; args = { file_path: 'r2-preview.html', content: attack };
  }
  if (last.includes('R2_RESUME')) assert.match(JSON.stringify(input.messages), /R2_PREVIEW_READY/);
  const text = last.includes('R2_RESUME') ? 'R2_RESUMED_HISTORY' : 'R2_PREVIEW_READY';
  const event = (type: string, fields: object) => 'event: ' + type + '\ndata: ' + JSON.stringify({ type, ...fields }) + '\n\n';
  return new Response(event('message_start', { message: { id: 'msg_' + randomUUID(), type: 'message', role: 'assistant',
    model: input.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } })
    + event('content_block_start', { index: 0, content_block: name ? { type: 'tool_use', id: 'tool_' + randomUUID(), name, input: {} } : { type: 'text', text: '' } })
    + event('content_block_delta', { index: 0, delta: name ? { type: 'input_json_delta', partial_json: JSON.stringify(args) } : { type: 'text_delta', text } })
    + event('content_block_stop', { index: 0 }) + event('message_delta', { delta: { stop_reason: name ? 'tool_use' : 'end_turn', stop_sequence: null },
      usage: { output_tokens: 5 } }) + event('message_stop', {}), { headers: { 'Content-Type': 'text/event-stream' } });
};
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let stage = 'setup';
try {
  const store = new Store(dataRoot);
  store.createUser({ username: 'preview-test', displayName: 'Preview test', passwordHash: await hashPassword(initial) }, 'USER');
  store.close();
  app = await createApp({ dataRoot, origin, serveWeb: true, nativeWeb: { image, model, idleMs: 8000 } });
  await app.listen({ host: '127.0.0.1', port });
  browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, chromiumSandbox: true });
  const page = await browser.newPage();
  await page.goto(origin);
  await page.getByLabel('用户名').fill('preview-test');
  await page.getByLabel('密码', { exact: true }).fill(initial);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByLabel('临时密码').fill(initial);
  await page.getByLabel('新密码').fill(password);
  await page.getByRole('button', { name: '保存密码' }).click();
  await page.waitForURL(origin + '/dsh/');
  const composer = page.locator('[data-composer-input][contenteditable=true]');
  stage = 'static HTML preview';
  await composer.fill('R2_PREVIEW');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.getByText('R2_PREVIEW_READY', { exact: true }).waitFor();
  await page.getByRole('button', { name: /在侧边栏预览 .*r2-preview\.html/ }).click();
  await page.frameLocator('iframe').getByText('R2_PREVIEW_CONTENT', { exact: true }).waitFor();
  assert.equal(await page.locator('iframe').getAttribute('sandbox'), '');
  assert.equal(await page.frameLocator('iframe').locator('[data-r2-executed]').count(), 0);
  assert.equal(await page.locator('[data-r2-executed]').count(), 0);
  console.log('PASS R2 real browser preview renders HTML with scripts and event handlers inert');

  stage = 'idle with original browser still connected';
  const before = containers();
  assert.ok(before);
  const resume = page.getByRole('button', { name: '继续使用 DSH', exact: true });
  await resume.waitFor({ timeout: 20_000 });
  await delay(1800);
  assert.equal(containers(), '');
  await resume.click();
  await page.getByRole('button', { name: '退出办公室', exact: true }).waitFor();
  assert.ok(containers());
  assert.notEqual(containers(), before);
  const history = page.getByText('R2_PREVIEW', { exact: true }).first();
  await history.click();
  await page.getByText('R2_PREVIEW_READY', { exact: true }).waitFor();
  await composer.fill('R2_RESUME');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.getByText('R2_RESUMED_HISTORY', { exact: true }).waitFor();
  console.log('PASS R2 idle browser does not respawn container; resume control restores and continues history');
} catch (error) {
  console.error(JSON.stringify({ stage, diagnostic: String(error).slice(0, 1500).replace(/token=[^\s"']+/g, 'token=[redacted]') }));
  process.exitCode = 1;
} finally {
  await browser?.close();
  await app?.close();
  assert.equal(containers(), '');
  rmSync(root, { recursive: true, force: true });
}
