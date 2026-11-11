import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, devices } from 'playwright-core';
import type { BrowserContext, Page, WebSocket } from 'playwright-core';
import { deepSeekBroker } from '../../packages/dsh-adapter/src/index.ts';
import type { ModelBroker } from '../../packages/dsh-adapter/src/index.ts';
import { startR5 } from './r5-harness.ts';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGP4KiFBEmIY1TCqYfhqAACiXyUQK381/QAAAABJRU5ErkJggg==', 'base64');
const fixtureText = 'R5_SYNTHETIC_FILE\n';
const deadline = new AbortController();
const stop = () => deadline.abort();
const shutdownSignals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
for (const event of shutdownSignals) process.on(event, stop);
let starts = 0;
const event = (type: string, fields: object) => 'event: ' + type + '\ndata: ' + JSON.stringify({ type, ...fields }) + '\n\n';
const fixture: ModelBroker = async body => {
  const input = JSON.parse(body);
  const last = JSON.stringify(input.messages.at(-1)), messages = JSON.stringify(input.messages);
  let text = 'R5_SECOND_ACCOUNT_OK', tool: string | undefined, args: object | undefined;
  if (last.includes('tool_result')) {
    assert.doesNotMatch(last, /"is_error":true/);
    const prior = input.messages.at(-2)?.content?.find((block: { type: string }) => block.type === 'tool_use')?.name;
    if (prior === 'write') { tool = 'present'; args = { files: [{ path: 'r5-report.txt' }] }; }
    else { assert.equal(prior, 'present'); text = 'R5_REPORT_READY'; }
  } else if (last.includes('R5_UPLOAD_CHECK')) {
    assert.ok(messages.includes(png.toString('base64')), 'The uploaded image did not reach the model');
    tool = 'write'; args = { file_path: 'r5-report.txt', content: fixtureText };
  } else if (messages.includes('R5_REVOKE_CHECK')) {
    assert.ok(!messages.includes('R5_SKILL_BLUE_PAPER'), 'Revoked instructions reached a new session');
    text = 'R5_REVOKED_OK';
  } else if (messages.includes('R5_SKILL_CHECK')) {
    assert.ok(messages.includes('R5_SKILL_BLUE_PAPER'), 'Official slash Skill did not load');
    text = 'R5_PUBLIC_LOADED';
  } else if (messages.includes('R5_RESUME_CHECK')) {
    assert.ok(messages.includes('R5_FIRST_REPLY') && messages.includes('R5_REPORT_READY'));
    text = 'R5_RECOVERED_CONTEXT';
  } else if (last.includes('R5_START_NONCE')) {
    starts++;
    text = 'R5_FIRST_REPLY';
  }
  return new Response(event('message_start', { message: { id: 'msg_' + randomUUID(), type: 'message', role: 'assistant',
    model: input.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }) +
    event('content_block_start', { index: 0, content_block: tool ? { type: 'tool_use', id: 'tool_' + randomUUID(), name: tool, input: {} } : { type: 'text', text: '' } }) +
    event('content_block_delta', { index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify(args) } : { type: 'text_delta', text } }) +
    event('content_block_stop', { index: 0 }) + event('message_delta', { delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null },
      usage: { output_tokens: 5 } }) + event('message_stop', {}), { headers: { 'Content-Type': 'text/event-stream' } });
};

const mode = process.argv[2] ?? 'fixture';
if (process.argv.length > 3 || !['fixture', 'phone', 'local', 'probe'].includes(mode)) throw new Error('Usage: node tests/e2e/r5-tailnet.ts [fixture|phone|local|probe]');
const key = process.env.DEEPSEEK_API_KEY ?? '';
delete process.env.DEEPSEEK_API_KEY;
const cloud = mode === 'phone' ? deepSeekBroker(key) : undefined;
let providerStreams = 0;
const model: ModelBroker = cloud ? async (body, signal) => {
  const response = await cloud(body, signal).catch(() => { throw new Error('R5 无法连接 DeepSeek，请检查本机代理'); });
  if (response.ok && response.headers.get('content-type')?.includes('text/event-stream')) {
    console.log('R5 DeepSeek SSE 已连接：' + ++providerStreams);
  } else console.error('R5 DeepSeek HTTP 状态：' + response.status);
  return response;
} : fixture;
let service: Awaited<ReturnType<typeof startR5>> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let stage = '预检';
try {
  service = await startR5(model, deadline.signal, mode === 'local');
  const { origin, users, skillId } = service;
  if (!service.tailnet) console.log('R5: running against an isolated loopback TLS reverse proxy');
  else if (service.tlsVerified) console.log('PASS R5 Tailnet HTTPS readiness with a trusted certificate');
  else console.log('R5 Serve route verified; Mac self-access TLS not verified. Check the address from a second device.');
  if (mode === 'probe') {
    assert.ok(service.tailnet);
    if (!service.tlsVerified) process.exitCode = 2;
  } else if (mode === 'phone') {
    assert.ok(service.tailnet);
    console.log('手机测试入口：' + origin);
    console.log('手机测试账户：' + users.a.name + '，临时密码：' + users.a.initial);
    console.log('Mac 管理入口：' + origin + '/?manage=1');
    console.log('管理员测试账户：' + users.admin.name + '，临时密码：' + users.admin.initial);
    console.log('只上传 R5 合成文件。验收结束按 Ctrl+C，最迟 45 分钟后自动停止。');
    const timeout = setTimeout(stop, 45 * 60_000);
    try {
      await Promise.race([delay(45 * 60_000, undefined, { signal: deadline.signal, ref: false }), service.exited]);
      if (!deadline.signal.aborted) throw new Error('Serve 提前退出');
    } catch (error) { if (!deadline.signal.aborted) throw error; }
    finally { clearTimeout(timeout); }
  } else {
    if (service.tailnet && !service.tlsVerified) throw new Error('Mac self-access failed. Use the local fixture and verify real HTTPS from a phone.');
    const proxyArgs = service.tailnet ? [] : ['--ignore-certificate-errors-spki-list=' + service.pin];
    const tls = service.tailnet ? {} : { ignoreHTTPSErrors: true }; // Playwright's API client has a separate trust store.
    const headers = { Origin: origin };
    browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      headless: true, chromiumSandbox: true, args: ['--no-proxy-server', ...proxyArgs] });
    const a = await browser.newContext({ ...devices['iPhone 13'], ...tls, acceptDownloads: true });
    const b = await browser.newContext(tls);
    const manager = await browser.newContext(tls);
    const page = await a.newPage();
    const sockets: WebSocket[] = [];
    const established = new Set<WebSocket>();
    page.on('websocket', ws => {
      if (ws.url() !== origin.replace('https:', 'wss:') + '/dsh/api/remote.mux') return;
      sockets.push(ws);
      ws.on('framereceived', () => established.add(ws));
    });
    const live = () => sockets.filter(ws => established.has(ws) && !ws.isClosed());
    const composer = page.locator('[data-composer-input][contenteditable=true]');
    const password = () => 'R5-' + randomUUID();
    async function call(context: BrowserContext, path: string, method = 'GET', data?: unknown, status = 200) {
      const res = await context.request.fetch(origin + path, { method, data, headers, maxRedirects: 0, timeout: 35_000 });
      assert.equal(res.status(), status, method + ' ' + path);
      return res;
    }
    async function rpc(context: BrowserContext, method: string, args: object) {
      const res = await call(context, '/dsh/api/' + method, 'POST', { type: 'client-request', method, rpcId: randomUUID(), payload: { args } });
      return (await res.json()).result;
    }
    async function login(context: BrowserContext, who: typeof users.a) {
      await call(context, '/api/v1/auth/login', 'POST', { username: who.name, password: who.initial });
      await call(context, '/api/v1/auth/change-password', 'POST', { currentPassword: who.initial, newPassword: password() });
    }
    async function closed(active: WebSocket[]) {
      assert.ok(active.length);
      await Promise.all(active.filter(ws => !ws.isClosed()).map(ws => ws.waitForEvent('close', { timeout: 8000 })));
    }
    async function send(p: Page, message: string, reply: string) {
      await p.locator('[data-composer-input][contenteditable=true]').fill(message);
      await p.getByRole('button', { name: '发送消息', exact: true }).click();
      await p.getByText(reply, { exact: true }).last().waitFor({ timeout: 55_000 });
      await delay(450);
    }
    async function openFirstHistory() {
      const history = page.getByText('R5_START_NONCE', { exact: true }).first();
      await history.waitFor({ state: 'attached', timeout: 35_000 });
      if (!await history.isVisible()) {
        await page.getByRole('button', { name: /打开侧边栏|展开／收起左侧栏/ }).first().click({ timeout: 8000 });
      }
      await history.click({ timeout: 12_000 });
    }
    stage = '首次登录、改密与 WSS';
    await page.goto(origin);
    await page.getByLabel('用户名').fill(users.a.name);
    await page.getByLabel('密码', { exact: true }).fill(users.a.initial);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.getByLabel('临时密码').fill(users.a.initial);
    const next = password();
    await page.getByLabel('新密码').fill(next);
    await page.getByRole('button', { name: '保存密码' }).click();
    await page.waitForURL(origin + '/dsh/');
    await composer.waitFor({ timeout: 45_000 });
    assert.equal(await page.title(), 'DeepSeek Harness');
    const cookies = await a.cookies(origin);
    assert.ok(!cookies.some(item => item.name === 'office_session'));
    const cookie = cookies.find(item => item.name === 'office_r5_session');
    assert.ok(cookie?.secure && cookie.httpOnly && cookie.sameSite === 'Strict');
    const initialPrompt = page.waitForRequest(req => req.url() === origin + '/dsh/api/session/prompt');
    await send(page, 'R5_START_NONCE', 'R5_FIRST_REPLY');
    assert.ok(live().length > 0);
    console.log('PASS R5 first login, password change, Secure cookie and official browser WSS');

    stage = '上传图片和文本、工具与下载';
    const uploads: number[] = [];
    const uploadDetails: Array<Promise<unknown>> = [];
    page.on('response', response => {
      if (new URL(response.url()).pathname !== '/dsh/api/session/uploadFileBinary') return;
      uploads.push(response.status());
      uploadDetails.push(response.json().catch(() => 'not JSON'));
    });
    await page.locator('input[type=file]').setInputFiles([
      { name: 'r5-synthetic.png', mimeType: 'image/png', buffer: png },
      { name: 'r5-note.txt', mimeType: 'text/plain', buffer: Buffer.from('R5 synthetic input file') },
    ]);
    await page.getByText('r5-note.txt', { exact: true }).last().waitFor({ timeout: 20_000 });
    try { await send(page, 'R5_UPLOAD_CHECK', 'R5_REPORT_READY'); }
    catch (error) {
      console.error('R5 synthetic upload HTTP statuses:', uploads, JSON.stringify(await Promise.all(uploadDetails)).slice(0, 1200), (await page.locator('body').innerText()).slice(-900));
      throw error;
    }
    assert.ok(uploads.length && uploads.every(status => status === 200));
    await page.getByRole('button', { name: /在侧边栏预览 .*r5-report\.txt/ }).click();
    const link = page.getByRole('link', { name: '下载文件', exact: true });
    const href = (await link.getAttribute('href'))!;
    const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
    assert.equal(download.suggestedFilename(), 'r5-report.txt');
    assert.equal(readFileSync((await download.path())!, 'utf8'), fixtureText);
    await page.locator('[data-sidebar-right-toggle]').click({ timeout: 8000 });
    const sessionId = new URL(href, origin).searchParams.get('sessionId')!;
    assert.ok(sessionId);
    console.log('PASS R5 synthetic image and text upload, real write/present and exact browser download');

    stage = '断网、恢复历史与重放';
    const opened = live();
    const oldCount = sockets.length;
    await a.setOffline(true);
    service.dropSockets();
    await closed(opened);
    await assert.rejects(page.reload({ timeout: 6000 }), /ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED/);
    await a.setOffline(false);
    await page.goto(origin + '/dsh/');
    await openFirstHistory();
    await page.getByText('R5_FIRST_REPLY', { exact: true }).waitFor();
    await page.getByText('R5_REPORT_READY', { exact: true }).waitFor();
    await send(page, 'R5_RESUME_CHECK', 'R5_RECOVERED_CONTEXT');
    assert.ok(sockets.length > oldCount && live().length > 0);
    const initial = (await initialPrompt).postDataJSON();
    assert.equal(initial.payload.args.request.sessionId, sessionId);
    await call(a, '/dsh/api/session/prompt', 'POST', { ...initial, rpcId: randomUUID() });
    await delay(650);
    assert.equal(starts, 1, 'Replaying the same prompt called the model again');
    console.log('PASS R5 browser network loss, WSS reconnect, same session context and request replay');

    stage = 'Skill 发现、隔离和撤权';
    await login(b, users.b);
    await login(manager, users.admin);
    await call(b, '/dsh/');
    await call(b, href, 'GET', undefined, 404);
    assert.equal((await rpc(b, 'session/events', { request: { address: { kind: 'session', sessionId }, maxMessages: 40 } })).ok, false);
    const library = (await (await call(a, '/api/v1/skills')).json());
    assert.deepEqual(library.public.map((value: { name: string }) => value.name), ['r5-marker']);
    assert.deepEqual(library.personal.map((value: { name: string }) => value.name), ['r5-personal']);
    assert.deepEqual((await (await call(b, '/api/v1/skills')).json()).public, []);
    const beforeSkill = await rpc(a, 'session/create', { request: { cwd: '/tenant/workspace' } });
    assert.ok(beforeSkill.ok);
    const skillPrompt = async (id: string, text: string, answer: string) => {
      const result = await rpc(a, 'session/prompt', { request: { sessionId: id, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text }] } });
      assert.ok(result.ok);
      for (let i = 0; i < 50; i++) {
        const history = await rpc(a, 'session/events', { request: { address: { kind: 'session', sessionId: id }, maxMessages: 20 } });
        if (history.ok && JSON.stringify(history.value).includes(answer)) return;
        await delay(200);
      }
      throw new Error('Missing Skill fixture reply: ' + answer);
    };
    await skillPrompt(beforeSkill.value.sessionId, '/r5-marker R5_SKILL_CHECK', 'R5_PUBLIC_LOADED');
    const before = live();
    assert.ok(before.length);
    await call(manager, '/api/v1/admin/users/' + users.a.id + '/skills/' + skillId, 'DELETE');
    await page.getByRole('button', { name: '继续使用 DSH', exact: true }).waitFor({ timeout: 12_000 });
    await closed(before);
    await page.getByRole('button', { name: '继续使用 DSH', exact: true }).click();
    await composer.waitFor({ timeout: 45_000 });
    const after = await rpc(a, 'session/create', { request: { cwd: '/tenant/workspace' } });
    assert.ok(after.ok);
    const grants = await (await call(a, '/api/v1/skills')).json();
    assert.deepEqual(grants.public, []);
    assert.equal(grants.personal.length, 1);
    await skillPrompt(after.value.sessionId, 'R5_REVOKE_CHECK', 'R5_REVOKED_OK');
    console.log('PASS R5 public and personal discovery, A/B isolation and live Skill revocation');

    stage = '登出、恢复与禁用';
    await page.getByRole('button', { name: '退出办公室', exact: true }).click();
    await page.waitForURL(origin + '/');
    await call(a, '/dsh/', 'GET', undefined, 401);
    await call(a, '/api/v1/auth/login', 'POST', { username: users.a.name, password: next });
    await page.goto(origin + '/dsh/');
    await openFirstHistory();
    await page.getByText('R5_RECOVERED_CONTEXT', { exact: true }).waitFor();
    assert.ok(live().length && service.socketCount());
    await call(manager, '/api/v1/admin/users/' + users.a.id, 'PATCH', { status: 'disabled' });
    await page.waitForURL(origin + '/');
    assert.equal(service.socketCount(), 0, 'Disable left gateway WebSockets open');
    await call(a, '/api/v1/auth/login', 'POST', { username: users.a.name, password: next }, 401);
    await call(b, '/api/v1/auth/me');
    console.log('PASS R5 logout, re-login history and immediate disable without affecting B');
  }
} catch (error) {
  if (!deadline.signal.aborted) {
    console.error('FAIL R5 [' + stage + ']: ' + (error instanceof Error ? error.message.slice(0, 1200) : 'Unknown'));
    process.exitCode = 1;
  }
} finally {
  try { await browser?.close(); }
  finally {
    await service?.dispose();
    if (service) console.log('PASS R5 isolated listener, containers and temporary data cleaned up');
    for (const event of shutdownSignals) process.off(event, stop);
  }
}
