import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../apps/api/src/app.ts';
import { hashBytes, hashPassword, temporaryPassword } from '../../apps/api/src/security.ts';
import { Store } from '../../apps/api/src/store.ts';
import { cleanupOfficeWorkers } from '../../packages/dsh-adapter/src/index.ts';
import type { ModelBroker } from '../../packages/dsh-adapter/src/index.ts';

const ctx = ['--context', 'desktop-linux'];
const docker = (...args: string[]) => execFileSync('docker', [...ctx, ...args],
  { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const image = docker('image', 'inspect', '--format', '{{.Id}}', 'ai-office-2-dsh:p3-0.2.2-rc.1');
const root = mkdtempSync(join(tmpdir(), 'office-p4-runtime-'));
const dataRoot = join(root, 'data');
let stage = 'orphan cleanup';
const scopes = [hashBytes(randomUUID()), hashBytes(randomUUID())];
const workers: string[] = [];
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let entered = 0;
let releaseEntered!: () => void;
const twoRunning = new Promise<void>(resolve => { releaseEntered = resolve; });
const model: ModelBroker = async (_body, signal) => {
  if (++entered === 2) releaseEntered();
  await new Promise<void>((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  throw new Error('Unreachable');
};

try {
  for (const scope of scopes) {
    workers.push(docker('run', '-d', '--rm', '--network=none', '--read-only', '--user=1000:1000',
      '--label=ai-office-2.worker=true', '--label=ai-office-2.scope=' + scope, '--entrypoint=/bin/sh', image, '-c', 'sleep 60'));
  }
  await cleanupOfficeWorkers(scopes[0]!);
  assert.throws(() => docker('inspect', workers[0]!));
  assert.equal(docker('inspect', '--format={{.State.Running}}', workers[1]!), 'true');
  console.log('PASS cleanup removes only abandoned Workers in the selected data scope');

  stage = 'concurrent Worker limit and cancellation';
  const origin = 'http://127.0.0.1:3000';
  const headers = { host: '127.0.0.1:3000', origin };
  const store = new Store(dataRoot);
  const users: { username: string; password: string }[] = [];
  for (const username of ['user-one', 'user-two', 'user-three']) {
    const password = temporaryPassword();
    store.createUser({ username, displayName: username, passwordHash: await hashPassword(password) }, 'USER');
    users.push({ username, password });
  }
  store.close();
  app = await createApp({ dataRoot, origin, runtime: { image, model } });
  const api = app;
  async function login(user: typeof users[number]) {
    const authenticated = await api.inject({ method: 'POST', url: '/api/v1/auth/login', headers, payload: user });
    assert.equal(authenticated.statusCode, 200);
    const cookie = String(authenticated.headers['set-cookie']).split(';')[0];
    const replaced = await api.inject({ method: 'POST', url: '/api/v1/auth/change-password', headers: { ...headers, cookie },
      payload: { currentPassword: user.password, newPassword: temporaryPassword() } });
    assert.equal(replaced.statusCode, 200);
    return String(replaced.headers['set-cookie']).split(';')[0]!;
  }
  const cookies = await Promise.all(users.map(login));
  const makeChat = async (cookie: string) => {
    const result = await api.inject({ method: 'POST', url: '/api/v1/conversations', headers: { ...headers, cookie }, payload: { title: 'P4' } });
    assert.equal(result.statusCode, 201);
    return result.json().id as string;
  };
  const chats = await Promise.all(cookies.map(makeChat));
  const post = async (index: number, requestId: string) =>
    api.inject({ method: 'POST', url: '/api/v1/conversations/' + chats[index] + '/messages',
      headers: { ...headers, cookie: cookies[index] }, payload: { text: 'Hold this test request.', requestId } });
  const replayId = randomUUID();
  const first = post(0, replayId);
  const second = post(1, randomUUID());
  await Promise.race([
    twoRunning,
    first.then(response => { throw new Error('First Worker ended early: ' + response.statusCode); }),
    second.then(response => { throw new Error('Second Worker ended early: ' + response.statusCode); }),
  ]);
  assert.equal((await post(0, replayId)).statusCode, 409);
  assert.equal((await post(2, randomUUID())).statusCode, 429);
  assert.equal(entered, 2);
  for (const index of [0, 1]) {
    const result = await api.inject({ method: 'POST', url: '/api/v1/conversations/' + chats[index] + '/stop',
      headers: { ...headers, cookie: cookies[index] } });
    assert.equal(result.statusCode, 200);
  }
  assert.equal((await first).statusCode, 409);
  assert.equal((await second).statusCode, 409);
  console.log('PASS A18/A20/A22 concurrent dedupe, capacity limit and Worker cancellation');
} catch (error) {
  console.error(JSON.stringify({ status: 'FAIL', stage, type: error instanceof Error ? error.name : 'Unknown',
    ...(error instanceof Error ? { diagnostic: error.message.slice(0, 500) } : {}) }));
  process.exitCode = 1;
} finally {
  await app?.close();
  for (const scope of scopes) await cleanupOfficeWorkers(scope);
  rmSync(root, { recursive: true, force: true });
}
