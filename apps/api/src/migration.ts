import { randomUUID } from 'node:crypto';
import { realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { verifyWorkerImage } from '../../../packages/dsh-adapter/src/index.ts';
import { migrationReportName, restoreData } from './backup.ts';
import { lockNativeOrBackup } from './data-lock.ts';
import { OfficeError } from './errors.ts';
import { readLocalWebImage } from './local-image.ts';
import { NativePool } from './native-pool.ts';
import { directoryAt, workspacePath } from './storage.ts';
import { Store } from './store.ts';

const r4NativeImage = 'sha256:56a0a59b5255d6841f64ff8fd6880f1f17dcce35cf5bc8607cb697bd360d5ad2';
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
type Legacy = { ownerId: string; id: string; relative: string; sessionId: string | null; accountStatus: string };
type ArchiveReason = 'no-native-id' | 'account-inactive' | 'workspace-unavailable' | 'history-unavailable' |
  'workspace-mismatch' | 'workspace-rejected' | 'activation-rejected' | 'native-format-migration-required';
type Item = { accountId: string; conversationId: string; sessionId: string | null } & (
  { status: 'adopted'; workspace: string; workspaceId: string } | { status: 'archive'; reason: ArchiveReason }
);
type Remote<T> = { ok: true; value: T } | { ok: false; error: unknown };
type Entry = Awaited<ReturnType<NativePool['get']>>;
type Summary = { sessionId: string; cwd?: string; formatStatus?: string };

function legacyConversations(root: string): Legacy[] {
  const database = new Database(join(root, 'db', 'office.sqlite'), { readonly: true, fileMustExist: true });
  try {
    return database.prepare(`SELECT c.user_id AS ownerId, c.id, c.workspace_relative_path AS relative,
      c.dsh_session_id AS sessionId, u.status AS accountStatus
      FROM conversations c JOIN users u ON u.id=c.user_id ORDER BY c.user_id,c.id`).all() as Legacy[];
  } finally { database.close(); }
}

function identity(row: Legacy) {
  return { accountId: row.ownerId, conversationId: row.id, sessionId: row.sessionId };
}

function archived(row: Legacy, reason: ArchiveReason): Item {
  return { ...identity(row), status: 'archive', reason };
}

function existingWorkspace(root: string, row: Legacy): string | undefined {
  if (!uuid.test(row.ownerId) || !uuid.test(row.id) || row.relative !== 'projects/' + row.id) return undefined;
  try { directoryAt(root, workspacePath(row.ownerId) + '/' + row.relative); }
  catch (error) {
    if (error instanceof OfficeError && error.statusCode === 404) return undefined;
    throw error;
  }
  return '/tenant/workspace/' + row.relative;
}

async function rpc<T>(pool: NativePool, entry: Entry, method: string, args: object): Promise<Remote<T>> {
  const body = Buffer.from(JSON.stringify({ type: 'client-request', method, rpcId: randomUUID(), payload: { args } }));
  const result = await pool.upstream(entry, '/api/' + method, 'POST', body, 'application/json');
  if (result.status !== 200) throw new Error('原版迁移 RPC 请求失败');
  let envelope: Remote<T> | undefined;
  try { envelope = JSON.parse(result.bytes.toString('utf8')).result; }
  catch { throw new Error('原版迁移 RPC 响应无效'); }
  if (envelope?.ok !== true && envelope?.ok !== false) throw new Error('原版迁移 RPC 响应无效');
  return envelope;
}

async function adopt(pool: NativePool, entry: Entry, row: Legacy, workspace: string, summary?: Summary): Promise<Item> {
  const sessionId = row.sessionId!;
  if (!summary) return archived(row, 'history-unavailable');
  if (summary.cwd !== workspace) return archived(row, 'workspace-mismatch');
  if (summary.formatStatus === 'migration-required') return archived(row, 'native-format-migration-required');
  const address = { kind: 'session', sessionId };
  const history = await rpc<{ records: unknown[] }>(pool, entry, 'session/events', { request: { address, maxMessages: 1 } });
  if (!history.ok || !Array.isArray(history.value.records)) return archived(row, 'history-unavailable');

  const created = await rpc<{ workspace: { workspaceId: string; path: string } }>(pool, entry, 'workspace/create', {
    request: { path: workspace },
  });
  if (!created.ok || created.value.workspace?.path !== workspace ||
      typeof created.value.workspace.workspaceId !== 'string') return archived(row, 'workspace-rejected');
  const activated = await rpc(pool, entry, 'session/selectModel', { request: {
    sessionId, provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'off',
  } });
  if (!activated.ok) return archived(row, 'activation-rejected');
  return { ...identity(row), status: 'adopted', workspace, workspaceId: created.value.workspace.workspaceId };
}

export async function migrateBackup(snapshot: string, destination: string) {
  const nativeImage = readLocalWebImage() ?? r4NativeImage;
  await verifyWorkerImage(nativeImage);
  await restoreData(snapshot, destination);
  const root = realpathSync(destination);
  const release = lockNativeOrBackup(root, true);
  let store: Store | undefined;
  let pool: NativePool | undefined;
  let cleanupFailed = false;
  const items: Item[] = [];
  try {
    store = new Store(root);
    const rows = legacyConversations(root);
    pool = new NativePool(store, new URL('http://127.0.0.1'), {
      image: nativeImage, skills: true, idleMs: 300_000,
      model: async () => { throw new Error('Migration cannot submit a model request'); },
    }, () => {});
    await pool.initialize();
    let owner: string | undefined;
    let entry: Entry | undefined;
    let sessions = new Map<string, Summary>();
    for (const row of rows) {
      if (owner !== row.ownerId) {
        if (owner) await pool.stopUser(owner);
        owner = row.ownerId;
        entry = undefined;
        sessions.clear();
      }
      if (!row.sessionId) { items.push(archived(row, 'no-native-id')); continue; }
      if (row.accountStatus !== 'active') { items.push(archived(row, 'account-inactive')); continue; }
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(row.sessionId)) { items.push(archived(row, 'history-unavailable')); continue; }
      const workspace = existingWorkspace(root, row);
      if (!workspace) { items.push(archived(row, 'workspace-unavailable')); continue; }
      if (!entry) {
        entry = await pool.get(row.ownerId, true);
        const listed = await rpc<{ items: Summary[] }>(pool, entry, 'session/list', { _request: {} });
        if (!listed.ok || !Array.isArray(listed.value.items)) throw new Error('无法读取原版会话目录');
        sessions = new Map(listed.value.items.map(item => [item.sessionId, item]));
      }
      pool.touch(entry);
      items.push(await adopt(pool, entry, row, workspace, sessions.get(row.sessionId)));
    }
    try { await pool.close(); }
    catch (error) { cleanupFailed = true; throw error; }
    pool = undefined;
    const report = { format: 1, image: nativeImage, records: items };
    const reportPath = join(root, 'db', migrationReportName);
    const temporary = reportPath + '.' + randomUUID();
    writeFileSync(temporary, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600, flush: true });
    renameSync(temporary, reportPath);
    return { adopted: items.filter(item => item.status === 'adopted').length, archive: items.filter(item => item.status === 'archive').length };
  } finally {
    try {
      if (!cleanupFailed) {
        try { await pool?.close(); }
        catch (error) { cleanupFailed = true; throw error; }
      }
    } finally {
      store?.close();
      // A stale native lock requires scoped container cleanup before reuse.
      if (!cleanupFailed) release();
    }
  }
}
