import test from'node:test';import assert from'node:assert/strict';import{readFileSync}from'node:fs';import vm from'node:vm';
function render(status,tasks=[]){
 const R={createElement:(type,props,...children)=>({type,props:props||{},children}),useSyncExternalStore:(_,snapshot)=>snapshot()};
 const context=vm.createContext({React:R,dq:'icon',document:{createElement:()=>({dataset:{},remove(){}}),head:{append(){}}}});
 vm.runInContext(readFileSync(new URL('../lib/native-panels.js',import.meta.url),'utf8'),context);
 const panels=context.__agyPanels({t:v=>v,options:()=>({progress:true,language:'en'}),state:()=>({conversationId:'test',progress:{status,tasks}}),subscribe:()=>()=>{},revision:()=>0});
 function text(node){if(typeof node==='string')return node;if(Array.isArray(node))return node.map(text).join(' ');return node&&typeof node==='object'?text(node.children):'';}
 return text(panels.Progress());
}
test('progress distinguishes active, failed, stopped and stopping states even when a checklist is complete',()=>{
 const done=[{title:'Example task',status:'complete'}];
 assert.ok(render('running',done).includes('进行中'));assert.ok(render('error',done).includes('错误'));
 assert.ok(render('stopped',done).includes('Stopped'));assert.ok(!render('stopped',done).includes('已完成'));
 assert.ok(render('canceling').includes('Stopping task'));assert.ok(render('stopped').includes('This turn stopped'));
});
