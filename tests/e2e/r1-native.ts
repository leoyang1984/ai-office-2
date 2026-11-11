import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import type { Duplex } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket as SocketClient } from 'ws';
import type { BrowserContext, WebSocket as BrowserSocket } from 'playwright-core';
import { chromium } from 'playwright-core';
import type { Page } from 'playwright-core';
import { createApp } from '../../apps/api/src/app.ts';
import { Store } from '../../apps/api/src/store.ts';
import { hashPassword, temporaryPassword } from '../../apps/api/src/security.ts';
import type { ModelBroker } from '../../packages/dsh-adapter/src/index.ts';
const root=mkdtempSync(join(tmpdir(),'office-r1-native-')),dataRoot=join(root,'data');
const image=execFileSync('docker',['--context','desktop-linux','image','inspect','--format={{.Id}}','ai-office-2-dsh-web:r2-0.2.2-rc.1'],{encoding:'utf8'}).trim();
const port=await new Promise<number>(resolve=>{const s=createServer();s.listen(0,'127.0.0.1',()=>{const a=s.address();assert.ok(a&&typeof a==='object');s.close(()=>resolve(a.port));});});
const origin='http://127.0.0.1:'+port;
const users=['admin','alice','bob'].map(username=>({username,password:temporaryPassword(),next:temporaryPassword(),id:''}));
const event=(type:string,fields:object)=>'event: '+type+'\ndata: '+JSON.stringify({type,...fields})+'\n\n';
const model:ModelBroker=async body=>{
 const input=JSON.parse(body),all=JSON.stringify(input.messages),last=JSON.stringify(input.messages.at(-1));
 const owner=all.includes('R1_ALICE')?'ALICE':all.includes('R1_BOB')?'BOB':undefined;assert.ok(owner);
 assert.ok(!(all.includes('R1_ALICE')&&all.includes('R1_BOB')));
 const stream=(block:object,delta:object,stop='end_turn')=>new Response(
 event('message_start',{message:{id:'msg_'+randomUUID(),type:'message',role:'assistant',model:input.model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:10,output_tokens:1}}})+
 event('content_block_start',{index:0,content_block:block})+event('content_block_delta',{index:0,delta})+event('content_block_stop',{index:0})+
 event('message_delta',{delta:{stop_reason:stop,stop_sequence:null},usage:{output_tokens:5}})+event('message_stop',{}),{headers:{'Content-Type':'text/event-stream'}});
 const text=(value:string)=>stream({type:'text',text:''},{type:'text_delta',text:value});
 const tool=(name:string,args:object)=>stream({type:'tool_use',id:'tool_'+randomUUID(),name,input:{}},{type:'input_json_delta',partial_json:JSON.stringify(args)},'tool_use');
 if(last.includes('tool_result')){assert.doesNotMatch(last,/"is_error":true/);const prior=input.messages.at(-2)?.content?.find((b:{type:string})=>b.type==='tool_use')?.name;
  return prior==='write'?tool('present',{files:[{path:'report.txt'}]}):text('R1_FILE_READY');}
 if(last.includes('R1_EXPORT'))return tool('write',{file_path:'report.txt',content:'R1_PRIVATE_'+owner+'\n'});
 return text(last.includes('R1_POSTRESET')?'R1_RESET_OK_'+owner:last.includes('R1_POSTDISABLE')?'R1_DISABLE_OK_'+owner:'R1_REPLY_'+owner);
};
let app:Awaited<ReturnType<typeof createApp>>|undefined,browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
let stage='setup';
let debugPage:Page|undefined;
const socketsA:BrowserSocket[]=[];
const diagnostics:string[]=[];
async function eventually(check:()=>boolean, label:string){for(let i=0;i<120&&!check();i++)await delay(25);assert.ok(check(),label);}
try{
 const store=new Store(dataRoot);for(const u of users)u.id=store.createUser({username:u.username,displayName:u.username,passwordHash:await hashPassword(u.password)},u.username==='admin'?'ADMIN':'USER').id;store.close();
 app=await createApp({dataRoot,origin,serveWeb:true,nativeWeb:{image,model,onError:error=>diagnostics.push(String(error).replace(/token=[^\s"']+/g,'token=[redacted]'))}});
 const gatewaySockets=new Map<Duplex,string>();
 app.server.on('upgrade',(req,socket)=>{
  gatewaySockets.set(socket,req.headers.cookie??'');
  socket.once('close',()=>gatewaySockets.delete(socket));
 });
 const connected=(raw:string)=>[...gatewaySockets].some(([socket,header])=>header===raw&&!socket.destroyed);
 await app.listen({host:'127.0.0.1',port});
 browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,chromiumSandbox:true});
 const context=await browser.newContext({viewport:{width:1280,height:800},acceptDownloads:true}),page=await context.newPage();debugPage=page;
 page.on('websocket',ws=>socketsA.push(ws));
 page.on('pageerror',e=>diagnostics.push(e.message));
 stage='login and native startup';
 await page.goto(origin);await page.getByLabel('用户名').fill('alice');await page.getByLabel('密码',{exact:true}).fill(users[1]!.password);await page.getByRole('button',{name:'登录',exact:true}).click();
 await page.getByLabel('临时密码').fill(users[1]!.password);await page.getByLabel('新密码').fill(users[1]!.next);await page.getByRole('button',{name:'保存密码'}).click();
 await page.waitForURL(origin+'/dsh/');
 await page.locator('[data-composer-input][contenteditable=true]').waitFor({timeout:30000});
 await page.getByRole('button',{name:'退出办公室',exact:true}).waitFor();
 assert.equal((await context.cookies()).filter(c=>c.name!=='office_session').length,0);
 console.log('PASS R1 existing login/password flow enters original DSH without browser-native credentials');
 stage='chat';
 await page.locator('[data-composer-input][contenteditable=true]').fill('R1_ALICE');await page.getByRole('button',{name:'发送消息',exact:true}).click();await page.getByText('R1_REPLY_ALICE',{exact:true}).waitFor({timeout:55000});
 console.log('PASS R1 authenticated native HTTP and WebSocket chat');
 stage='native download control';
 await page.locator('[data-composer-input][contenteditable=true]').fill('R1_EXPORT R1_ALICE');await page.getByRole('button',{name:'发送消息',exact:true}).click();await page.getByText('R1_FILE_READY',{exact:true}).waitFor({timeout:55000});
 await page.getByRole('button',{name:'在侧边栏预览 /tenant/workspace/deepseek-harness/default-workspace/report.txt',exact:true}).click();
 const [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('link',{name:'下载文件',exact:true}).click()]);
 assert.equal(readFileSync((await download.path())!,'utf8'),'R1_PRIVATE_ALICE\n');console.log('PASS R1 official-slot download button saves exact bytes');
 const headers={origin};
 const cookie=async(c:BrowserContext)=>{const k=(await c.cookies()).find(k=>k.name==='office_session');assert.ok(k);return k.name+'='+k.value;};
 async function rpc(p:Page,method:string,args:object,query=''){
  const r=await p.request.post(origin+'/dsh/api/'+method+query,{headers,data:{type:'client-request',rpcId:randomUUID(),method,payload:{args}}});
  assert.equal(r.status(),200);return (await r.json()).result;
 }
 const listA=await rpc(page,'session/list',{_request:{}}),sidA=listA.value.items[0].sessionId as string;
 const aliceCookie=await cookie(context);
 const anon=await browser.newContext();
 assert.equal((await anon.request.get(origin+'/dsh/')).status(),401);
 assert.equal((await anon.request.get(origin+'/dsh/assets/test.js',{headers:{Cookie:'dsh_session=forged'}})).status(),401);
 assert.equal((await page.request.get(origin+'/dsh/?token=forged')).status(),403);
 assert.ok(!/\?token=[A-Za-z0-9_-]{24}/.test(await (await page.request.get(origin+'/dsh/')).text()));
 async function rejectedWs(rawCookie:string,status:number,site=origin){
  await new Promise<void>((resolve,reject)=>{let settled=false;
   const ws=new SocketClient(origin.replace('http','ws')+'/dsh/api/remote.mux',{headers:{Cookie:rawCookie,Origin:site},handshakeTimeout:3000});
   ws.on('unexpected-response',(_req,res)=>{settled=true;try{assert.equal(res.statusCode,status);res.resume();resolve();}catch(e){reject(e);}});
   ws.on('open',()=>{ws.terminate();reject(Error('Unauthorized WS opened'));});ws.on('error',e=>{if(!settled)reject(e);});
  });
 }
 await rejectedWs('',401);await rejectedWs(aliceCookie,403,'https://untrusted.invalid');
 console.log('PASS R1 anonymous/forged native credentials and cross-origin WebSocket denied');
 stage='second account and cross-tenant attacks';
 const contextB=await browser.newContext(),pageB=await contextB.newPage(),socketsB:BrowserSocket[]=[];
 pageB.on('websocket',ws=>socketsB.push(ws));
 async function loginUi(p:Page,u:typeof users[number],initial=false){
  await p.goto(origin);await p.getByLabel('用户名').fill(u.username);await p.getByLabel('密码',{exact:true}).fill(initial?u.password:u.next);
  await p.getByRole('button',{name:'登录',exact:true}).click();
  if(initial){await p.getByLabel('临时密码').fill(u.password);await p.getByLabel('新密码').fill(u.next);await p.getByRole('button',{name:'保存密码'}).click();}
  await p.waitForURL(origin+'/dsh/');
  await p.getByRole('button',{name:'退出办公室',exact:true}).waitFor({timeout:30000});
 }
 async function send(p:Page,text:string,reply:string){await p.locator('[data-composer-input][contenteditable=true]').fill(text);await p.getByRole('button',{name:'发送消息',exact:true}).click();await p.getByText(reply,{exact:true}).last().waitFor({timeout:55000});}
 await loginUi(pageB,users[2]!,true);await send(pageB,'R1_BOB','R1_REPLY_BOB');
 const listB=await rpc(pageB,'session/list',{_request:{}}),sidB=listB.value.items[0].sessionId as string;
 assert.notEqual(sidA,sidB);
 const forgedTarget=await rpc(pageB,'session/list',{_request:{}},'?userId='+users[1]!.id);
 assert.ok(forgedTarget.value.items.every((item:{sessionId:string})=>item.sessionId!==sidA));
 const foreignFile=await rpc(pageB,'workspaceFiles/read',{workspaceFileScopeId:sidA,path:'report.txt',range:{}});
 assert.equal(foreignFile.ok,false);assert.match(foreignFile.error.code,/not-found/);
 const foreignDownload=await pageB.request.get(origin+'/dsh/office/download?'+new URLSearchParams({sessionId:sidA,path:'/tenant/workspace/deepseek-harness/default-workspace/report.txt'}));
 assert.equal(foreignDownload.status(),404);
 assert.equal((await page.request.get(origin+'/dsh/office/download?'+new URLSearchParams({sessionId:sidA,path:'/tenant/dsh-home/state/.credentials.yaml'}))).status(),403);
 assert.equal((await page.request.post(origin+'/dsh/api/settings/mutate',{headers,data:{type:'client-request',rpcId:randomUUID(),method:'settings/mutate',payload:{args:{ns:'llm-deepseek',ops:[{op:'set',path:['baseURL'],value:'https://untrusted.invalid'}],expectedRevision:0}}}})).status(),403);
 assert.equal((await pageB.request.get(origin+'/api/v1/admin/users')).status(),403);
 const bobCookie=await cookie(contextB);
 await new Promise<void>((resolve,reject)=>{
  const ws=new SocketClient(origin.replace('http','ws')+'/dsh/api/remote.mux',{headers:{Cookie:bobCookie,Origin:origin}});
  const timeout=setTimeout(()=>{ws.terminate();reject(Error('Foreign WS history timeout'));},5000);
  ws.on('error',reject);ws.on('open',()=>ws.send(JSON.stringify({type:'open',streamId:'foreign',endpoint:'session/follow',payload:{args:{request:{address:{kind:'session',sessionId:sidA},maxMessages:20,assistantStream:true}}}})));
  ws.on('message',data=>{const text=data.toString();assert.ok(!text.includes('R1_PRIVATE_ALICE')&&!text.includes('R1_REPLY_ALICE'));const f=JSON.parse(text);if(f.type==='error'){try{assert.match(f.error.code,/not-found/);clearTimeout(timeout);ws.close();resolve();}catch(e){reject(e);}}});
 });
 await new Promise<void>((resolve,reject)=>{
  const ws=new SocketClient(origin.replace('http','ws')+'/dsh/api/remote.mux',{headers:{Cookie:bobCookie,Origin:origin}});
  const timeout=setTimeout(()=>{ws.terminate();reject(Error('Forbidden WS endpoint admitted'));},3000);
  ws.on('error',reject);ws.on('open',()=>ws.send(JSON.stringify({type:'open',streamId:'forbidden',endpoint:'settings/mutate',payload:{args:{}}})));
  ws.on('close',()=>{clearTimeout(timeout);resolve();});
 });
 console.log('PASS R1 HTTP/WS session/file ownership and settings/admin restrictions');
 stage='logout revocation';
 const liveA=socketsA.filter(ws=>!ws.isClosed());assert.ok(liveA.length);
 assert.equal((await page.request.post(origin+'/api/v1/auth/logout',{headers})).status(),200);
 await eventually(()=>liveA.every(ws=>ws.isClosed()),'Logout must close existing native sockets');
 assert.equal((await anon.request.get(origin+'/dsh/',{headers:{Cookie:aliceCookie}})).status(),401);
 await rejectedWs(aliceCookie,401);
 assert.ok(socketsB.some(ws=>!ws.isClosed()));
 console.log('PASS R1 logout invalidates HTTP, old cookies and existing WebSockets');
 stage='same-browser account switch and storage isolation';
 await loginUi(page,users[1]!);
 await page.evaluate(()=>localStorage.setItem('r1-private-draft','R1_PRIVATE_DRAFT_ALICE'));
 await page.evaluate(()=>new Promise<void>((resolve,reject)=>{const r=indexedDB.open('r1-secret',1);r.onupgradeneeded=()=>r.result.createObjectStore('private');r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result;const t=db.transaction('private','readwrite');t.objectStore('private').put('R1_PRIVATE_ALICE','draft');t.oncomplete=()=>{db.close();resolve();};};}));
 assert.equal((await page.request.post(origin+'/api/v1/auth/login',{headers,data:{username:'bob',password:users[2]!.next}})).status(),200);
 await page.goto(origin+'/dsh/');await page.getByRole('button',{name:'退出办公室',exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>localStorage.getItem('r1-private-draft')),null);
 const databases=await page.evaluate(()=>indexedDB.databases());assert.ok(!databases.some(db=>db.name?.startsWith('office-native:'+users[1]!.id+':')));
 assert.ok(!(await page.locator('body').innerText()).includes('R1_REPLY_ALICE'));
 const switched=await rpc(page,'session/list',{_request:{}});assert.ok(switched.value.items.every((item:{sessionId:string})=>item.sessionId!==sidA));
 console.log('PASS R1 shared-browser account switch isolates native storage and history');
 stage='admin reset and disable';
 const adminContext=await browser.newContext();
 const loginAdmin=await adminContext.request.post(origin+'/api/v1/auth/login',{headers,data:{username:'admin',password:users[0]!.password}});assert.equal(loginAdmin.status(),200);
 assert.equal((await adminContext.request.post(origin+'/api/v1/auth/change-password',{headers,data:{currentPassword:users[0]!.password,newPassword:users[0]!.next}})).status(),200);
 const contextC=await browser.newContext(),pageC=await contextC.newPage(),socketsC:BrowserSocket[]=[];
 pageC.on('websocket',ws=>socketsC.push(ws));
 await loginUi(pageC,users[1]!);const oldAlice=await cookie(contextC),liveC=socketsC.filter(ws=>!ws.isClosed());
 const reset=temporaryPassword();
 assert.equal((await adminContext.request.patch(origin+'/api/v1/admin/users/'+users[1]!.id,{headers,data:{password:reset}})).status(),200);
 await eventually(()=>liveC.every(ws=>ws.isClosed()),'Password reset must close existing sockets');
 assert.equal((await anon.request.get(origin+'/dsh/',{headers:{Cookie:oldAlice}})).status(),401);
 const resetLogin=await contextC.request.post(origin+'/api/v1/auth/login',{headers,data:{username:'alice',password:reset}});assert.equal(resetLogin.status(),200);assert.equal((await resetLogin.json()).mustChangePassword,true);
 assert.equal((await contextC.request.get(origin+'/dsh/')).status(),403);
 const changedAgain=temporaryPassword();
 assert.equal((await contextC.request.post(origin+'/api/v1/auth/change-password',{headers,data:{currentPassword:reset,newPassword:changedAgain}})).status(),200);
 await pageC.goto(origin+'/dsh/');await pageC.getByRole('button',{name:'退出办公室',exact:true}).waitFor({timeout:75000});
 await pageC.getByText('R1_ALICE',{exact:true}).first().click();await pageC.getByText('R1_REPLY_ALICE',{exact:true}).waitFor();
 await send(pageC,'R1_POSTRESET R1_ALICE','R1_RESET_OK_ALICE');
 const switchedBobCookie=await cookie(context);
 await eventually(()=>connected(bobCookie)&&connected(switchedBobCookie),'Both Bob browser sessions must have live gateway sockets');
 assert.equal((await adminContext.request.patch(origin+'/api/v1/admin/users/'+users[2]!.id,{headers,data:{status:'disabled'}})).status(),200);
 await eventually(()=>!connected(bobCookie)&&!connected(switchedBobCookie),'Disable must close both Bob gateway connections');
 assert.equal((await contextB.request.get(origin+'/dsh/')).status(),401);
 assert.equal((await anon.request.post(origin+'/api/v1/auth/login',{headers,data:{username:'bob',password:users[2]!.next}})).status(),401);
 await send(pageC,'R1_POSTDISABLE R1_ALICE','R1_DISABLE_OK_ALICE');
 console.log('PASS R1 password reset, mandatory change, user disable and unaffected other tenant');
 stage='native logout button';
 await pageC.getByRole('button',{name:'退出办公室',exact:true}).click();await pageC.waitForURL(origin+'/');await pageC.getByLabel('用户名').waitFor();
 assert.equal((await contextC.request.get(origin+'/dsh/')).status(),401);
 console.log('PASS R1 native logout control returns to platform login');
 console.log('PASS R1 native account gateway acceptance (synthetic model, temporary data)');

}catch(error){console.error(JSON.stringify({status:'FAIL',stage,diagnostic:error instanceof Error?error.message.slice(0,1800).replace(/token=[^\s"']+/g,'token=[redacted]'):'Unknown'}));process.exitCode=1;console.log('test diagnostics:',diagnostics.slice(-8));if(debugPage)console.log('test DOM:',(await debugPage.locator('body').innerText().catch(()=>'' )).slice(-2600));}
finally{await browser?.close();await app?.close();rmSync(root,{recursive:true,force:true});}
