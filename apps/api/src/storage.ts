import {
  closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, opendirSync,
  readFileSync, readSync, readdirSync, realpathSync, rmdirSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { extname, isAbsolute, join, resolve, sep } from 'node:path';
import { badRequest, conflict, missing, OfficeError } from './errors.ts';
import { hashBytes } from './security.ts';

export const MAX_UPLOAD = 20 * 1024 * 1024;
export const MAX_USER_BYTES = 100 * 1024 * 1024;
export const MAX_USER_FILES = 500;
const marker = '.ai-office-2-data';

export function openDataRoot(path: string): string {
  if (!isAbsolute(path)) throw new Error('AI_OFFICE_DATA_ROOT must be an absolute path');
  const candidate = resolve(path);
  if (!existsSync(candidate)) mkdirSync(candidate, { mode: 0o700 });
  const stat = lstatSync(candidate);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) {
    throw new Error('AI_OFFICE_DATA_ROOT must be a private directory owned by the service user');
  }
  const root = realpathSync(candidate);
  const entries = readdirSync(root);
  if (entries.length === 0) writeFileSync(join(root, marker), 'ai-office-2\n', { flag: 'wx', mode: 0o600 });
  const label = lstatSync(join(root, marker), { throwIfNoEntry: false });
  if (!label?.isFile() || label.nlink !== 1 || label.size !== 12 ||
      readFileSync(join(root, marker), 'utf8') !== 'ai-office-2\n') {
    throw new Error('Choose a new AI Office data directory');
  }
  for (const name of ['db', 'users', 'knowledge', 'backup']) {
    const dir = join(root, name);
    if (!existsSync(dir)) mkdirSync(dir, { mode: 0o700 });
    directoryAt(root, name);
  }
  return root;
}

function parts(relativePath: string): string[] {
  const segments = relativePath.split('/');
  if (isAbsolute(relativePath) || segments.some(s => !s || s === '.' || s === '..' || /[\\\u0000-\u001f]/.test(s))) {
    throw badRequest('路径无效');
  }
  return segments;
}

export function directoryAt(root: string, relativePath: string): string {
  let current = root;
  for (const segment of parts(relativePath)) {
    current = join(current, segment);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (!stat?.isDirectory()) throw missing();
  }
  if (realpathSync(current) !== current) throw missing();
  return current;
}

export function createDirectories(root: string, relativePaths: string[], created: string[]): void {
  for (const relativePath of relativePaths) {
    const segments = parts(relativePath);
    if (segments.length > 1) directoryAt(root, segments.slice(0, -1).join('/'));
    const path = join(root, ...segments);
    mkdirSync(path, { mode: 0o700 });
    created.push(path);
  }
}

export function removeEmptyDirectories(created: string[]): void {
  for (const path of [...created].reverse()) {
    try { rmdirSync(path); } catch { /* Preserve data that arrived during provisioning. */ }
  }
}

export function workspacePath(userId: string): string {
  return 'users/' + userId + '/workspace';
}

export function validateUpload(name: string, mime: string, bytes: Buffer): string {
  if (name.length < 1 || name.length > 180 || name.startsWith('.') || /[\/\\:\u0000-\u001f\u007f]/.test(name)) {
    throw badRequest('文件名无效');
  }
  if (bytes.length === 0 || bytes.length > MAX_UPLOAD) throw new OfficeError(413, 'FILE_SIZE', '文件大小超出限制');
  const extension = extname(name).slice(1).toLowerCase();
  switch (extension) {
    case 'png':
      if (mime === 'image/png' && bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return mime;
      break;
    case 'jpg':
    case 'jpeg':
      if (mime === 'image/jpeg' && bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex')) &&
          bytes.subarray(-2).equals(Buffer.from('ffd9', 'hex'))) return mime;
      break;
    case 'webp':
      if (mime === 'image/webp' && bytes.length >= 16 && bytes.toString('ascii', 0, 4) === 'RIFF' &&
          bytes.toString('ascii', 8, 12) === 'WEBP') return mime;
      break;
    case 'pdf':
      if (mime === 'application/pdf' && bytes.toString('ascii', 0, 5) === '%PDF-') return mime;
      break;
    case 'txt':
    case 'md':
      if (!['text/plain', 'text/markdown', 'application/octet-stream'].includes(mime)) break;
      try {
        if (!new TextDecoder('utf-8', { fatal: true }).decode(bytes).includes('\0')) {
          return extension === 'md' ? 'text/markdown' : 'text/plain';
        }
      } catch { /* Reject non-UTF-8 text. */ }
      break;
  }
  throw new OfficeError(415, 'FILE_TYPE', '文件类型或内容不受支持');
}

export function writeWorkspaceFile(root: string, userId: string, relativePath: string, bytes: Buffer): string {
  const segments = parts(relativePath);
  const directory = directoryAt(root, [workspacePath(userId), ...segments.slice(0, -1)].join('/'));
  const path = join(directory, segments.at(-1)!);
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, bytes);
    return path;
  } catch (error) {
    unlinkSync(path);
    throw error;
  } finally {
    closeSync(fd);
  }
}

function readWorkspaceBytes(root: string, userId: string, relativePath: string, limit: number, expectedSize?: number): Buffer {
  const segments = parts(relativePath);
  const workspace = directoryAt(root, workspacePath(userId));
  const directory = segments.length > 1 ? directoryAt(workspace, segments.slice(0, -1).join('/')) : workspace;
  const path = join(directory, segments.at(-1)!);
  let fd: number | undefined;
  try {
    const before = lstatSync(path);
    if (!before.isFile() || before.nlink !== 1 || before.size > limit || (expectedSize !== undefined && before.size !== expectedSize)) throw missing();
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino ||
        opened.size !== before.size || realpathSync(path) !== path || !path.startsWith(workspace + sep)) throw missing();
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, length);
      if (count === 0) break;
      length += count;
    }
    const bytes = buffer.subarray(0, length);
    if (length !== before.size) throw conflict('文件已更改');
    return bytes;
  } catch (error) {
    if (error instanceof OfficeError) throw error;
    throw missing();
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function readWorkspaceFile(
  root: string, userId: string, record: { relativePath: string; size: number; sha256: string },
): Buffer {
  const bytes = readWorkspaceBytes(root, userId, record.relativePath, MAX_UPLOAD, record.size);
  if (hashBytes(bytes) !== record.sha256) throw conflict('文件已更改');
  return bytes;
}

const exportTypes: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  txt: 'text/plain', md: 'text/markdown', pdf: 'application/pdf',
};

export function collectExports(root: string, userId: string, relativePath: string) {
  const result: { name: string; mime: string; bytes: Buffer }[] = [];
  let directory;
  try {
    directory = opendirSync(directoryAt(root, workspacePath(userId) + '/' + relativePath));
  } catch (error) {
    if (error instanceof OfficeError && error.statusCode === 404) return result;
    throw error;
  }
  let budget = MAX_UPLOAD;
  try {
    for (let scanned = 0; scanned < 64 && result.length < 8 && budget > 0; scanned++) {
      const item = directory.readSync();
      if (!item) break;
      const type = exportTypes[extname(item.name).slice(1).toLowerCase()];
      if (!item.isFile() || !type) continue;
      try {
        const bytes = readWorkspaceBytes(root, userId, relativePath + '/' + item.name, budget);
        const mime = validateUpload(item.name, type, bytes);
        result.push({ name: item.name, mime, bytes });
        budget -= bytes.length;
      } catch (error) {
        if (!(error instanceof OfficeError) || error.statusCode >= 500) throw error;
      }
    }
  } finally {
    directory.closeSync();
  }
  return result;
}
