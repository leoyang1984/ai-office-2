import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import type { BrowserContext, Page } from 'playwright-core';
import { OfficeError } from '../../apps/api/src/errors.ts';
import { createApp } from '../../apps/api/src/app.ts';
import { lockDataRoot } from '../../apps/api/src/data-lock.ts';
import { defaultNativeStorage } from '../../apps/api/src/native-storage.ts';
import { Runner } from '../../apps/api/src/runner.ts';
import { hashBytes, hashPassword, temporaryPassword } from '../../apps/api/src/security.ts';
import { Store } from '../../apps/api/src/store.ts';
import type { ModelBroker } from '../../packages/dsh-adapter/src/index.ts';

const docker = (...args: string[]) => execFileSync('docker', ['--context', 'desktop-linux', ...args],
  { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sdkImage = docker('image', 'inspect', '--format={{.Id}}', 'ai-office-2-dsh:p3-0.2.2-rc.1');
const webImage = docker('image', 'inspect', '--format={{.Id}}', 'ai-office-2-dsh-web:r3-0.2.2-rc.1');
const testRoot = realpathSync(mkdtempSync(join(tmpdir(), 'office-r4-migration-')));
const source = join(testRoot, 'legacy'), snapshot = join(testRoot, 'before'), migrated = join(testRoot, 'migrated');
const checkpoint = join(testRoot, 'after'), recovered = join(testRoot, 'recovered'), rollback = join(testRoot, 'rollback');
const ports = await new Promise<number>(resolve => {
  const listener = createServer();
  listener.listen(0, '127.0.0.1', () => {
    const address = listener.address();
    assert.ok(address && typeof address === 'object');
    listener.close(() => resolve(address.port));
  });
});
const origin = 'http://127.0.0.1:' + ports;
const execute = promisify(execFile);
const cli = (...args: string[]) => execute(process.execPath, ['apps/api/src/maintenance.ts', ...args], {
  env: { ...process.env, AI_OFFICE_DATA_ROOT: source },
  timeout: 180_000, maxBuffer: 8192,
});
const backup = (root: string, destination: string) => execute(process.execPath, ['apps/api/src/maintenance.ts', 'backup', destination], {
  env: { ...process.env, AI_OFFICE_DATA_ROOT: root },
  timeout: 45_000, maxBuffer: 8192,
});
function contentHash(root: string, relativePaths: string[]) {
  const hash = createHash('sha256');
  function add(relative: string) {
    const path = join(root, relative);
    hash.update(JSON.stringify(relative));
    if (lstatSync(path).isDirectory()) {
      for (const name of readdirSync(path).sort()) add(relative + '/' + name);
    } else hash.update(readFileSync(path));
  }
  for (const path of relativePaths) add(path);
  return hash.digest('hex');
}
const tracked = ['db/office.sqlite', 'db/native-skills.sqlite', 'users', 'knowledge', 'skills'];
const fixture = (name: string) => ({ name, id: '', password: temporaryPassword() });
const a = fixture('legacy-alice'), b = fixture('legacy-bob'), disabled = fixture('legacy-disabled');
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let rollbackRelease: (() => void) | undefined;
let stage = 'fixture';
let nativeContinued = false, sdkContinued = false;
const diagnostics: string[] = [];
const model: ModelBroker = async body => {
  const input = JSON.parse(body);
  const all = JSON.stringify(input.messages), last = JSON.stringify(input.messages.at(-1));
  let reply: string;
  if (all.includes('R4_NATIVE_NEXT')) {
    assert.ok(all.includes('R4_LEGACY_PROMPT_A') && all.includes('R4_LEGACY_REPLY_A'));
    assert.ok(!all.includes('R4_LEGACY_REPLY_B'));
    nativeContinued = true;
    reply = 'R4_NATIVE_REPLY';
  } else if (last.includes('R4_ROLLBACK_NEXT')) {
    assert.ok(all.includes('R4_LEGACY_REPLY_A'));
    assert.ok(!all.includes('R4_NATIVE_REPLY'));
    sdkContinued = true;
    reply = 'R4_ROLLBACK_REPLY';
  } else if (last.includes('R4_LEGACY_PROMPT_A')) reply = 'R4_LEGACY_REPLY_A';
  else if (last.includes('R4_LEGACY_PROMPT_B')) reply = 'R4_LEGACY_REPLY_B';
  else throw new Error('Unexpected synthetic model request');
  const event = (type: string, fields: object) => 'event: ' + type + '\ndata: ' + JSON.stringify({ type, ...fields }) + '\n\n';
  return new Response(event('message_start', { message: { id: 'msg_' + randomUUID(), type: 'message', role: 'assistant',
    model: input.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } })
    + event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
    + event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: reply } })
    + event('content_block_stop', { index: 0 })
    + event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } })
    + event('message_stop', {}), { headers: { 'Content-Type': 'text/event-stream' } });
};
async function start(root: string, native: boolean) {
  if (!native) rollbackRelease = lockDataRoot(root, true);
  app = await createApp({ dataRoot: root, origin, serveWeb: true,
    ...(native ? { nativeWeb: { image: webImage, skills: true, model, onError(error: unknown) {
      if (error instanceof OfficeError) return;
      diagnostics.push(String(error).replace(/token=[^\s"']+/g, 'token=[redacted]').slice(0, 300));
    } } } : { runtime: { image: sdkImage, model } }),
  });
  await app.listen({ host: '127.0.0.1', port: ports });
}
async function stop() {
  await app?.close();
  app = undefined;
  rollbackRelease?.();
  rollbackRelease = undefined;
}
async function call(context: BrowserContext, path: string, method = 'GET', data?: unknown, status = 200) {
  const res = await context.request.fetch(origin + path, { method, data, headers: { Origin: origin }, maxRedirects: 0 });
  assert.equal(res.status(), status, method + ' ' + path + ' expected ' + status);
  return res;
}
async function login(context: BrowserContext, who: typeof a) {
  const result = await call(context, '/api/v1/auth/login', 'POST', { username: who.name, password: who.password });
  const account = await result.json();
  assert.equal(account.id, who.id);
  assert.equal(account.mustChangePassword, false);
}
async function rpc(context: BrowserContext, method: string, args: object) {
  const res = await call(context, '/dsh/api/' + method, 'POST', {
    type: 'client-request', method, rpcId: randomUUID(), payload: { args },
  });
  return (await res.json()).result;
}
const events = (context: BrowserContext, id: string) => rpc(context, 'session/events', {
  request: { address: { kind: 'session', sessionId: id }, maxMessages: 40 },
});
const list = (context: BrowserContext) => rpc(context, 'session/list', { _request: {} });
async function openHistory(page: Page, project: string, title: string) {
  await page.goto(origin + '/dsh/');
  await page.getByText(project, { exact: true }).first().waitFor();
  for (let i = 0; i < 8; i++) {
    const collapsed = page.locator('[role=treeitem][aria-expanded=false]');
    if (!await collapsed.count()) break;
    await collapsed.first().click();
  }
  await page.getByText(title, { exact: true }).first().click();
  await page.getByText('R4_LEGACY_REPLY_A', { exact: true }).waitFor();
}

try {
  const store = new Store(source);
  const runner = new Runner(store, { image: sdkImage, model });
  let chatA: string, chatB: string, sidA: string, sidB: string, archiveId: string, missingId: string;
  let oldSession: string, uploadId: string, publicId: string, kbId: string;
  try {
    for (const who of [a, b, disabled]) {
      const initial = temporaryPassword();
      who.id = store.createUser({ username: who.name, displayName: who.name, passwordHash: await hashPassword(initial) }, 'USER').id;
      const token = store.changePassword(store.credentials(who.name)!, await hashPassword(who.password));
      if (who === a) oldSession = token;
    }
    const knowledge = join(source, 'knowledge', 'fixture');
    mkdirSync(knowledge);
    writeFileSync(join(knowledge, 'note.txt'), 'R4_KNOWLEDGE');
    kbId = store.registerKnowledge('R4 library', 'fixture').id;
    store.setGrant(a.id, kbId, true);
    store.enableSkills(defaultNativeStorage);
    const skills = store.skillCatalog!;
    const skill = (name: string, instructions: string) => ({ name, instructions, description: 'Synthetic ' + name, version: '1.0.0', resources: [] });
    publicId = skills.installPublic(skill('team-fixture', 'R4_PUBLIC_SKILL')).id;
    skills.setGrant(a.id, publicId, true);
    skills.savePersonal(a.id, skill('my-fixture', 'R4_PRIVATE_A'));
    skills.savePersonal(b.id, skill('my-fixture', 'R4_PRIVATE_B'));
    uploadId = store.addFile(a.id, 'upload.txt', 'text/plain', Buffer.from('R4_UPLOADED_BYTES')).id;

    chatA = store.createConversation(a.id, 'Legacy Alice archive').id;
    chatB = store.createConversation(b.id, 'Legacy Bob archive').id;
    await runner.send(a.id, chatA, randomUUID(), 'R4_LEGACY_PROMPT_A');
    await runner.send(b.id, chatB, randomUUID(), 'R4_LEGACY_PROMPT_B');
    sidA = store.workerTarget(a.id, chatA).sessionId!;
    sidB = store.workerTarget(b.id, chatB).sessionId!;
    assert.ok(sidA && sidB && sidA !== sidB);
    const project = join(store.workerTarget(a.id, chatA).workspace, 'projects', chatA);
    writeFileSync(join(project, 'old-project.txt'), 'R4_ORIGINAL_PROJECT_BYTES');

    archiveId = store.createConversation(a.id, 'Mock archive').id;
    await new Runner(store).send(a.id, archiveId, randomUUID(), 'R4_MOCK_ONLY');
    missingId = store.createConversation(a.id, 'Unavailable legacy history').id;
    const missingTurn = store.reserveTurn(a.id, missingId, randomUUID(), 'R4_SQL_ONLY_WITH_ID')!;
    // A foreign ID in the old index must not make the other user's history importable.
    store.finishTurn(a.id, missingId, missingTurn, { text: 'R4_ARCHIVE_ONLY' }, sidB);
    const inactiveId = store.createConversation(disabled.id, 'Disabled account history').id;
    const inactiveTurn = store.reserveTurn(disabled.id, inactiveId, randomUUID(), 'R4_INACTIVE')!;
    store.finishTurn(disabled.id, inactiveId, inactiveTurn, { text: 'R4_INACTIVE_ARCHIVE' }, randomUUID());
    store.updateUser(disabled.id, 'disabled');
  } finally {
    await runner.close();
    store.close();
  }
  console.log('PASS R4 seeded two real SDK sessions, SQL-only history, accounts, files, knowledge and Skill grants');

  stage = 'backup and corruption verification';
  const before = contentHash(source, tracked);
  await cli('backup', snapshot);
  const checked = JSON.parse((await cli('verify', snapshot)).stdout);
  assert.equal(checked.format, 2);
  assert.equal(checked.skills, true);
  const snapshotHash = contentHash(snapshot, ['db', 'users', 'knowledge', 'skills', '.ai-office-2-snapshot.json']);
  const bad = join(testRoot, 'tampered');
  cpSync(snapshot, bad, { recursive: true });
  writeFileSync(join(bad, 'skills', publicId, 'SKILL.md'), 'corrupted fixture');
  await assert.rejects(cli('verify', bad));
  const rejected = join(testRoot, 'rejected');
  await assert.rejects(cli('restore', bad, rejected));
  assert.ok(!existsSync(rejected));
  const badDb = join(testRoot, 'damaged-sqlite');
  cpSync(snapshot, badDb, { recursive: true });
  const dbBytes = 'not a database';
  writeFileSync(join(badDb, 'db', 'native-skills.sqlite'), dbBytes);
  const manifestPath = join(badDb, '.ai-office-2-snapshot.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.files['db/native-skills.sqlite'] = hashBytes(dbBytes);
  writeFileSync(manifestPath, JSON.stringify(manifest));
  await assert.rejects(cli('verify', badDb), /SQLITE_NOTADB/);
  console.log('PASS R4 verified SQLite/files/Skill snapshot; tampered Skill rejected before restore');

  stage = 'offline migration';
  const result = JSON.parse((await cli('migrate', snapshot, migrated)).stdout);
  assert.deepEqual(result, { adopted: 2, archive: 3 });
  const report = JSON.parse(readFileSync(join(migrated, 'db', 'native-migration.json'), 'utf8'));
  assert.equal(report.records.find((row: { conversationId: string }) => row.conversationId === chatA).sessionId, sidA);
  assert.equal(report.records.find((row: { conversationId: string }) => row.conversationId === chatB).sessionId, sidB);
  assert.equal(report.records.find((row: { conversationId: string }) => row.conversationId === archiveId).reason, 'no-native-id');
  assert.equal(report.records.find((row: { conversationId: string }) => row.conversationId === missingId).reason, 'history-unavailable');
  assert.ok(report.records.some((row: { reason?: string }) => row.reason === 'account-inactive'));
  await assert.rejects(cli('migrate', snapshot, migrated));
  assert.equal(contentHash(source, tracked), before);
  assert.equal(contentHash(snapshot, ['db', 'users', 'knowledge', 'skills', '.ai-office-2-snapshot.json']), snapshotHash);
  console.log('PASS R4 migration records original session IDs and archive reasons, and refuses an existing destination');

  stage = 'migrated account and original browser continuation';
  await start(migrated, true);
  const runningBackup = join(testRoot, 'blocked-backup');
  await assert.rejects(backup(migrated, runningBackup));
  assert.ok(!existsSync(runningBackup));
  browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, chromiumSandbox: true });
  const ctxA = await browser.newContext(), ctxB = await browser.newContext(), stale = await browser.newContext();
  await stale.addCookies([{ name: 'office_session', value: oldSession!, url: origin }]);
  await call(stale, '/api/v1/auth/me', 'GET', undefined, 401);
  await call(stale, '/api/v1/auth/login', 'POST', { username: disabled.name, password: disabled.password }, 401);
  await login(ctxA, a);
  await login(ctxB, b);
  const page = await ctxA.newPage();
  page.on('response', response => {
    if (!response.url().endsWith('/dsh/api/session/prompt')) return;
    void response.json().then(body => {
      diagnostics.push('Prompt HTTP ' + response.status() + ' ' + (body.error?.code ?? body.result?.error?.code ?? 'accepted'));
    }).catch(() => diagnostics.push('Prompt response interrupted'));
  });
  await page.goto(origin + '/?manage=1');
  await page.getByRole('button', { name: 'Mock archive', exact: true }).click();
  await page.getByRole('article', { name: '旧版对话正文' }).getByText('你 R4_MOCK_ONLY', { exact: true }).waitFor();
  await call(ctxA, '/api/v1/conversations/' + chatB, 'GET', undefined, 404);
  assert.equal(await (await call(ctxA, '/api/v1/files/' + uploadId + '/download')).text(), 'R4_UPLOADED_BYTES');
  assert.equal((await (await call(ctxA, '/api/v1/knowledge')).json())[0].id, kbId);
  const libraryA = await (await call(ctxA, '/api/v1/skills')).json();
  const libraryB = await (await call(ctxB, '/api/v1/skills')).json();
  assert.equal(libraryA.public[0].id, publicId);
  assert.deepEqual(libraryB.public, []);
  assert.equal((await (await call(ctxA, '/api/v1/skills/personal/my-fixture')).json()).instructions, 'R4_PRIVATE_A');
  assert.equal((await (await call(ctxB, '/api/v1/skills/personal/my-fixture')).json()).instructions, 'R4_PRIVATE_B');

  await call(ctxA, '/dsh/');
  const items = (await list(ctxA)).value.items;
  const row = items.find((item: { sessionId: string }) => item.sessionId === sidA);
  assert.ok(row && !items.some((item: { sessionId: string }) => item.sessionId === sidB));
  const title = row.projections.values.title;
  assert.equal(typeof title, 'string');
  const originalFile = await rpc(ctxA, 'workspaceFiles/read', { workspaceFileScopeId: sidA, path: 'old-project.txt', range: {} });
  assert.match(JSON.stringify(originalFile.value), /R4_ORIGINAL_PROJECT_BYTES/);
  const kbFile = await rpc(ctxA, 'workspaceFiles/read', { workspaceFileScopeId: sidA, path: '/knowledge/' + kbId + '/note.txt', range: {} });
  assert.match(JSON.stringify(kbFile.value), /R4_KNOWLEDGE/);
  const nativeSkills = await rpc(ctxA, 'skills/list', { request: { sessionId: sidA } });
  assert.deepEqual(nativeSkills.value.skills.map((item: { name: string }) => item.name).sort(), ['my-fixture', 'team-fixture']);
  await openHistory(page, chatA, title);
  await page.locator('[data-composer-input][contenteditable=true]').fill('R4_NATIVE_NEXT');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.getByText('R4_NATIVE_REPLY', { exact: true }).waitFor({ timeout: 55000 });
  assert.ok(nativeContinued);
  let settled = false;
  for (let i = 0; i < 100 && !settled; i++) {
    const state = await rpc(ctxA, 'session/state', { request: { sessionId: sidA } });
    const saved = await events(ctxA, sidA);
    settled = state.ok && !state.value.running && state.value.queue?.length === 0 &&
      saved.ok && JSON.stringify(saved.value).includes('R4_NATIVE_REPLY');
    if (!settled) await delay(50);
  }
  assert.ok(settled, 'Wait for the native continuation to be stored before taking a snapshot');
  await call(ctxB, '/dsh/');
  const historyB = await events(ctxB, sidB);
  assert.match(JSON.stringify(historyB.value), /R4_LEGACY_REPLY_B/);
  assert.equal((await events(ctxB, sidA)).ok, false);
  await stop();
  console.log('PASS R4 restored auth and permissions, browser archive and same-session original DSH continuation');

  stage = 'post-migration backup and restore';
  await backup(migrated, checkpoint);
  assert.equal(JSON.parse((await cli('verify', checkpoint)).stdout).skills, true);
  await cli('restore', checkpoint, recovered);
  assert.deepEqual(readFileSync(join(recovered, 'db', 'native-migration.json')), readFileSync(join(migrated, 'db', 'native-migration.json')));
  await start(recovered, true);
  const restoredCtx = await browser.newContext();
  await login(restoredCtx, a);
  await call(restoredCtx, '/dsh/');
  const restored = await events(restoredCtx, sidA);
  assert.match(JSON.stringify(restored.value), /R4_NATIVE_REPLY/);
  assert.equal((await (await call(restoredCtx, '/api/v1/skills')).json()).public[0].id, publicId);
  await stop();
  console.log('PASS R4 recovered native continuation, migration report and Skill grants from the new snapshot');

  stage = 'rollback into old SDK';
  await cli('restore', snapshot, rollback);
  await start(rollback, false);
  const oldCtx = await browser.newContext();
  await login(oldCtx, a);
  const rolled = await (await call(oldCtx, '/api/v1/conversations/' + chatA + '/messages', 'POST', {
    text: 'R4_ROLLBACK_NEXT', requestId: randomUUID(),
  })).json();
  assert.ok(sdkContinued);
  assert.ok(rolled.messages.some((item: { text: string }) => item.text === 'R4_ROLLBACK_REPLY'));
  await browser.close();
  browser = undefined;
  await stop();
  assert.equal(contentHash(source, tracked), before);
  assert.equal(contentHash(snapshot, ['db', 'users', 'knowledge', 'skills', '.ai-office-2-snapshot.json']), snapshotHash);
  console.log('PASS R4 rollback restored pre-migration snapshot and continued the same old SDK session');
} catch (error) {
  console.error(JSON.stringify({
    stage, diagnostic: String(error).replace(/token=[^\s"']+/g, 'token=[redacted]').slice(0, 1400),
    nativeContinued, recent: diagnostics.slice(-10),
  }));
  process.exitCode = 1;
} finally {
  await browser?.close();
  await stop();
  for (const root of [source, migrated, recovered, rollback]) {
    const workers = docker('ps', '-aq', '--filter', 'label=ai-office-2.scope=' + hashBytes(root));
    assert.equal(workers, '', 'Synthetic containers must stop before removing data');
  }
  rmSync(testRoot, { recursive: true, force: true });
}
