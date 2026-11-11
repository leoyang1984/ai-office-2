import { lstatSync, readFileSync } from 'node:fs';

const receipt = new URL('../../../.runtime/native-web-image', import.meta.url);

export function readLocalWebImage(): string | undefined {
  const stat = lstatSync(receipt, { throwIfNoEntry: false });
  if (!stat) return undefined;
  if (!stat.isFile() || stat.nlink !== 1 || stat.size !== 72) throw new Error('本地镜像记录无效，请重跑 pnpm setup:local');
  const id = readFileSync(receipt, 'utf8');
  if (!/^sha256:[a-f0-9]{64}\n$/.test(id)) throw new Error('本地镜像记录无效，请重跑 pnpm setup:local');
  return id.trim();
}
