import { Agent, request } from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { ModelBroker } from '../../../packages/dsh-adapter/src/index.ts';
import { DshWebTransport, removeWebOrphans } from '../../../packages/dsh-web/src/transport.ts';
import { OfficeError } from './errors.ts';
import { checkNativeStorage, defaultNativeStorage } from './native-storage.ts';
import type { NativeStorageLimit } from './native-storage.ts';
import { hashBytes } from './security.ts';
import type { Store } from './store.ts';

export interface NativeRuntime {
  image: string;
  model: ModelBroker;
  onError?: (error: unknown) => void;
  idleMs?: number;
  turnMs?: number;
  maxModelCalls?: number;
  maxTurns?: number;
  storage?: NativeStorageLimit;
  skills?: boolean;
}
type Turn = { sessionId: string; signal: AbortSignal; controller: AbortController; timer: ReturnType<typeof setTimeout>; calls: number };
type StopReason = 'idle' | 'failed' | 'timeout' | 'storage' | 'access' | 'shutdown';
type Entry = {
  userId: string;
  roots: readonly string[];
  transport: DshWebTransport;
  agent: Agent;
  ready: Promise<void>;
  cookie: string;
  touched: number;
  writing: boolean;
  uploads?: { tail: Promise<unknown>; count: number };
  stopped?: StopReason;
  stopping?: Promise<void>;
  turn?: Turn;
};
type Response = { status: number; headers: IncomingMessage['headers']; bytes: Buffer };
const unavailable = () => new OfficeError(503, 'NATIVE_UNAVAILABLE', 'DSH 正在恢复，请稍后重试');
const modelTools = new Set(['read', 'read_image', 'write', 'edit', 'present']);
const noCapacity = () => new OfficeError(429, 'NATIVE_TURN_LIMIT', '当前对话正在运行或名额已满，请稍后再试');
const noticeMs = 5 * 60_000;

export class NativePool {
  private entries = new Map<string, Entry>();
  private recentTimeouts = new Map<string, number>();
  private timer?: ReturnType<typeof setInterval>;
  private initialized = false;
  private closing = false;
  private readonly scope: string;
  private readonly store: Store;
  private readonly origin: URL;
  private readonly runtime: NativeRuntime;
  private readonly disconnect: (userId: string) => void;
  private readonly idleMs: number;
  private readonly turnMs: number;
  private readonly maxModelCalls: number;
  private readonly maxTurns: number;
  private readonly storage: NativeStorageLimit;
  constructor(store: Store, origin: URL, runtime: NativeRuntime, disconnect: (userId: string) => void) {
    this.store = store; this.origin = origin; this.runtime = runtime; this.disconnect = disconnect;
    this.scope = hashBytes(store.root);
    this.idleMs = runtime.idleMs ?? 5 * 60_000;
    this.turnMs = runtime.turnMs ?? 10 * 60_000;
    this.maxModelCalls = runtime.maxModelCalls ?? 64;
    this.maxTurns = runtime.maxTurns ?? 2;
    this.storage = runtime.storage ?? defaultNativeStorage;
  }
  async initialize(): Promise<void> {
    for (const [value, maximum] of [[this.idleMs, 60 * 60_000], [this.turnMs, 30 * 60_000], [this.maxModelCalls, 128], [this.maxTurns, 2],
      [this.storage.bytes, defaultNativeStorage.bytes], [this.storage.entries, defaultNativeStorage.entries]] as const) {
      if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new Error('Invalid native runtime limit');
    }
    const removed = await removeWebOrphans(this.scope);
    if (removed) this.audit(null, 'orphans-removed');
    if (this.runtime.skills) this.store.enableSkills(this.storage);
    this.timer = setInterval(() => this.sweep(), Math.min(500, this.idleMs));
    this.timer.unref();
    this.initialized = true;
  }
  private audit(id: string | null, action: string, success = true): void {
    this.store.audit({ actorId: null, targetId: id, action: 'native.' + action, success, ip: 'local-runtime', requestId: randomUUID() });
  }
  private sweep(): void {
    const now = performance.now();
    for (const [userId, expires] of this.recentTimeouts) if (expires <= now) this.recentTimeouts.delete(userId);
    for (const entry of this.entries.values()) {
      if (entry.stopped) { this.retire(entry, entry.stopped); continue; }
      if (!entry.cookie) continue;
      try { this.check(entry); } catch { this.retire(entry, 'storage'); continue; }
      if (!entry.turn && !entry.writing && !entry.uploads && performance.now() - entry.touched >= this.idleMs) this.retire(entry, 'idle');
    }
  }
  private check(entry: Entry, reserve = 0, entries = 0): void {
    checkNativeStorage(entry.roots, this.storage, reserve, entries);
  }
  status(userId: string) {
    const entry = this.entries.get(userId);
    const available = Boolean(entry?.cookie && !entry.stopped && !this.closing);
    return { available, ...(!available && (this.recentTimeouts.get(userId) ?? 0) > performance.now() ? { reason: 'timeout' } : {}) };
  }
  touch(entry: Entry): void { entry.touched = performance.now(); }
  async get(userId: string, wake: boolean): Promise<Entry> {
    if (this.closing || !this.initialized) throw unavailable();
    let entry = this.entries.get(userId);
    if (!entry) {
      if (!wake) throw unavailable();
      if (this.entries.size >= 2) throw new OfficeError(429, 'WORKER_BUSY', '当前工作进程已满，请稍后再试');
      const target = this.store.nativeTarget(userId);
      const skills = this.store.skillCatalog?.mounts(userId);
      const roots = [target.workspace, target.home];
      if (skills?.personalRoot) roots.push(skills.personalRoot);
      checkNativeStorage(roots, this.storage);
      const agent = new Agent({ keepAlive: false });
      const transport = new DshWebTransport({ ...target, image: this.runtime.image, skillMounts: skills?.mounts,
        scope: this.scope, transportLabel: 'r2', trustedHost: this.origin.host,
        model: (body, signal) => this.model(current, body, signal),
        onFailure: error => {
          this.runtime.onError?.(error);
          this.retire(current, 'failed');
        },
      });
      agent.createConnection = () => transport.connect() as Socket;
      const current: Entry = { userId, roots, transport, agent, ready: Promise.resolve(), cookie: '',
        touched: performance.now(), writing: false };
      this.entries.set(userId, current);
      entry = current;
      current.ready = (async () => {
        try {
          await transport.start();
          const response = await this.upstream(current, transport.bootstrapPath, 'GET', Buffer.alloc(0));
          if (![302, 303].includes(response.status) || !response.headers['set-cookie']) throw new Error('Native bootstrap failed');
          current.cookie = response.headers['set-cookie'].map(value => value.split(';')[0]).join('; ');
          this.check(current);
          this.touch(current);
          this.recentTimeouts.delete(userId);
          this.audit(userId, 'started');
        } catch (error) {
          this.retire(current, 'failed');
          throw error;
        }
      })();
    }
    // The watchdog can remove the container before retiring its in-memory entry.
    // Keep reporting the active storage violation during that interval.
    if (entry.stopped === 'storage' && wake) this.check(entry);
    if (entry.stopped) throw unavailable();
    await entry.ready;
    if (entry.stopped || this.closing) throw unavailable();
    return entry;
  }
  private async model(entry: Entry, body: string, transportSignal: AbortSignal): Promise<globalThis.Response> {
    const turn = entry.turn;
    if (!turn || turn.signal.aborted || entry.stopped) throw new Error('Model request outside turn policy');
    const tools = JSON.parse(body).tools;
    if (tools !== undefined && (!Array.isArray(tools) || tools.some(tool => !modelTools.has(tool?.name) && !(this.runtime.skills && tool?.name === 'skill')))) {
      const names = Array.isArray(tools) ? tools.map(tool => /^[a-z0-9_-]{1,40}$/i.test(tool?.name ?? '') ? tool.name : '[unknown]') : [];
      throw new Error('Unexpected native tool capability: ' + names.join(','));
    }
    try { this.check(entry); } catch (error) { this.retire(entry, 'storage'); throw error; }
    if (++turn.calls > this.maxModelCalls) {
      if (turn.calls === this.maxModelCalls + 1) this.audit(entry.userId, 'model-budget-reached', false);
      // A non-retryable provider error ends this turn without destroying the Web transport.
      return Response.json({ type: 'error', error: { type: 'invalid_request_error',
        message: `本轮任务已达到 ${this.maxModelCalls} 次模型请求上限。可在此会话发送下一条消息继续。` } }, { status: 400 });
    }
    return this.runtime.model(body, AbortSignal.any([turn.signal, transportSignal]));
  }
  begin(entry: Entry, sessionId: string): Turn {
    if (entry.turn || entry.writing || entry.uploads || [...this.entries.values()].filter(e => e.turn).length >= this.maxTurns) throw noCapacity();
    this.check(entry, 0, 1);
    const controller = new AbortController();
    const turn = { sessionId, controller, signal: controller.signal, calls: 0,
      timer: setTimeout(() => this.retire(entry, 'timeout'), this.turnMs) };
    turn.timer.unref();
    entry.turn = turn;
    this.touch(entry);
    return turn;
  }
  private finish(entry: Entry, turn: Turn): void {
    if (entry.turn !== turn) return;
    clearTimeout(turn.timer);
    turn.controller.abort();
    entry.turn = undefined;
    this.touch(entry);
  }
  async prompt(entry: Entry, sessionId: string, body: Buffer, type?: string): Promise<Response> {
    const turn = this.begin(entry, sessionId);
    try {
      // Once admitted the lifecycle belongs to the gateway, even if the
      // initiating browser disconnects before receiving its receipt.
      const response = await this.upstream(entry, '/api/session/prompt', 'POST', body, type, turn.signal);
      const result = response.status === 200 ? JSON.parse(response.bytes.toString('utf8')).result : undefined;
      if (result?.ok === true && result.value?.accepted === true) {
        void this.followTurn(entry, turn);
      } else if (result?.ok === false) {
        this.finish(entry, turn);
      } else {
        throw new Error('Ambiguous native prompt acknowledgement');
      }
      return response;
    } catch (error) {
      this.retire(entry, 'failed');
      throw error;
    }
  }
  private async followTurn(entry: Entry, turn: Turn): Promise<void> {
    try {
      while (!turn.signal.aborted) {
        const response = await this.upstream(entry, '/api/session/wait', 'POST', Buffer.from(JSON.stringify({
          type: 'client-request', rpcId: randomUUID(), method: 'session/wait',
          payload: { args: { request: { sessionId: turn.sessionId, timeoutMs: 5000, maxMessages: 1 } } },
        })), 'application/json', turn.signal);
        const result = response.status === 200 ? JSON.parse(response.bytes.toString('utf8')).result : undefined;
        if (result?.ok !== true || !result.value?.state) throw new Error('Native turn status unavailable');
        const { reason, state } = result.value;
        if (reason === 'idle' && state.running === false && Array.isArray(state.queue) && state.queue.length === 0) {
          this.check(entry);
          this.finish(entry, turn);
          return;
        }
        if (reason === 'input-required') throw new Error('Unexpected interactive native turn');
        await delay(100, undefined, { signal: turn.signal });
      }
    } catch (error) {
      if (!turn.signal.aborted) { this.runtime.onError?.(error); this.retire(entry, 'failed'); }
    }
  }
  async cancel(entry: Entry, sessionId: string, run: () => Promise<Response>): Promise<Response> {
    if (entry.turn?.sessionId !== sessionId) throw new OfficeError(403, 'NATIVE_OPERATION_DENIED', '只能停止正在运行的对话');
    if (entry.writing) throw noCapacity();
    entry.writing = true;
    try { return await run(); }
    finally { entry.writing = false; this.touch(entry); }
  }
  async upload(entry: Entry, reserve: number, signal: AbortSignal, run: () => Promise<Response>): Promise<Response> {
    // The original UI uploads a multi-selection in parallel. Serialize admission
    // and storage checks, and bound how many request bodies a user can queue.
    if (entry.turn || (entry.writing && !entry.uploads) || (entry.uploads?.count ?? 0) >= 3) throw noCapacity();
    const queue = entry.uploads ??= { tail: Promise.resolve(), count: 0 };
    queue.count++;
    const next = queue.tail.then(() => {
      signal.throwIfAborted();
      if (entry.stopped || this.closing) throw unavailable();
      return this.write(entry, reserve, run, true);
    });
    queue.tail = next.catch(() => {});
    try { return await next; }
    finally { if (--queue.count === 0) entry.uploads = undefined; }
  }
  async write(entry: Entry, reserve: number, run: () => Promise<Response>, fromUpload = false): Promise<Response> {
    if (entry.turn || entry.writing || (entry.uploads && !fromUpload)) throw noCapacity();
    this.check(entry, reserve, 1);
    entry.writing = true; this.touch(entry);
    try {
      const response = await run();
      try { this.check(entry); } catch (error) { this.retire(entry, 'storage'); throw error; }
      return response;
    } finally {
      entry.writing = false; this.touch(entry);
    }
  }
  async stopUser(userId: string): Promise<void> {
    const entry = this.entries.get(userId);
    if (entry) await this.stop(entry, 'access');
  }
  private retire(entry: Entry, reason: StopReason): void {
    void this.stop(entry, reason).catch(error => this.runtime.onError?.(error));
  }
  private stop(entry: Entry, reason: StopReason): Promise<void> {
    if (entry.stopping) return entry.stopping;
    if (!entry.stopped) {
      entry.stopped = reason;
      if (reason === 'timeout') this.recentTimeouts.set(entry.userId, performance.now() + noticeMs);
      if (entry.turn) { clearTimeout(entry.turn.timer); entry.turn.controller.abort(); }
      if (entry.cookie) this.disconnect(entry.userId);
      entry.agent.destroy();
    }
    entry.stopping = (async () => {
      await entry.ready.catch(() => {});
      try { await entry.transport.close(); }
      catch (error) { this.audit(entry.userId, 'cleanup-failed', false); throw error; }
      if (this.entries.get(entry.userId) === entry) this.entries.delete(entry.userId);
      this.audit(entry.userId, 'stopped-' + entry.stopped);
    })().finally(() => { entry.stopping = undefined; });
    return entry.stopping;
  }
  async upstream(entry: Entry, path: string, method: string, body: Buffer, contentType?: string, signal?: AbortSignal): Promise<Response> {
    return new Promise((resolve, reject) => {
      const timeout = AbortSignal.timeout(70_000);
      const req = request({ host: 'office-web.invalid', port: 80, path, method, agent: entry.agent,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { Host: this.origin.host, Origin: this.origin.origin, Connection: 'close', 'Accept-Encoding': 'identity',
          ...(entry.cookie ? { Cookie: entry.cookie } : {}), ...(contentType ? { 'Content-Type': contentType } : {}),
          ...(method === 'POST' ? { 'Content-Length': String(body.length) } : {}) },
      }, res => {
        const chunks: Buffer[] = []; let size = 0;
        res.on('data', chunk => {
          size += chunk.length;
          if (size > 24 * 1024 * 1024) res.destroy(new Error('Native response quota'));
          else chunks.push(chunk);
        });
        res.once('error', reject);
        res.once('aborted', () => reject(new Error('Native response aborted')));
        res.once('end', () => resolve({ status: res.statusCode ?? 502, headers: res.headers, bytes: Buffer.concat(chunks) }));
      });
      req.once('error', reject); req.end(body);
    });
  }
  async close(): Promise<void> {
    this.closing = true;
    clearInterval(this.timer);
    const results = await Promise.allSettled([...this.entries.values()].map(entry => this.stop(entry, 'shutdown')));
    if (results.some(result => result.status === 'rejected')) throw new Error('Native container cleanup incomplete');
  }
}
