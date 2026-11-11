import { runDshWorker, WorkerFailure } from '../../../packages/dsh-adapter/src/index.ts';
import type { ModelBroker } from '../../../packages/dsh-adapter/src/index.ts';
import { MockAgentAdapter } from '@office/runner-contract';
import { conflict, OfficeError } from './errors.ts';
import { hashBytes, redactMessage } from './security.ts';
import type { Store } from './store.ts';

export interface DshRuntime {
  image: string;
  model: ModelBroker;
}

export class Runner {
  private readonly store: Store;
  private readonly runtime?: DshRuntime;
  private readonly mock = new MockAgentAdapter();
  private readonly active = new Map<string, { conversationId: string; abort: AbortController; done: Promise<void> }>();
  private readonly changingAccess = new Set<string>();
  private readonly faulted = new Set<string>();

  constructor(store: Store, runtime?: DshRuntime) {
    this.store = store;
    this.runtime = runtime;
  }

  get mode(): 'mock' | 'dsh' { return this.runtime ? 'dsh' : 'mock'; }

  send(userId: string, conversationId: string, requestId: string, text: string, attachmentId?: string): Promise<void> {
    this.store.conversation(userId, conversationId);
    if (this.faulted.has(userId)) throw new OfficeError(503, 'WORKER_CLEANUP_FAILED', '请先检查该账户的工作进程');
    if (this.changingAccess.has(userId) || this.active.has(userId)) throw conflict('此账户已有运行中的任务');
    if (this.active.size >= 2) throw new OfficeError(429, 'WORKER_BUSY', '当前工作进程已满，请稍后重试');
    if (attachmentId && !this.runtime) throw new OfficeError(415, 'ATTACHMENT_UNAVAILABLE', '请用 DSH 模式发送图片附件');
    const attachment = attachmentId ? this.store.imageAttachment(userId, attachmentId) : undefined;
    const turnId = this.store.reserveTurn(userId, conversationId, requestId, text);
    if (!turnId) return Promise.resolve();
    const abort = new AbortController();
    const done = this.execute(userId, conversationId, turnId, redactMessage(text), abort.signal, attachment)
      .finally(() => this.active.delete(userId));
    this.active.set(userId, { conversationId, abort, done });
    return done;
  }

  private async execute(userId: string, id: string, turnId: string, text: string, signal: AbortSignal, attachment?: ReturnType<Store['imageAttachment']>): Promise<void> {
    try {
      this.store.recordEvent(id, turnId, 'started');
      if (this.runtime) {
        const target = this.store.workerTarget(userId, id);
        const folder = this.store.prepareExports(userId, id, turnId);
        const instruction = '\n\nIf you create files for the user, save them in the relative directory ' + folder + '/.';
        const result = await runDshWorker({
          ...target, ...this.runtime, scope: hashBytes(this.store.root), turnId, text: text + instruction, attachment, signal,
          onDelta: chunk => this.store.recordEvent(id, turnId, 'delta', chunk),
          onTool: () => this.store.recordEvent(id, turnId, 'tool'),
        });
        this.store.finishTurn(userId, id, turnId, { text: result.text, outputs: this.store.outputs(userId, id, folder) }, result.sessionId);
      } else {
        const result = await this.mock.send({ conversationId: id, turnId, text });
        this.store.finishTurn(userId, id, turnId, result);
      }
    } catch (error) {
      this.store.finishTurn(userId, id, turnId);
      if (error instanceof WorkerFailure) {
        if (error.code === 'WORKER_CLEANUP_FAILED') this.faulted.add(userId);
        const message = error.httpStatus
          ? 'DSH 模型请求失败，HTTP ' + error.httpStatus
          : error.code === 'DSH_INITIALIZE_FAILED' ? '无法启动或恢复该 DSH 会话'
          : error.code === 'WORKER_STOPPED' ? '该轮对话已停止'
          : 'DSH 工作进程运行失败';
        throw new OfficeError(error.code === 'WORKER_STOPPED' ? 409 : 500, error.code, message);
      }
      throw error;
    }
  }

  async stop(userId: string, conversationId: string): Promise<void> {
    this.store.conversation(userId, conversationId);
    const run = this.active.get(userId);
    if (run?.conversationId === conversationId) await this.end(run);
  }

  private async end(run: { abort: AbortController; done: Promise<void> }): Promise<void> {
    run.abort.abort();
    try { await run.done; } catch (error) {
      if (error instanceof OfficeError && error.code === 'WORKER_CLEANUP_FAILED') throw error;
    }
  }

  async changeAccess<T>(userId: string, update: () => T): Promise<T> {
    if (this.faulted.has(userId)) throw new OfficeError(503, 'WORKER_CLEANUP_FAILED', '请先检查该账户的工作进程');
    if (this.changingAccess.has(userId)) throw conflict('正在更改此账户的权限');
    this.changingAccess.add(userId);
    try {
      const run = this.active.get(userId);
      if (run) await this.end(run);
      return update();
    } finally {
      this.changingAccess.delete(userId);
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.active.values()].map(run => this.end(run)));
  }
}
