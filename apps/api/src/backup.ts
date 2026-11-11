import { createHash } from 'node:crypto';
import {
  chmodSync, constants, copyFileSync, createReadStream, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync,
  readFileSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import Database from 'better-sqlite3';
import { directoryAt, openDataRoot } from './storage.ts';
import { lockNativeOrBackup } from './data-lock.ts';

const manifestName = '.ai-office-2-snapshot.json';
export const migrationReportName = 'native-migration.json';
const officeDatabase = 'office.sqlite';
const skillDatabase = 'native-skills.sqlite';
const baseFolders = ['db', 'users', 'knowledge'];
type Layout = { folders: string[]; databases: string[] };
type Manifest = { format: 1 | 2; files: Record<string, string> };

function inside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep);
}

function freshDirectory(path: string, protectedRoot: string): string {
  if (!isAbsolute(path)) throw new Error('使用绝对目标路径');
  const absolute = resolve(path);
  const target = join(realpathSync(dirname(absolute)), absolute.split(sep).at(-1)!);
  if (inside(protectedRoot, target)) throw new Error('目标目录必须与来源目录分开');
  mkdirSync(target, { mode: 0o700 });
  return realpathSync(target);
}

function walk(path: string, visit: (path: string, directory: boolean) => void): void {
  const stat = lstatSync(path);
  if (realpathSync(path) !== path) throw new Error('快照范围包含链接');
  if (stat.isDirectory()) {
    visit(path, true);
    for (const name of readdirSync(path).sort()) walk(join(path, name), visit);
  } else if (stat.isFile() && stat.nlink === 1) {
    visit(path, false);
  } else {
    throw new Error('快照范围包含链接或特殊文件');
  }
}

function copyFile(source: string, target: string): void {
  copyFileSync(source, target, constants.COPYFILE_EXCL);
  chmodSync(target, 0o600);
}

function copyTree(source: string, target: string): void {
  walk(source, (path, directory) => {
    const destination = target + path.slice(source.length);
    if (directory) mkdirSync(destination, { mode: 0o700 });
    else copyFile(path, destination);
  });
}

async function fingerprints(root: string, folders: string[]): Promise<Record<string, string>> {
  const entries: { path: string; directory: boolean }[] = [];
  for (const folder of folders) walk(join(root, folder), (path, directory) => entries.push({ path, directory }));
  const result: [string, string][] = [];
  for (const entry of entries) {
    const relative = entry.path.slice(root.length + 1);
    if (entry.directory) {
      result.push([relative + '/', 'directory']);
      continue;
    }
    const hash = createHash('sha256');
    for await (const block of createReadStream(entry.path)) hash.update(block);
    result.push([relative, hash.digest('hex')]);
  }
  return Object.fromEntries(result);
}

function sameFiles(expected: unknown, actual: Record<string, string>): boolean {
  if (typeof expected !== 'object' || !expected || Array.isArray(expected)) return false;
  const entries = Object.entries(expected);
  return entries.length === Object.keys(actual).length && entries.every(([path, digest]) =>
    Object.hasOwn(actual, path) && actual[path] === digest);
}

function regularFile(path: string, max = Infinity): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > max || realpathSync(path) !== path) throw new Error('快照文件无效');
  return path;
}

function layout(root: string, format?: 1 | 2): Layout {
  const db = directoryAt(root, 'db');
  const hasSkills = Boolean(lstatSync(join(root, 'skills'), { throwIfNoEntry: false }));
  const hasSkillDb = Boolean(lstatSync(join(db, skillDatabase), { throwIfNoEntry: false }));
  if (hasSkills !== hasSkillDb || (format === 1 && hasSkills)) throw new Error('Skill 数据库与文件目录必须成对存在');
  const folders = hasSkills ? [...baseFolders, 'skills'] : [...baseFolders];
  const databases = hasSkillDb ? [officeDatabase, skillDatabase] : [officeDatabase];
  for (const filename of databases) regularFile(join(db, filename));
  if (format !== undefined) {
    const allowed = new Set([...databases, ...(format === 2 ? [migrationReportName] : [])]);
    if (readdirSync(db).some(name => !allowed.has(name)) ||
        readdirSync(root).some(name => name !== manifestName && !folders.includes(name))) {
      throw new Error('快照校验失败：含未登记的内容');
    }
  }
  return { folders, databases };
}

function checkDatabase(database: Database.Database): void {
  if (database.pragma('integrity_check', { simple: true }) !== 'ok' ||
      (database.pragma('foreign_key_check') as unknown[]).length !== 0) {
    throw new Error('SQLite 完整性检查失败');
  }
}

export async function backupData(dataRoot: string, destination: string): Promise<void> {
  if (!lstatSync(dataRoot).isDirectory()) throw new Error('数据目录不存在');
  const root = openDataRoot(dataRoot);
  const release = lockNativeOrBackup(root, false);
  try {
    const { folders, databases } = layout(root);
    const target = freshDirectory(destination, root);
    mkdirSync(join(target, 'db'), { mode: 0o700 });
    for (const filename of databases) {
      const output = join(target, 'db', filename);
      const database = new Database(join(root, 'db', filename), { readonly: true, fileMustExist: true, timeout: 5000 });
      try {
        checkDatabase(database);
        await database.backup(output);
        chmodSync(output, 0o600);
      } finally { database.close(); }
    }
    const report = join(root, 'db', migrationReportName);
    if (lstatSync(report, { throwIfNoEntry: false })) {
      copyFile(regularFile(report, 16 * 1024 * 1024), join(target, 'db', migrationReportName));
    }
    for (const folder of folders) if (folder !== 'db') copyTree(join(root, folder), join(target, folder));
    const manifest = { format: 2, files: await fingerprints(target, folders) };
    writeFileSync(join(target, manifestName), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600, flush: true });
  } finally {
    release();
  }
}

async function loadSnapshot(snapshot: string) {
  if (!isAbsolute(snapshot) || !lstatSync(snapshot).isDirectory()) throw new Error('使用独立快照目录的绝对路径');
  const root = realpathSync(snapshot);
  let manifest: Manifest;
  try {
    manifest = JSON.parse(readFileSync(regularFile(join(root, manifestName), 16 * 1024 * 1024), 'utf8')) as Manifest;
  } catch { throw new Error('快照清单无效'); }
  if (manifest?.format !== 1 && manifest?.format !== 2) throw new Error('快照校验失败：格式无效');
  const { folders, databases } = layout(root, manifest.format);
  if (!sameFiles(manifest.files, await fingerprints(root, folders))) throw new Error('快照校验失败');
  return { root, manifest, folders, databases };
}

export async function verifyBackup(snapshot: string): Promise<{ format: number; entries: number; skills: boolean }> {
  const { root, manifest, databases } = await loadSnapshot(snapshot);
  // Open disposable DB copies so SQLite can never add sidecars to the snapshot.
  const temporary = mkdtempSync(join(tmpdir(), 'office-snapshot-check-'));
  try {
    for (const filename of databases) {
      const path = join(temporary, filename);
      copyFile(join(root, 'db', filename), path);
      const database = new Database(path, { readonly: true, fileMustExist: true });
      try { checkDatabase(database); }
      finally { database.close(); }
    }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
  return { format: manifest.format, entries: Object.keys(manifest.files).length, skills: databases.includes(skillDatabase) };
}

export async function restoreData(snapshot: string, destination: string): Promise<void> {
  const { root: source, manifest, folders, databases } = await loadSnapshot(snapshot);
  const target = freshDirectory(destination, source);
  for (const folder of folders) copyTree(join(source, folder), join(target, folder));
  if (!sameFiles(manifest.files, await fingerprints(target, folders))) throw new Error('恢复副本校验失败');
  for (const filename of databases) {
    const database = new Database(join(target, 'db', filename), { fileMustExist: true, timeout: 5000 });
    try {
      checkDatabase(database);
      if (filename === officeDatabase) database.transaction(() => {
        const entries = database.prepare('SELECT id,directory FROM knowledge_bases').all() as { id: string; directory: string }[];
        const update = database.prepare('UPDATE knowledge_bases SET canonical_host_path=? WHERE id=?');
        for (const entry of entries) update.run(directoryAt(target, 'knowledge/' + entry.directory), entry.id);
        database.prepare('DELETE FROM auth_sessions').run();
      }).immediate();
      database.pragma('wal_checkpoint(TRUNCATE)');
    } finally { database.close(); }
  }
  mkdirSync(join(target, 'backup'), { mode: 0o700 });
  writeFileSync(join(target, '.ai-office-2-data'), 'ai-office-2\n', { flag: 'wx', mode: 0o600, flush: true });
}
