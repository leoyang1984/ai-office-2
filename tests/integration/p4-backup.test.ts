import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { backupData, restoreData, verifyBackup } from '../../apps/api/src/backup.ts';
import { lockDataRoot, unlockStoppedService } from '../../apps/api/src/data-lock.ts';
import { hashPassword, temporaryPassword, verifyPassword } from '../../apps/api/src/security.ts';
import { openDataRoot } from '../../apps/api/src/storage.ts';
import { Store } from '../../apps/api/src/store.ts';

test('snapshot keeps account, files, knowledge and DSH state, then restores into a new data root', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'office-p4-backup-'));
  const source = join(folder, 'source');
  const snapshot = join(folder, 'snapshot');
  const restored = join(folder, 'restored');
  try {
    const password = temporaryPassword();
    const store = new Store(source);
    const account = store.createUser({
      username: 'backup-user', displayName: 'Backup user', passwordHash: await hashPassword(password),
    }, 'USER');
    const credentials = store.credentials(account.username)!;
    const token = store.authenticate(credentials)!;
    const upload = store.addFile(account.id, 'test.txt', 'text/plain', Buffer.from('sample upload'));
    const chat = store.createConversation(account.id, '会话');
    const first = store.reserveTurn(account.id, chat.id, randomUUID(), '第一轮')!;
    const savedId = randomUUID();
    store.finishTurn(account.id, chat.id, first, { text: '已完成' }, savedId);
    store.reserveTurn(account.id, chat.id, randomUUID(), '第二轮中断');
    const dshPath = join('users', account.id, 'dsh-home', 'synthetic-state.txt');
    writeFileSync(join(source, dshPath), 'synthetic DSH state', { mode: 0o600 });
    const kbPath = join(source, 'knowledge', 'sample');
    mkdirSync(kbPath, { mode: 0o700 });
    writeFileSync(join(kbPath, 'note.txt'), 'synthetic note', { mode: 0o600 });
    const kb = store.registerKnowledge('Sample', 'sample');
    store.setGrant(account.id, kb.id, true);
    store.close();

    const release = lockDataRoot(openDataRoot(source));
    try {
      await expect(unlockStoppedService(openDataRoot(source))).rejects.toThrow('仍在运行');
      await expect(backupData(source, snapshot)).rejects.toThrow('正在使用');
    } finally {
      release();
    }
    await backupData(source, snapshot);
    await restoreData(snapshot, restored);
    await expect(restoreData(snapshot, restored)).rejects.toMatchObject({ code: 'EEXIST' });

    const v1 = join(folder, 'snapshot-v1');
    cpSync(snapshot, v1, { recursive: true });
    const v1ManifestPath = join(v1, '.ai-office-2-snapshot.json');
    const v1Manifest = JSON.parse(readFileSync(v1ManifestPath, 'utf8'));
    v1Manifest.format = 1;
    writeFileSync(v1ManifestPath, JSON.stringify(v1Manifest));
    await expect(verifyBackup(v1)).resolves.toMatchObject({ format: 1, skills: false });
    const v1Restore = join(folder, 'restored-v1');
    await restoreData(v1, v1Restore);
    expect(readFileSync(join(v1Restore, dshPath), 'utf8')).toBe('synthetic DSH state');

    const restoredStore = new Store(restored);
    try {
      expect(await verifyPassword(password, restoredStore.credentials(account.username)!.passwordHash)).toBe(true);
      expect(restoredStore.session(token)).toBeUndefined();
      expect(restoredStore.download(account.id, upload.id).bytes.toString()).toBe('sample upload');
      const target = restoredStore.workerTarget(account.id, chat.id);
      expect(target.sessionId).toBe(savedId);
      expect(target.grants[0]?.path).toContain('/restored/knowledge/sample');
      expect(readFileSync(join(restored, dshPath), 'utf8')).toBe('synthetic DSH state');
      restoredStore.recoverInterruptedTurns();
      expect(restoredStore.events(account.id, chat.id, 0).at(-1)?.type).toBe('failed');
      expect(restoredStore.reserveTurn(account.id, chat.id, randomUUID(), '恢复后新的一轮')).toBeTruthy();
    } finally {
      restoredStore.close();
    }
    writeFileSync(join(snapshot, dshPath), 'tampered snapshot');
    await expect(restoreData(snapshot, join(folder, 'tampered'))).rejects.toThrow('快照校验失败');
    expect(readFileSync(join(source, dshPath), 'utf8')).toBe('synthetic DSH state');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('stale service lock waits for Worker cleanup after the owning process exits', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'office-p4-lock-'));
  try {
    const root = openDataRoot(folder);
    const child = spawnSync('/usr/bin/true');
    expect(child.status).toBe(0);
    writeFileSync(join(root, '.office-service.lock'), String(child.pid) + '\ndsh\n', { flag: 'wx', mode: 0o600 });
    await expect(unlockStoppedService(root, async () => { throw new Error('Docker unavailable'); })).rejects.toThrow('Docker unavailable');
    await expect(unlockStoppedService(root, async () => {})).resolves.toBe(true);
    const release = lockDataRoot(root);
    release();
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
