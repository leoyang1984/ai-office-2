import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { AgentResult } from '@office/runner-contract';
import { imageMime, maxAttachedImage } from '@office/shared';
import type { Account, Conversation, ConversationDetail, Grant, Knowledge, OfficeFile } from '@office/shared';
import { conflict, missing, OfficeError } from './errors.ts';
import { SkillCatalog } from './skills.ts';
import type { NativeStorageLimit } from './native-storage.ts';
import { hashBytes, makeToken, redactMessage } from './security.ts';
import {
  collectExports, createDirectories, directoryAt, MAX_USER_BYTES, MAX_USER_FILES, openDataRoot,
  readWorkspaceFile, removeEmptyDirectories, workspacePath, writeWorkspaceFile,
} from './storage.ts';

type UserRow = Omit<Account, 'mustChangePassword'> & { mustChangePassword: number; passwordHash: string };
type SessionUser = { account: Account; sessionId: string };
type FileRow = OfficeFile & { relativePath: string; sha256: string };
type InputUser = { username: string; displayName: string; passwordHash: string; knowledgeIds?: string[] };
type Page = { limit: number; offset: number };

const userFields = 'id, username, display_name AS displayName, role, status, must_change_password AS mustChangePassword';
const qualifiedUserFields = 'u.id, u.username, u.display_name AS displayName, u.role, u.status, u.must_change_password AS mustChangePassword';
const conversationFields = 'id, title, updated_at AS updatedAt';
const fileFields = "id, name, mime, size, CASE WHEN conversation_id IS NULL THEN 'upload' ELSE 'output' END AS source";
export const SESSION_AGE = 12 * 60 * 60;

function toAccount(row: Omit<UserRow, 'passwordHash'>): Account {
  return {
    id: row.id, username: row.username, displayName: row.displayName, role: row.role,
    status: row.status, mustChangePassword: row.mustChangePassword === 1,
  };
}

export class Store {
  readonly root: string;
  skillCatalog?: SkillCatalog;
  private readonly db: Database.Database;

  constructor(dataRoot: string) {
    this.root = openDataRoot(dataRoot);
    const file = join(this.root, 'db', 'office.sqlite');
    for (const path of [file, file + '-wal', file + '-shm']) {
      const stat = lstatSync(path, { throwIfNoEntry: false });
      if (stat && (!stat.isFile() || stat.nlink !== 1)) throw new Error('Invalid SQLite file');
    }
    const previousMask = process.umask(0o077);
    try {
      this.db = new Database(file, { timeout: 5000 });
    } finally {
      process.umask(previousMask);
    }
    try {
      this.db.pragma('foreign_keys = ON');
      this.db.pragma('journal_mode = WAL');
      this.db.transaction(() => {
        const version = this.db.pragma('user_version', { simple: true });
        if (version === 0) {
          this.db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
        }
        if (version === 0 || version === 1) {
          this.db.exec(readFileSync(new URL('./events.sql', import.meta.url), 'utf8'));
          this.db.pragma('user_version = 2');
        } else if (version !== 2) throw new Error('Unsupported schema version');
      }).immediate();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  enableSkills(storage: NativeStorageLimit): void { this.skillCatalog ??= new SkillCatalog(this.root, storage); }
  close(): void {
    this.skillCatalog?.close();
    this.db.close();
  }

  private get<T>(sql: string, ...params: (string | number | null)[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  private all<T>(sql: string, ...params: (string | number | null)[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  private run(sql: string, ...params: (string | number | null)[]): number {
    return this.db.prepare(sql).run(...params).changes;
  }

  credentials(username: string): UserRow | undefined {
    return this.get<UserRow>('SELECT ' + userFields + ', password_hash AS passwordHash FROM users WHERE username=?', username);
  }

  findUser(id: string): Account {
    const user = this.get<UserRow>('SELECT ' + userFields + ' FROM users WHERE id=?', id);
    if (!user) throw missing();
    return toAccount(user);
  }

  listUsers(page: Page): Account[] {
    return this.all<UserRow>('SELECT ' + userFields + ' FROM users ORDER BY username LIMIT ? OFFSET ?', page.limit, page.offset).map(toAccount);
  }

  createUser(input: InputUser, role: Account['role']): Account {
    const id = randomUUID();
    const created: string[] = [];
    try {
      return this.db.transaction(() => {
        if (role === 'ADMIN' && this.get('SELECT 1 FROM users WHERE role=?', 'ADMIN')) {
          throw conflict('管理员已经初始化');
        }
        if (this.credentials(input.username)) throw conflict('用户名已存在');
        const now = Date.now();
        this.run(
          'INSERT INTO users VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)',
          id, input.username, input.displayName, input.passwordHash, role, 'pending', now, now,
        );
        const base = 'users/' + id;
        const ws = workspacePath(id);
        createDirectories(this.root, [
          base, base + '/dsh-home', base + '/logs', ws, ws + '/uploads', ws + '/outputs', ws + '/projects',
        ], created);
        for (const knowledgeId of new Set(input.knowledgeIds)) this.setGrant(id, knowledgeId, true);
        this.run('UPDATE users SET status=? WHERE id=?', 'active', id);
        if (role === 'ADMIN') this.audit({ actorId: id, action: 'bootstrap', targetId: id, success: true, ip: 'local-cli', requestId: randomUUID() });
        return this.findUser(id);
      }).immediate();
    } catch (error) {
      removeEmptyDirectories(created);
      throw error;
    }
  }

  updateUser(id: string, status?: Account['status'], passwordHash?: string): Account {
    return this.db.transaction(() => {
      const existing = this.findUser(id);
      if (existing.role === 'ADMIN') throw conflict('引导管理员只能自行修改密码');
      this.run(
        'UPDATE users SET status=?, password_hash=COALESCE(?, password_hash), ' +
        'must_change_password=CASE WHEN ? IS NULL THEN must_change_password ELSE 1 END, updated_at=? WHERE id=?',
        status ?? existing.status, passwordHash ?? null, passwordHash ?? null, Date.now(), id,
      );
      if (status === 'disabled' || passwordHash) this.revokeUserSessions(id);
      return this.findUser(id);
    }).immediate();
  }

  changePassword(user: UserRow, passwordHash: string): string {
    return this.db.transaction(() => {
      const changed = this.run(
        'UPDATE users SET password_hash=?, must_change_password=0, updated_at=? WHERE id=? AND password_hash=? AND status=?',
        passwordHash, Date.now(), user.id, user.passwordHash, 'active',
      );
      if (changed !== 1) throw conflict('账户状态已变化，请重新登录');
      this.revokeUserSessions(user.id);
      return this.insertSession(user.id);
    }).immediate();
  }

  authenticate(user: UserRow): string | undefined {
    return this.db.transaction(() => {
      const current = this.credentials(user.username);
      if (current?.id !== user.id || current.passwordHash !== user.passwordHash || current.status !== 'active') return undefined;
      return this.insertSession(user.id);
    }).immediate();
  }

  private insertSession(userId: string): string {
    const token = makeToken();
    const now = Date.now();
    this.run('DELETE FROM auth_sessions WHERE expires_at<=? OR revoked_at IS NOT NULL', now);
    this.run(
      'INSERT INTO auth_sessions(id,user_id,token_hash,created_at,expires_at) VALUES (?,?,?,?,?)',
      randomUUID(), userId, hashBytes(token), now, now + SESSION_AGE * 1000,
    );
    return token;
  }

  session(token: string): SessionUser | undefined {
    const row = this.get<UserRow & { sessionId: string }>(
      'SELECT ' + qualifiedUserFields + ', s.id AS sessionId FROM auth_sessions s JOIN users u ON s.user_id=u.id ' +
      'WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>? AND u.status=?',
      hashBytes(token), Date.now(), 'active',
    );
    return row ? { account: toAccount(row), sessionId: row.sessionId } : undefined;
  }

  revokeSession(id: string): void {
    this.run('UPDATE auth_sessions SET revoked_at=? WHERE id=?', Date.now(), id);
  }

  private revokeUserSessions(userId: string): void {
    this.run('UPDATE auth_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL', Date.now(), userId);
  }

  listKnowledge(page: Page): Knowledge[] {
    return this.all('SELECT id, name FROM knowledge_bases ORDER BY name, id LIMIT ? OFFSET ?', page.limit, page.offset);
  }

  registerKnowledge(name: string, directory: string): Knowledge {
    const canonical = directoryAt(this.root, 'knowledge/' + directory);
    const id = randomUUID();
    this.db.transaction(() => {
      if (this.get('SELECT 1 FROM knowledge_bases WHERE directory=? OR canonical_host_path=?', directory, canonical)) {
        throw conflict('知识库目录已登记');
      }
      this.run('INSERT INTO knowledge_bases VALUES (?,?,?,?,?)', id, name, directory, canonical, Date.now());
    }).immediate();
    return { id, name };
  }

  setGrant(userId: string, knowledgeId: string, enabled: boolean): void {
    this.findUser(userId);
    if (!this.get('SELECT 1 FROM knowledge_bases WHERE id=?', knowledgeId)) throw missing();
    if (enabled) {
      this.run('INSERT OR IGNORE INTO knowledge_grants(user_id,knowledge_id,created_at) VALUES (?,?,?)', userId, knowledgeId, Date.now());
    } else {
      this.run('DELETE FROM knowledge_grants WHERE user_id=? AND knowledge_id=?', userId, knowledgeId);
    }
  }

  grants(userId: string, page: Page): Grant[] {
    return this.all(
      'SELECT k.id, k.name, g.permission FROM knowledge_grants g JOIN knowledge_bases k ON k.id=g.knowledge_id ' +
      'WHERE g.user_id=? ORDER BY k.name, k.id LIMIT ? OFFSET ?', userId, page.limit, page.offset,
    );
  }

  listConversations(userId: string, page: Page): Conversation[] {
    return this.all(
      'SELECT ' + conversationFields + ' FROM conversations WHERE user_id=? ORDER BY updated_at DESC,id LIMIT ? OFFSET ?',
      userId, page.limit, page.offset,
    );
  }

  createConversation(userId: string, title: string): Conversation {
    const id = randomUUID();
    const relativePath = 'projects/' + id;
    const created: string[] = [];
    try {
      return this.db.transaction(() => {
        const updatedAt = Date.now();
        this.run(
          'INSERT INTO conversations(id,user_id,title,workspace_relative_path,updated_at) VALUES (?,?,?,?,?)',
          id, userId, title, relativePath, updatedAt,
        );
        createDirectories(this.root, [workspacePath(userId) + '/' + relativePath], created);
        return { id, title, updatedAt };
      }).immediate();
    } catch (error) {
      removeEmptyDirectories(created);
      throw error;
    }
  }

  private ownConversation(userId: string, id: string): Conversation {
    const row = this.get<Conversation>('SELECT ' + conversationFields + ' FROM conversations WHERE id=? AND user_id=?', id, userId);
    if (!row) throw missing();
    return row;
  }

  conversation(userId: string, id: string): ConversationDetail {
    return {
      ...this.ownConversation(userId, id),
      messages: this.all('SELECT id, role, text FROM messages WHERE conversation_id=? ORDER BY seq', id),
    };
  }

  reserveTurn(userId: string, id: string, requestId: string, text: string): string | undefined {
    return this.db.transaction(() => {
      this.ownConversation(userId, id);
      const existing = this.get<{ status: string }>('SELECT status FROM agent_runs WHERE conversation_id=? AND request_id=?', id, requestId);
      if (existing?.status === 'completed') return undefined;
      if (existing) throw conflict('该请求正在运行或已失败');
      if (this.get('SELECT 1 FROM agent_runs WHERE conversation_id=? AND status=?', id, 'running')) throw conflict('该会话正在运行');
      const { count } = this.get<{ count: number }>('SELECT count(*) AS count FROM agent_runs WHERE conversation_id=?', id)!;
      if (count >= 200) throw conflict('该会话已达到消息上限，请新建会话');
      const turnId = randomUUID();
      this.run('INSERT INTO agent_runs(id,conversation_id,request_id,status,started_at) VALUES (?,?,?,?,?)',
        turnId, id, requestId, 'running', Date.now());
      this.run('INSERT INTO messages(id,conversation_id,run_id,role,text) VALUES (?,?,?,?,?)',
        randomUUID(), id, turnId, 'user', redactMessage(text));
      this.recordEvent(id, turnId, 'queued');
      this.run('UPDATE conversations SET updated_at=? WHERE id=?', Date.now(), id);
      return turnId;
    }).immediate();
  }

  recordEvent(id: string, turnId: string, type: 'queued' | 'started' | 'delta' | 'tool' | 'completed' | 'failed', text?: string): void {
    this.run('INSERT INTO conversation_events(conversation_id,turn_id,type,text,created_at) VALUES (?,?,?,?,?)',
      id, turnId, type, text ? redactMessage(text) : null, Date.now());
  }

  events(userId: string, id: string, after: number) {
    this.ownConversation(userId, id);
    return this.all<{ seq: number; turnId: string; type: string; text: string | null; createdAt: number }>(
      'SELECT seq, turn_id AS turnId, type, text, created_at AS createdAt FROM conversation_events ' +
      'WHERE conversation_id=? AND seq>? ORDER BY seq LIMIT 100', id, after,
    );
  }

  recoverInterruptedTurns(): void {
    this.db.transaction(() => {
      const interrupted = this.all<{ id: string; conversationId: string }>(
        'SELECT id,conversation_id AS conversationId FROM agent_runs WHERE status=?', 'running',
      );
      for (const run of interrupted) this.recordEvent(run.conversationId, run.id, 'failed');
      this.run('UPDATE agent_runs SET status=?,ended_at=? WHERE status=?', 'failed', Date.now(), 'running');
    }).immediate();
  }

  workerTarget(userId: string, id: string) {
    this.ownConversation(userId, id);
    const { workspace, home, grants } = this.nativeTarget(userId, false);
    const row = this.get<{ sessionId: string | null }>('SELECT dsh_session_id AS sessionId FROM conversations WHERE id=?', id)!;
    return { workspace, home, grants, projectId: id, sessionId: row.sessionId ?? undefined };
  }

  nativeTarget(userId: string, initializeProject = true) {
    if (this.findUser(userId).status !== 'active') throw missing();
    const workspace = directoryAt(this.root, workspacePath(userId));
    const home = directoryAt(this.root, 'users/' + userId + '/dsh-home');
    if (initializeProject) {
      try { directoryAt(workspace, 'projects/' + userId); } catch {
        createDirectories(workspace, ['projects/' + userId], []);
      }
    }
    const grants = this.all<{ id: string; directory: string; canonical: string }>(
      'SELECT k.id,k.directory,k.canonical_host_path AS canonical FROM knowledge_grants g ' +
      'JOIN knowledge_bases k ON k.id=g.knowledge_id WHERE g.user_id=?', userId,
    ).map(grant => {
      const path = directoryAt(this.root, 'knowledge/' + grant.directory);
      if (path !== grant.canonical) throw conflict('知识库目录已变化');
      return { id: grant.id, path };
    });
    return { workspace, home, grants, projectId: userId };
  }

  finishTurn(userId: string, id: string, turnId: string, result?: AgentResult, dshSessionId?: string): void {
    const written: string[] = [];
    try {
      this.db.transaction(() => {
        this.ownConversation(userId, id);
        const now = Date.now();
        const changed = this.run('UPDATE agent_runs SET status=?,ended_at=? WHERE id=? AND conversation_id=? AND status=?',
          result ? 'completed' : 'failed', now, turnId, id, 'running');
        if (changed !== 1) throw conflict('该轮对话已经结束');
        if (result) {
          if (result.artifact) {
            this.persistFile(userId, result.artifact.name, 'text/plain', Buffer.from(result.artifact.text), written, id);
          }
          for (const output of result.outputs ?? []) this.persistFile(userId, output.name, output.mime, output.bytes, written, id);
          this.run('INSERT INTO messages(id,conversation_id,run_id,role,text) VALUES (?,?,?,?,?)',
            randomUUID(), id, turnId, 'assistant', redactMessage(result.text));
        }
        if (dshSessionId) this.run('UPDATE conversations SET dsh_session_id=? WHERE id=?', dshSessionId, id);
        this.recordEvent(id, turnId, result ? 'completed' : 'failed');
        this.run('UPDATE conversations SET updated_at=? WHERE id=?', now, id);
      }).immediate();
    } catch (error) {
      for (const path of written) unlinkSync(path);
      throw error;
    }
  }

  listFiles(userId: string, page: Page): OfficeFile[] {
    return this.all(
      'SELECT ' + fileFields + ' FROM files WHERE user_id=? ORDER BY created_at DESC,id LIMIT ? OFFSET ?',
      userId, page.limit, page.offset,
    );
  }

  addFile(userId: string, name: string, mime: string, bytes: Buffer): OfficeFile {
    const written: string[] = [];
    try {
      return this.db.transaction(() =>
        this.persistFile(userId, name, mime, bytes, written)).immediate();
    } catch (error) {
      for (const path of written) unlinkSync(path);
      throw error;
    }
  }

  private persistFile(
    userId: string, name: string, mime: string, bytes: Buffer, written: string[], conversationId?: string,
  ): OfficeFile {
    if (this.findUser(userId).status !== 'active') throw missing();
    const usage = this.get<{ bytes: number; files: number }>(
      'SELECT COALESCE(sum(size),0) AS bytes, count(*) AS files FROM files WHERE user_id=?', userId,
    )!;
    if (usage.bytes + bytes.length > MAX_USER_BYTES || usage.files >= MAX_USER_FILES) throw conflict('工作区文件配额已用完');
    const id = randomUUID();
    const path = (conversationId ? 'outputs/' : 'uploads/') + id;
    written.push(writeWorkspaceFile(this.root, userId, path, bytes));
    this.run('INSERT INTO files VALUES (?,?,?,?,?,?,?,?,?)', id, userId, conversationId ?? null,
      path, name, mime, bytes.length, hashBytes(bytes), Date.now());
    return { id, name, mime, size: bytes.length, source: conversationId ? 'output' : 'upload' };
  }

  imageAttachment(userId: string, id: string) {
    const file = this.fileRecord(userId, id);
    const mime = imageMime.safeParse(file.mime);
    if (!mime.success || file.size > maxAttachedImage) {
      throw new OfficeError(415, 'UNSUPPORTED_ATTACHMENT', '消息附件须为不超过 2 MiB 的 PNG、JPEG 或 WebP 图片');
    }
    const bytes = readWorkspaceFile(this.root, userId, file);
    return { name: file.name, data: bytes.toString('base64'), mimeType: mime.data };
  }

  prepareExports(userId: string, id: string, turnId: string): string {
    const workspace = directoryAt(this.root, workspacePath(userId));
    const project = 'projects/' + id;
    createDirectories(workspace, [project + '/export-' + turnId], []);
    return 'export-' + turnId;
  }

  outputs(userId: string, id: string, folder: string) {
    return collectExports(this.root, userId, 'projects/' + id + '/' + folder);
  }

  private fileRecord(userId: string, id: string): FileRow {
    const record = this.get<FileRow>('SELECT ' + fileFields + ', relative_path AS relativePath, sha256 FROM files WHERE id=? AND user_id=?', id, userId);
    if (!record) throw missing();
    return record;
  }

  download(userId: string, id: string): { file: OfficeFile; bytes: Buffer } {
    const record = this.fileRecord(userId, id);
    return { file: record, bytes: readWorkspaceFile(this.root, userId, record) };
  }

  audit(event: { actorId: string | null; action: string; targetId: string | null; success: boolean; ip: string; requestId: string }): void {
    this.run(
      'INSERT INTO audit_events(at,actor_id,action,target_id,success,ip,request_id) VALUES (?,?,?,?,?,?,?)',
      Date.now(), event.actorId, event.action, event.targetId, Number(event.success), event.ip, event.requestId,
    );
  }

  auditEvents(page: Page) {
    return this.all<{
      id: number; at: number; actorId: string | null; action: string; targetId: string | null; success: number; ip: string; requestId: string;
    }>('SELECT id, at, actor_id AS actorId, action, target_id AS targetId, success, ip, request_id AS requestId ' +
      'FROM audit_events ORDER BY id DESC LIMIT ? OFFSET ?', page.limit, page.offset)
      .map(row => ({ ...row, success: row.success === 1 }));
  }
}
