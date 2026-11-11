import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, readFileSync } from 'node:fs';
import { createServer, get } from 'node:https';
import { request } from 'node:http';
import { createPublicKey, createHash } from 'node:crypto';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../../apps/api/src/app.ts';
import { hashBytes, hashPassword, temporaryPassword } from '../../apps/api/src/security.ts';
import { openDataRoot } from '../../apps/api/src/storage.ts';
import { Store } from '../../apps/api/src/store.ts';
import { defaultNativeStorage } from '../../apps/api/src/native-storage.ts';
import { verifyWorkerImage } from '../../packages/dsh-adapter/src/index.ts';
import type { ModelBroker } from '../../packages/dsh-adapter/src/index.ts';

const image = 'sha256:ed68b7540cb03646604d9aa57afa087b855f2db242c5e191250eb1270590b7f1';
export const httpsPort = 8443;
const target = 'http://127.0.0.1:18445';
const read = (...args: string[]) => {
  const output = execFileSync('tailscale', args, { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  return JSON.parse(output || '{}');
};

type ServeConfig = {
  TCP?: Record<string, { HTTPS?: boolean }>;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
  AllowFunnel?: Record<string, boolean>;
  Foreground?: Record<string, ServeConfig>;
  Services?: Record<string, ServeConfig>;
};
function configs(state: ServeConfig): ServeConfig[] {
  return [state, ...[...Object.values(state.Foreground ?? {}), ...Object.values(state.Services ?? {})].flatMap(configs)];
}
const slot = ':' + httpsPort;
function inspect() {
  const entries = configs(read('serve', 'status', '--json') ?? {});
  return {
    occupied: entries.some(entry => entry.TCP?.[httpsPort] ||
      [...Object.keys(entry.Web ?? {}), ...Object.keys(entry.AllowFunnel ?? {})].some(address => address.endsWith(slot))),
    routes: entries.flatMap(entry => Object.entries(entry.Web ?? {}).filter(([address]) => address.endsWith(slot))),
    public: entries.some(entry => Object.entries(entry.AllowFunnel ?? {}).some(([address, enabled]) => address.endsWith(slot) && enabled)),
  };
}

function ready(origin: string) {
  return new Promise<boolean>(resolve => {
    const request = get(origin + '/api/v1/health/ready', { agent: false }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; if (body.length > 4096) request.destroy(); });
      response.on('end', () => {
        try { resolve(response.statusCode === 200 && JSON.parse(body).agent === 'dsh'); }
        catch { resolve(false); }
      });
      response.on('error', () => resolve(false));
    });
    request.setTimeout(1200, () => request.destroy());
    request.on('error', () => resolve(false));
  });
}

export async function startR5(model: ModelBroker, signal: AbortSignal, localFixture = false) {
  const status = localFixture ? undefined : read('status', '--json');
  const host = status?.Self?.DNSName?.replace(/\.$/, '');
  if (!localFixture && (status.BackendState !== 'Running' || !status.Self?.Online ||
      !/^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/i.test(host ?? ''))) throw new Error('请先连接 Mac 的 Tailscale，确认已启用 MagicDNS 和 HTTPS');
  if (!localFixture && !status.CertDomains?.includes(host)) throw new Error('这个 Tailnet 尚未为该 Mac 启用 HTTPS 证书');
  const tailnetOrigin = 'https://' + host + slot;
  // The local TLS fallback runs in its own fixture data root and never starts Serve.
  const origin = localFixture ? 'https://127.0.0.1:18446' : tailnetOrigin;
  if (!localFixture && inspect().occupied) throw new Error('Tailnet 测试端口 8443 已有配置，已停止启动');
  await verifyWorkerImage(image);
  signal.throwIfAborted();

  const root = realpathSync(mkdtempSync('/private/tmp/ai-office-r5-'));
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  let serve: ReturnType<typeof spawn> | undefined;
  let loopback: ReturnType<typeof createServer> | undefined;
  const sockets = new Set<Duplex>();
  const testConnections = new Set<Duplex>();
  const socketCount = () => testConnections.size;
  const dropSockets = () => { for (const socket of testConnections) socket.destroy(); };
  const stopServe = (signal: NodeJS.Signals) => {
    if (!serve?.pid) return;
    try { process.kill(-serve.pid, signal); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  let exited: Promise<void> | undefined;
  let stopped = false;
  let stopPromise: Promise<void> | undefined;
  let serveError = false;
  const dispose = () => stopPromise ??= (async () => {
    let serveClean = true;
    try {
      if (serve) {
        stopServe('SIGINT');
        await Promise.race([exited, delay(4500, undefined, { ref: false })]);
        if (!stopped || inspect().occupied) {
          stopServe('SIGTERM');
          await Promise.race([exited, delay(2500, undefined, { ref: false })]);
        }
        for (let i = 0; i < 8 && inspect().occupied; i++) await delay(250);
        serveClean = stopped && !inspect().occupied;
      }
    } finally {
      for (const socket of sockets) socket.destroy();
      if (loopback) {
        const closed = new Promise<void>(resolve => loopback!.close(() => resolve()));
        loopback.closeAllConnections();
        await closed;
      }
      await app?.close();
      const leftovers = execFileSync('docker', ['--context', 'desktop-linux', 'ps', '-aq',
        '--filter', 'label=ai-office-2.r2=true', '--filter', 'label=ai-office-2.scope=' + hashBytes(root)],
      { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      if (leftovers) throw new Error('R5 测试容器未全部收回，保留测试目录以便清理：' + root);
      rmSync(root, { recursive: true, force: true });
    }
    if (!serveClean) throw new Error('请检查 8443 的 Serve 状态，确认测试路由已撤销');
  })();

  try {
    const store = new Store(openDataRoot(root));
    const users = { admin: { name: 'r5-admin', initial: temporaryPassword(), id: '' },
      a: { name: 'r5-phone', initial: temporaryPassword(), id: '' },
      b: { name: 'r5-second', initial: temporaryPassword(), id: '' } };
    let skillId: string;
    try {
      for (const [role, who] of Object.entries(users)) {
        who.id = store.createUser({ username: who.name, displayName: who.name, passwordHash: await hashPassword(who.initial) },
          role === 'admin' ? 'ADMIN' : 'USER').id;
      }
      store.enableSkills(defaultNativeStorage);
      const catalog = store.skillCatalog!;
      skillId = catalog.installPublic({ name: 'r5-marker', version: '1.0.0', description: 'R5 synthetic marker',
        instructions: 'When this Skill is invoked, reply with exactly R5_SKILL_BLUE_PAPER.', resources: [] }).id;
      catalog.setGrant(users.a.id, skillId, true);
      catalog.savePersonal(users.a.id, { name: 'r5-personal', version: '1.0.0', description: 'R5 private marker',
        instructions: 'When invoked, reply with exactly R5_PRIVATE_ORANGE_PAPER.', resources: [] });
    } finally { store.close(); }

    app = await createApp({ dataRoot: root, origin, serveWeb: true, sessionCookie: 'office_r5_session', nativeWeb: { image, model, skills: true } });
    app.server.on('upgrade', (_req, socket) => {
      testConnections.add(socket);
      socket.on('close', () => testConnections.delete(socket));
    });
    await app.listen({ host: '127.0.0.1', port: 18445 });
    signal.throwIfAborted();
    if (localFixture) {
      const key = join(root, 'local.key'), cert = join(root, 'local.crt');
      execFileSync('openssl', ['req', '-x509', '-nodes', '-newkey', 'rsa:2048', '-days', '1',
        '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', key, '-out', cert], { stdio: 'ignore', timeout: 8000 });
      const pin = createHash('sha256').update(createPublicKey(readFileSync(cert)).export({ type: 'spki', format: 'der' })).digest('base64');
      const forward = (url: string | undefined) => new URL(url ?? '/', target);
      loopback = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
        const url = forward(req.url);
        if (url.origin !== target) { res.writeHead(400).end(); return; }
        const upstream = request(url, { method: req.method, headers: req.headers }, incoming => {
          res.writeHead(incoming.statusCode ?? 502, incoming.headers);
          incoming.pipe(res);
        });
        upstream.on('error', () => res.writeHead(502).end());
        req.pipe(upstream);
      });
      loopback.on('upgrade', (req, socket, head) => {
        if (req.url !== '/dsh/api/remote.mux') { socket.destroy(); return; }
        const upstream = connect(18445, '127.0.0.1');
        sockets.add(socket);
        socket.on('close', () => { sockets.delete(socket); upstream.destroy(); });
        socket.on('error', () => upstream.destroy());
        upstream.on('close', () => socket.destroy());
        upstream.on('error', () => socket.destroy());
        upstream.on('connect', () => {
          const lines = ['GET ' + req.url + ' HTTP/1.1'];
          for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(req.rawHeaders[i] + ': ' + req.rawHeaders[i + 1]);
          upstream.write(lines.join('\r\n') + '\r\n\r\n');
          upstream.write(head);
          socket.pipe(upstream).pipe(socket);
        });
      });
      await new Promise<void>((resolve, reject) => {
        loopback!.once('error', reject);
        loopback!.listen(18446, '127.0.0.1', resolve);
      });
      return { origin, users, skillId, dispose, dropSockets, socketCount, pin, tailnet: false as const };
    }
    if (inspect().occupied) throw new Error('Tailnet 测试端口 8443 已被占用');
    // Foreground Serve owns this one route. Never reset, enable Funnel, or auto-approve HTTPS changes.
    const { DEEPSEEK_API_KEY: _key, ...env } = process.env;
    serve = spawn('tailscale', ['serve', '--https=' + httpsPort, target], { env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
    serve.stderr?.resume();
    exited = new Promise<void>(resolve => {
      serve!.once('error', () => { serveError = true; });
      serve!.once('close', () => { stopped = true; resolve(); });
    });
    for (let i = 0; i < 8; i++) {
      signal.throwIfAborted();
      if (stopped || serveError) throw new Error('Serve 未启动，请检查 Tailscale HTTPS、端口权限和本机登录状态');
      const route = inspect();
      if (route.public) throw new Error('测试端口出现 Funnel 配置，已停止启动');
      if (route.routes.some(([address, config]) => address === host + slot && config.Handlers?.['/']?.Proxy === target)) {
        const tlsVerified = await ready(origin);
        // macOS may be unable to loop through its own Serve TLS endpoint.
        // The phone must independently verify trusted HTTPS in that case.
        if (tlsVerified || i >= 3) return { origin, users, skillId, dispose, dropSockets, socketCount, exited, tailnet: true as const, tlsVerified };
      }
      await delay(450, undefined, { signal });
    }
    throw new Error('Tailnet HTTPS 预检超时，请检查证书、MagicDNS 和 8443 的访问权限');
  } catch (error) {
    await dispose();
    throw error;
  }
}
