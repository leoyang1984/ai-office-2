import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { startFixture } from './fixture.mjs';

const mode = process.argv[2];
if (!['metadata', 'fixture', 'cloud'].includes(mode)) {
  console.error('Usage: node sdk-smoke.mjs metadata|fixture|cloud');
  process.exit(64);
}
const credential = mode === 'cloud' ? process.env.DEEPSEEK_API_KEY?.trim() : undefined;
if (mode === 'cloud' && !credential) {
  console.error('BLOCKED: DEEPSEEK_API_KEY is unavailable in this process.');
  process.exit(2);
}

assert.equal(process.version, 'v24.21.0');
const probeDir = resolve(process.env.P0_DEPENDENCY_DIR ?? import.meta.dirname);
const require = createRequire(join(probeDir, 'package.json'));
const sdk = require('@deepseek-ai/dsh-sdk-client');
const dshPackagePath = require.resolve('@deepseek-ai/dsh/package.json');
const dshPackage = require(dshPackagePath);
const sdkPackage = require('@deepseek-ai/dsh-sdk-client/package.json');
assert.equal(sdkPackage.version, '0.2.2-rc.1');
assert.equal(dshPackage.version, sdkPackage.version);
const dshBin = join(dirname(dshPackagePath), dshPackage.bin.dsh);
const { DeepSeekHarness, JsonRpcResponseError } = sdk;
const model = 'deepseek-flash';
const proxyVariables = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy'];
const cloudProxyEnv = mode === 'cloud'
  ? Object.fromEntries(proxyVariables.filter(name => process.env[name]).map(name => [name, process.env[name]]))
  : {};
const proxyConfigured = proxyVariables.slice(0, 4).some(name => Boolean(cloudProxyEnv[name]));
const providerCodes = new Set([
  'AUTH', 'CLIENT_UPGRADE_REQUIRED', 'CONTEXT_WINDOW_EXCEEDED', 'INVALID_CREDENTIAL', 'INVALID_REQUEST',
  'MISSING_CREDENTIAL', 'MODEL_UNSUPPORTED', 'NETWORK', 'NO_ADAPTER', 'QUOTA', 'RATE_LIMIT', 'SERVER',
  'TIMEOUT', 'UNKNOWN',
]);
const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-office-2-p0-')));
const markers = [`P0A-${randomUUID()}`, `P0B-${randomUUID()}`];
let stage = 'setup';
let fixture;

const report = (check, details = {}) => console.log(JSON.stringify({ check, status: 'PASS', ...details }));
class ProbeError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.code = code;
    this.details = details;
  }
}

function summarizeError(error) {
  // SDK messages, error data and stderr can include prompt or credential material.
  if (error instanceof ProbeError) return { code: error.code, ...error.details };
  return {
    type: error?.constructor?.name ?? 'Error',
    ...(Number.isInteger(error?.code) ? { code: error.code } : {}),
    ...(error?.code === 'EPERM' || error?.code === 'EACCES' ? { code: error.code } : {}),
    ...(mode !== 'cloud' && typeof error?.message === 'string' ? {
      diagnostic: error.message.replaceAll(root, '<probe-root>').slice(0, 500),
    } : {}),
  };
}

async function makeTenant(label, marker) {
  const dir = join(root, label);
  const home = join(dir, 'home');
  const dshHome = join(dir, 'dsh-home');
  const workspace = join(dir, 'workspace');
  const project = join(workspace, 'project');
  for (const path of [home, dshHome, project, join(dir, 'tmp')]) {
    await mkdir(path, { mode: 0o700, recursive: true });
  }
  return { dir, home, dshHome, workspace, project, marker };
}

async function usingHarness(tenant, operation) {
  const harness = new DeepSeekHarness({
    profile: 'sdk',
    dshBin,
    dshHome: tenant.dshHome,
    processCwd: tenant.workspace,
    cwd: tenant.workspace,
    provider: 'deepseek-official',
    model,
    reasoningEffort: 'off',
    maxTokens: 256,
    initializeTimeoutMs: 30_000,
    requestTimeoutMs: 15_000,
    env: {
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: tenant.home,
      XDG_CONFIG_HOME: join(tenant.home, 'config'),
      XDG_DATA_HOME: join(tenant.home, 'data'),
      XDG_CACHE_HOME: join(tenant.home, 'cache'),
      TMPDIR: join(tenant.dir, 'tmp'),
      DSH_TELEMETRY_DISABLED: '1',
      ...cloudProxyEnv,
      ...(fixture ? { DEEPSEEK_BASE_URL: fixture.baseUrl, DEEPSEEK_API_KEY: fixture.credential } : {}),
      ...(credential ? { DEEPSEEK_API_KEY: credential } : {}),
    },
  });
  try {
    await harness.start();
    return await operation(harness);
  } finally {
    await harness.close();
  }
}

async function runTurn(session, marker, resume = false) {
  const methods = new Set();
  const text = resume
    ? 'P0_RECALL. Repeat the full reply from the previous turn exactly, without extra text or formatting. Do not use tools.'
    : `P0_HELLO ${marker}. Reply with exactly "P0_REPLY ${marker}" without quotes or formatting. Do not use tools.`;
  let timer;
  const timeoutMs = mode === 'cloud' ? 90_000 : 45_000;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new ProbeError('TURN_TIMEOUT', { timeoutMs, notificationsSeen: methods.size > 0 })), timeoutMs);
  });
  let turn;
  try {
    turn = await Promise.race([deadline, session.run(text, { onNotification(notification) {
      methods.add(notification.method);
    } })]);
  } finally {
    clearTimeout(timer);
  }
  assert.equal(turn.sessionId, session.id);
  if (turn.finishReason !== 'completed') {
    const reason = turn.events.findLast(event => event.type === 'turn/end')?.data.reason;
    const failure = reason?.kind === 'error' ? reason.error : undefined;
    const { status, code } = failure ?? {};
    throw new ProbeError('TURN_FAILED', {
      finishReason: ['error', 'blocked', 'aborted', 'max-tokens'].includes(turn.finishReason) ? turn.finishReason : 'unknown',
      ...(providerCodes.has(code) ? { providerCode: code } : {}),
      ...(Number.isInteger(status) && status >= 400 && status <= 599 ? { httpStatus: status } : {}),
    });
  }
  if (turn.finalResponse.trim() !== `P0_REPLY ${marker}`) {
    throw new ProbeError('UNEXPECTED_REPLY');
  }
  assert.ok(methods.has('session.event'));
  assert.ok(methods.has('session.status'));
  return { methods: [...methods].sort(), finishReason: turn.finishReason };
}

try {
  report('versions', {
    node: process.version, dsh: dshPackage.version, sdk: sdkPackage.version, mode,
    ...(mode === 'cloud' ? { model, proxyConfigured } : {}),
  });
  if (mode === 'fixture') {
    stage = 'loopback fixture startup';
    fixture = await startFixture(markers);
  }
  const tenants = await Promise.all(markers.map((marker, index) => makeTenant(index === 0 ? 'A' : 'B', marker)));
  const sessionIds = [];
  for (const [index, tenant] of tenants.entries()) {
    stage = `initialize/cwd ${index + 1}`;
    sessionIds.push(await usingHarness(tenant, async harness => {
      const session = harness.session();
      assert.equal(await session.getWorkingDirectory(), tenant.workspace);
      assert.equal(await session.setWorkingDirectory(tenant.project), tenant.project);
      assert.equal(await session.getWorkingDirectory(), tenant.project);
      report(stage);
      if (mode !== 'metadata') {
        stage = `text ${index + 1}`;
        report(stage, await runTurn(session, tenant.marker));
      }
      return session.id;
    }));
  }
  assert.notEqual(sessionIds[0], sessionIds[1]);

  stage = 'reject cross-home resume';
  await usingHarness(tenants[1], async harness => {
    await assert.rejects(harness.resumeSession(sessionIds[0]), error => {
      assert.ok(error instanceof JsonRpcResponseError);
      assert.ok(Number.isInteger(error.code));
      report(stage, { type: error.constructor.name, code: error.code });
      return true;
    });
  });

  if (mode !== 'metadata') {
    for (const [index, tenant] of tenants.entries()) {
      stage = `new process resume ${index + 1}`;
      await usingHarness(tenant, async harness => {
        const session = await harness.resumeSession(sessionIds[index]);
        assert.equal(session.id, sessionIds[index]);
        assert.equal(await session.getWorkingDirectory(), tenant.project);
        report(stage, await runTurn(session, tenant.marker, true));
      });
    }
  }
  if (fixture) {
    stage = 'isolated provider requests';
    assert.deepEqual(fixture.failures, []);
    assert.deepEqual(fixture.requests, [
      { marker: markers[0], resume: false }, { marker: markers[1], resume: false },
      { marker: markers[0], resume: true }, { marker: markers[1], resume: true },
    ]);
    report(stage, { requests: fixture.requests.length, provider: 'loopback fixture' });
  }
} catch (error) {
  console.error(JSON.stringify({ check: stage, status: 'FAIL', ...summarizeError(error) }));
  process.exitCode = 1;
} finally {
  await fixture?.close();
  // This path is always newly created by this process, never supplied by the user.
  await rm(root, { recursive: true, force: true });
}
