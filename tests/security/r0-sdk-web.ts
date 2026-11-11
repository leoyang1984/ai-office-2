import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { NativeWebProbe } from '../../packages/dsh-web-probe/src/relay.ts';
import { hashBytes } from '../../apps/api/src/security.ts';
import { runDshWorker } from '../../packages/dsh-adapter/src/index.ts';
import type { ModelBroker } from '../../packages/dsh-adapter/src/index.ts';
const dockerImage = (tag: string) => execFileSync('docker', ['--context', 'desktop-linux', 'image', 'inspect', '--format={{.Id}}', tag], { encoding: 'utf8', timeout: 8000 }).trim();
const root = realpathSync(mkdtempSync(join(tmpdir(), 'office-r0-sdk-web-')));
const home = join(root, 'home'), workspace = join(root, 'workspace'), projectId = randomUUID(), scope = hashBytes(root);
mkdirSync(home, { recursive: true }); mkdirSync(join(workspace, 'projects', projectId), { recursive: true });
const marker = 'R0_SDK_' + randomUUID().slice(0, 8);
let continued = false;
let modelCalls = 0;
const event = (type: string, fields: object) => 'event: ' + type + '\ndata: ' + JSON.stringify({ type, ...fields }) + '\n\n';
const model: ModelBroker = async body => {
 modelCalls++;
 const input = JSON.parse(body), text = JSON.stringify(input.messages);
 assert.ok(text.includes(marker));
 const reply = text.includes('R0_WEB_CONTINUE') ? 'R0_WEB_CONTINUED' : 'R0_SDK_REPLY';
 if (reply === 'R0_WEB_CONTINUED') { assert.ok(text.includes('R0_SDK_REPLY')); continued = true; }
 return new Response(event('message_start', { message: { id: 'msg_' + randomUUID(), type: 'message', role: 'assistant', model: input.model,
 content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }) +
 event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
 event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: reply } }) +
 event('content_block_stop', { index: 0 }) + event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } }) +
 event('message_stop', {}), { headers: { 'Content-Type': 'text/event-stream' } });
};
let probe: NativeWebProbe | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let stage = 'SDK synthetic seed';
try {
 const seeded = await runDshWorker({ image: dockerImage('ai-office-2-dsh:p3-0.2.2-rc.1'), home, workspace, projectId, scope,
 grants: [], turnId: randomUUID(), text: 'R0_SDK_HELLO ' + marker, signal: AbortSignal.timeout(90_000), model });
 assert.equal(seeded.text, 'R0_SDK_REPLY');
 console.log('PASS R0 SDK synthetic seed with isolated persistent home');
 stage = 'Web discovery and history';
 probe = new NativeWebProbe({ image: dockerImage('ai-office-2-dsh-web:r0-0.2.2-rc.1'), home, workspace, projectId, scope, grants: [], model });
 await probe.start();
 browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, chromiumSandbox: true });
 const page = await browser.newPage(); await page.goto(probe.bootstrapUrl);
 await page.getByRole('button', { name: '继续', exact: true }).click();
 async function rpc(method: string, args: object) {
  const response = await page.request.post(probe!.url + '/api/' + method, { data: { type: 'client-request', rpcId: randomUUID(), method, payload: { args } } });
  assert.equal(response.status(), 200); return (await response.json()).result;
 }
 const listed = await rpc('session/list', { _request: {} });
 assert.equal(listed.ok, true); assert.ok(listed.value.items.some((item: { sessionId: string }) => item.sessionId === seeded.sessionId));
 const history = await rpc('session/events', { request: { address: { kind: 'session', sessionId: seeded.sessionId }, maxMessages: 50 } });
 assert.equal(history.ok, true, JSON.stringify(history)); assert.ok(JSON.stringify(history.value).includes('R0_SDK_REPLY'));
 console.log('PASS R0 official Web discovers and reads the same-version SDK session');
 const adopted = await rpc('workspace/create', { request: { path: '/tenant/workspace/projects/' + projectId } });
 assert.equal(adopted.ok, true, JSON.stringify(adopted));
 stage = 'SDK activation without a new model turn';
 const callsBeforeActivation = modelCalls;
 const selected = await rpc('session/selectModel', {request:{sessionId:seeded.sessionId,provider:'deepseek-official',model:'deepseek-flash',reasoningEffort:'off'}});
 assert.equal(selected.ok,true,JSON.stringify(selected)); assert.equal(continued,false); assert.equal(modelCalls,callsBeforeActivation);
 const activated = await rpc('session/list', {_request:{}});
 assert.equal(activated.value.items.find((item:{sessionId:string})=>item.sessionId===seeded.sessionId)?.agentAvailable,true);
 const actualTitle=activated.value.items.find((item:{sessionId:string})=>item.sessionId===seeded.sessionId)?.projections.values.title;
 assert.equal(actualTitle,'R0_SDK_HELLO '+marker);
 stage = 'SDK history in original UI';
 await page.getByText(projectId,{exact:true}).first().waitFor();
 for(let i=0;i<8;i++){const collapsed=page.locator('[role=treeitem][aria-expanded=false]');if(await collapsed.count()===0)break;await collapsed.first().click();}
 await page.getByText(actualTitle, { exact: true }).first().click({ timeout: 15_000 });
 await page.getByText('R0_SDK_REPLY', { exact: true }).last().waitFor({timeout:15000});
 console.log('PASS R0 SDK history rendered in original Web after native workspace registration and activation');
 stage = 'continue SDK history through original UI';
 await page.locator('[data-composer-input][contenteditable=true]').fill('R0_WEB_CONTINUE '+marker);
 await page.getByRole('button',{name:'发送消息',exact:true}).click();
 await page.getByText('R0_WEB_CONTINUED',{exact:true}).last().waitFor({timeout:55000});
 assert.ok(continued);probe.assertHealthy();
 console.log('PASS R0 SDK session continued through original Web UI with prior history');
} catch (error) {
 console.error(JSON.stringify({ status: 'FAIL', stage, diagnostic: error instanceof Error ? error.message.slice(0, 1400).replace(/token=[^\s"']+/g, 'token=[redacted]') : 'Unknown' }));
 process.exitCode = 1;
} finally {
 await browser?.close(); await probe?.close(); rmSync(root, { recursive: true, force: true });
}
