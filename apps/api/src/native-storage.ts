import { lstatSync, opendirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { OfficeError } from './errors.ts';
import { MAX_USER_BYTES, MAX_USER_FILES } from './storage.ts';

export type NativeStorageLimit = { bytes: number; entries: number };
export const defaultNativeStorage: NativeStorageLimit = { bytes: MAX_USER_BYTES, entries: MAX_USER_FILES };

export function nativeQuotaError() {
  return new OfficeError(413, 'NATIVE_STORAGE_LIMIT', '工作区或会话存储已达上限，请联系管理员释放空间');
}

function absent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

// Count both workspace and DSH state, including unregistered tool output, logs,
// and directories. Never traverse links or open a file to count it.
export function checkNativeStorage(roots: readonly string[], limit: NativeStorageLimit, reserve = 0, entries = 0): void {
  let bytes = reserve;
  const check = () => { if (bytes > limit.bytes || entries > limit.entries) throw nativeQuotaError(); };
  const scan = (path: string, depth: number) => {
    if (depth > 32) throw nativeQuotaError();
    if (!lstatSync(path).isDirectory() || realpathSync(path) !== path) {
      throw new OfficeError(403, 'NATIVE_UNSAFE_STORAGE', '存储目录包含不安全的路径');
    }
    const dir = opendirSync(path);
    try {
      for (let item; (item = dir.readSync());) {
        entries++; check();
        const file = join(path, item.name);
        try {
          const stat = lstatSync(file);
          if (stat.isDirectory()) scan(file, depth + 1);
          else if (stat.isFile()) { bytes += stat.size; check(); }
          else throw new OfficeError(403, 'NATIVE_UNSAFE_STORAGE', '存储目录包含链接或特殊文件');
        } catch (error) { if (!absent(error)) throw error; }
      }
    } finally { dir.closeSync(); }
  };
  check();
  for (const root of roots) scan(root, 0);
}
