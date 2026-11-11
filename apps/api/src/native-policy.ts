import { posix } from 'node:path';
import { OfficeError } from './errors.ts';
export const NATIVE_PREFIX = '/dsh/';
export const MAX_NATIVE_BODY = 20 * 1024 * 1024;
const reads = [
 'session/list','session/search','session/modelCatalog','session/events','session/page','session/state','session/wait',
 'session/projections','session/attachment','session/skills','session/fileReferences','session/availableSkills',
 'workspaceFiles/read','workspaceFiles/readBytes','workspaceFiles/stat','workspaceFiles/list',
 'settings/describe','credentials/describe','agentPresets/list','permissionPresets/catalog',
 'llm/listProviders','llm/listConfigurableProviders',
 'schedule/catalog','commands/list','skills/list','session/canOpenWorkspacePath',
];
const writes = ['workspace/initializeDefault','session/create','session/rename','session/selectModel',
 'session/fork','workspace/create','workspace/rename','workspace/insertBefore','workspace/insertSessionBefore',
 'workspace/archiveSession','workspace/unarchiveSession','workspace/pinSession','workspace/unpinSession'];
const allowed = new Set([...reads,...writes,'session/prompt','session/cancel']);
const streams = new Set(['job/list','remoteAccess/follow','account/watch','$events','workspace/follow','session/control','session/follow','session/observeEvent',
 'session/observeState','session/observeProjections','workspaceFiles/changes']);
export const forbidden = () => new OfficeError(403, 'NATIVE_OPERATION_DENIED', '此功能由办公室管理员管理');
export function nativePath(raw: string): URL {
 const url = new URL(raw, 'http://office.invalid');
 if (!raw.startsWith(NATIVE_PREFIX) || /[\\\x00-\x20]/.test(raw) || /%(?:2f|5c|00)/i.test(raw.split('?')[0]!) ||
     url.searchParams.has('token') || !url.pathname.startsWith(NATIVE_PREFIX)) throw forbidden();
 return url;
}
type NativeOperation = { kind: 'read' | 'write' | 'upload' } | { kind: 'prompt' | 'cancel'; sessionId: string };
function workspacePath(path: unknown, absolute = false, knowledge = false): boolean {
 if (typeof path !== 'string' || /[\\\x00-\x1f]/.test(path) || path.length > 1024) return false;
 const normalized = posix.normalize(path);
 if (normalized !== path || path.split('/').includes('..')) return false;
 if (!path.startsWith('/')) return !absolute;
 return path === '/tenant/workspace' || path.startsWith('/tenant/workspace/') ||
   (knowledge && (/^\/knowledge\/[a-f0-9-]{36}(?:\/|$)/.test(path) ||
     /^\/office-skills(?:\/[a-z][a-z0-9-]*(?:\/.*)?)?$/.test(path)));
}
export function authorizeNative(method: string, url: URL, bytes: Buffer): NativeOperation {
 const path = url.pathname.slice(NATIVE_PREFIX.length - 1);
 if (method === 'GET' || method === 'HEAD') {
  if (path.startsWith('/api/') && !['/api/present.host','/api/changes.summary'].includes(path)) throw forbidden();
  if (path.startsWith('/office/')) throw forbidden();
  return { kind: 'read' };
 }
 if (method !== 'POST') throw forbidden();
 if (path === '/api/session/uploadFileBinary') {
  if (url.searchParams.has('mediaType') && bytes.length > 2 * 1024 * 1024) {
   throw new OfficeError(413,'IMAGE_SIZE','图片最多 2 MiB');
  }
  if (bytes.length === 0) throw new OfficeError(400, 'FILE_REQUIRED', '请选择文件');
  return { kind: 'upload' };
 }
 const endpoint = path.slice('/api/'.length);
 if (!path.startsWith('/api/') || !allowed.has(endpoint)) throw forbidden();
 if (bytes.length > 1024 * 1024) throw new OfficeError(413,'NATIVE_RPC_SIZE','请求过大');
 let body;
 try { body = JSON.parse(bytes.toString('utf8')); } catch { throw forbidden(); }
 if (body?.type !== 'client-request' || body.method !== endpoint || !body.payload?.args || typeof body.rpcId !== 'string') throw forbidden();
 const args = body.payload.args;
 const request = args.request;
 if (endpoint === 'session/prompt' || endpoint === 'session/cancel') {
  if (typeof request?.sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(request.sessionId)) throw forbidden();
  if (endpoint === 'session/prompt' && request.mode !== 'queue') throw forbidden();
  return { kind: endpoint === 'session/prompt' ? 'prompt' : 'cancel', sessionId: request.sessionId };
 }
 if (endpoint === 'session/selectModel' && (request?.provider !== 'deepseek-official' || request?.model !== 'deepseek-flash' ||
     (request.reasoningEffort !== undefined && request.reasoningEffort !== 'off'))) throw forbidden();
 if (endpoint === 'session/create' && ((request?.cwd !== undefined && !workspacePath(request.cwd, true)) ||
     (request?.agentPreset !== undefined && request.agentPreset !== 'standard'))) throw forbidden();
 if (endpoint === 'workspace/create' && !workspacePath(request?.path, true)) throw forbidden();
 if (endpoint.startsWith('workspaceFiles/') &&
     (!workspacePath(args.path, false, true) || (args.options?.baseFile !== undefined && !workspacePath(args.options.baseFile, false, true)))) throw forbidden();
 return { kind: writes.includes(endpoint) ? 'write' : 'read' };
}
export function authorizeStream(raw: string, active: Set<string>): void {
 const frame = JSON.parse(raw);
 if (typeof frame.streamId !== 'string' || frame.streamId.length > 128) throw forbidden();
 if (frame.type === 'open') {
  if (!streams.has(frame.endpoint) || active.has(frame.streamId) || active.size >= 48 ||
      !frame.payload || typeof frame.payload !== 'object') throw forbidden();
  if (frame.endpoint === 'workspaceFiles/changes' && !workspacePath(frame.payload.args?.path, false, true)) throw forbidden();
  active.add(frame.streamId);
 } else if (frame.type === 'cancel' || frame.type === 'end') active.delete(frame.streamId);
 else throw forbidden(); // No writable/uplink endpoint is admitted in R1.
}
export function readOnlySettings(path: string, bytes: Buffer): Buffer {
 if (!['/api/settings/describe','/api/credentials/describe'].includes(path)) return bytes;
 const value = JSON.parse(bytes.toString('utf8'));
 if (value.result?.ok) {
  if (path === '/api/settings/describe') value.result.value.writable = false;
  else for (const state of Object.values(value.result.value) as { writable?: boolean }[]) state.writable = false;
 }
 return Buffer.from(JSON.stringify(value));
}
export function storageBootstrap(userId: string): string {
 return `(() => {
 const owner=${JSON.stringify(userId)}, prefix='office-native:'+owner+':';
 const rawLocal=window.localStorage,rawSession=window.sessionStorage;
 for(const storage of [rawLocal,rawSession])for(const key of Object.keys(storage))if(key.startsWith('office-native:')&&!key.startsWith(prefix))storage.removeItem(key);
 const rawDeleteDatabase=window.indexedDB?indexedDB.deleteDatabase.bind(indexedDB):null;
 window.__OFFICE_STORAGE_READY__=window.indexedDB&&indexedDB.databases?indexedDB.databases().then(dbs=>Promise.all(dbs.filter(db=>db.name?.startsWith('office-native:')&&!db.name.startsWith(prefix)).map(db=>new Promise((resolve,reject)=>{const r=rawDeleteDatabase(db.name);r.onsuccess=()=>resolve();r.onerror=()=>reject(Error('Unable to clear previous browser cache'));r.onblocked=()=>reject(Error('Close old account tabs before switching'));})))):Promise.resolve();
 const scoped=storage=>({get length(){return Object.keys(storage).filter(k=>k.startsWith(prefix)).length},
  key(n){return Object.keys(storage).filter(k=>k.startsWith(prefix))[n]?.slice(prefix.length)??null},
  getItem(k){return storage.getItem(prefix+k)},setItem(k,v){storage.setItem(prefix+k,String(v))},
  removeItem(k){storage.removeItem(prefix+k)},clear(){for(const k of Object.keys(storage))if(k.startsWith(prefix))storage.removeItem(k)}});
 Object.defineProperty(window,'localStorage',{value:scoped(window.localStorage)});
 Object.defineProperty(window,'sessionStorage',{value:scoped(window.sessionStorage)});
 if(window.indexedDB){const open=indexedDB.open.bind(indexedDB),del=indexedDB.deleteDatabase.bind(indexedDB);
  indexedDB.open=(n,v)=>v===undefined?open(prefix+n):open(prefix+n,v);indexedDB.deleteDatabase=n=>del(prefix+n);}
 let checking=false, resume;
 function showResume(){
  if(resume?.isConnected||!document.body)return;
  resume=document.createElement('button');
  resume.type='button';resume.textContent='继续使用 DSH';
  resume.title='会话已休眠或连接已断开，点击恢复';
  resume.style.cssText='position:fixed;bottom:16px;right:16px;z-index:2147483647;padding:8px 14px;cursor:pointer';
  resume.onclick=()=>location.reload();
  document.body.append(resume);
 }
 async function check(){if(checking)return;checking=true;try{const r=await fetch('/api/v1/auth/me',{cache:'no-store'});
  const u=r.ok?await r.json():null;if(!u||u.id!==owner||u.mustChangePassword){localStorage.clear();sessionStorage.clear();document.body?.replaceChildren();location.replace('/');return;}
  const status=await fetch('/dsh/office/status',{cache:'no-store'});
  if(status.ok){if((await status.json()).available)resume?.remove();else showResume();}}
  catch{}finally{checking=false;}}
 window.addEventListener('pagehide',()=>document.body?.replaceChildren());
 window.addEventListener('pageshow',e=>{if(e.persisted)location.reload()});
 document.addEventListener('visibilitychange',()=>{if(!document.hidden)void check()});
 const c=new BroadcastChannel('office-auth');c.onmessage=()=>void check();setInterval(check,1500);
 })();`;
}
