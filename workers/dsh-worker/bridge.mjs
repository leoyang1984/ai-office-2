import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client';

// The SDK requires a nonempty value. The loopback broker uses no cloud credential.
const brokerPlaceholder = 'local-loopback-placeholder';
const MODEL_REQUEST_MAX = 4 * 1024 * 1024;
const providerRequests = new Map();
const send = value => process.stdout.write(JSON.stringify(value) + '\n');

let harness;
let session;
let turnId;
let modelRequests = 0;
let closed = false;

const server = createServer(async (request, response) => {
  if (!turnId || request.method !== 'POST' || request.url !== '/anthropic/v1/messages') {
    response.writeHead(403).end();
    return;
  }
  if (++modelRequests > 12 || providerRequests.size > 0) {
    response.writeHead(429).end();
    return;
  }
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of request) {
      size += chunk.length;
      if (size > MODEL_REQUEST_MAX) {
        response.writeHead(413).end();
        return;
      }
      chunks.push(chunk);
    }
    const id = randomUUID();
    providerRequests.set(id, response);
    response.on('close', () => {
      if (providerRequests.delete(id)) send({ type: 'provider-abort', id });
    });
    send({ type: 'provider-request', id, turnId, body: Buffer.concat(chunks).toString('utf8') });
  } catch {
    response.destroy();
  }
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});

async function initialize(savedSessionId) {
  if (harness) throw new Error('ALREADY_STARTED');
  const cwd = process.cwd();
  const dshHome = '/tenant/dsh-home/state';
  harness = new DeepSeekHarness({
    profile: 'sdk',
    dshHome,
    cwd,
    processCwd: cwd,
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    maxTokens: 1024,
    reasoningEffort: 'off',
    initializeTimeoutMs: 30_000,
    requestTimeoutMs: 15_000,
    env: {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: '/tenant/dsh-home',
      XDG_CONFIG_HOME: '/tenant/dsh-home/config',
      XDG_DATA_HOME: '/tenant/dsh-home/data',
      XDG_CACHE_HOME: '/tenant/dsh-home/cache',
      TMPDIR: '/tmp',
      DSH_TELEMETRY_DISABLED: '1',
      // Load the image's pinned prebuilt module directly instead of copying it to the noexec tmpfs.
      NARB_DISABLE_NATIVE_CACHE: '1',
      NARB_DISABLE_LOCAL_BUILD: '1',
      DEEPSEEK_BASE_URL: 'http://127.0.0.1:' + server.address().port + '/anthropic',
      DEEPSEEK_API_KEY: brokerPlaceholder,
    },
  });
  await harness.start();
  session = savedSessionId ? await harness.resumeSession(savedSessionId) : harness.session();
  if (await session.getWorkingDirectory() !== cwd) throw new Error('WORKSPACE_MISMATCH');
  send({ type: 'initialized', sessionId: session.id });
}

async function run(message) {
  if (!session || turnId || typeof message.text !== 'string' || message.text.length > 8500 ||
      typeof message.turnId !== 'string' || message.turnId.length > 64) throw new Error('INVALID_TURN');
  turnId = message.turnId;
  modelRequests = 0;
  try {
    const attachment = message.attachment;
    if (attachment && (typeof attachment.data !== 'string' || attachment.data.length > 2_796_204 ||
        !['image/png', 'image/jpeg', 'image/webp'].includes(attachment.mimeType) || typeof attachment.name !== 'string')) {
      throw new Error('INVALID_ATTACHMENT');
    }
    const prompt = attachment ? [
      { type: 'text', text: message.text },
      { type: 'image', mimeType: attachment.mimeType, data: attachment.data, name: attachment.name },
    ] : message.text;
    const result = await session.run(prompt, {
      onNotification(notification) {
        const event = notification.params.event;
        if (notification.params.sessionId !== session.id || !event) return;
        if (event.type === 'tool/call') send({ type: 'tool', turnId });
        if (event.type === 'assistant/message') {
          const content = event.data?.message?.content;
          const text = Array.isArray(content)
            ? content.filter(block => block.type === 'text').map(block => block.text).join('')
            : '';
          if (text) send({ type: 'delta', turnId, text: text.slice(0, 16_000) });
        }
      },
    });
    if (result.finishReason !== 'completed') {
      const reason = result.events.findLast(event => event.type === 'turn/end')?.data.reason;
      const status = reason?.kind === 'error' ? reason.error?.status : undefined;
      send({ type: 'failed', turnId, code: 'DSH_TURN_FAILED',
        ...(Number.isInteger(status) && status >= 400 && status <= 599 ? { status } : {}) });
    } else {
      send({ type: 'completed', turnId, text: result.finalResponse });
    }
  } finally {
    turnId = undefined;
  }
}

async function close() {
  if (closed) return;
  closed = true;
  for (const response of providerRequests.values()) response.destroy();
  server.closeAllConnections();
  server.close();
  await harness?.close();
  process.stdin.destroy();
}

function deliverProviderResponse(message) {
  const response = providerRequests.get(message.id);
  if (!response) return;
  if (message.type === 'provider-headers') {
    if (!Number.isInteger(message.status) || message.status < 200 || message.status > 599) {
      response.destroy();
      return;
    }
    response.writeHead(message.status, {
      'Content-Type': message.status === 200 ? 'text/event-stream' : 'application/json',
    });
  } else if (message.type === 'provider-data') {
    if (typeof message.data === 'string' && message.data.length <= 256 * 1024) {
      response.write(Buffer.from(message.data, 'base64'));
    } else {
      response.destroy();
    }
  } else {
    providerRequests.delete(message.id);
    response.end();
  }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
  if (closed) return;
  let message;
  try { message = JSON.parse(line); } catch { void close(); return; }
  if (!message || typeof message.type !== 'string') { void close(); return; }
  switch (message.type) {
    case 'initialize':
      void initialize(message.sessionId).catch(() => send({ type: 'startup-failed', code: 'DSH_INITIALIZE_FAILED' }));
      break;
    case 'run':
      void run(message).catch(() => send({ type: 'failed', turnId: message.turnId, code: 'DSH_TURN_FAILED' }));
      break;
    case 'provider-headers':
    case 'provider-data':
    case 'provider-end':
      deliverProviderResponse(message);
      break;
    case 'close':
      void close();
      break;
    default:
      void close();
  }
});
input.once('close', () => { void close(); });
