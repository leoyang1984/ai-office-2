import { useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import * as s from '@office/shared';
import type { Account, Conversation, ConversationDetail, Grant, Knowledge, OfficeFile } from '@office/shared';
import './style.css';

const api = '/api/v1';

class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, schema: { parse(input: unknown): T }, init?: RequestInit): Promise<T> {
  const result = await fetch(api + path, init);
  const body: unknown = await result.json();
  if (!result.ok) {
    const parsed = s.errorBody.safeParse(body);
    throw new ApiError(result.status, parsed.success ? parsed.data.error.message : '请求失败');
  }
  return schema.parse(body);
}

const json = (method: string, value: unknown): RequestInit =>
  ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
const value = (data: FormData, name: string) => String(data.get(name) ?? '');
const formatTime = (timestamp: number) => new Date(timestamp).toLocaleString('zh-CN');

function Form({ onSubmit, children }: {
  onSubmit: (data: FormData, form: HTMLFormElement) => Promise<void>;
  children: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setBusy(true);
    try { await onSubmit(new FormData(form), form); } finally { setBusy(false); }
  }
  return <form onSubmit={submit}><fieldset disabled={busy}>{children}</fieldset></form>;
}

function PasswordField({ label, name, isNew = false }: { label: string; name: string; isNew?: boolean }) {
  return <label>{label}<input name={name} type="password" required minLength={isNew ? 12 : 1} maxLength={128}
    autoComplete={isNew ? 'new-password' : 'current-password'} /></label>;
}

function App() {
  const [account, setAccount] = useState<Account | null>();
  const [error, setError] = useState('');
  const [native, setNative] = useState(false);
  const [skills, setSkills] = useState(false);
  const [agent, setAgent] = useState<'mock' | 'dsh'>();
  const [page, setPage] = useState<'workspace' | 'admin'>('workspace');

  async function act(operation: () => Promise<void>) {
    setError('');
    try { await operation(); } catch (failure) {
      if (account && failure instanceof ApiError && failure.status === 401) setAccount(null);
      setError(failure instanceof Error ? failure.message : '操作失败');
    }
  }

  useEffect(() => {
    void request('/native/status', s.nativeStatus).then(status => { setNative(status.enabled); setSkills(status.skills === true); }).catch(() => {});
    void request('/health/ready', s.readiness).then(status => setAgent(status.agent)).catch(() => {});
    request('/auth/me', s.account).then(setAccount).catch(failure => {
      setAccount(null);
      if (!(failure instanceof ApiError && failure.status === 401)) setError('无法连接办公室服务');
    });
  }, []);

  useEffect(() => {
    if (native && account && !account.mustChangePassword && new URLSearchParams(location.search).get('manage') !== '1') location.replace('/dsh/');
  }, [account, native]);

  return <>
    <header className="top">
      <strong>AI Office 2.0</strong><span className="badge">{agent === 'dsh' ? 'DeepSeek Harness' : agent === 'mock' ? 'Mock Agent' : '正在连接'}</span>
      {account && <div className="account">
        <span>{account.displayName}</span>
        <button className="secondary" onClick={() => void act(async () => {
          await request('/auth/logout', s.ok, { method: 'POST' });
          new BroadcastChannel('office-auth').postMessage('changed');
          setAccount(null);
          setPage('workspace');
        })}>退出</button>
      </div>}
    </header>
    {error && <p className="notice" role="alert">{error}</p>}
    {account === undefined && <main className="login">正在连接…</main>}
    {account === null && <main className="login card">
      <h1>登录办公室</h1>
      <Form onSubmit={data => act(async () => {
        setAccount(await request('/auth/login', s.account, json('POST', {
          username: value(data, 'username'), password: value(data, 'password'),
        })));
        new BroadcastChannel('office-auth').postMessage('changed');
      })}>
        <label>用户名<input name="username" required autoComplete="username" /></label>
        <PasswordField label="密码" name="password" />
        <button>登录</button>
      </Form>
    </main>}
    {account?.mustChangePassword && <main className="login card">
      <h1>修改临时密码</h1>
      <p>新密码至少 12 个字符。</p>
      <Form onSubmit={data => act(async () => {
        setAccount(await request('/auth/change-password', s.account, json('POST', {
          currentPassword: value(data, 'currentPassword'), newPassword: value(data, 'newPassword'),
        })));
      })}>
        <PasswordField label="临时密码" name="currentPassword" />
        <PasswordField label="新密码" name="newPassword" isNew />
        <button>保存密码</button>
      </Form>
    </main>}
    {account && !account.mustChangePassword && <main>
      {account.role === 'ADMIN' && <nav className="tabs" aria-label="工作台导航">
        <button className={page === 'workspace' ? '' : 'secondary'} onClick={() => setPage('workspace')}>工作台</button>
        <button className={page === 'admin' ? '' : 'secondary'} onClick={() => setPage('admin')}>账户管理</button>
      </nav>}
      {page === 'admin' && account.role === 'ADMIN' ? <Admin act={act} skills={skills} /> : native ?
        <>
        <section className="card"><h1>DSH 工作台</h1><p>对话、文件和历史在你的独立 DSH 中保存。</p><a href="/dsh/">打开 DSH</a></section>
        {skills && <PersonalSkills key={account.id} act={act} />}
        <LegacyHistory key={account.id} act={act} />
        </> : <Workspace act={act} agent={agent} />}
    </main>}
  </>;
}

type Act = (operation: () => Promise<void>) => Promise<void>;

function Workspace({ act, agent }: { act: Act; agent?: 'mock' | 'dsh' }) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [files, setFiles] = useState<OfficeFile[]>([]);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [selected, setSelected] = useState<ConversationDetail>();
  const [draft, setDraft] = useState('');
  const [attachmentId, setAttachmentId] = useState('');
  const [preview, setPreview] = useState<{ file: OfficeFile; text?: string }>();
  const [connected, setConnected] = useState(false);
  const [activity, setActivity] = useState<{ type: string; text: string }>({ type: '', text: '' });
  const [sending, setSending] = useState(false);
  const selectedId = selected?.id;
  async function refresh() {
    const [nextConversations, nextFiles, nextGrants] = await Promise.all([
      request('/conversations', s.conversation.array()), request('/files', s.file.array()),
      request('/knowledge', s.grant.array()),
    ]);
    setConversations(nextConversations);
    setFiles(nextFiles);
    setGrants(nextGrants);
  }
  useEffect(() => { void act(refresh); }, []);
  useEffect(() => {
    setConnected(false);
    setActivity({ type: '', text: '' });
    setAttachmentId('');
    if (!selectedId) return;
    const path = '/conversations/' + selectedId;
    const source = new EventSource(api + path + '/events');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    const update = (event: MessageEvent<string>) => {
      let parsed;
      try { parsed = s.conversationEvent.safeParse(JSON.parse(event.data)); } catch { return; }
      if (!parsed.success) return;
      const { type, text } = parsed.data;
      setActivity(current => ({
        type,
        text: type === 'delta' ? current.text + (text ?? '') :
          ['queued', 'completed', 'failed'].includes(type) ? '' : current.text,
      }));
      if (type === 'completed' || type === 'failed') {
        clearTimeout(timer);
        timer = setTimeout(() => {
          void request(path, s.conversationDetail).then(detail => {
            if (!disposed) {
              setSelected(current => current?.id === detail.id ? detail : current);
              void refresh().catch(() => {});
            }
          }).catch(() => {});
        }, 100);
      }
    };
    for (const event of ['queued', 'started', 'tool', 'delta', 'completed', 'failed']) {
      source.addEventListener(event, update as EventListener);
    }
    return () => {
      disposed = true;
      clearTimeout(timer);
      source.close();
    };
  }, [selectedId]);
  const running = sending || ['queued', 'started', 'tool', 'delta'].includes(activity.type);
  const compatibleImages = files.filter(file => s.imageMime.safeParse(file.mime).success && file.size <= s.maxAttachedImage);

  async function showPreview(file: OfficeFile) {
    if (s.imageMime.safeParse(file.mime).success) {
      setPreview({ file });
    } else {
      const result = await fetch(api + '/files/' + file.id + '/preview');
      if (!result.ok) throw new ApiError(result.status, '文件暂时无法预览');
      setPreview({ file, text: await result.text() });
    }
  }

  return <div className="workspace">
    <aside className="card">
      <h2>会话</h2>
      <Form onSubmit={(data, form) => act(async () => {
        const created = await request('/conversations', s.conversation, json('POST', { title: value(data, 'title') }));
        setSelected({ ...created, messages: [] });
        form.reset();
        await refresh();
      })}>
        <label>会话标题<input name="title" required maxLength={80} /></label><button>新建会话</button>
      </Form>
      <ul className="plain">
        {conversations.map(item => <li key={item.id}><button className="secondary full"
          aria-pressed={item.id === selected?.id}
          onClick={() => void act(async () => {
            setSelected(await request('/conversations/' + item.id, s.conversationDetail));
            setDraft('');
          })}>{item.title}</button></li>)}
      </ul>
    </aside>
    <section className="card chat">
      <h1>{selected?.title ?? '工作台'}</h1>
      <p className="muted">{selected ? agent === 'dsh' ? '此会话由 DeepSeek Harness 处理。' : 'Mock Agent 会返回测试回复。' : '从左侧新建或打开一个会话。'}</p>
      {selected && <>
        <ol className="messages">
          {selected.messages.map(item => <li key={item.id} className={item.role}>
            <b>{item.role === 'user' ? '你' : agent === 'dsh' ? 'DSH' : 'Mock Agent'}</b><p>{item.text}</p>
          </li>)}
        </ol>
        <p role="status" className="muted">{!connected ? '正在连接会话更新…' :
          activity.type === 'failed' ? '上一轮未完成' : activity.type === 'tool' ? '正在使用工具' :
          running ? '正在处理' : '会话已连接'}</p>
        {activity.text && <p className="stream-text">{activity.text}</p>}
        <Form onSubmit={() => act(async () => {
          if (running) return;
          setSending(true);
          try {
            const updated = await request('/conversations/' + selected.id + '/messages', s.conversationDetail, json('POST', {
              text: draft, requestId: crypto.randomUUID(), attachmentId: attachmentId || undefined,
            }));
            setSelected(current => current?.id === updated.id ? updated : current);
            setDraft('');
            setAttachmentId('');
            await refresh();
          } finally { setSending(false); }
        })}>
          <label>消息<textarea required maxLength={8000} rows={3} value={draft} onChange={event => setDraft(event.target.value)} /></label>
          {agent === 'dsh' && compatibleImages.length > 0 && <label>图片附件（可选）
            <select value={attachmentId} onChange={event => setAttachmentId(event.target.value)}>
              <option value="">选择已上传图片</option>
              {compatibleImages.map(file => <option key={file.id} value={file.id}>{file.name}</option>)}
            </select>
          </label>}
          <button disabled={running}>发送</button>
        </Form>
        {running && <button className="secondary" onClick={() => void act(async () => {
          await request('/conversations/' + selected.id + '/stop', s.ok, { method: 'POST' });
        })}>停止当前任务</button>}
      </>}
    </section>
    <aside className="card">
      <h2>工作区文件</h2>
      <Form onSubmit={(data, form) => act(async () => {
        await request('/files/upload', s.file, { method: 'POST', body: data });
        form.reset();
        await refresh();
      })}>
        <label>上传文件<input type="file" name="file" required accept=".txt,.md,.png,.jpg,.jpeg,.webp,.pdf" /></label>
        <button>上传</button>
      </Form>
      {(['output', 'upload'] as const).map(group => <div key={group}>
        <h3>{group === 'output' ? '生成成果' : '上传文件'}</h3>
        <ul className="plain">{files.filter(item => item.source === group).map(item => <li key={item.id}>
          <div>{item.name} <span className="muted">{Math.ceil(item.size / 1024)} KB</span></div>
          <div className="file-actions">
            {item.mime !== 'application/pdf' && <button type="button" className="secondary"
              onClick={() => void act(() => showPreview(item))}>预览 {item.name}</button>}
            <a href={api + '/files/' + item.id + '/download'}>下载 {item.name}</a>
          </div>
        </li>)}</ul>
      </div>)}
      {preview && <section aria-label="文件预览" className="file-preview">
        <div className="row"><strong>{preview.file.name}</strong>
          <button type="button" className="secondary" onClick={() => setPreview(undefined)}>关闭预览</button></div>
        {preview.text === undefined ? <img src={api + '/files/' + preview.file.id + '/preview'} alt={preview.file.name} />
          : <pre>{preview.text}</pre>}
      </section>}
      <h2>已授权知识库</h2>
      {grants.length ? <ul>{grants.map(item => <li key={item.id}>{item.name} · 只读</li>)}</ul> : <p className="muted">暂无授权。</p>}
    </aside>
  </div>;
}

function Admin({ act, skills }: { act: Act; skills: boolean }) {
  const [users, setUsers] = useState<Account[]>([]);
  const [bases, setBases] = useState<Knowledge[]>([]);
  const [audit, setAudit] = useState<ReturnType<typeof s.auditEvent.parse>[]>([]);
  async function refresh() {
    const [nextUsers, nextBases, nextAudit] = await Promise.all([
      request('/admin/users', s.account.array()), request('/admin/knowledge', s.knowledge.array()),
      request('/admin/audit?limit=20', s.auditEvent.array()),
    ]);
    setUsers(nextUsers);
    setBases(nextBases);
    setAudit(nextAudit);
  }
  useEffect(() => { void act(refresh); }, []);
  const ordinary = users.filter(item => item.role === 'USER');
  return <div className="admin">
    <section className="card">
      <h1>账户</h1>
      <Form onSubmit={(data, form) => act(async () => {
        await request('/admin/users', s.account, json('POST', {
          username: value(data, 'username'), displayName: value(data, 'displayName'), password: value(data, 'password'),
        }));
        form.reset();
        await refresh();
      })}>
        <label>用户名<input name="username" required pattern="[a-z][a-z0-9_-]{2,31}" /></label>
        <label>显示名称<input name="displayName" required maxLength={80} /></label>
        <PasswordField label="临时密码（至少 12 个字符）" name="password" isNew />
        <button>创建用户</button>
      </Form>
      <ul className="plain">
        {users.map(item => <li className="row" key={item.id}>
          <span>{item.displayName} · {item.username} · {item.status === 'active' ? '启用' : '禁用'}</span>
          {item.role === 'USER' && <button className="secondary" onClick={() => void act(async () => {
            await request('/admin/users/' + item.id, s.account, json('PATCH', {
              status: item.status === 'active' ? 'disabled' : 'active',
            }));
            await refresh();
          })}>{item.status === 'active' ? '禁用' : '启用'}</button>}
        </li>)}
      </ul>
      {ordinary.length > 0 && <Form onSubmit={(data, form) => act(async () => {
        await request('/admin/users/' + value(data, 'userId'), s.account, json('PATCH', { password: value(data, 'password') }));
        form.reset();
        await refresh();
      })}>
        <label>需要重置的用户<select name="userId">{ordinary.map(item =>
          <option key={item.id} value={item.id}>{item.displayName}</option>)}</select></label>
        <PasswordField label="新临时密码" name="password" isNew />
        <button>重置密码</button>
      </Form>}
    </section>
    <section className="card">
      <h2>知识库授权</h2>
      <Form onSubmit={(data, form) => act(async () => {
        await request('/admin/knowledge', s.knowledge, json('POST', {
          name: value(data, 'name'), directory: value(data, 'directory'),
        }));
        form.reset();
        await refresh();
      })}>
        <label>知识库名称<input name="name" required maxLength={80} /></label>
        <label>托管目录名<input name="directory" required pattern="[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}" /></label>
        <button>登记知识库</button>
      </Form>
      {ordinary.length > 0 && bases.length > 0 && <Form onSubmit={data => act(async () => {
        await request('/admin/users/' + value(data, 'userId') + '/knowledge/' + value(data, 'kbId'),
          s.ok, { method: value(data, 'action') });
        await refresh();
      })}>
        <label>用户<select name="userId">{ordinary.map(item => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select></label>
        <label>知识库<select name="kbId">{bases.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label>权限操作<select name="action"><option value="PUT">授予只读</option><option value="DELETE">撤销权限</option></select></label>
        <button>保存权限</button>
      </Form>}
    </section>
    {skills && <PublicSkills act={act} users={users} />}
    <section className="card audit">
      <h2>最近审计</h2>
      <ul className="plain">{audit.map(event => <li key={event.id}>
        {formatTime(event.at)} · {event.action} · {event.success ? '成功' : '拒绝'}
      </li>)}</ul>
    </section>
  </div>;
}

function LegacyHistory({ act }: { act: Act }) {
  const limit = 50;
  const [rows, setRows] = useState<Conversation[]>([]);
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<ConversationDetail>();
  async function load(next: number) {
    const page = await request('/conversations?limit=' + limit + '&offset=' + next, s.conversation.array());
    setRows(page);
    setOffset(next);
    setSelected(undefined);
  }
  useEffect(() => { void act(() => load(0)); }, []);
  if (!rows.length && offset === 0) return null;
  return <section className="card">
    <h2>旧版对话记录</h2>
    <ul className="plain">{rows.map(row => <li key={row.id} className="row">
      <button className="secondary" onClick={() => void act(async () => {
        setSelected(await request('/conversations/' + row.id, s.conversationDetail));
      })}>{row.title}</button>
      <time dateTime={new Date(row.updatedAt).toISOString()}>{formatTime(row.updatedAt)}</time>
    </li>)}</ul>
    {offset > 0 && <button className="secondary" onClick={() => void act(() => load(offset - limit))}>上一页</button>}
    {rows.length === limit && <button className="secondary" onClick={() => void act(() => load(offset + limit))}>下一页</button>}
    {selected && <article aria-label="旧版对话正文">
      <h3>{selected.title}</h3>
      {selected.messages.map(message => <p key={message.id} className="message">
        <strong>{message.role === 'user' ? '你' : '助手'}</strong> {message.text}
      </p>)}
    </article>}
  </section>;
}

function SkillEditor({ draft, action, act, save }: {
  draft?: s.SkillInput;
  action: string;
  act: Act;
  save: (input: s.SkillInput, form: HTMLFormElement) => Promise<void>;
}) {
  return <Form onSubmit={(data, form) => act(async () => {
    const selected = data.getAll('resources').filter((file): file is File => file instanceof File && file.name !== '');
    if (selected.length > 8 || selected.some(file => file.size > 16_384)) throw new Error('最多选择 8 个参考文件，每个最多 16 KiB');
    const resources = selected.length > 0 ? await Promise.all(selected.map(async file => ({
      name: file.name, text: new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()),
    }))) : data.has('clearResources') ? [] : draft?.resources ?? [];
    await save({
      name: value(data, 'name'), version: value(data, 'version'), description: value(data, 'description'),
      instructions: value(data, 'instructions'), resources,
    }, form);
  })}>
    <label>Skill 名称<input name="name" required readOnly={!!draft} defaultValue={draft?.name}
      pattern="[a-z][a-z0-9]*(?:-[a-z0-9]+)*" maxLength={64} placeholder="weekly-report" /></label>
    <label>版本<input name="version" required defaultValue={draft?.version ?? '1.0.0'} maxLength={24} /></label>
    <label>说明<input name="description" required defaultValue={draft?.description} maxLength={240} /></label>
    <label>指令正文<textarea name="instructions" required defaultValue={draft?.instructions} maxLength={32_768} rows={6} /></label>
    <label>参考文件（可选，所选文件将替换原参考文件）<input type="file" name="resources" multiple accept=".md,.txt,.json,.csv" /></label>
    {!!draft?.resources.length && <label><input type="checkbox" name="clearResources" />清除现有参考文件</label>}
    <button>{action}</button>
  </Form>;
}

function PersonalSkills({ act }: { act: Act }) {
  const [library, setLibrary] = useState<{ public: s.SkillInfo[]; personal: s.SkillInfo[] }>({ public: [], personal: [] });
  const [draft, setDraft] = useState<s.SkillInput>();
  const [notice, setNotice] = useState('');
  const refresh = async () => setLibrary(await request('/skills', s.skillLibrary));
  useEffect(() => { void act(refresh); }, []);
  return <section className="card">
    <h2>个人 Skill</h2>
    <ul className="plain">{library.personal.map(skill => <li key={skill.id} className="row">
      <span>{skill.name} · {skill.version}</span>
      <button type="button" className="secondary" onClick={() => void act(async () => {
        setDraft(await request('/skills/personal/' + skill.name, s.skillInput));
      })}>编辑 {skill.name}</button>
      <button type="button" className="secondary" onClick={() => void act(async () => {
        await request('/skills/personal/' + skill.name, s.ok, { method: 'DELETE' });
        if (draft?.name === skill.name) setDraft(undefined);
        setNotice('已删除 ' + skill.name);
        await refresh();
      })}>删除 {skill.name}</button>
    </li>)}</ul>
    {draft && <button className="secondary" onClick={() => setDraft(undefined)}>取消编辑</button>}
    <SkillEditor key={draft?.name ?? 'new'} draft={draft} action="保存个人 Skill" act={act} save={async (input, form) => {
      const saved = await request('/skills/personal', s.skillInfo, json('PUT', input));
      form.reset();
      setDraft(undefined);
      setNotice('已保存 ' + saved.name + ' · ' + saved.version);
      await refresh();
    }} />
    {notice && <p role="status">{notice}</p>}
    <h2>获授权的公共 Skill</h2>
    <ul className="plain">{library.public.map(skill =>
      <li key={skill.id}>{skill.name} · {skill.version} · {skill.description}</li>)}</ul>
  </section>;
}

function PublicSkills({ act, users }: { act: Act; users: Account[] }) {
  const [versions, setVersions] = useState<s.SkillInfo[]>([]);
  const [selection, setSelection] = useState<{ owner: string; grants: s.SkillInfo[] }>();
  const [owner, setOwner] = useState('');
  const [notice, setNotice] = useState('');
  const refresh = async () => setVersions(await request('/admin/skills', s.skillInfo.array()));
  const refreshGrants = async (id: string) => setSelection({
    owner: id, grants: await request('/admin/users/' + id + '/skills', s.skillInfo.array()),
  });
  const grants = selection?.owner === owner ? selection.grants : [];
  useEffect(() => { void act(refresh); }, []);
  return <section className="card">
    <h2>公共 Skill</h2>
    <SkillEditor action="发布公共版本" act={act} save={async (input, form) => {
      const installed = await request('/admin/skills', s.skillInfo, json('POST', input));
      form.reset();
      setNotice('已发布 ' + installed.name + ' · ' + installed.version);
      await refresh();
    }} />
    <ul className="plain">{versions.map(skill => <li key={skill.id}>{skill.name} · {skill.version}</li>)}</ul>
    {users.length > 0 && versions.length > 0 && <Form onSubmit={data => act(async () => {
      await request('/admin/users/' + owner + '/skills/' + value(data, 'skillId'), s.ok, { method: value(data, 'action') });
      setNotice('已保存 Skill 授权');
      await refreshGrants(owner);
    })}>
      <label>授权账户<select name="owner" required value={owner} onChange={event => {
        const id = event.target.value;
        setOwner(id);
        if (id) void act(() => refreshGrants(id));
      }}>
        <option value="">选择账户</option>
        {users.map(item => <option key={item.id} value={item.id}>{item.displayName}</option>)}
      </select></label>
      <label>公共 Skill 版本<select name="skillId">{versions.map(skill =>
        <option key={skill.id} value={skill.id}>{skill.name} · {skill.version}</option>)}</select></label>
      <label>授权操作<select name="action"><option value="PUT">授予只读或切换版本</option><option value="DELETE">撤销所选版本</option></select></label>
      <button>保存 Skill 授权</button>
    </Form>}
    {grants.length > 0 && <ul className="plain" aria-label="当前授权">
      {grants.map(skill => <li key={skill.id}>{skill.name} · {skill.version}</li>)}
    </ul>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}

createRoot(document.getElementById('root')!).render(<App />);
