import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startNativeIntegration,declaredNativeNames} from '../lib/native-host.mjs';

test('same window reattaches after an updater changes the origin or debug endpoint',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'agy-recovery-')),portFile=join(directory,'port');
  writeFileSync(portFile,'12345\n');
  const originalFetch=globalThis.fetch,clients=[],origins=[];
  let target={id:'same-window',type:'page',title:'Conversation - Antigravity',url:'https://127.0.0.1:5000/c/a',webSocketDebuggerUrl:'ws://127.0.0.1:12345/devtools/page/a'};
  globalThis.fetch=async()=>({json:async()=>[target]});
  let stop;
  try{
    stop=startNativeIntegration({portFile,parseSessionData:()=>({}),onStatus:()=>{},discover:async origin=>{origins.push(origin);return ['sampleNativeName'];},connect:async endpoint=>{
      const client={endpoint,closed:false,calls:[],onEvent(){},socket:{addEventListener(){},close(){client.closed=true;}},async send(method,params){this.calls.push({method,params});if(method==='Page.getFrameTree')return{frameTree:{frame:{id:'frame'}}};if(method==='Page.addScriptToEvaluateOnNewDocument')return{identifier:'script'};return{result:{value:false}};}};
      clients.push(client);return client;
    }});
    await stop.ready;
    assert.equal(clients.length,1);
    target={...target,url:'https://127.0.0.1:6000/c/a'};
    await stop.check();
    assert.equal(clients.length,2);assert.equal(clients[0].closed,true);
    assert.deepEqual(origins,['https://127.0.0.1:5000','https://127.0.0.1:6000']);
    target={...target,webSocketDebuggerUrl:'ws://127.0.0.1:12345/devtools/page/b'};
    await stop.check();
    assert.equal(clients.length,3);assert.equal(clients[1].closed,true);
    for(const client of clients)assert.ok(client.calls.some(c=>c.method==='Page.addScriptToEvaluateOnNewDocument'));
  }finally{await stop?.();globalThis.fetch=originalFetch;rmSync(directory,{recursive:true,force:true});}
});

test('component discovery includes lexical declarations without executing bundle text',()=>{
  const source='var Alpha=1;const Beta=2,Gamma=3;let Delta=4;globalThis.sideEffect();';
  assert.deepEqual(declaredNativeNames(source),['Alpha','Beta','Gamma','Delta']);
});
