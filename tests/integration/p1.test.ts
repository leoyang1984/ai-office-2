import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createApp } from '../../apps/api/src/app.ts';
import { hashPassword, temporaryPassword } from '../../apps/api/src/security.ts';
import { Store } from '../../apps/api/src/store.ts';

const origin = 'http://127.0.0.1:3000';
const api = '/api/v1';
const root = mkdtempSync(join(tmpdir(), 'ai-office-p1-test-'));
const dataRoot = join(root, 'data');
let app: Awaited<ReturnType<typeof createApp>>;
let adminCookie: string;
let alice: { id: string; cookie: string; password: string };
let bob: { id: string; cookie: string; password: string };
let bobConversationId: string;
let bobFileId: string;

type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
function call(method: HttpMethod, url: string, cookie?: string, payload?: object, headers?: Record<string, string>) {
  return app.inject({
    method, url: api + url, payload,
    headers: { host: '127.0.0.1:3000', origin, ...(cookie ? { cookie } : {}), ...headers },
  });
}

function cookieOf(response: Awaited<ReturnType<typeof call>>): string {
  expect(response.statusCode, response.body).toBe(200);
  const raw = response.headers['set-cookie'];
  expect(raw).toEqual(expect.stringContaining('HttpOnly; SameSite=Strict'));
  return String(raw).split(';')[0]!;
}

async function changeTemporary(username: string, temp: string) {
  const initial = cookieOf(await call('POST', '/auth/login', undefined, { username, password: temp }));
  const protectedResponse = await call('GET', '/conversations', initial);
  expect(protectedResponse.statusCode).toBe(403);
  expect(protectedResponse.json().error.code).toBe('PASSWORD_CHANGE_REQUIRED');
  const password = temporaryPassword();
  const cookie = cookieOf(await call('POST', '/auth/change-password', initial, {
    currentPassword: temp, newPassword: password,
  }));
  expect((await call('GET', '/auth/me', initial)).statusCode).toBe(401);
  return { cookie, password };
}

async function createUser(username: string) {
  const password = temporaryPassword();
  const response = await call('POST', '/admin/users', adminCookie, { username, displayName: username, password });
  expect(response.statusCode, response.body).toBe(201);
  return { id: response.json().id as string, ...await changeTemporary(username, password) };
}

function upload(cookie: string, filename: string, type: string, bytes: Buffer) {
  const boundary = 'p1-' + randomUUID();
  const header = '--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="' + filename +
    '"\r\nContent-Type: ' + type + '\r\n\r\n';
  const body = Buffer.concat([Buffer.from(header), bytes, Buffer.from('\r\n--' + boundary + '--\r\n')]);
  return app.inject({
    method: 'POST', url: api + '/files/upload', payload: body,
    headers: { host: '127.0.0.1:3000', origin, cookie, 'content-type': 'multipart/form-data; boundary=' + boundary },
  });
}

describe('P1 office acceptance', () => {
  beforeAll(async () => {
    const store = new Store(dataRoot);
    const password = temporaryPassword();
    const admin = { username: 'admin', displayName: '管理员', passwordHash: await hashPassword(password) };
    store.createUser(admin, 'ADMIN');
    expect(() => store.createUser(admin, 'ADMIN')).toThrow('管理员已经初始化');
    store.close();
    app = await createApp({ dataRoot, origin });
    adminCookie = (await changeTemporary('admin', password)).cookie;
  });

  afterAll(async () => {
    await app?.close();
    rmSync(root, { recursive: true, force: true });
  });

  test('A01/A02 account creation, password change and UUID directory provisioning', async () => {
    expect((await call('POST', '/register', undefined, {})).statusCode).toBe(404);
    const original = readdirSync(join(dataRoot, 'users'));
    const missingGrant = await call('POST', '/admin/users', adminCookie, {
      username: 'rolled-back', displayName: 'Roll back', password: temporaryPassword(), knowledgeIds: [randomUUID()],
    });
    expect(missingGrant.statusCode).toBe(404);
    expect(readdirSync(join(dataRoot, 'users'))).toEqual(original);

    alice = await createUser('alice');
    bob = await createUser('bob');
    expect(alice.id).not.toBe(bob.id);
    for (const user of [alice, bob]) {
      const path = join(dataRoot, 'users', user.id);
      for (const directory of ['dsh-home', 'logs', 'workspace/uploads', 'workspace/outputs', 'workspace/projects']) {
        expect(statSync(join(path, directory)).mode & 0o777).toBe(0o700);
      }
    }
    const openapi = await call('GET', '/openapi.json');
    expect(openapi.statusCode, openapi.body).toBe(200);
    expect(openapi.json().paths['/api/v1/auth/login']).toHaveProperty('post');
  });

  test('A03/A04/A05/A17 account boundaries, mock conversation and CSRF', async () => {
    const created = await call('POST', '/conversations', bob.cookie, { title: 'Bob 私有会话' });
    expect(created.statusCode, created.body).toBe(201);
    bobConversationId = created.json().id;
    const project = join(dataRoot, 'users', bob.id, 'workspace/projects', bobConversationId);
    expect(statSync(project).isDirectory()).toBe(true);
    const requestId = randomUUID();
    const messageRoute = '/conversations/' + bobConversationId + '/messages';
    const message = { text: '生成测试文件', requestId };
    for (let attempt = 0; attempt < 2; attempt++) {
      const sent = await call('POST', messageRoute, bob.cookie, message);
      expect(sent.statusCode, sent.body).toBe(200);
      expect(sent.json().messages).toHaveLength(2);
      expect(sent.json().messages[1].text).toContain('Mock Agent');
    }
    const listed = await call('GET', '/files', bob.cookie);
    expect(listed.json()).toHaveLength(1);
    bobFileId = listed.json()[0].id;
    const mine = await call('GET', '/files/' + bobFileId + '/download', bob.cookie);
    expect(mine.statusCode).toBe(200);
    expect(mine.body).toContain('生成测试文件');
    expect(mine.headers['content-disposition']).toContain('attachment;');

    expect((await call('GET', '/conversations', alice.cookie)).json()).toEqual([]);
    expect((await call('GET', '/files', alice.cookie)).json()).toEqual([]);
    expect((await call('GET', '/conversations/' + bobConversationId, alice.cookie)).statusCode).toBe(404);
    expect((await call('POST', messageRoute, alice.cookie, message)).statusCode).toBe(404);
    expect((await call('GET', '/files/' + bobFileId + '/download', alice.cookie)).statusCode).toBe(404);
    expect((await call('GET', '/admin/users', alice.cookie)).statusCode).toBe(403);
    expect((await call('POST', '/conversations', alice.cookie, { title: '跨站' }, { origin: 'https://invalid.test' })).statusCode).toBe(403);
    expect((await call('GET', '/auth/me', alice.cookie, undefined, { host: 'invalid.test' })).statusCode).toBe(403);
    const audit = (await call('GET', '/admin/audit', adminCookie)).json();
    expect(audit).toContainEqual(expect.objectContaining({
      actorId: alice.id, action: 'GET /api/v1/admin/users', success: false,
    }));
  });

  test('A06/A16 uploads reject traversal and fake images; downloads reject symbolic links', async () => {
    expect((await upload(alice.cookie, '../escape.txt', 'text/plain', Buffer.from('test'))).statusCode).toBe(400);
    expect((await upload(alice.cookie, 'fake.png', 'image/png', Buffer.from('not a png'))).statusCode).toBe(415);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X7v8AAAAASUVORK5CYII=', 'base64');
    const valid = await upload(alice.cookie, 'valid.png', 'image/png', png);
    expect(valid.statusCode, valid.body).toBe(201);
    const fileId = valid.json().id;
    const route = '/files/' + fileId + '/download';
    const download = await call('GET', route, alice.cookie);
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload).toEqual(png);

    const foreign = join(root, 'outside.png');
    writeFileSync(foreign, png);
    const local = join(dataRoot, 'users', alice.id, 'workspace/uploads', fileId);
    unlinkSync(local);
    symlinkSync(foreign, local);
    expect((await call('GET', route, alice.cookie)).statusCode).toBe(404);
  });

  test('managed knowledge registration and explicit read-only grants', async () => {
    mkdirSync(join(dataRoot, 'knowledge/fixture'), { mode: 0o700 });
    symlinkSync(root, join(dataRoot, 'knowledge/link'));
    expect((await call('POST', '/admin/knowledge', adminCookie, { name: '外部', directory: '../outside' })).statusCode).toBe(400);
    expect((await call('POST', '/admin/knowledge', adminCookie, { name: '链接', directory: 'link' })).statusCode).toBe(404);
    const created = await call('POST', '/admin/knowledge', adminCookie, { name: '合成知识库', directory: 'fixture' });
    expect(created.statusCode, created.body).toBe(201);
    expect(Object.keys(created.json()).sort()).toEqual(['id', 'name']);
    const route = '/admin/users/' + alice.id + '/knowledge/' + created.json().id;
    expect((await call('GET', '/knowledge', alice.cookie)).json()).toEqual([]);
    expect((await call('PUT', route, adminCookie)).statusCode).toBe(200);
    expect((await call('GET', '/knowledge', alice.cookie)).json()).toEqual([{
      id: created.json().id, name: '合成知识库', permission: 'READ_ONLY',
    }]);
    expect((await call('GET', '/knowledge', bob.cookie)).json()).toEqual([]);
    expect((await call('DELETE', route, adminCookie)).statusCode).toBe(200);
    expect((await call('GET', '/knowledge', alice.cookie)).json()).toEqual([]);
  });

  test('A15 persistent accounts, sessions, conversations and files after restart', async () => {
    await app.close();
    app = await createApp({ dataRoot, origin, serveWeb: true });
    const index = await app.inject({ url: '/', headers: { host: '127.0.0.1:3000' } });
    expect(index.statusCode).toBe(200);
    expect(index.body).toContain('<title>AI Office 2.0</title>');
    expect(index.headers['content-security-policy']).toContain("default-src 'self'");
    const asset = index.body.match(/src="([^"]+\.js)"/)?.[1];
    expect(asset).toBeTruthy();
    expect((await app.inject({ url: asset!, headers: { host: '127.0.0.1:3000' } })).statusCode).toBe(200);
    expect((await call('GET', '/auth/me', bob.cookie)).json().id).toBe(bob.id);
    const detail = await call('GET', '/conversations/' + bobConversationId, bob.cookie);
    expect(detail.statusCode).toBe(200);
    expect(detail.json().messages).toHaveLength(2);
    expect((await call('GET', '/files/' + bobFileId + '/download', bob.cookie)).statusCode).toBe(200);
  });

  test('disabled users lose existing sessions and cannot log in', async () => {
    const result = await call('PATCH', '/admin/users/' + bob.id, adminCookie, { status: 'disabled' });
    expect(result.statusCode).toBe(200);
    expect((await call('GET', '/auth/me', bob.cookie)).statusCode).toBe(401);
    const invalid = await call('POST', '/auth/login', undefined, { username: 'bob', password: bob.password });
    const unknown = await call('POST', '/auth/login', undefined, { username: 'ghost', password: bob.password });
    expect(invalid.statusCode).toBe(401);
    expect(invalid.json().error.message).toBe(unknown.json().error.message);
    expect(statSync(join(dataRoot, 'users', bob.id)).isDirectory()).toBe(true);
  });
});
