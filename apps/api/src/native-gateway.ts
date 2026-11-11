import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { posix } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { NativePool } from './native-pool.ts';
import type { NativeRuntime } from './native-pool.ts';
export type { NativeRuntime } from './native-pool.ts';
import type { Store } from './store.ts';
import { OfficeError } from './errors.ts';
import { sessionToken } from './security.ts';
import { authorizeNative, authorizeStream, forbidden, MAX_NATIVE_BODY, nativePath, readOnlySettings, storageBootstrap } from './native-policy.ts';

type Lease = { userId: string; sessionId: string; token: string; stop: () => void; };
export class NativeGateway {
 private pool: NativePool;
 private leases = new Set<Lease>();
 private httpLeases = new WeakMap<IncomingMessage, {lease: Lease; abort: AbortController}>();
 private changing = new Set<string>();
 private sockets = new WebSocketServer({noServer:true,maxPayload:1024*1024,perMessageDeflate:false});
 private timer: ReturnType<typeof setInterval>;
 private closing = false;
 private store: Store;
 private origin: URL;
 private runtime: NativeRuntime;
 private cookie: string;
 constructor(store: Store, origin: URL, runtime: NativeRuntime, cookie: string) {
  this.store=store;this.origin=origin;this.runtime=runtime;this.cookie=cookie;
  this.pool=new NativePool(store,origin,runtime,userId=>this.disconnectUser(userId));
  this.timer=setInterval(()=>{for(const lease of [...this.leases])if(!this.valid(lease))lease.stop();},500);
  this.timer.unref();
 }
 private identity(req: IncomingMessage) {
  if (this.closing || req.headers.host !== this.origin.host || req.headers['sec-fetch-site']==='cross-site' ||
      (req.headers.origin && req.headers.origin !== this.origin.origin)) throw forbidden();
  const token=sessionToken(req.headers.cookie,this.cookie), session=token?this.store.session(token):undefined;
  if(!session)throw new OfficeError(401,'UNAUTHENTICATED','请登录后继续');
  if(session.account.mustChangePassword)throw new OfficeError(403,'PASSWORD_CHANGE_REQUIRED','请先修改临时密码');
  if(this.changing.has(session.account.id))throw new OfficeError(503,'ACCESS_CHANGING','账户权限正在更新');
  return {token:token!,session};
 }
 private valid(lease: Pick<Lease,'userId'|'sessionId'|'token'>): boolean {
  if(this.closing || this.changing.has(lease.userId))return false;
  const session=this.store.session(lease.token);
  return session?.sessionId===lease.sessionId && session.account.id===lease.userId && !session.account.mustChangePassword;
 }
 private lease(req: IncomingMessage, stop:()=>void): {lease: Lease; release:()=>void} {
  const {token,session}=this.identity(req);
  if([...this.leases].filter(l=>l.sessionId===session.sessionId).length>=24)throw new OfficeError(429,'NATIVE_CONNECTION_LIMIT','连接数已满');
  const lease={token,sessionId:session.sessionId,userId:session.account.id,stop};
  this.leases.add(lease);return {lease,release:()=>this.leases.delete(lease)};
 }
 revokeSession(sessionId:string): void {for(const lease of [...this.leases])if(lease.sessionId===sessionId)lease.stop();}
 async changeAccess<T>(userId:string, update:()=>T|Promise<T>, validate?:()=>void):Promise<T> {
  if(this.changing.has(userId))throw new OfficeError(409,'ACCESS_CHANGING','账户权限正在更新');
  this.changing.add(userId);
  try {
   validate?.();
   this.disconnectUser(userId);
   await this.pool.stopUser(userId);
   return await update();
  } finally {this.changing.delete(userId);}
 }
 private disconnectUser(userId: string): void {
  for(const lease of [...this.leases])if(lease.userId===userId)lease.stop();
 }
 async register(app: FastifyInstance):Promise<void> {
  await this.pool.initialize();
  app.server.on('upgrade',(req,socket,head)=>{void this.upgrade(req,socket as Socket,head);});
  await app.register(async scope=>{
   scope.addHook('onRequest',async(req,reply)=>{
    const raw=req.raw.url??'';nativePath(raw==='/dsh'?'/dsh/':raw);
    try{this.identity(req.raw);}catch(error){
     if(error instanceof OfficeError&&error.statusCode===401&&req.method==='GET'&&raw==='/dsh/'&&req.headers.accept?.includes('text/html')){reply.redirect('/');return;}throw error;
    }
    const abort=new AbortController();
    const tracked=this.lease(req.raw,()=>{abort.abort();req.raw.destroy();reply.raw.destroy();});
    this.httpLeases.set(req.raw,{lease:tracked.lease,abort});
    const release=()=>{tracked.release();this.httpLeases.delete(req.raw);};
    req.raw.once('aborted',()=>{abort.abort();release();});
    reply.raw.once('finish',release);
    reply.raw.once('close',()=>{abort.abort();release();});
   });
   scope.removeAllContentTypeParsers();
   scope.addContentTypeParser('*',{parseAs:'buffer',bodyLimit:MAX_NATIVE_BODY},(_req,body,done)=>done(null,body));
   scope.get('/dsh',async(req,reply)=>{this.identity(req.raw);return reply.redirect('/dsh/');});
   scope.route({method:['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS'],url:'/dsh/*',bodyLimit:MAX_NATIVE_BODY,
    handler:async(req,reply)=>this.http(req,reply)});
  });
 }
 private async http(req:FastifyRequest,reply:FastifyReply):Promise<unknown> {
  const url=nativePath(req.raw.url!);
  const tracked=this.httpLeases.get(req.raw);
  if(!tracked)throw new OfficeError(401,'UNAUTHENTICATED','登录已失效');
  const {lease,abort}=tracked;
  try{
   if(url.pathname.startsWith('/dsh/office/')&&!['GET','HEAD'].includes(req.method))throw forbidden();
   if(url.pathname==='/dsh/office/bootstrap.js')return reply.type('text/javascript').send(storageBootstrap(lease.userId));
   if(url.pathname==='/dsh/office/status')return reply.send({available:this.pool.available(lease.userId)});
   if(url.pathname==='/dsh/office/download')return await this.download(url,lease,abort.signal,reply);
   const bytes=Buffer.isBuffer(req.body)?req.body:Buffer.alloc(0);
   const op=authorizeNative(req.method,url,bytes);
   const shell=req.method==='GET' && url.pathname==='/dsh/';
   const wakes=op.kind==='prompt' || op.kind==='upload' || (op.kind==='write' && url.pathname!=='/dsh/api/workspace/initializeDefault');
   const entry=await this.pool.get(lease.userId,shell || wakes);
   if(!this.valid(lease))throw new OfficeError(401,'UNAUTHENTICATED','登录已失效');
   const path=url.pathname.slice(4)+url.search;
   if(shell || ['/api/session/events','/api/session/page','/api/session/search'].includes(url.pathname.slice(4))) this.pool.touch(entry);
   const typeIn=req.headers['content-type'];
   const forward=()=>this.pool.upstream(entry,path,req.method,bytes,typeIn,abort.signal);
   const result=op.kind==='prompt' ? await this.pool.prompt(entry,op.sessionId,bytes,typeIn)
    : op.kind==='upload' ? await this.pool.upload(entry,bytes.length,abort.signal,forward)
    : op.kind==='write' ? await this.pool.write(entry,0,forward)
    : op.kind==='cancel' ? await this.pool.cancel(entry,op.sessionId,forward)
    : await forward();
   if(!this.valid(lease))throw new OfficeError(401,'UNAUTHENTICATED','登录已失效');
   const type=result.headers['content-type']??'application/octet-stream';
   let data=readOnlySettings(url.pathname.slice(4),result.bytes);
   if(type.includes('text/html') && url.pathname!=='/dsh/') throw forbidden();
   if(type.includes('text/html') && url.pathname==='/dsh/') {
    let html=data.toString('utf8').replace('<head>','<head><script src="/dsh/office/bootstrap.js"></script>');
    html=html.replace(/<script type="module"[^>]*src="([^"]+)"[^>]*><\/script>/g,(_tag,src:string)=>'<script type="module">await window.__OFFICE_STORAGE_READY__;await import('+JSON.stringify(src)+');</script>');
    data=Buffer.from(html);
   }
   if(result.status>=300 && result.status<400){
    const location=result.headers.location;
    if(location){
     const target=new URL(location,this.origin.origin+'/dsh/');
     if(target.origin!==this.origin.origin || !target.pathname.startsWith('/dsh/') || target.searchParams.has('token'))throw forbidden();
     reply.header('Location',target.pathname+target.search);
    }
   }
   const wsOrigin=this.origin.origin.replace(/^http/,'ws');
   reply.header('Content-Security-Policy',`default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ${wsOrigin}; frame-src blob:; worker-src blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`);
   return reply.code(result.status).type(type).header('Vary','Cookie').send(data);
  }catch(error){
   this.runtime.onError?.(error);
   if(error instanceof OfficeError)throw error;
   throw new OfficeError(503,'NATIVE_UNAVAILABLE','DSH 暂时无法连接');
  }
 }
 private async download(url:URL,lease:Lease,signal:AbortSignal,reply:FastifyReply):Promise<unknown>{
  const sessionId=url.searchParams.get('sessionId')??'',path=url.searchParams.get('path')??'';
  if(!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId) || !path.startsWith('/tenant/workspace/') ||
    /[\\\x00-\x1f]/.test(path) || posix.normalize(path)!==path)throw forbidden();
  const entry=await this.pool.get(lease.userId,false);
  this.pool.touch(entry);
  if(!this.valid(lease))throw forbidden();
  const method='workspaceFiles/readBytes';
  const result=await this.pool.upstream(entry,'/api/'+method,'POST',Buffer.from(JSON.stringify({type:'client-request',rpcId:randomUUID(),method,
    payload:{args:{workspaceFileScopeId:sessionId,path,options:{}}}})),'application/json',signal);
  const type=result.headers['content-type'];
  if(result.status!==200 || !type?.startsWith('multipart/'))throw new OfficeError(404,'FILE_NOT_FOUND','文件不可用');
  const form=await new Response(new Uint8Array(result.bytes),{headers:{'Content-Type':type}}).formData();
  const files=[...form.values()].filter((value):value is File=>value instanceof File);
  if(files.length!==1 || files[0]!.size>MAX_NATIVE_BODY)throw new OfficeError(413,'FILE_SIZE','文件过大');
  const bytes=Buffer.from(await files[0]!.arrayBuffer());
  if(!this.valid(lease))throw forbidden();
  const name=encodeURIComponent(posix.basename(path)).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
  return reply.type('application/octet-stream').header('Content-Disposition',"attachment; filename*=UTF-8''"+name).send(bytes);
 }
 private async upgrade(req:IncomingMessage,socket:Socket,head:Buffer):Promise<void>{
  let tracked:{lease:Lease;release:()=>void}|undefined;
  let upstream:WebSocket|undefined,client:WebSocket|undefined;
  try{
   const url=nativePath(req.url!);
   if(url.pathname!=='/dsh/api/remote.mux' || url.search || req.headers.origin!==this.origin.origin)throw forbidden();
   tracked=this.lease(req,()=>{upstream?.terminate();client?.terminate();socket.destroy();});
   socket.once('close',()=>tracked?.release());socket.once('error',()=>tracked?.release());
   const entry=await this.pool.get(tracked.lease.userId,false);
   if(!this.valid(tracked.lease) || socket.destroyed)throw new OfficeError(401,'UNAUTHENTICATED','登录已失效');
   upstream=new WebSocket('ws://office-web.invalid/api/remote.mux',{
    createConnection:()=>entry.transport.connect() as Socket,perMessageDeflate:false,maxPayload:1024*1024,
    headers:{Host:this.origin.host,Origin:this.origin.origin,Cookie:entry.cookie},handshakeTimeout:10000,
   });
   await new Promise<void>((resolve,reject)=>{upstream!.once('open',resolve);upstream!.once('error',reject);});
   if(!this.valid(tracked.lease)||socket.destroyed)throw forbidden();
   const active=new Set<string>();
   this.sockets.handleUpgrade(req,socket,head,ws=>{
    client=ws;
    const stop=()=>{tracked?.release();ws.terminate();upstream?.terminate();};
    ws.on('error',stop);ws.once('close',stop);upstream!.on('error',stop);upstream!.once('close',stop);
    ws.on('message',(data,binary)=>{
     try{if(binary||!this.valid(tracked!.lease)||upstream!.bufferedAmount>2*1024*1024)throw forbidden();
      authorizeStream(data.toString(),active);upstream!.send(data.toString());
     }catch(error){this.runtime.onError?.(error);stop();}
    });
    upstream!.on('message',(data,binary)=>{
     if(!this.valid(tracked!.lease)||ws.bufferedAmount>2*1024*1024){stop();return;}
     if(!binary)try{const frame=JSON.parse(data.toString());if(frame.type==='end'||frame.type==='error')active.delete(frame.streamId);}catch{stop();return;}
     ws.send(data,{binary});
    });
   });
  }catch(error){
   this.runtime.onError?.(error);
   tracked?.release();upstream?.terminate();
   if(!socket.destroyed){const status=error instanceof OfficeError?error.statusCode:502;socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);}
  }
 }
 async close():Promise<void>{
  this.closing=true;clearInterval(this.timer);for(const lease of [...this.leases])lease.stop();
  try {await this.pool.close();} finally {this.sockets.close();}
 }
}
