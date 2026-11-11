import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, realpathSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { chromium } from 'playwright-core';
import type { Page, BrowserContext } from 'playwright-core';
import { NativeWebProbe } from '../../packages/dsh-web-probe/src/relay.ts';
import { hashBytes } from '../../apps/api/src/security.ts';
import type { ModelBroker } from '../../packages/dsh-adapter/src/index.ts';
const root = realpathSync(mkdtempSync(join(tmpdir(), 'office-r0-web-')));
const scope = hashBytes(root);
const image = execFileSync('docker', ['--context', 'desktop-linux', 'image', 'inspect', '--format={{.Id}}', 'ai-office-2-dsh-web:r0-0.2.2-rc.1'], { encoding: 'utf8', timeout: 8000 }).trim();
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGP4KiFBEmIY1TCqYfhqAACiXyUQK381/QAAAABJRU5ErkJggg==', 'base64');
const grant = { id: randomUUID(), path: join(root, 'knowledge') };
mkdirSync(grant.path); writeFileSync(join(grant.path, 'note.txt'), 'R0_SHARED_READ_ONLY');
const knowledgeHash = hashBytes(readFileSync(join(grant.path, 'note.txt')));
const tenants = ['A', 'B'].map(label => {
 const home = join(root, label, 'home'), workspace = join(root, label, 'workspace'), projectId = randomUUID();
 mkdirSync(home, { recursive: true, mode: 0o700 }); mkdirSync(join(workspace, 'projects', projectId), { recursive: true, mode: 0o700 });
 const marker = 'R0_' + label + '_' + randomUUID().slice(0, 8);
 writeFileSync(join(workspace, 'private.txt'), marker);
 return { label, home, workspace, projectId, marker, reply: 'R0_REPLY_' + label, sawImage: false, wrote: false, presented: false };
});
const frame = (type: string, fields: object) => 'event: ' + type + '\ndata: ' + JSON.stringify({ type, ...fields }) + '\n\n';
function response(model: string, block: object, delta: object, stop = 'end_turn') {
 return new Response(frame('message_start', { message: { id: 'msg_' + randomUUID(), type: 'message', role: 'assistant', model,
 content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }) +
 frame('content_block_start', { index: 0, content_block: block }) + frame('content_block_delta', { index: 0, delta }) +
 frame('content_block_stop', { index: 0 }) + frame('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } }) +
 frame('message_stop', {}), { headers: { 'Content-Type': 'text/event-stream' } });
}
function fixture(tenant: typeof tenants[number]): ModelBroker {
 return async body => {
  const input = JSON.parse(body);
  const all = JSON.stringify(input.messages), last = JSON.stringify(input.messages.at(-1));
  const other = tenants.find(item => item !== tenant)!;
  assert.ok(all.includes(tenant.marker)); assert.ok(!all.includes(other.marker));
  if (all.includes(png.toString('base64'))) tenant.sawImage = true;
  const text = (value: string) => response(input.model, { type: 'text', text: '' }, { type: 'text_delta', text: value });
  const tool = (name: string, args: object) => response(input.model,
   { type: 'tool_use', id: 'tool_' + randomUUID(), name, input: {} },
   { type: 'input_json_delta', partial_json: JSON.stringify(args) }, 'tool_use');
  if (last.includes('tool_result')) {
   assert.doesNotMatch(last, /"is_error":true/);
   const prior = input.messages.at(-2)?.content?.find((block: { type: string }) => block.type === 'tool_use')?.name;
   if (prior === 'write') { tenant.wrote = true; return tool('present', { files: [{ path: 'report.txt', description: 'R0 synthetic result' }] }); }
   if (prior === 'present') { tenant.presented = true; return text('R0_FILE_READY'); }
   throw new Error('Unexpected tool result');
  }
  if (last.includes('R0_EXPORT')) {
   assert.ok(tenant.sawImage);
   return tool('write', { file_path: 'report.txt', content: tenant.marker + '\n' });
  }
  if (last.includes('R0_RECALL')) { assert.ok(all.includes(tenant.reply)); return text('R0_RESTORED_' + tenant.label); }
  return text(tenant.reply);
 };
}
const probes: NativeWebProbe[] = [];
const pages: Page[] = [];
const contexts: BrowserContext[] = [];
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let stage = 'startup';
let wsCount = 0;
async function rpc(page: Page, origin: string, method: string, args: object) {
 const result = await page.request.post(origin + '/api/' + method, { data: { type: 'client-request', rpcId: randomUUID(), method, payload: { args } } });
 assert.equal(result.status(), 200); return (await result.json()).result;
}
async function sessionList(index: number) {
 const result = await rpc(pages[index]!, probes[index]!.url, 'session/list', { _request: {} });
 assert.equal(result.ok, true); return result.value.items as { sessionId: string }[];
}
async function send(page: Page, text: string, expected: string) {
 await page.locator('[data-composer-input][contenteditable=true]').fill(text);
 await page.getByRole('button', { name: '发送消息', exact: true }).click();
 await page.getByText(expected, { exact: true }).last().waitFor({ timeout: 55_000 });
}
try {
 browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, chromiumSandbox: true });
 for (const tenant of tenants) {
  const probe = new NativeWebProbe({ image, ...tenant, scope, grants: tenant.label === 'A' ? [grant] : [], model: fixture(tenant) });
  probes.push(probe); await probe.start();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true }); contexts.push(context);
  const page = await context.newPage(); pages.push(page);
  page.on('websocket', () => { wsCount++; });
  await page.goto(probe.bootstrapUrl);
  await page.getByRole('button', { name: '继续', exact: true }).click();
  await page.locator('[data-composer-input][contenteditable=true]').waitFor({ timeout: 25_000 });
  assert.equal(await page.title(), 'DeepSeek Harness'); assert.equal(new URL(page.url()).search, '');
  await send(page, 'R0_HELLO ' + tenant.marker, tenant.reply);
  probe.assertHealthy();
 }
 assert.ok(wsCount >= 2);
 console.log('PASS R0 original Web UI, HTTP RPC and WebSocket for two independent tenants (synthetic model)');

 stage = 'image, file upload and generated download';
 const page = pages[0]!;
 await page.locator('input[type=file]').setInputFiles([
  { name: 'sample.png', mimeType: 'image/png', buffer: png },
  { name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('R0_UPLOAD_NOTE') },
 ]);
 await page.getByText('note.txt', { exact: true }).last().waitFor();
 await send(page, 'R0_EXPORT ' + tenants[0]!.marker, 'R0_FILE_READY');
 assert.ok(tenants[0]!.sawImage && tenants[0]!.wrote && tenants[0]!.presented);
 assert.equal(readFileSync(join(tenants[0]!.workspace, 'deepseek-harness/default-workspace/report.txt'), 'utf8'), tenants[0]!.marker + '\n');
 await page.getByRole('button', { name: '在侧边栏预览 /tenant/workspace/deepseek-harness/default-workspace/report.txt', exact: true }).click();
 await page.getByText(tenants[0]!.marker, { exact: true }).last().waitFor();
 await page.screenshot({ path: '/tmp/office-r0-ui.png' });
 console.log('PASS R0 native image input, text upload and real write/present tools');

 stage = 'data and cookie isolation';
 const lists = await Promise.all([sessionList(0), sessionList(1)]);
 assert.ok(lists[0]!.length && lists[1]!.length);

 const ids = lists.map(items => items.map(item => item.sessionId));
 assert.ok(ids[0]!.every(id => !ids[1]!.includes(id)));
 assert.equal((await pages[0]!.request.get(probes[1]!.url + '/api/session/list')).status(), 401);
 console.log('PASS R0 separate session lists and cross-instance cookie rejection');
 const ownRead = await rpc(page, probes[0]!.url, 'workspaceFiles/read', {
  workspaceFileScopeId: ids[0]![0], path: 'report.txt', range: {},
 });
 assert.equal(ownRead.ok, true, JSON.stringify(ownRead));
 assert.equal(ownRead.value.text, tenants[0]!.marker);
 const foreignRead = await rpc(page, probes[0]!.url, 'workspaceFiles/read', {
  workspaceFileScopeId: ids[1]![0], path: 'report.txt', range: {},
 });
 assert.equal(foreignRead.ok, false); assert.match(foreignRead.error.code, /not-found/);
 const ownKnowledge = await rpc(page, probes[0]!.url, 'workspaceFiles/read', {
  workspaceFileScopeId: ids[0]![0], path: '/knowledge/' + grant.id + '/note.txt', range: {},
 });
 assert.equal(ownKnowledge.ok, true); assert.equal(ownKnowledge.value.text, 'R0_SHARED_READ_ONLY');
 const deniedKnowledge = await rpc(pages[1]!, probes[1]!.url, 'workspaceFiles/read', {
  workspaceFileScopeId: ids[1]![0], path: '/knowledge/' + grant.id + '/note.txt', range: {},
 });
 assert.equal(deniedKnowledge.ok, false);
 // The pinned official preview has no general browser download button. This test
 // exercises its authenticated binary Remote then the browser's download API;
 // a small native UI contribution remains an explicit R1 integration item.
 const downloading = page.waitForEvent('download');
 await page.evaluate(async ({ sessionId }) => {
  const method = 'workspaceFiles/readBytes';
  const result = await fetch('/api/' + method, { method: 'POST', headers: { 'Content-Type': 'application/json' },
   body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method,
    payload: { args: { workspaceFileScopeId: sessionId, path: 'report.txt', options: {} } } }) });
  if (!result.ok || !result.headers.get('content-type')?.includes('multipart/')) throw new Error('Native binary route failed');
  const parts = await result.formData();
  const files = [...parts.values()].filter((part): part is File => part instanceof File);
  if (files.length !== 1) throw new Error('Unexpected native attachment count');
  const url = URL.createObjectURL(files[0]!);
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'report.txt';
  document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 500);
 }, { sessionId: ids[0]![0]! });
 const download = await downloading;
 assert.equal(download.suggestedFilename(), 'report.txt');
 assert.equal(readFileSync((await download.path())!, 'utf8'), tenants[0]!.marker + '\n');
 console.log('PASS R0 native preview, authenticated binary transfer and browser download (test harness action)');
 const cookies = (await contexts[0]!.cookies()).map(item => item.name + '=' + item.value).join('; ');
 await new Promise<void>((resolve, reject) => {
  const req = httpRequest(probes[1]!.url + '/api/remote.mux', { headers: {
   Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
   'Sec-WebSocket-Key': Buffer.alloc(16, 1).toString('base64'), Cookie: cookies, Origin: probes[1]!.url,
  } });
  req.once('response', response => { try { assert.equal(response.statusCode, 401); response.resume(); resolve(); } catch(error) { reject(error); } });
  req.once('upgrade', (_response, socket) => { socket.destroy(); reject(new Error('Foreign cookie admitted WebSocket')); });
  req.once('error', reject); req.setTimeout(5000, () => { req.destroy(); reject(new Error('WebSocket rejection timeout')); }); req.end();
 });
 console.log('PASS R0 foreign session/file/knowledge and WebSocket-cookie rejection');


 stage = 'OS and network isolation';
 for (let index = 0; index < 2; index++) {
  const tenant = tenants[index]!;
  const script = `const f=require('node:fs'),a=require('node:assert/strict'),net=require('node:net');
   a.notEqual(process.getuid(),0);a.equal(f.readFileSync('/tenant/workspace/private.txt','utf8'),${JSON.stringify(tenant.marker)});
   a.equal(f.readFileSync('/proc/net/route','utf8').trim().split('\\n').length,1);
   a.equal(process.env.SSH_AUTH_SOCK,undefined);a.equal(process.env.DEEPSEEK_API_KEY,undefined);
   for(const p of ['/var/run/docker.sock','/run/docker.sock','/Users',${JSON.stringify(tenants[1-index]!.workspace)}])a.equal(f.existsSync(p),false);
   const note='/knowledge/${grant.id}/note.txt';
   ${index === 0 ? "a.equal(f.readFileSync(note,'utf8'),'R0_SHARED_READ_ONLY');for(const op of [()=>f.writeFileSync(note,'bad'),()=>f.unlinkSync(note),()=>f.renameSync(note,note+'.moved')])a.throws(op,e=>['EROFS','EACCES','EPERM'].includes(e.code));" : "a.equal(f.existsSync(note),false);"}
   Promise.all(['1.1.1.1','10.0.0.1','host.docker.internal'].map(host=>new Promise((resolve,reject)=>{
    const s=net.connect({host,port:443});s.once('connect',()=>{s.destroy();reject(Error('Unexpected network route'));});
    s.once('error',()=>resolve());s.setTimeout(500,()=>{s.destroy();resolve();});
   }))).then(()=>console.log('isolated'),()=>process.exit(1));`;
  assert.equal(await probes[index]!.exec(script), 'isolated');
 }
 assert.equal(hashBytes(readFileSync(join(grant.path, 'note.txt'))), knowledgeHash);
 console.log('PASS R0 read-only grants, unmounted tenant data, no host sockets and no external network');
 stage = 'fresh-container history and continued conversation';
 for (let index = 0; index < 2; index++) {
  const tenant = tenants[index]!;
  await probes[index]!.close();
  const next = new NativeWebProbe({ image, ...tenant, scope, grants: index === 0 ? [grant] : [], model: fixture(tenant) });
  probes[index] = next; await next.start();
  const restored = pages[index]!;
  await restored.goto(next.bootstrapUrl);
  await restored.getByText('R0_HELLO ' + tenant.marker, { exact: true }).first().click();
  await restored.getByText(tenant.reply, { exact: true }).last().waitFor();
  await send(restored, 'R0_RECALL ' + tenant.marker, 'R0_RESTORED_' + tenant.label);
  if (index === 0) assert.equal(readFileSync(join(tenant.workspace, 'deepseek-harness/default-workspace/report.txt'), 'utf8'), tenant.marker + '\n');
 }
 console.log('PASS R0 new-container history recovery and continued native Web conversation for A/B');
 for (const probe of probes) probe.assertHealthy();
 console.log('PASS R0 native Web dual-instance feasibility');
} catch (error) {
 console.error(JSON.stringify({ status: 'FAIL', stage, diagnostic: error instanceof Error ? error.message.slice(0, 1400).replace(/token=[^\s"']+/g, 'token=[redacted]') : 'Unknown' }));
 if (pages[0]) console.log('synthetic test DOM:', (await pages[0].locator('body').innerText().catch(()=>'' )).slice(-3500));
 process.exitCode = 1;
} finally {
 await browser?.close();
 for (const probe of probes) await probe.close();
 rmSync(root, { recursive: true, force: true });
}
