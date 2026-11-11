// A narrow provider around the pinned native filesystem. Scope checks use
// canonical targets; the original tool names, schemas, and UI stay in place.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const modules = '/opt/office-worker/node_modules/.pnpm';
const builds = readdirSync(modules).filter(name => name.startsWith('@deepseek-ai+dsh-fs-sandbox@0.2.2-rc.1_'));
if (builds.length !== 1) throw new Error('Expected one pinned filesystem backend');
const { SandboxedFileSystem } = await import(pathToFileURL(join(modules, builds[0],
  'node_modules/@deepseek-ai/dsh-fs-sandbox/lib/index.js')).href);

const workspace = '/tenant/workspace';
function requirePath(path, writable = false) {
  if (path === workspace || path.startsWith(workspace + '/')) return;
  if (!writable && /^\/knowledge\/[a-f0-9-]{36}(?:\/|$)/.test(path)) return;
  if (!writable && (path === '/office-skills' || path.startsWith('/office-skills/'))) return;
  throw new Error('OFFICE_FILE_SCOPE_DENIED');
}

export default class OfficeFileSystem extends SandboxedFileSystem {
  async resolve(path, options) {
    const target = await super.resolve(path, options);
    requirePath(super.processPath(target));
    return target;
  }
  async lstat(path, options, signal) {
    await this.resolve(path, options);
    return super.lstat(path, options, signal);
  }
  async writable(target) {
    const checked = await this.resolve(super.processPath(target));
    requirePath(super.processPath(checked), true);
    return checked;
  }
  async writeText(target, content, expected, signal) {
    return super.writeText(await this.writable(target), content, expected, signal);
  }
  async editText(target, edit, expected, signal) {
    return super.editText(await this.writable(target), edit, expected, signal);
  }
  async deleteFile(target, expected, signal) {
    return super.deleteFile(await this.writable(target), expected, signal);
  }
  async moveFile(source, destination, options, signal) {
    return super.moveFile(await this.writable(source), await this.writable(destination), options, signal);
  }
  async patchText(target, hunks, expected, signal) {
    return super.patchText(await this.writable(target), hunks, expected, signal);
  }
}
