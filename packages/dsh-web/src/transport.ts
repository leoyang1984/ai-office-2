// Private byte transport for official DSH Web. R1 uses stream channels without a TCP listener.
import { execFile, spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { Duplex } from 'node:stream';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { workerOptions } from '../../dsh-adapter/src/index.ts';
import type { ModelBroker } from '../../dsh-adapter/src/index.ts';

const command = promisify(execFile);
const context = ['--context', 'desktop-linux'];
const MAX_FRAME = 6 * 1024 * 1024;
const MAX_QUEUED = 24 * 1024 * 1024;
const channel = /^[a-f0-9-]{36}$/;
export interface WebTransportInput {
  publishLoopback?: boolean; transportLabel?: 'r0' | 'r1' | 'r2'; trustedHost?: string; onFailure?: (error: Error) => void;
  image: string; workspace: string; home: string; projectId: string; scope: string;
  grants: { id: string; path: string }[]; model: ModelBroker;
  skillMounts?: { name: string; path: string }[];
}
export class DshWebTransport {
  readonly name: string;
  private channels = new Map<string, Duplex>();
  private child?: ChildProcessWithoutNullStreams;
  private server?: Server;
  private sockets = new Map<string, Socket>();
  private requests = new Map<string, AbortController>();
  private decoder = new StringDecoder('utf8');
  private buffer = '';
  private closing = false;
  private removal?: Promise<void>;
  private failure?: Error;
  private readyResolve?: () => void;
  private readyReject?: (error: Error) => void;
  private launchPath = '';
  private origin = '';
  private input: WebTransportInput;
  constructor(input: WebTransportInput) { this.input = input; this.name = 'ai-office-2-' + (input.transportLabel ?? 'r1') + '-' + randomUUID(); }
  get bootstrapPath(): string { return this.launchPath; }
  get url(): string { return this.origin; }
  // Contains a synthetic process credential. Callers must never log this value.
  get bootstrapUrl(): string { return this.origin + this.launchPath; }
  assertHealthy(): void { if (this.failure) throw this.failure; }
  async start(): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(this.input.scope)) throw new Error('Invalid test scope');
    if(this.input.trustedHost && !/^[a-zA-Z0-9.\[\]:-]{1,255}$/.test(this.input.trustedHost))throw new Error('Invalid public authority');
    const options = workerOptions(this.input).map(value => value === '--memory=768m' ? '--memory=1024m' : value === '--pids-limit=64' ? '--pids-limit=128' : value);
    const names = new Set<string>();
    for (const { name, path } of this.input.skillMounts ?? []) {
      if (name.length > 64 || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name) || names.has(name) ||
          !isAbsolute(path) || /[,\r\n\x00]/.test(path) || realpathSync(path) !== path || !lstatSync(path).isDirectory()) {
        throw new Error('Invalid managed skill mount');
      }
      names.add(name);
      options.push('--mount=type=bind,source=' + path + ',target=/office-skills/' + name + ',readonly,bind-recursive=disabled');
    }
    if (names.size > 48) throw new Error('Too many managed skill mounts');
    try {
      await command('docker', [...context, 'create', '--rm', '-i', '--name', this.name,
        '--label=ai-office-2.' + (this.input.transportLabel ?? 'r1') + '=true', '--label=ai-office-2.scope=' + this.input.scope,
        ...(this.input.transportLabel === 'r2' ? ['--ulimit=fsize=33554432:33554432', '--memory-swap=1024m'] : []),
        ...(this.input.trustedHost?['--env=OFFICE_WEB_TRUSTED_HOST='+this.input.trustedHost]:[]), ...options, this.input.image],
      { timeout: 15_000, maxBuffer: 8192 });
      const ready = new Promise<void>((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
      const child = this.child = spawn('docker', [...context, 'start', '-ai', this.name], { stdio: 'pipe' });
      child.stderr.resume();
      child.stdout.on('data', chunk => this.read(chunk));
      child.stdin.on('error', () => this.fail(new Error('R0 transport pipe failed')));
      child.stdin.on('drain', () => { for (const socket of this.sockets.values()) socket.resume(); });
      child.once('error', () => this.fail(new Error('R0 container start failed')));
      child.once('close', () => { if (!this.closing) this.fail(new Error('R0 container exited')); });
      await Promise.race([ready, delay(70_000, undefined, { ref: false }).then(() => { throw new Error('R0 startup timeout'); })]);
      if (!this.input.publishLoopback) return;
      this.server = createServer(socket => {
        if (this.sockets.size >= 48 || this.failure || this.closing) { socket.destroy(); return; }
        const id = randomUUID();
        this.sockets.set(id, socket);
        this.send({ type: 'connect', id });
        socket.on('data', bytes => {
          for (let i = 0; i < bytes.length; i += 48 * 1024) {
            if (!this.send({ type: 'data', id, data: bytes.subarray(i, i + 48 * 1024).toString('base64') })) socket.pause();
          }
        });
        socket.on('end', () => this.send({ type: 'end', id }));
        socket.on('error', () => socket.destroy());
        socket.once('close', () => { this.sockets.delete(id); this.send({ type: 'closed', id }); });
      });
      await new Promise<void>((resolve, reject) => {
        this.server!.once('error', reject);
        this.server!.listen(0, '127.0.0.1', resolve);
      });
      const address = this.server.address();
      if (!address || typeof address === 'string') throw new Error('R0 listen failed');
      this.origin = 'http://127.0.0.1:' + address.port;
    } catch (error) { await this.close(); throw error; }
  }
  private send(frame: Record<string, unknown>): boolean {
    if (this.closing || !this.child?.stdin.writable) return false;
    const line = JSON.stringify(frame) + '\n';
    if (Buffer.byteLength(line) > MAX_FRAME || this.child.stdin.writableLength > MAX_QUEUED) {
      this.fail(new Error('R0 transport quota exceeded')); return false;
    }
    return this.child.stdin.write(line);
  }
  private read(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk);
    if (Buffer.byteLength(this.buffer) > MAX_FRAME) { this.fail(new Error('R0 frame too large')); return; }
    let end: number;
    while ((end = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
      try { this.receive(JSON.parse(line)); }
      catch (error) { this.fail(error instanceof Error ? error : new Error('R0 invalid frame')); return; }
    }
  }
  private receive(frame: Record<string, unknown>): void {
    if (frame.type === 'ready') {
      if (this.input.transportLabel === 'r2' && frame.locked !== true) throw new Error('Locked Web image required');
      if ((frame.skills === true) !== (this.input.skillMounts !== undefined)) throw new Error('Skill image and gateway configuration differ');
      if (typeof frame.launchPath !== 'string' || !/^\/\?token=[a-zA-Z0-9_-]+$/.test(frame.launchPath)) throw new Error('Invalid startup path');
      this.launchPath = frame.launchPath; this.readyResolve?.(); return;
    }
    if (frame.type === 'boot-failed') throw new Error('R0 Web boot failed: ' + String(frame.diagnostic).slice(-4000));
    if (frame.type === 'exited') { if (!this.closing) throw new Error('DSH Web exited: ' + frame.code + (typeof frame.diagnostic === 'string' ? ': ' + frame.diagnostic.slice(-3500) : '')); return; }
    if (typeof frame.id !== 'string' || !channel.test(frame.id)) throw new Error('R0 invalid channel');
    if (frame.type === 'model-request') { void this.proxy(frame.id, frame.body).catch(error => this.fail(error)); return; }
    if (frame.type === 'model-abort') { this.requests.get(frame.id)?.abort(); return; }
    const stream = this.channels.get(frame.id);
    if (stream) {
      if (frame.type === 'data' && typeof frame.data === 'string' && frame.data.length <= 66 * 1024) {
        if (stream.readableLength > MAX_QUEUED) stream.destroy(new Error('DSH Web receive quota'));
        else stream.push(Buffer.from(frame.data, 'base64'));
      } else if (frame.type === 'end') stream.push(null);
      else if (frame.type === 'closed') stream.destroy();
      else throw new Error('Invalid stream frame');
      return;
    }
    const socket = this.sockets.get(frame.id);
    if (!socket) return;
    if (frame.type === 'data') {
      if (typeof frame.data !== 'string' || frame.data.length > 66 * 1024) throw new Error('R0 invalid bytes');
      if (socket.writableLength > MAX_QUEUED) { socket.destroy(); return; }
      socket.write(Buffer.from(frame.data, 'base64'));
    } else if (frame.type === 'end') socket.end();
    else if (frame.type === 'closed') socket.destroy();
    else throw new Error('R0 unexpected frame');
  }
  private async proxy(id: string, body: unknown): Promise<void> {
    if (typeof body !== 'string' || Buffer.byteLength(body) > 4 * 1024 * 1024 || this.requests.size >= (this.input.transportLabel === 'r2' ? 1 : 2) || this.requests.has(id)) throw new Error('R0 rejected model request');
    const value = JSON.parse(body);
    if (value.model !== 'deepseek-flash' || value.stream !== true || !Number.isInteger(value.max_tokens) || value.max_tokens < 1 || value.max_tokens > 1024) {
      throw new Error('R0 rejected model or output quota');
    }
    const abort = new AbortController();
    this.requests.set(id, abort);
    try {
      const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(60_000)]);
      const response = await this.input.model(body, signal);
      signal.throwIfAborted();
      this.send({ type: 'model-headers', id, status: response.status });
      const reader = response.body?.getReader();
      let size = 0;
      if (reader) try {
        for (;;) {
          const { value, done } = await reader.read(); if (done) break;
          signal.throwIfAborted();
          size += value.length; if (size > 16 * 1024 * 1024) throw new Error('R0 model response too large');
          for (let i = 0; i < value.length; i += 48 * 1024) this.send({ type: 'model-data', id, data: Buffer.from(value.subarray(i, i + 48 * 1024)).toString('base64') });
        }
      } finally { await reader.cancel().catch(() => {}); }
      this.send({ type: 'model-end', id });
    } catch (error) { if (!abort.signal.aborted) throw error; }
    finally { this.requests.delete(id); }
  }
  private fail(error: Error): void {
    if (this.failure || this.closing) return;
    this.failure = error; this.readyReject?.(error);
    for (const request of this.requests.values()) request.abort();
    for (const socket of this.sockets.values()) socket.destroy();
    for (const channel of this.channels.values()) channel.destroy();
    this.input.onFailure?.(error);
  }
  connect(): Duplex {
    this.assertHealthy();
    if (this.closing || !this.launchPath || this.channels.size >= 40) throw new Error('DSH Web unavailable');
    const id = randomUUID();
    const stream = new Duplex({
      read() {},
      write: (bytes: Buffer, _encoding, done) => {
        for (let i = 0; i < bytes.length; i += 48 * 1024) {
          this.send({ type: 'data', id, data: bytes.subarray(i, i + 48 * 1024).toString('base64') });
        }
        done(this.failure);
      },
      final: done => { this.send({ type: 'end', id }); done(); },
      destroy: (error, done) => { this.channels.delete(id); this.send({ type: 'closed', id }); done(error); },
    });
    this.channels.set(id, stream);
    this.send({ type: 'connect', id });
    queueMicrotask(() => stream.emit('connect'));
    return stream;
  }
  async close(): Promise<void> {
    if (!this.closing) {
      this.send({ type: 'close' }); this.closing = true;
      for (const request of this.requests.values()) request.abort();
      for (const socket of this.sockets.values()) socket.destroy();
      for (const channel of this.channels.values()) channel.destroy();
      if (this.server) await new Promise<void>(resolve => this.server!.close(() => resolve()));
      this.child?.stdin.end();
    }
    this.removal ??= removeWebContainer(this.name).catch(error => { this.removal = undefined; throw error; });
    await this.removal;
  }
}

async function removeWebContainer(name: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await command('docker', [...context, 'rm', '-f', name], { timeout: 10_000, maxBuffer: 8192 });
      return;
    } catch (error) {
      const stderr = String((error as { stderr?: string }).stderr);
      if (stderr.includes('No such container')) return;
      if (!stderr.includes('removal') || !stderr.includes('already in progress')) break;
      await delay(150);
    }
  }
  throw new Error('Web container cleanup failed');
}

// Called only while holding the same data root's exclusive gateway lease.
export async function removeWebOrphans(scope: string): Promise<number> {
  if (!/^[a-f0-9]{64}$/.test(scope)) throw new Error('Invalid Web scope');
  const endpoint = await command('docker', ['context', 'inspect', 'desktop-linux', '--format', '{{.Endpoints.docker.Host}}'],
    { timeout: 10_000, maxBuffer: 8192 });
  if (!endpoint.stdout.trim().startsWith('unix:///')) throw new Error('Local Docker context required');
  const { stdout } = await command('docker', [...context, 'ps', '-a', '--filter', 'label=ai-office-2.scope=' + scope,
    '--filter', 'label=ai-office-2.r2=true', '--format', '{{.Names}}'], { timeout: 10_000, maxBuffer: 64 * 1024 });
  let removed = 0;
  for (const name of stdout.trim().split('\n')) {
    if (!/^ai-office-2-r2-[a-f0-9-]{36}$/.test(name)) continue;
    const result = await command('docker', [...context, 'inspect', '--type=container', '--format', '{{json .Config.Labels}}', name],
      { timeout: 10_000, maxBuffer: 8192 }).catch(error => {
      if (String(error.stderr).includes('No such')) return undefined;
      throw error;
    });
    if (!result) continue;
    const labels = JSON.parse(result.stdout);
    if (labels['ai-office-2.scope'] !== scope || labels['ai-office-2.r2'] !== 'true') continue;
    await removeWebContainer(name);
    removed++;
  }
  return removed;
}
