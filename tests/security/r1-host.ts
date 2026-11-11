import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { OfficeError } from '../../apps/api/src/errors.ts';
import { createApp } from '../../apps/api/src/app.ts';
import { Store } from '../../apps/api/src/store.ts';
import { hashPassword, temporaryPassword } from '../../apps/api/src/security.ts';
const root=mkdtempSync(join(tmpdir(),'office-r1-host-')),dataRoot=join(root,'data');
const image=execFileSync('docker',['--context','desktop-linux','image','inspect','--format={{.Id}}','ai-office-2-dsh-web:r2-0.2.2-rc.1'],{encoding:'utf8'}).trim();
const origin='https://office-r1.invalid',host='office-r1.invalid',password=temporaryPassword();
let app:Awaited<ReturnType<typeof createApp>>|undefined;
try{
 const store=new Store(dataRoot);store.createUser({username:'host-test',displayName:'Host test',passwordHash:await hashPassword(password)},'USER');store.close();
 app=await createApp({dataRoot,origin,nativeWeb:{image,onError:error=>{if(!(error instanceof OfficeError))console.error(String(error).replace(/token=[^\s"']+/g,'token=[redacted]'));},model:async()=>{throw Error('No model request expected');}}});
 const login=await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{host,origin},payload:{username:'host-test',password}});
 assert.equal(login.statusCode,200);assert.match(String(login.headers['set-cookie']),/; Secure/);
 const old=String(login.headers['set-cookie']).split(';')[0]!;
 const change=await app.inject({method:'POST',url:'/api/v1/auth/change-password',headers:{host,origin,cookie:old},payload:{currentPassword:password,newPassword:temporaryPassword()}});
 assert.equal(change.statusCode,200);const cookie=String(change.headers['set-cookie']).split(';')[0]!;
 const native=await app.inject({url:'/dsh/',headers:{host,origin,cookie}});
 assert.equal(native.statusCode,200);assert.ok(native.body.includes('DeepSeek Harness'));
 assert.equal(native.headers['set-cookie'],undefined);
 assert.match(String(native.headers['content-security-policy']),/wss:\/\/office-r1.invalid/);
 assert.match(String(native.headers['cache-control']),/no-store/);
 assert.equal((await app.inject({url:'/dsh/',headers:{host:'other.invalid',origin,cookie}})).statusCode,403);
 assert.equal((await app.inject({method:'POST',url:'/dsh/api/session/list',headers:{host,cookie},payload:{}})).statusCode,403);
 assert.equal((await app.inject({url:'/dsh/office/download?sessionId=test&path=%2Ftenant%2Fworkspace%2F..%2Fdsh-home%2Fprivate',headers:{host,origin,cookie}})).statusCode,403);
 console.log('PASS R1 external HTTPS authority, Secure platform cookie, private native credential and Host/CSRF/path checks (injection, no live TLS)');
 await app.listen({host:'127.0.0.1',port:0});const address=app.server.address();assert.ok(address&&typeof address==='object');
 let closed=false;
 const upload=httpRequest({host:'127.0.0.1',port:address.port,method:'POST',path:'/dsh/api/session/uploadFileBinary?sessionId=test&name=slow.txt',
  headers:{Host:host,Origin:origin,Cookie:cookie,'Content-Type':'application/octet-stream','Content-Length':String(1024*1024)}});
 upload.on('error',()=>{closed=true;});upload.on('close',()=>{closed=true;});
 upload.write(Buffer.alloc(8));await delay(100);assert.equal(closed,false);
 const logout=await app.inject({method:'POST',url:'/api/v1/auth/logout',headers:{host,origin,cookie}});assert.equal(logout.statusCode,200);
 for(let i=0;i<80&&!closed;i++)await delay(25);
 upload.destroy();assert.ok(closed,'Logout must terminate an upload before its body completes');
 console.log('PASS R1 logout immediately terminates an in-progress HTTP upload');

}finally{await app?.close();rmSync(root,{recursive:true,force:true});}
