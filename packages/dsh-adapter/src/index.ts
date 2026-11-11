import { execFile, spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const docker = promisify(execFile);
const MAX_WIRE = 9 * 1024 * 1024;
const MAX_MODEL_REQUEST = 4 * 1024 * 1024;
const MAX_MODEL_RESPONSE = 16 * 1024 * 1024;
const providerUrl = 'https://api.deepseek.com/anthropic/v1/messages';
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const sessionIdPattern = /^[a-zA-Z0-9_-]{1,128}$/;

export interface WorkerInput {
  image: string;
  workspace: string;
  home: string;
  projectId: string;
  scope?: string;
  grants: { id: string; path: string }[];
  sessionId?: string;
  turnId: string;
  text: string;
  attachment?: { name: string; data: string; mimeType: 'image/png' | 'image/jpeg' | 'image/webp' };
  signal: AbortSignal;
  onTool?: () => void;
  onDelta?: (text: string) => void;
  model: ModelBroker;
}

export type ModelBroker = (body: string, signal: AbortSignal) => Promise<Response>;

export class WorkerFailure extends Error {
  readonly code: string;
  readonly httpStatus?: number;
  constructor(code: string, httpStatus?: number) {
    super(code);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export function deepSeekBroker(key: string): ModelBroker {
  if (!key.trim()) throw new WorkerFailure('MODEL_KEY_REQUIRED');
  return (body, signal) => fetch(providerUrl, {
    method: 'POST', redirect: 'error', signal, body,
    headers: {
      'Content-Type': 'application/json', Accept: 'text/event-stream',
      'x-api-key': key, 'anthropic-version': '2023-06-01',
    },
  });
}

function checkedDirectory(path: string): string {
  if (!isAbsolute(path) || /[,\r\n\0]/.test(path) || realpathSync(path) !== path || !lstatSync(path).isDirectory()) {
    throw new WorkerFailure('UNSAFE_MOUNT');
  }
  return path;
}

function validateKnowledgeTree(path: string): void {
  const stack = [{ path, depth: 0 }];
  let entries = 0;
  while (stack.length > 0) {
    const dir = stack.pop()!;
    if (dir.depth > 32) throw new WorkerFailure('UNSAFE_KNOWLEDGE');
    for (const name of readdirSync(dir.path)) {
      if (++entries > 20_000) throw new WorkerFailure('KNOWLEDGE_TOO_LARGE');
      const child = join(dir.path, name);
      const stat = lstatSync(child);
      if (stat.isDirectory()) stack.push({ path: child, depth: dir.depth + 1 });
      else if (!stat.isFile() || stat.nlink !== 1) throw new WorkerFailure('UNSAFE_KNOWLEDGE');
    }
  }
}

export function workerOptions(input: Pick<WorkerInput, 'workspace' | 'home' | 'projectId' | 'grants' | 'image'>): string[] {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (!uid || gid === undefined || !uuid.test(input.projectId) || !/^sha256:[a-f0-9]{64}$/.test(input.image)) {
    throw new WorkerFailure('WORKER_CONFIG_INVALID');
  }
  const workspace = checkedDirectory(input.workspace);
  const home = checkedDirectory(input.home);
  checkedDirectory(join(workspace, 'projects', input.projectId));
  const options = [
    '--platform=linux/arm64', '--network=none', '--read-only', '--cap-drop=ALL',
    '--security-opt=no-new-privileges', '--pids-limit=64', '--memory=768m', '--cpus=1',
    '--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=64m', '--stop-timeout=5', '--user=' + uid + ':' + gid,
    '--workdir=/tenant/workspace/projects/' + input.projectId,
    '--mount=type=bind,source=' + workspace + ',target=/tenant/workspace,bind-recursive=disabled',
    '--mount=type=bind,source=' + home + ',target=/tenant/dsh-home,bind-recursive=disabled',
  ];
  const used = new Set<string>();
  if (input.grants.length > 32) throw new WorkerFailure('TOO_MANY_MOUNTS');
  for (const grant of input.grants) {
    if (!uuid.test(grant.id) || used.has(grant.id)) throw new WorkerFailure('UNSAFE_MOUNT');
    used.add(grant.id);
    const source = checkedDirectory(grant.path);
    validateKnowledgeTree(source);
    options.push('--mount=type=bind,source=' + source + ',target=/knowledge/' + grant.id + ',readonly,bind-recursive=disabled');
  }
  return options;
}

type Frame = Record<string, unknown>;
function isFrame(value: unknown): value is Frame {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

class WorkerConnection {
  private readonly input: WorkerInput;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly decoder = new StringDecoder('utf8');
  private readonly requests = new Map<string, AbortController>();
  private buffer = '';
  private count = 0;
  private active = false;
  private pending?: { expected: string; resolve: (message: Frame) => void; reject: (error: Error) => void };
  readonly exited: Promise<void>;

  constructor(child: ChildProcessWithoutNullStreams, input: WorkerInput) {
    this.input = input;
    this.child = child;
    this.exited = new Promise(resolve => {
      child.once('close', () => { this.fail(new WorkerFailure('WORKER_EXITED')); resolve(); });
      child.once('error', () => { this.fail(new WorkerFailure('WORKER_START_FAILED')); resolve(); });
    });
    child.stdin.on('error', () => this.fail(new WorkerFailure('WORKER_PIPE_FAILED')));
    child.stderr.resume();
    child.stdout.on('data', (chunk: Buffer) => this.read(chunk));
  }

  private read(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk);
    if (Buffer.byteLength(this.buffer) > MAX_WIRE) {
      this.fail(new WorkerFailure('WORKER_PROTOCOL_LIMIT'));
      return;
    }
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      try {
        const message: unknown = JSON.parse(line);
        if (!isFrame(message)) throw new Error('Invalid worker frame');
        this.receive(message);
      } catch {
        this.fail(new WorkerFailure('WORKER_PROTOCOL_FAILED'));
        return;
      }
    }
  }

  private receive(message: Frame): void {
    if (message.type === 'provider-request') {
      if (!this.active || message.turnId !== this.input.turnId || typeof message.id !== 'string' ||
          !uuid.test(message.id) || this.requests.size > 0 || ++this.count > 12 || typeof message.body !== 'string') {
        this.fail(new WorkerFailure('MODEL_GATEWAY_REJECTED'));
        return;
      }
      void this.proxy(message.id, message.body).catch(() => this.fail(new WorkerFailure('MODEL_GATEWAY_FAILED')));
      return;
    }
    if (message.type === 'provider-abort' && typeof message.id === 'string') {
      this.requests.get(message.id)?.abort();
      return;
    }
    if (this.active && message.turnId === this.input.turnId) {
      if (message.type === 'tool') {
        this.input.onTool?.();
        return;
      }
      if (message.type === 'delta' && typeof message.text === 'string' && message.text.length <= 16_000) {
        this.input.onDelta?.(message.text);
        return;
      }
    }
    const pending = this.pending;
    if (!pending) return;
    if (message.type === 'startup-failed' && pending.expected === 'initialized') {
      this.fail(new WorkerFailure('DSH_INITIALIZE_FAILED'));
    } else if (message.type === 'failed' && pending.expected === 'completed' && message.turnId === this.input.turnId) {
      const status = typeof message.status === 'number' && Number.isInteger(message.status) &&
        message.status >= 400 && message.status <= 599 ? message.status : undefined;
      this.fail(new WorkerFailure('DSH_TURN_FAILED', status));
    } else if (message.type === pending.expected && (message.type !== 'completed' || message.turnId === this.input.turnId)) {
      this.pending = undefined;
      pending.resolve(message);
    } else {
      this.fail(new WorkerFailure('WORKER_PROTOCOL_FAILED'));
    }
  }

  private async proxy(id: string, body: string): Promise<void> {
    if (Buffer.byteLength(body) > MAX_MODEL_REQUEST) throw new WorkerFailure('MODEL_GATEWAY_REJECTED');
    const parsed: unknown = JSON.parse(body);
    if (!isFrame(parsed) || parsed.model !== 'deepseek-flash' || parsed.stream !== true ||
        !Number.isInteger(parsed.max_tokens) || Number(parsed.max_tokens) < 1 || Number(parsed.max_tokens) > 1024 ||
        !Array.isArray(parsed.messages)) throw new WorkerFailure('MODEL_GATEWAY_REJECTED');
    const controller = new AbortController();
    this.requests.set(id, controller);
    try {
      const response = await this.input.model(body, AbortSignal.any([
        this.input.signal, controller.signal, AbortSignal.timeout(75_000),
      ]));
      await this.write({ type: 'provider-headers', id, status: response.status });
      let length = 0;
      if (response.body) {
        const reader = response.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.length;
            if (length > MAX_MODEL_RESPONSE) throw new WorkerFailure('MODEL_RESPONSE_LIMIT');
            for (let offset = 0; offset < value.length; offset += 48 * 1024) {
              await this.write({
                type: 'provider-data', id,
                data: Buffer.from(value.subarray(offset, offset + 48 * 1024)).toString('base64'),
              });
            }
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
      }
      await this.write({ type: 'provider-end', id });
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      this.requests.delete(id);
    }
  }

  private write(frame: Frame): Promise<void> {
    return new Promise((resolve, reject) => {
      this.child.stdin.write(JSON.stringify(frame) + '\n', error => error ? reject(error) : resolve());
    });
  }

  private fail(error: Error): void {
    const pending = this.pending;
    this.pending = undefined;
    this.buffer = '';
    pending?.reject(error);
    for (const controller of this.requests.values()) controller.abort();
  }

  async request(frame: Frame, expected: string, timeoutMs: number): Promise<Frame> {
    const signal = AbortSignal.any([this.input.signal, AbortSignal.timeout(timeoutMs)]);
    if (signal.aborted) throw new WorkerFailure('WORKER_STOPPED');
    const onAbort = () => this.fail(new WorkerFailure(this.input.signal.aborted ? 'WORKER_STOPPED' : 'WORKER_TIMEOUT'));
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      return await new Promise((resolve, reject) => {
        this.pending = { expected, resolve, reject };
        void this.write(frame).catch(() => this.fail(new WorkerFailure('WORKER_PIPE_FAILED')));
      });
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  async run(sessionId?: string): Promise<{ sessionId: string; text: string }> {
    const ready = await this.request({ type: 'initialize', sessionId }, 'initialized', 40_000);
    if (typeof ready.sessionId !== 'string' || !sessionIdPattern.test(ready.sessionId) ||
        (sessionId !== undefined && ready.sessionId !== sessionId)) throw new WorkerFailure('INVALID_DSH_SESSION');
    this.active = true;
    try {
      const answer = await this.request({ type: 'run', text: this.input.text, turnId: this.input.turnId, attachment: this.input.attachment }, 'completed', 90_000);
      if (typeof answer.text !== 'string' || answer.text.length > 64_000) throw new WorkerFailure('INVALID_DSH_RESPONSE');
      return { sessionId: ready.sessionId, text: answer.text };
    } finally {
      this.active = false;
    }
  }

  async close(): Promise<void> {
    this.fail(new WorkerFailure('WORKER_STOPPED'));
    if (this.child.exitCode !== null) return;
    try {
      await Promise.race([this.write({ type: 'close' }), delay(500)]);
      this.child.stdin.end();
      await Promise.race([this.exited, delay(3500)]);
    } catch { /* Container removal handles a broken transport. */ }
  }
}

const dockerContext = ['--context', 'desktop-linux'];
async function localDocker(): Promise<void> {
  const { stdout } = await docker('docker', ['context', 'inspect', 'desktop-linux', '--format', '{{.Endpoints.docker.Host}}'],
    { timeout: 5000, maxBuffer: 8192 });
  if (!stdout.trim().startsWith('unix:///')) throw new WorkerFailure('DOCKER_NOT_LOCAL');
}

export async function verifyWorkerImage(image: string): Promise<void> {
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new WorkerFailure('WORKER_CONFIG_INVALID');
  await localDocker();
  const { stdout } = await docker('docker', [
    ...dockerContext, 'image', 'inspect', '--format={{.Os}}/{{.Architecture}}', image,
  ], { timeout: 8000, maxBuffer: 8192 }).catch(() => { throw new WorkerFailure('VERIFIED_IMAGE_NOT_FOUND'); });
  if (stdout.trim() !== 'linux/arm64') throw new WorkerFailure('WORKER_CONFIG_INVALID');
}

export async function cleanupOfficeWorkers(scope: string): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(scope)) throw new WorkerFailure('WORKER_CONFIG_INVALID');
  await localDocker();
  const { stdout } = await docker('docker', [
    ...dockerContext, 'ps', '-a', '--no-trunc', '--filter=label=ai-office-2.worker=true',
    '--filter=label=ai-office-2.scope=' + scope, '--format={{.ID}}',
  ], { timeout: 8000, maxBuffer: 32 * 1024 });
  const ids = stdout.trim().split(/\s+/).filter(Boolean);
  if (ids.some(id => !/^[a-f0-9]{64}$/.test(id))) throw new WorkerFailure('WORKER_CONFIG_INVALID');
  for (const id of ids) await removeOfficeWorker(id);
}

async function removeOfficeWorker(id: string): Promise<void> {
  await docker('docker', [...dockerContext, 'rm', '-f', id], { timeout: 8000, maxBuffer: 8192 })
    .catch(error => {
      if (!String(error.stderr).includes('No such container')) throw new WorkerFailure('WORKER_CLEANUP_FAILED');
    });
}

export async function runDshWorker(input: WorkerInput): Promise<{ sessionId: string; text: string }> {
  if (!uuid.test(input.turnId) || (input.sessionId !== undefined && !sessionIdPattern.test(input.sessionId))) {
    throw new WorkerFailure('WORKER_CONFIG_INVALID');
  }
  if (input.scope !== undefined && !/^[a-f0-9]{64}$/.test(input.scope)) throw new WorkerFailure('WORKER_CONFIG_INVALID');
  await localDocker();
  const options = workerOptions(input);
  const name = 'ai-office-2-' + randomUUID();
  let connection: WorkerConnection | undefined;
  try {
    if (input.signal.aborted) throw new WorkerFailure('WORKER_STOPPED');
    await docker('docker', [...dockerContext, 'create', '--name', name, '--label=ai-office-2.worker=true', '--rm', '-i',
      ...(input.scope ? ['--label=ai-office-2.scope=' + input.scope] : []), ...options, input.image], { timeout: 15_000, maxBuffer: 8192 });
    if (input.signal.aborted) throw new WorkerFailure('WORKER_STOPPED');
    const child = spawn('docker', [...dockerContext, 'start', '-ai', name], { stdio: 'pipe' });
    connection = new WorkerConnection(child, input);
    return await connection.run(input.sessionId);
  } finally {
    await connection?.close();
    await removeOfficeWorker(name);
  }
}
