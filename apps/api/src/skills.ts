import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { skillResourceName } from '@office/shared';
import type { SkillInfo, SkillInput } from '@office/shared';
import { badRequest, missing, OfficeError } from './errors.ts';
import { hashBytes } from './security.ts';
import { directoryAt, workspacePath } from './storage.ts';
import { checkNativeStorage } from './native-storage.ts';
import type { NativeStorageLimit } from './native-storage.ts';

type Installed = SkillInfo & { digest: string };
type TextFile = { name: string; text: string };
const publicLimit = 128;
const personalLimit = 16;
const grantLimit = 32;
const bundleLimit = 128 * 1024;
const fields = 'id,name,version,description,digest';

function collision(message: string) {
  return new OfficeError(409, 'SKILL_CONFLICT', message);
}

function header({ name, description }: Pick<SkillInput, 'name' | 'description'>) {
  // JSON string scalars also quote YAML punctuation and escapes.
  return '---\nname: ' + JSON.stringify(name) + '\ndescription: ' + JSON.stringify(description) + '\n---\n';
}

function digest(files: TextFile[]) {
  return hashBytes(JSON.stringify([...files].sort((a, b) => a.name.localeCompare(b.name, 'en'))));
}

function bundle(input: SkillInput): TextFile[] {
  const files = [{ name: 'SKILL.md', text: header(input) + input.instructions + '\n' }, ...input.resources];
  if (new Set(files.map(file => file.name.toLowerCase())).size !== files.length ||
      files.some(file => !file.text.isWellFormed() || /\x00/.test(file.text))) throw badRequest('Skill 包包含重复文件名或无效文本');
  if (files.reduce((total, file) => total + Buffer.byteLength(file.text), 0) > bundleLimit) {
    throw new OfficeError(413, 'SKILL_SIZE', 'Skill 文本包最多 128 KiB');
  }
  return files;
}

export class SkillCatalog {
  private readonly db: Database.Database;
  private readonly root: string;
  private readonly publicPath: string;
  private readonly storage: NativeStorageLimit;
  constructor(root: string, storage: NativeStorageLimit) {
    this.root = root;
    this.storage = storage;
    this.publicPath = this.ensureDirectory('skills');
    const path = join(directoryAt(root, 'db'), 'native-skills.sqlite');
    for (const filename of [path, path + '-journal', path + '-wal', path + '-shm']) {
      const stat = lstatSync(filename, { throwIfNoEntry: false });
      if (stat && (!stat.isFile() || stat.nlink !== 1)) throw new Error('Invalid skill database');
    }
    const previous = process.umask(0o077);
    try { this.db = new Database(path); }
    finally { process.umask(previous); }
    try {
      this.db.pragma('foreign_keys = ON');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS public_skills (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, version TEXT NOT NULL,
          description TEXT NOT NULL, digest TEXT NOT NULL, UNIQUE(name,version)
        );
        CREATE TABLE IF NOT EXISTS personal_skills (
          owner TEXT NOT NULL, id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, version TEXT NOT NULL,
          description TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(owner,name)
        );
        CREATE TABLE IF NOT EXISTS skill_grants (
          owner TEXT NOT NULL, name TEXT NOT NULL, skill_id TEXT NOT NULL REFERENCES public_skills(id),
          PRIMARY KEY(owner,name)
        );
      `);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close() { this.db.close(); }

  private ensureDirectory(relative: string) {
    const path = join(this.root, relative);
    try { mkdirSync(path, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    return directoryAt(this.root, relative);
  }

  private personalDirectory(owner: string) { return 'users/' + owner + '/skills'; }

  private publicFor(id: string) {
    const skill = this.db.prepare('SELECT ' + fields + ' FROM public_skills WHERE id=?').get(id) as Installed | undefined;
    if (!skill) throw missing();
    return skill;
  }

  private privateFor(owner: string, name: string) {
    return this.db.prepare('SELECT ' + fields + ' FROM personal_skills WHERE owner=? AND name=?').get(owner, name) as Installed | undefined;
  }

  listPublic(): Installed[] {
    return this.db.prepare('SELECT ' + fields + ' FROM public_skills ORDER BY name, version').all() as Installed[];
  }

  private grants(owner: string): Installed[] {
    return this.db.prepare(`SELECT ${fields.split(',').map(field => 'p.' + field).join(',')}
      FROM skill_grants g JOIN public_skills p ON g.skill_id=p.id WHERE g.owner=? ORDER BY p.name`).all(owner) as Installed[];
  }

  private personal(owner: string): Installed[] {
    return this.db.prepare('SELECT ' + fields + ' FROM personal_skills WHERE owner=? ORDER BY name').all(owner) as Installed[];
  }

  library(owner: string) {
    return { public: this.grants(owner), personal: this.personal(owner) };
  }

  personalDraft(owner: string, name: string): SkillInput {
    const skill = this.privateFor(owner, name);
    if (!skill) throw missing();
    const files = this.readBundle(this.personalDirectory(owner), skill);
    const instructions = files.find(file => file.name === 'SKILL.md')!.text.slice(header(skill).length).trimEnd();
    return { name, version: skill.version, description: skill.description, instructions, resources: files.filter(file => file.name !== 'SKILL.md') };
  }

  private writeBundle(parent: string, id: string, files: TextFile[], commit: () => void) {
    const path = join(parent, id);
    mkdirSync(path, { mode: 0o700 });
    try {
      for (const file of files) writeFileSync(join(path, file.name), file.text, { mode: 0o600, flag: 'wx', flush: true });
      commit();
    } catch (error) {
      rmSync(path, { recursive: true, force: true });
      throw error;
    }
  }

  installPublic(input: SkillInput): SkillInfo {
    const files = bundle(input);
    const hash = digest(files);
    const existing = this.db.prepare('SELECT ' + fields + ' FROM public_skills WHERE name=? AND version=?')
      .get(input.name, input.version) as Installed | undefined;
    if (existing) {
      if (existing.digest !== hash) throw collision('该公共 Skill 版本已发布，请使用新版本号');
      this.readBundle('skills', existing);
      return existing;
    }
    if (this.listPublic().length >= publicLimit) throw collision('公共 Skill 版本数已达上限');
    const { name, version, description } = input;
    const id = randomUUID();
    this.writeBundle(this.publicPath, id, files, () => {
      this.db.prepare('INSERT INTO public_skills VALUES (?,?,?,?,?)').run(id, name, version, description, hash);
    });
    return { id, name, version, description };
  }

  checkPersonal(owner: string, input: SkillInput) {
    bundle(input);
    if (this.grants(owner).some(skill => skill.name === input.name)) throw collision('此名称已用于获授权的公共 Skill');
    if (!this.privateFor(owner, input.name) && this.personal(owner).length >= personalLimit) {
      throw collision('个人 Skill 数量已达上限');
    }
  }

  savePersonal(owner: string, input: SkillInput): SkillInfo {
    const { name, version, description } = input;
    const old = this.privateFor(owner, name);
    const files = bundle(input);
    const hash = digest(files);
    const parent = this.ensureDirectory(this.personalDirectory(owner));
    const bytes = files.reduce((total, file) => total + Buffer.byteLength(file.text), 0);
    checkNativeStorage([
      directoryAt(this.root, workspacePath(owner)), directoryAt(this.root, 'users/' + owner + '/dsh-home'), parent,
    ], this.storage, bytes, files.length + 1);
    const id = randomUUID();
    this.writeBundle(parent, id, files, () => {
      this.db.prepare(`INSERT INTO personal_skills (owner,id,name,version,description,digest) VALUES (?,?,?,?,?,?)
        ON CONFLICT(owner,name) DO UPDATE SET id=excluded.id,version=excluded.version,
          description=excluded.description,digest=excluded.digest`).run(owner, id, name, version, description, hash);
    });
    if (old) this.discardPersonal(parent, old.id);
    return { id, name, version, description };
  }

  removePersonal(owner: string, name: string): void {
    const skill = this.privateFor(owner, name);
    if (!skill) throw missing();
    this.db.prepare('DELETE FROM personal_skills WHERE owner=? AND name=?').run(owner, name);
    this.discardPersonal(directoryAt(this.root, this.personalDirectory(owner)), skill.id);
  }

  private discardPersonal(parent: string, id: string) {
    // The database has already removed the reference. A filesystem cleanup
    // failure leaves an inaccessible revision and must not undo the update.
    try { rmSync(join(parent, id), { recursive: true, force: true }); } catch { /* Retained data counts toward quota. */ }
  }

  checkGrant(owner: string, id: string, enabled: boolean): void {
    const skill = this.publicFor(id);
    if (!enabled) return;
    if (this.privateFor(owner, skill.name)) throw collision('此用户已保存同名个人 Skill');
    const grants = this.grants(owner);
    if (!grants.some(grant => grant.name === skill.name) && grants.length >= grantLimit) {
      throw collision('此用户的公共 Skill 授权数已达上限');
    }
    this.readBundle('skills', skill);
  }

  setGrant(owner: string, id: string, enabled: boolean): void {
    const skill = this.publicFor(id);
    if (enabled) {
      this.db.prepare(`INSERT INTO skill_grants VALUES (?,?,?)
        ON CONFLICT(owner,name) DO UPDATE SET skill_id=excluded.skill_id`).run(owner, skill.name, skill.id);
    } else {
      this.db.prepare('DELETE FROM skill_grants WHERE owner=? AND skill_id=?').run(owner, id);
    }
  }

  private readBundle(parent: string, skill: Installed): TextFile[] {
    const path = directoryAt(this.root, parent + '/' + skill.id);
    const names = readdirSync(path);
    const invalid = () => collision('Skill 安装文件已变化');
    if (names.length > 9 || !names.includes('SKILL.md')) throw invalid();
    let size = 0;
    const files = names.map(name => {
      if (name !== 'SKILL.md' && !skillResourceName.safeParse(name).success) throw invalid();
      const filename = join(path, name);
      const stat = lstatSync(filename);
      size += stat.size;
      if (!stat.isFile() || stat.nlink !== 1 || size > bundleLimit) throw invalid();
      try {
        return { name, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(filename)) };
      } catch { throw invalid(); }
    });
    if (digest(files) !== skill.digest) throw invalid();
    return files;
  }

  mounts(owner: string) {
    const personalDirectory = this.personalDirectory(owner);
    const personal = this.personal(owner);
    const grants = this.grants(owner);
    const names = [...personal, ...grants].map(skill => skill.name);
    if (new Set(names).size !== names.length) throw collision('Skill 名称冲突');
    const mount = (parent: string, skill: Installed) => {
      this.readBundle(parent, skill);
      return { name: skill.name, path: directoryAt(this.root, parent + '/' + skill.id) };
    };
    return {
      mounts: [...grants.map(skill => mount('skills', skill)), ...personal.map(skill => mount(personalDirectory, skill))],
      personalRoot: lstatSync(join(this.root, personalDirectory), { throwIfNoEntry: false })
        ? directoryAt(this.root, personalDirectory) : undefined,
    };
  }
}
