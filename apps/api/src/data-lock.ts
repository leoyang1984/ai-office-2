import { closeSync, fstatSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const name = '.office-service.lock';

export function lockDataRoot(root: string, workerMode: boolean | 'native' = false): () => void {
  const path = join(root, name);
  let fd;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('数据目录正在使用。如果服务已意外退出，请在本机执行 pnpm maintenance unlock。');
    }
    throw error;
  }
  try {
    writeFileSync(fd, String(process.pid) + (workerMode === 'native' ? '\nnative\n' : workerMode ? '\ndsh\n' : '\n'));
  } catch (error) {
    unlinkSync(path);
    throw error;
  } finally {
    closeSync(fd);
  }
  const lock = lstatSync(path);
  return () => {
    const current = lstatSync(path, { throwIfNoEntry: false });
    if (current?.dev === lock.dev && current.ino === lock.ino) unlinkSync(path);
  };
}

// Share the native SQLite lease with existing native builds, and the PID
// lock with the SDK entry point. Backups need both when the SQLite lease exists.
export function lockNativeOrBackup(root: string, native: boolean): () => void {
  const path = join(root, 'db', 'native-gateway-lock.sqlite');
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat && (!stat.isFile() || stat.nlink !== 1)) throw new Error('Invalid native gateway lock');
  let database: Database.Database | undefined;
  if (native || stat) {
    const previous = process.umask(0o077);
    try { database = new Database(path, { timeout: 0 }); }
    finally { process.umask(previous); }
    try { database.exec('BEGIN IMMEDIATE'); }
    catch (error) {
      database.close();
      if ((error as { code?: string }).code === 'SQLITE_BUSY') {
        throw new Error('A native gateway already owns this data root. 数据目录正在使用。');
      }
      throw error;
    }
  }
  try {
    const release = lockDataRoot(root, native ? 'native' : false);
    return () => {
      try { database?.close(); }
      finally { release(); }
    };
  } catch (error) {
    database?.close();
    throw error;
  }
}

export async function unlockStoppedService(root: string, cleanupWorkers?: (mode: 'dsh' | 'native') => Promise<void>): Promise<boolean> {
  const path = join(root, name);
  const lock = lstatSync(path, { throwIfNoEntry: false });
  if (!lock) return false;
  if (!lock.isFile() || lock.nlink !== 1 || lock.size < 2 || lock.size > 32) throw new Error('锁文件格式无效');
  const fd = openSync(path, 'r');
  let pid: number;
  let workerMode: 'dsh' | 'native' | undefined;
  try {
    const opened = fstatSync(fd);
    if (opened.dev !== lock.dev || opened.ino !== lock.ino) throw new Error('锁已变化，请重新检查');
    const [owner, mode] = readFileSync(fd, 'utf8').trim().split('\n');
    pid = Number(owner);
    if (mode === 'dsh' || mode === 'native') workerMode = mode;
  } finally {
    closeSync(fd);
  }
  if (!Number.isSafeInteger(pid) || pid < 2) throw new Error('锁文件缺少有效进程号');
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    if (workerMode) {
      if (!cleanupWorkers) throw new Error('请先清理数据目录的遗留 Worker');
      await cleanupWorkers(workerMode);
    }
    const current = lstatSync(path, { throwIfNoEntry: false });
    if (current?.dev !== lock.dev || current.ino !== lock.ino) throw new Error('锁已变化，请重新检查');
    unlinkSync(path);
    return true;
  }
  throw new Error('数据目录锁对应的进程仍在运行');
}
