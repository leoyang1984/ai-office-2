// Project-owned transport around the unmodified, pinned official Web application.
// No Docker ports or external container network are exposed.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
// The official adapter requires a nonempty credential; no cloud key enters this image.
const loopbackCredentialPlaceholder = 'local-loopback-placeholder';
const WEB_PORT = 3080;
const locked = process.argv.includes('--office-locked');
const skills = locked && process.argv.includes('--office-skills');
const MAX_FRAME = 6 * 1024 * 1024;
const MAX_QUEUED = 24 * 1024 * 1024;
const sockets = new Map();
const providers = new Map();
let child;
let closing = false;
const send = frame => {
  if (closing) return false;
  const line = JSON.stringify(frame) + '\n';
  if (Buffer.byteLength(line) > MAX_FRAME || process.stdout.writableLength > MAX_QUEUED) { void close(2); return false; }
  return process.stdout.write(line);
};
process.stdout.on('drain', () => { for (const socket of sockets.values()) socket.resume(); });
const provider = createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/anthropic/v1/messages' || providers.size >= (locked ? 1 : 2)) {
    res.writeHead(403).end(); return;
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4 * 1024 * 1024) { res.writeHead(413).end(); return; }
    chunks.push(chunk);
  }
  const id = randomUUID();
  providers.set(id, res);
  res.once('close', () => { if (providers.delete(id)) send({ type: 'model-abort', id }); });
  send({ type: 'model-request', id, body: Buffer.concat(chunks).toString('utf8') });
});
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
for (const folder of ['/tenant/dsh-home/state', '/tenant/dsh-home/config', '/tenant/dsh-home/cache']) mkdirSync(folder, { recursive: true });
if (locked) {
  for (const name of ['sessions', 'storages', 'attachments', 'spill']) mkdirSync('/tenant/dsh-home/state/' + name, { recursive: true });
  mkdirSync('/tmp/office-cache', { recursive: true });
}
const env = {
  PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tenant/dsh-home',
  DSH_HOME: '/tenant/dsh-home/state', XDG_CONFIG_HOME: '/tenant/dsh-home/config',
  XDG_DATA_HOME: '/tenant/dsh-home/data', XDG_CACHE_HOME: '/tenant/dsh-home/cache', TMPDIR: '/tmp',
  NARB_DISABLE_NATIVE_CACHE: '1', NARB_DISABLE_LOCAL_BUILD: '1', DSH_TELEMETRY_DISABLED: '1',
  DEEPSEEK_BASE_URL: 'http://127.0.0.1:' + provider.address().port + '/anthropic',
  DEEPSEEK_API_KEY: loopbackCredentialPlaceholder,
  ...(locked ? { HOME: '/opt/office-empty', DSH_HOME: '/opt/office-home', AGENTS_HOME: '/opt/office-empty',
    XDG_CONFIG_HOME: '/opt/office-empty', XDG_DATA_HOME: '/opt/office-empty', XDG_CACHE_HOME: '/tmp/office-cache',
    DSH_PERMISSION_MODE: 'workspace-write' } : {}),
};
child = spawn(process.execPath, [...(locked ? ['--import', '/opt/office-web/readonly-root.mjs'] : []), '/opt/office-worker/node_modules/@deepseek-ai/dsh/lib/bin.js', '--profile', 'web',
  '--patch', '/opt/office-web/probe.patch.yml', ...(locked ? ['--patch', '/opt/office-web/locked.patch.yml'] : []),
  ...(skills ? ['--patch', '/opt/office-web/skills.patch.yml'] : []), '--no-open', '--host', '127.0.0.1', '--port', String(WEB_PORT),
  ...(process.env.OFFICE_WEB_TRUSTED_HOST ? ['--trusted-host', process.env.OFFICE_WEB_TRUSTED_HOST] : [])],
  { cwd: locked ? '/opt/office-invocation' : '/tenant/workspace', env, stdio: ['ignore', 'pipe', 'pipe'] });
// Capture the synthetic instance launch credential privately, never forward its log.
let bootLog = '';
let ready = false;
function observe(chunk) {
  bootLog = (bootLog + chunk.toString()).slice(-256 * 1024);
  const match = bootLog.match(/dsh web:\s+(http:\/\/127\.0\.0\.1:3080\/\?token=[^\s\x1b]+)/);
  if (match && !ready) { ready = true; send({ type: 'ready', locked, skills, launchPath: new URL(match[1]).pathname + new URL(match[1]).search }); }
}
child.stdout.on('data', observe);
child.stderr.on('data', observe);
child.once('exit', code => { send({ type: 'exited', code, ...(!ready ? { diagnostic: bootLog.replace(/token=[^\s"']+/g, 'token=[redacted]').slice(-5000) } : {}) }); void close(code || 1); });
setTimeout(() => {
  if (!ready) {
    // Test instances have no cloud secrets, but always redact process credentials.
    send({ type: 'boot-failed', diagnostic: bootLog.replace(/token=[^\s"']+/g, 'token=[redacted]').slice(-5000) });
    void close(2);
  }
}, 60_000).unref();
async function close(code = 0) {
  if (closing) return;
  closing = true;
  for (const socket of sockets.values()) socket.destroy();
  for (const response of providers.values()) response.destroy();
  provider.closeAllConnections(); provider.close();
  child?.kill('SIGTERM');
  setTimeout(() => process.exit(code), 500).unref();
  process.stdin.destroy();
}
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  if (Buffer.byteLength(buffer) > MAX_FRAME) { void close(2); return; }
  let end;
  while ((end = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    try { receive(JSON.parse(line)); } catch { void close(2); return; }
  }
});
process.stdin.once('end', () => void close());
function receive(frame) {
  if (frame.type === 'close') { void close(); return; }
  if (typeof frame.id !== 'string' || !/^[a-f0-9-]{36}$/.test(frame.id)) throw new Error('Invalid channel');
  if (frame.type === 'connect') {
    if (!ready || sockets.has(frame.id) || sockets.size >= 48) throw new Error('Invalid connection');
    const socket = connect({ host: '127.0.0.1', port: WEB_PORT });
    sockets.set(frame.id, socket);
    socket.on('data', bytes => {
      for (let i = 0; i < bytes.length; i += 48 * 1024) {
        if (!send({ type: 'data', id: frame.id, data: bytes.subarray(i, i + 48 * 1024).toString('base64') })) socket.pause();
      }
    });
    socket.on('end', () => send({ type: 'end', id: frame.id }));
    socket.on('error', () => socket.destroy());
    socket.once('close', () => { sockets.delete(frame.id); send({ type: 'closed', id: frame.id }); });
  } else if (frame.type === 'data') {
    if (typeof frame.data !== 'string' || frame.data.length > 66 * 1024) throw new Error('Invalid data');
    const socket = sockets.get(frame.id);
    if (socket && socket.writableLength < MAX_QUEUED) socket.write(Buffer.from(frame.data, 'base64'));
    else socket?.destroy();
  } else if (frame.type === 'end') sockets.get(frame.id)?.end();
  else if (frame.type === 'closed') sockets.get(frame.id)?.destroy();
  else if (frame.type.startsWith('model-')) {
    const response = providers.get(frame.id);
    if (!response) return;
    if (frame.type === 'model-headers') {
      if (!Number.isInteger(frame.status) || frame.status < 200 || frame.status > 599) throw new Error('Invalid model status');
      response.writeHead(frame.status, { 'Content-Type': frame.status === 200 ? 'text/event-stream' : 'application/json' });
    }
    else if (frame.type === 'model-data') {
      if (typeof frame.data !== 'string' || frame.data.length > 66 * 1024) throw new Error('Invalid model data');
      if (response.writableLength > MAX_QUEUED) response.destroy();
      else response.write(Buffer.from(frame.data, 'base64'));
    } else if (frame.type === 'model-end') { providers.delete(frame.id); response.end(); }
    else response.destroy();
  } else throw new Error('Unknown frame');
}
