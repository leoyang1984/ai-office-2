import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../apps/api/src/app.ts';
import { hashBytes, hashPassword, temporaryPassword } from '../../apps/api/src/security.ts';
import { Store } from '../../apps/api/src/store.ts';
import { cleanupOfficeWorkers } from '../../packages/dsh-adapter/src/index.ts';
import type { ModelBroker } from '../../packages/dsh-adapter/src/index.ts';

// Every destructive probe is restricted to a random synthetic data scope.
const docker = (...args: string[]) => execFileSync('docker', ['--context', 'desktop-linux', ...args],
  { encoding: 'utf8', timeout: 15_000, maxBuffer: 8192, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const image = docker('image', 'inspect', '--format={{.Id}}', 'ai-office-2-dsh:p3-0.2.2-rc.1');
const root = realpathSync(mkdtempSync(join(tmpdir(), 'office-p4-failures-')));
const dataRoot = join(root, 'data');
const scope = hashBytes(dataRoot);
const ownedWorkers = () => docker('ps', '-a', '--no-trunc', '--filter=label=ai-office-2.worker=true',
  '--filter=label=ai-office-2.scope=' + scope, '--format={{.ID}}').split(/\s+/).filter(Boolean);
const event = (type: string, fields: object) => 'event: ' + type + '\ndata: ' + JSON.stringify({ type, ...fields }) + '\n\n';
let hold = true;
let reached: (() => void) | undefined;
let release: (() => void) | undefined;
const model: ModelBroker = async (body, signal) => {
  if (hold) {
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      release = () => { signal.removeEventListener('abort', onAbort); resolve(); };
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', onAbort, { once: true });
      reached?.();
    });
  }
  const { model } = JSON.parse(body) as { model: string };
  return new Response(
    event('message_start', { message: { id: 'msg_' + randomUUID(), type: 'message', role: 'assistant', model,
      content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }) +
    event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
    event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'RECOVERED' } }) +
    event('content_block_stop', { index: 0 }) +
    event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }) +
    event('message_stop', {}), { headers: { 'Content-Type': 'text/event-stream' } });
};
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let stage = 'setup';
try {
  const store = new Store(dataRoot);
  const password = temporaryPassword();
  const user = store.createUser({ username: 'failure-fixture', displayName: 'Fixture', passwordHash: await hashPassword(password) }, 'USER');
  const sentinel = store.addFile(user.id, 'sentinel.txt', 'text/plain', Buffer.from('synthetic file must survive'));
  store.close();
  app = await createApp({ dataRoot, origin: 'http://127.0.0.1:3000', runtime: { image, model } });
  const api = app;
  const headers = { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' };
  const login = await api.inject({ method: 'POST', url: '/api/v1/auth/login', headers, payload: { username: user.username, password } });
  assert.equal(login.statusCode, 200);
  const changed = await api.inject({ method: 'POST', url: '/api/v1/auth/change-password',
    headers: { ...headers, cookie: String(login.headers['set-cookie']).split(';')[0] },
    payload: { currentPassword: password, newPassword: temporaryPassword() } });
  assert.equal(changed.statusCode, 200);
  const authenticated = { ...headers, cookie: String(changed.headers['set-cookie']).split(';')[0]! };
  const created = await api.inject({ method: 'POST', url: '/api/v1/conversations', headers: authenticated, payload: { title: 'Synthetic failure checks' } });
  assert.equal(created.statusCode, 201);
  const base = '/api/v1/conversations/' + created.json().id;
  const send = () => api.inject({ method: 'POST', url: base + '/messages', headers: authenticated,
    payload: { text: 'Synthetic failure check.', requestId: randomUUID() } });
  async function intact() {
    assert.deepEqual(ownedWorkers(), []);
    const downloaded = await api.inject({ url: '/api/v1/files/' + sentinel.id + '/download', headers: authenticated });
    assert.equal(downloaded.statusCode, 200);
    assert.equal(downloaded.body, 'synthetic file must survive');
  }
  for (const fault of ['container crash', 'DSH crash', 'tmpfs exhaustion', 'model timeout']) {
    stage = fault;
    hold = true;
    const entered = new Promise<void>(resolve => { reached = resolve; });
    const started = Date.now();
    const pending = send();
    await Promise.race([entered, pending.then(() => { throw new Error('Worker ended before model request'); })]);
    const ids = ownedWorkers();
    assert.equal(ids.length, 1);
    const id = ids[0]!;
    assert.match(id, /^[a-f0-9]{64}$/);
    if (fault === 'container crash') docker('kill', '--signal=KILL', id);
    if (fault === 'DSH crash') {
      // PID 1 is the bridge. Only its DSH child inside this test container is killed.
      const script = `const f=require('node:fs'),a=require('node:assert/strict');const pids=[];
        for(const name of f.readdirSync('/proc')){if(!/^\\d+$/.test(name)||+name===process.pid||+name===1)continue;
        try{if(/^PPid:\\s+1$/m.test(f.readFileSync('/proc/'+name+'/status','utf8')))pids.push(+name);}
        catch(e){if(e.code!=='ENOENT'&&e.code!=='ESRCH')throw e;}}
        a.equal(pids.length,1);process.kill(pids[0],'SIGKILL');console.log('DSH child killed');`;
      assert.equal(docker('exec', id, 'node', '-e', script), 'DSH child killed');
    }
    if (fault === 'tmpfs exhaustion') {
      // This writes at most 65 MiB to the container's 64 MiB tmpfs, never the host disk.
      const script = `const f=require('node:fs'),a=require('node:assert/strict');const p='/tmp/exhaustion-fixture';
        const fd=f.openSync(p,'wx'),b=Buffer.alloc(1024*1024);let denied=false;
        try{for(let n=0;n<65;n++)f.writeSync(fd,b);}catch(e){a.equal(e.code,'ENOSPC');denied=true;}
        finally{f.closeSync(fd);f.unlinkSync(p);}a.equal(denied,true);console.log('ENOSPC bounded');`;
      assert.equal(docker('exec', id, 'node', '-e', script), 'ENOSPC bounded');
      release?.();
    }
    const result = await pending;
    if (fault === 'tmpfs exhaustion') {
      assert.equal(result.statusCode, 200);
      assert.equal(result.json().messages.at(-1).text, 'RECOVERED');
    } else {
      assert.equal(result.statusCode, 500);
      assert.match(result.json().error.code, /^(WORKER_EXITED|DSH_TURN_FAILED|WORKER_TIMEOUT|MODEL_GATEWAY_FAILED)$/);
      if (fault === 'model timeout') assert.ok(Date.now() - started >= 70_000);
      const inspector = new Store(dataRoot);
      try {
        const events = inspector.events(user.id, created.json().id, 0);
        assert.equal(events.at(-1)?.type, 'failed');
      } finally { inspector.close(); }
    }
    await intact();
    hold = false;
    const recovered = await send();
    assert.equal(recovered.statusCode, 200);
    assert.equal(recovered.json().messages.at(-1).text, 'RECOVERED');
    await intact();
    console.log('PASS A20 ' + fault + ': scoped cleanup, intact file and next-turn recovery');
  }
} catch (error) {
  console.error(JSON.stringify({ status: 'FAIL', stage, diagnostic: error instanceof Error ? error.message.slice(0, 500) : 'Unknown' }));
  process.exitCode = 1;
} finally {
  await app?.close();
  await cleanupOfficeWorkers(scope);
  rmSync(root, { recursive: true, force: true });
}
