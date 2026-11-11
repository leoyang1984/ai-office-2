import { cleanupOfficeWorkers } from '../../../packages/dsh-adapter/src/index.ts';
import { hashBytes } from './security.ts';
import { backupData, restoreData, verifyBackup } from './backup.ts';
import { unlockStoppedService } from './data-lock.ts';
import { migrateBackup } from './migration.ts';
import { removeWebOrphans } from '../../../packages/dsh-web/src/transport.ts';
import { openDataRoot } from './storage.ts';

const [action, first, second, ...extra] = process.argv.slice(2);
const root = process.env.AI_OFFICE_DATA_ROOT;
try {
  if (extra.length) throw new Error('维护命令参数过多');
  if (action === 'backup' && root && first && !second) {
    await backupData(root, first);
    console.log('备份已完成并生成完整性清单');
  } else if (action === 'verify' && first && !second) {
    console.log(JSON.stringify(await verifyBackup(first)));
  } else if (action === 'migrate' && first && second) {
    console.log(JSON.stringify(await migrateBackup(first, second)));
  } else if (action === 'restore' && first && second) {
    await restoreData(first, second);
    console.log('数据已恢复到新目录，请使用原账号重新登录');
  } else if (action === 'unlock' && root && !first) {
    const data = openDataRoot(root);
    const unlocked = await unlockStoppedService(data, async mode => {
      if (mode === 'native') await removeWebOrphans(hashBytes(data));
      else await cleanupOfficeWorkers(hashBytes(data));
    });
    console.log(unlocked ? '已清理停止进程的锁' : '数据目录未锁定');
  } else {
    throw new Error('用法：pnpm maintenance backup <新目录> | verify <快照目录> | restore <快照目录> <新目录> | migrate <快照目录> <新目录> | unlock');
  }
} catch (error) {
  const code = (error as NodeJS.ErrnoException).code;
  console.error(code ? '维护操作失败 [' + code + ']' : error instanceof Error ? error.message : '维护操作失败');
  process.exitCode = 1;
}
