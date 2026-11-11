import { username as usernameSchema } from '@office/shared';
import { OfficeError } from './errors.ts';
import { hashPassword, temporaryPassword } from './security.ts';
import { lockDataRoot } from './data-lock.ts';
import { openDataRoot } from './storage.ts';
import { Store } from './store.ts';

const dataRoot = process.env.AI_OFFICE_DATA_ROOT;
if (!dataRoot) throw new Error('Set AI_OFFICE_DATA_ROOT to a dedicated absolute directory');
if (!process.stdout.isTTY) throw new Error('Run bootstrap in a local interactive terminal');
const username = usernameSchema.parse(process.argv[2] ?? 'admin');
const password = temporaryPassword();
const root = openDataRoot(dataRoot);
const release = lockDataRoot(root);
let store: Store | undefined;
try {
  store = new Store(root);
  const account = store.createUser({ username, displayName: '管理员', passwordHash: await hashPassword(password) }, 'ADMIN');
  console.log('管理员账号 ' + account.username);
  console.log('一次性临时密码 ' + password);
  console.log('首次登录时请修改密码。');
} catch (error) {
  if (!(error instanceof OfficeError)) throw error;
  console.error(error.message);
  process.exitCode = 1;
} finally {
  try { store?.close(); } finally { release(); }
}
