import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { deepSeekBroker, runDshWorker, WorkerFailure, workerOptions } from '../../packages/dsh-adapter/src/index.ts';
import type { ModelBroker } from '../../packages/dsh-adapter/src/index.ts';

const command = promisify(execFile);
const cloud = process.argv[2] === 'cloud';
const key = cloud ? process.env.DEEPSEEK_API_KEY?.trim() : undefined;
if (cloud && !key) {
  console.error('BLOCKED: DEEPSEEK_API_KEY unavailable');
  process.exit(2);
}
const { stdout: imageValue } = await command('docker', [
  '--context', 'desktop-linux', 'image', 'inspect', '--format', '{{.Id}}', process.env.OFFICE_TEST_IMAGE ?? 'ai-office-2-dsh:p2-0.2.2-rc.1-r3',
], { timeout: 8000 });
const image = imageValue.trim();
const root = realpathSync(mkdtempSync(join(tmpdir(), 'ai-office-2-p2-')));
const signals = () => AbortSignal.timeout(130_000);
const granted = { id: randomUUID(), path: join(root, 'granted') };
const denied = { id: randomUUID(), path: join(root, 'denied') };
for (const path of [granted.path, denied.path]) {
  mkdirSync(path, { mode: 0o700 });
  writeFileSync(join(path, 'note.txt'), '合成数据', { mode: 0o600 });
}
const tenants = ['A', 'B'].map(label => {
  const workspace = join(root, label, 'workspace');
  const home = join(root, label, 'dsh-home');
  const projectId = randomUUID();
  mkdirSync(join(workspace, 'projects', projectId), { recursive: true, mode: 0o700 });
  mkdirSync(home, { mode: 0o700 });
  writeFileSync(join(workspace, 'private.txt'), '合成用户数据');
  writeFileSync(join(home, 'private.txt'), '合成会话数据');
  return { image, workspace, home, projectId, marker: 'P2-' + randomUUID() };
});

const event = (type: string, fields: object) => 'event: ' + type + '\ndata: ' + JSON.stringify({ type, ...fields }) + '\n\n';
const observed: { marker: string; resumed: boolean }[] = [];
const fixture: ModelBroker = async body => {
  const input = JSON.parse(body) as { model: string; messages: unknown[] };
  const messages = JSON.stringify(input.messages);
  const markers = tenants.filter(tenant => messages.includes(tenant.marker));
  assert.equal(markers.length, 1);
  const marker = markers[0]!.marker;
  const resumed = messages.includes('P2_RECALL');
  if (resumed) {
    assert.ok(messages.includes('P2_HELLO ' + marker));
    assert.ok(messages.includes('P2_REPLY ' + marker));
  }
  observed.push({ marker, resumed });
  return new Response(
    event('message_start', { message: { id: 'msg_p2_' + observed.length, type: 'message', role: 'assistant',
      model: input.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }) +
    event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
    event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'P2_REPLY ' + marker } }) +
    event('content_block_stop', { index: 0 }) +
    event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 6 } }) +
    event('message_stop', {}),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );
};
const model = key ? deepSeekBroker(key) : fixture;
const knowledgeHash = () => createHash('sha256').update(readFileSync(join(granted.path, 'note.txt'))).digest('hex');
const originalHash = knowledgeHash();
let stage = 'mounts';

async function checkMounts(grants: { id: string; path: string }[]) {
  const paths = JSON.stringify({ granted: granted.id, denied: denied.id, grantedExpected: grants.length === 1 });
  const options = workerOptions({ ...tenants[0]!, grants });
  const program = [
    'const f = require("node:fs"), a = require("node:assert/strict");',
    'const p = JSON.parse(process.argv[1]); const granted = "/knowledge/" + p.granted + "/note.txt";',
    'const expectDenied = operation => a.throws(operation, e => ["EACCES", "EPERM", "EROFS", "ENOENT"].includes(e.code));',
    'a.equal(process.arch, "arm64"); a.notEqual(process.getuid(), 0);',
    'a.match(f.readFileSync("/proc/self/status", "utf8"), /^NoNewPrivs:\\s+1$/m);',
    'f.writeFileSync("./p2.txt", "workspace RW"); f.writeFileSync("/tenant/dsh-home/proof.txt", "home RW");',
    'a.equal(process.env.DEEPSEEK_API_KEY, undefined); a.equal(process.env.SSH_AUTH_SOCK, undefined);',
    'a.equal(f.readFileSync("/proc/net/route", "utf8").trim().split("\\n").length, 1);',
    'for (const x of ["/tenant/B/workspace/private.txt", "/tenant/B/dsh-home/private.txt", "/knowledge/" + p.denied + "/note.txt", "/var/run/docker.sock", "/run/docker.sock", "/Users"]) expectDenied(() => f.openSync(x));',
    'if (p.grantedExpected) {',
    '  a.equal(f.readFileSync(granted, "utf8"), "合成数据");',
    '  for (const operation of [() => f.writeFileSync(granted,"changed"), () => f.unlinkSync(granted), () => f.renameSync(granted, granted + ".moved"), () => f.chmodSync(granted,0o777), () => f.symlinkSync("/tmp", granted + ".link")]) expectDenied(operation);',
    '} else expectDenied(() => f.readFileSync(granted));',
  ].join('\n');
  await command('docker', ['--context', 'desktop-linux', 'run', '--rm', ...options, '--entrypoint=node', image, '-e', program, paths],
    { timeout: 25_000, maxBuffer: 16 * 1024 });
  assert.equal(knowledgeHash(), originalHash);
  assert.equal(readFileSync(join(tenants[0]!.home, 'proof.txt'), 'utf8'), 'home RW');
  console.log(grants.length ? 'PASS A07-A11 actual Worker image mounts' : 'PASS knowledge absent after new Worker launch');
}

try {
  await checkMounts([granted]);
  const sessions: string[] = [];
  for (const tenant of tenants) {
    stage = 'initial turn';
    const result = await runDshWorker({
      ...tenant, grants: [], turnId: randomUUID(), signal: signals(), model,
      text: 'P2_HELLO ' + tenant.marker + '. Reply exactly "P2_REPLY ' + tenant.marker + '" without quotes. Do not use tools.',
    });
    assert.equal(result.text.trim(), 'P2_REPLY ' + tenant.marker);
    sessions.push(result.sessionId);
  }
  assert.notEqual(sessions[0], sessions[1]);
  stage = 'cross-home resume rejection';
  await assert.rejects(runDshWorker({
    ...tenants[1]!, grants: [], turnId: randomUUID(), signal: signals(), model, sessionId: sessions[0],
    text: 'This request must not be sent.',
  }), error => error instanceof WorkerFailure && error.code === 'DSH_INITIALIZE_FAILED');
  console.log('PASS A13 independent DSH Worker sessions');
  stage = 'new-container resume';
  for (const [index, tenant] of tenants.entries()) {
    const result = await runDshWorker({
      ...tenant, grants: [], turnId: randomUUID(), signal: signals(), model, sessionId: sessions[index],
      text: 'P2_RECALL. Repeat the full reply from the previous turn exactly. Do not use tools.',
    });
    assert.equal(result.text.trim(), 'P2_REPLY ' + tenant.marker);
  }
  if (!cloud) assert.equal(observed.filter(request => request.resumed).length, 2);
  console.log('PASS A15 new container resumes persisted history');
  stage = 'revoked mount';
  await checkMounts([]);
  console.log('PASS P2 Worker ' + (cloud ? 'real cloud model' : 'synthetic model fixture'));
} catch (error) {
  if (error instanceof WorkerFailure) {
    console.error(JSON.stringify({ status: 'FAIL', stage, code: error.code, httpStatus: error.httpStatus }));
  } else {
    console.error(JSON.stringify({ status: 'FAIL', stage, type: error instanceof Error ? error.name : 'Unknown',
      ...(!cloud && error instanceof Error ? { diagnostic: error.message.slice(0, 350) } : {}) }));
  }
  process.exitCode = 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
