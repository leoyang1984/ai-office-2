import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { lstatSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import swagger from '@fastify/swagger';
import { jsonSchemaTransform, serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import * as s from '@office/shared';
import { Runner } from './runner.ts';
import { NativeGateway } from './native-gateway.ts';
import type { NativeRuntime } from './native-gateway.ts';
import type { DshRuntime } from './runner.ts';
import { denied, missing, OfficeError } from './errors.ts';
import { hashPassword, sessionToken, temporaryPassword, verifyPassword } from './security.ts';
import { MAX_UPLOAD, openDataRoot, validateUpload } from './storage.ts';
import { SESSION_AGE, Store } from './store.ts';
import { lockNativeOrBackup } from './data-lock.ts';

declare module 'fastify' {
  interface FastifyRequest {
    officeSession: ReturnType<Store['session']> | null;
    auditTargetId: string | null;
  }
}

const authError = () => new OfficeError(401, 'UNAUTHENTICATED', '请登录后继续');
const wrongPassword = () => new OfficeError(401, 'INVALID_CREDENTIALS', '用户名或密码错误');
const idParams = z.object({ id: s.uuid });
const grantParams = z.object({ id: s.uuid, kbId: s.uuid });
const response = <T extends z.ZodType>(body: T, status = 200) => ({
  [status]: body, 400: s.errorBody, 401: s.errorBody, 403: s.errorBody, 404: s.errorBody,
  409: s.errorBody, 413: s.errorBody, 415: s.errorBody, 429: s.errorBody, 500: s.errorBody, 503: s.errorBody,
});
const ok = { ok: true } as const;
const adminRoute = (request: FastifyRequest) =>
  request.routeOptions.url?.startsWith('/api/v1/admin/') || request.url.startsWith('/api/v1/admin/');
const webRoot = fileURLToPath(new URL('../../web/dist/', import.meta.url));

function user(request: FastifyRequest, allowPasswordChange = false) {
  const session = request.officeSession;
  if (!session) throw authError();
  if (session.account.mustChangePassword && !allowPasswordChange) {
    throw new OfficeError(403, 'PASSWORD_CHANGE_REQUIRED', '请先修改临时密码');
  }
  return session.account;
}

export async function createApp(options: { dataRoot: string; origin: string; serveWeb?: boolean; runtime?: DshRuntime; nativeWeb?: NativeRuntime; sessionCookie?: string }) {
  const cookie = options.sessionCookie ?? 'office_session';
  if (!/^[a-z_][a-z0-9_]{0,63}$/.test(cookie)) throw new Error('Invalid session cookie name');
  const origin = new URL(options.origin);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== options.origin) throw new Error('Invalid AI_OFFICE_ORIGIN');
  if (options.nativeWeb && options.runtime) throw new Error('Choose one DSH runtime');
  const root = options.nativeWeb ? openDataRoot(options.dataRoot) : options.dataRoot;
  const releaseNative = options.nativeWeb ? lockNativeOrBackup(root, true) : undefined;
  let store: Store;
  try { store = new Store(root); }
  catch (error) { releaseNative?.(); throw error; }
  const app = Fastify({
    logger: false, genReqId: () => randomUUID(), bodyLimit: 32 * 1024,
    // The native preClose hook retires workers and WS first. Drop remaining
    // HTTP connections so an open account page cannot hold a restart open.
    ...(options.nativeWeb ? { forceCloseConnections: true } : {}),
  })
    .withTypeProvider<ZodTypeProvider>();
  const runner = new Runner(store, options.runtime);
  const native = options.nativeWeb ? new NativeGateway(store, origin, options.nativeWeb, cookie) : undefined;
  const changeAccess = <T>(id: string, update: () => T, validate?: () => void) => native
    ? native.changeAccess(id, () => runner.changeAccess(id, update), validate) : runner.changeAccess(id, update);
  const closing = new AbortController();
  let nativeStopped = false;
  app.addHook('preClose', async () => {
    closing.abort();
    await native?.close();
    nativeStopped = true;
    await runner.close();
  });
  app.addHook('onClose', async () => {
    store.close();
    if (nativeStopped) releaseNative?.();
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorateRequest('officeSession', null);
  app.decorateRequest('auditTargetId', null);
  try {
    store.recoverInterruptedTurns();
    const dummyHash = await hashPassword(temporaryPassword());
    await app.register(swagger, { openapi: { info: { title: 'AI Office 2.0', version: '0.1.0' } }, transform: jsonSchemaTransform });
    await app.register(rateLimit, { global: false });
    await app.register(multipart, { preservePath: true, limits: { files: 1, fields: 0, parts: 1, fileSize: MAX_UPLOAD } });

    const setCookie = (reply: FastifyReply, token = '') => {
      reply.header('Set-Cookie', cookie + '=' + token + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' +
        (token ? SESSION_AGE : 0) + (origin.protocol === 'https:' ? '; Secure' : ''));
    };

    app.addHook('onRequest', async (request, reply) => {
      reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer')
        .header('X-Frame-Options', 'DENY').header('Cache-Control', 'no-store')
        .header('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      if (request.headers.host !== origin.host) throw denied();
      const token = sessionToken(request.headers.cookie, cookie);
      request.officeSession = token ? store.session(token) ?? null : null;
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers.origin !== origin.origin) throw denied();
      if (adminRoute(request)) {
        if (user(request).role !== 'ADMIN') throw denied();
      }
    });

    app.addHook('onResponse', async (request, reply) => {
      if (!adminRoute(request)) return;
      const action = request.method + ' ' + (request.routeOptions.url ?? '/api/v1/admin/*');
      store.audit({
        actorId: request.officeSession?.account.id ?? null, action,
        targetId: request.auditTargetId,
        success: reply.statusCode < 400, ip: request.ip, requestId: request.id,
      });
    });

    app.setErrorHandler((error, request, reply) => {
      const known = error instanceof OfficeError;
      const status = known ? error.statusCode :
        typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500;
      const safeStatus = [400, 401, 403, 404, 409, 413, 415, 429, 503].includes(status) ? status : 500;
      const code = known ? error.code : safeStatus === 429 ? 'RATE_LIMITED' :
        safeStatus === 500 ? 'INTERNAL_ERROR' : 'INVALID_INPUT';
      const message = known ? error.message : safeStatus === 429 ? '操作过于频繁，请稍后重试' :
        safeStatus === 500 ? '服务暂时无法处理请求' : '请求格式无效';
      reply.code(safeStatus).send({ error: { code, message, requestId: request.id } });
    });
    app.setNotFoundHandler(request => { throw missing(); });

    app.get('/api/v1/health/live', { schema: { response: response(s.ok) } }, async () => ok);
    app.get('/api/v1/health/ready', { schema: { response: response(s.readiness) } },
      async () => ({ ...ok, agent: native ? 'dsh' : runner.mode } as const));
    app.get('/api/v1/openapi.json', { schema: { hide: true } }, async () => app.swagger());
    app.get('/api/v1/native/status', { schema: { response: response(s.nativeStatus) } }, async () => ({ enabled: Boolean(native), ...(options.nativeWeb?.skills ? { skills: true } : {}) }));
    app.post('/api/v1/auth/login', {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: { body: s.login, response: response(s.account) },
    }, async (request, reply) => {
      const row = store.credentials(request.body.username);
      const matches = await verifyPassword(request.body.password, row?.passwordHash ?? dummyHash);
      if (!matches || !row) throw wrongPassword();
      if (request.officeSession) {
        store.revokeSession(request.officeSession.sessionId);
        native?.revokeSession(request.officeSession.sessionId);
      }
      const token = store.authenticate(row);
      if (!token) throw wrongPassword();
      setCookie(reply, token);
      return store.findUser(row.id);
    });
    app.get('/api/v1/auth/me', { schema: { response: response(s.account) } }, async request => user(request, true));
    app.post('/api/v1/auth/logout', { schema: { response: response(s.ok) } }, async (request, reply) => {
      if (!request.officeSession) throw authError();
      store.revokeSession(request.officeSession.sessionId);
      native?.revokeSession(request.officeSession.sessionId);
      setCookie(reply);
      return ok;
    });
    app.post('/api/v1/auth/change-password', {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: { body: s.changePassword, response: response(s.account) },
    }, async (request, reply) => {
      const account = user(request, true);
      const row = store.credentials(account.username);
      if (!row || !await verifyPassword(request.body.currentPassword, row.passwordHash)) throw wrongPassword();
      if (request.body.currentPassword === request.body.newPassword) {
        throw new OfficeError(400, 'PASSWORD_UNCHANGED', '请使用新的密码');
      }
      const nextHash = await hashPassword(request.body.newPassword);
      const token = await changeAccess(account.id, () => store.changePassword(row, nextHash));
      setCookie(reply, token);
      return store.findUser(row.id);
    });

    app.get('/api/v1/admin/users', { schema: { querystring: s.page, response: response(z.array(s.account)) } },
      async request => store.listUsers(request.query));
    app.post('/api/v1/admin/users', { schema: { body: s.createUser, response: response(s.account, 201) } },
      async (request, reply) => {
        const { password, ...input } = request.body;
        const created = store.createUser({ ...input, passwordHash: await hashPassword(password) }, 'USER');
        request.auditTargetId = created.id;
        return reply.code(201).send(created);
      });
    app.patch('/api/v1/admin/users/:id', { schema: { params: idParams, body: s.updateUser, response: response(s.account) } },
      async request => {
        request.auditTargetId = request.params.id;
        const { status, password } = request.body;
        const hash = password ? await hashPassword(password) : undefined;
        return changeAccess(request.params.id, () => store.updateUser(request.params.id, status, hash));
      });
    app.get('/api/v1/admin/knowledge', { schema: { querystring: s.page, response: response(z.array(s.knowledge)) } },
      async request => store.listKnowledge(request.query));
    app.post('/api/v1/admin/knowledge', { schema: { body: s.registerKnowledge, response: response(s.knowledge, 201) } },
      async (request, reply) => {
        const registered = store.registerKnowledge(request.body.name, request.body.directory);
        request.auditTargetId = registered.id;
        return reply.code(201).send(registered);
      });
    for (const [method, enabled] of [['PUT', true], ['DELETE', false]] as const) {
      app.route({
        method, url: '/api/v1/admin/users/:id/knowledge/:kbId',
        schema: { params: grantParams, response: response(s.ok) },
        handler: async request => {
          request.auditTargetId = request.params.kbId;
          await changeAccess(request.params.id, () => store.setGrant(request.params.id, request.params.kbId, enabled));
          return ok;
        },
      });
    }
    app.get('/api/v1/admin/audit', { schema: { querystring: s.page, response: response(z.array(s.auditEvent)) } },
      async request => store.auditEvents(request.query));
    app.get('/api/v1/knowledge', { schema: { querystring: s.page, response: response(z.array(s.grant)) } },
      async request => store.grants(user(request).id, request.query));

    app.get('/api/v1/conversations', { schema: { querystring: s.page, response: response(z.array(s.conversation)) } },
      async request => store.listConversations(user(request).id, request.query));
    app.post('/api/v1/conversations', { schema: { body: s.createConversation, response: response(s.conversation, 201) } },
      async (request, reply) => reply.code(201).send(store.createConversation(user(request).id, request.body.title)));
    app.get('/api/v1/conversations/:id', { schema: { params: idParams, response: response(s.conversationDetail) } },
      async request => store.conversation(user(request).id, request.params.id));
    app.post('/api/v1/conversations/:id/messages', {
      schema: { params: idParams, body: s.sendMessage, response: response(s.conversationDetail) },
    }, async request => {
      const owner = user(request).id;
      const { id } = request.params;
      const { text, requestId, attachmentId } = request.body;
      if (native) throw new OfficeError(409, 'NATIVE_WEB_REQUIRED', '请在 DSH 页面发送消息');
      await runner.send(owner, id, requestId, text, attachmentId);
      return store.conversation(owner, id);
    });
    app.post('/api/v1/conversations/:id/stop', { schema: { params: idParams, response: response(s.ok) } },
      async request => {
        await runner.stop(user(request).id, request.params.id);
        return ok;
      });
    app.get('/api/v1/conversations/:id/events', { schema: { params: idParams } }, async (request, reply) => {
      const owner = user(request).id;
      const id = request.params.id;
      const token = sessionToken(request.headers.cookie, cookie)!;
      const from = request.headers['last-event-id'];
      let after = Number(from ?? 0);
      if (!Number.isSafeInteger(after) || after < 0) throw new OfficeError(400, 'INVALID_EVENT_ID', '事件编号无效');
      store.events(owner, id, after);
      reply.hijack();
      const stream = reply.raw;
      stream.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'X-Accel-Buffering': 'no',
      });
      stream.write(': connected\n\n');
      const disconnected = new AbortController();
      stream.once('close', () => disconnected.abort());
      const signal = AbortSignal.any([closing.signal, disconnected.signal, AbortSignal.timeout(60_000)]);
      try {
        while (!signal.aborted && store.session(token)?.account.id === owner) {
          for (const event of store.events(owner, id, after)) {
            after = event.seq;
            if (!stream.write('id: ' + event.seq + '\nevent: ' + event.type + '\ndata: ' +
              JSON.stringify(event) + '\n\n')) return;
          }
          await delay(250, undefined, { signal });
        }
      } catch (error) {
        if (!signal.aborted) stream.destroy(error instanceof Error ? error : undefined);
      } finally {
        stream.end();
      }
    });

    app.get('/api/v1/files', { schema: { querystring: s.page, response: response(z.array(s.file)) } },
      async request => store.listFiles(user(request).id, request.query));
    app.post('/api/v1/files/upload', {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: { response: response(s.file, 201) },
    }, async (request, reply) => {
      const owner = user(request).id;
      if (native) throw new OfficeError(409, 'NATIVE_WEB_REQUIRED', '请在 DSH 页面上传文件');
      const file = await request.file();
      if (!file) throw new OfficeError(400, 'FILE_REQUIRED', '请选择一个文件');
      const bytes = await file.toBuffer();
      const type = validateUpload(file.filename, file.mimetype, bytes);
      return reply.code(201).send(store.addFile(owner, file.filename, type, bytes));
    });
    app.get('/api/v1/files/:id/preview', { schema: { params: idParams } }, async (request, reply) => {
      const { file, bytes } = store.download(user(request).id, request.params.id);
      if (s.imageMime.safeParse(file.mime).success) return reply.type(file.mime).send(bytes);
      if (file.mime === 'text/plain' || file.mime === 'text/markdown') {
        return reply.type('text/plain; charset=utf-8').send(bytes.subarray(0, 64 * 1024));
      }
      throw new OfficeError(415, 'PREVIEW_UNAVAILABLE', '此文件类型请下载查看');
    });
    app.get('/api/v1/files/:id/download', { schema: { params: idParams } }, async (request, reply) => {
      const { file, bytes } = store.download(user(request).id, request.params.id);
      const encoded = encodeURIComponent(file.name).replace(/[!'()*]/g, char =>
        '%' + char.charCodeAt(0).toString(16).toUpperCase());
      return reply.type(file.mime).header('Content-Disposition', "attachment; filename*=UTF-8''" + encoded).send(bytes);
    });

    if (native) await native.register(app);
    const catalog = store.skillCatalog;
    if (catalog) {
      const nameParams = z.object({ name: s.skillName });
      const skillGrantParams = z.object({ id: s.uuid, skillId: s.uuid });
      app.get('/api/v1/skills', { schema: { response: response(s.skillLibrary) } },
        async request => catalog.library(user(request).id));
      app.get('/api/v1/skills/personal/:name', { schema: { params: nameParams, response: response(s.skillInput) } },
        async request => catalog.personalDraft(user(request).id, request.params.name));
      app.put('/api/v1/skills/personal', {
        bodyLimit: 192 * 1024, schema: { body: s.skillInput, response: response(s.skillInfo) },
      }, async request => {
        const id = user(request).id;
        const saved = await changeAccess(id, () => catalog.savePersonal(id, request.body), () => catalog.checkPersonal(id, request.body));
        store.audit({ actorId: id, action: 'skill.personal.save', targetId: saved.id, success: true, ip: request.ip, requestId: request.id });
        return saved;
      });
      app.delete('/api/v1/skills/personal/:name', { schema: { params: nameParams, response: response(s.ok) } }, async request => {
        const id = user(request).id;
        await changeAccess(id, () => catalog.removePersonal(id, request.params.name));
        store.audit({ actorId: id, action: 'skill.personal.delete', targetId: null, success: true, ip: request.ip, requestId: request.id });
        return ok;
      });
      app.get('/api/v1/admin/skills', { schema: { response: response(s.skillInfo.array()) } },
        async () => catalog.listPublic());
      app.post('/api/v1/admin/skills', {
        bodyLimit: 192 * 1024, schema: { body: s.skillInput, response: response(s.skillInfo, 201) },
      }, async (request, reply) => {
        const installed = catalog.installPublic(request.body);
        request.auditTargetId = installed.id;
        return reply.code(201).send(installed);
      });
      app.get('/api/v1/admin/users/:id/skills', { schema: { params: idParams, response: response(s.skillInfo.array()) } },
        async request => catalog.library(store.findUser(request.params.id).id).public);
      for (const [method, enabled] of [['PUT', true], ['DELETE', false]] as const) {
        app.route({
          method, url: '/api/v1/admin/users/:id/skills/:skillId',
          schema: { params: skillGrantParams, response: response(s.ok) },
          handler: async request => {
            const { id, skillId } = request.params;
            request.auditTargetId = skillId;
            store.findUser(id);
            await changeAccess(id, () => catalog.setGrant(id, skillId, enabled), () => catalog.checkGrant(id, skillId, enabled));
            return ok;
          },
        });
      }
    }
    if (options.serveWeb) {
      if (!lstatSync(webRoot, { throwIfNoEntry: false })?.isDirectory()) throw new Error('Run pnpm build before starting the server');
      await app.register(staticFiles, { root: webRoot, prefix: '/', index: false });
      app.get('/', { schema: { hide: true } }, async (_request, reply) => reply.sendFile('index.html'));
    }
    await app.ready();
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}
