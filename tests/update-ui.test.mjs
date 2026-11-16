import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

function surface(release){
  const states=[],effects=[],calls=[];let index=0,status={status:'idle'};
  const React={createElement:(type,props,...children)=>({type,props:props||{},children}),Fragment:'fragment',useState:initial=>{const n=index++;if(!(n in states))states[n]=initial;return[states[n],value=>{states[n]=value;}];},useEffect:effect=>effects.push(effect)};
  const context=vm.createContext({React,document:{createElement:()=>({dataset:{},remove(){}}),head:{append(){}}},URL,setInterval:()=>1,clearInterval(){},UP:'row',TP:'card',VP:'section',Uy:'button',k0:'disclosure'});
  vm.runInContext(readFileSync(new URL('../lib/native-panels.js',import.meta.url),'utf8'),context);
  const panels=context.__agyPanels({version:'2.12.0',project:{name:'Agy Powertools'},t:value=>value,options:()=>({language:'en'}),request:async(method,payload)=>{calls.push({method,payload});if(method==='update.check')return release;if(method==='update.install')return{status:'preparing',version:release.version};return status;}});
  const render=()=>{index=0;return panels.About();};
  function find(node,id){if(!node||typeof node!=='object')return null;if(node.props?.['data-testid']===id)return node;for(const value of [...node.children||[],node.props?.rightElement]){const values=Array.isArray(value)?value:[value];for(const item of values){const found=find(item,id);if(found)return found;}}return null;}
  return{calls,render,find,effects,setStatus:value=>{status=value;}};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('About installs only the selected verified release and displays progress and rollback results',async()=>{
  const ui=surface({status:'available',version:'2.13.0',canInstall:true,releaseUrl:'https://github.com/test/project/releases/tag/v2.13.0'});
  ui.find(ui.render(),'agy-check-update').props.onClick();await tick();let tree=ui.render();assert.ok(ui.find(tree,'agy-install-update'));
  ui.find(tree,'agy-install-update').props.onClick();await tick();tree=ui.render();assert.equal(ui.find(tree,'agy-install-update').props.disabled,true);
  assert.deepEqual(ui.calls.find(call=>call.method==='update.install').payload.version,'2.13.0');assert.ok(ui.find(tree,'agy-install-status').children.includes('Preparing update…'));
  ui.setStatus({status:'rolled-back'});ui.effects[0]();await tick();tree=ui.render();assert.equal(ui.find(tree,'agy-install-status').children[0],'Update failed. Previous version restored.');
  ui.setStatus({status:'completed'});ui.effects[0]();await tick();assert.equal(ui.find(ui.render(),'agy-install-status').children[0],'Update installed');
});

test('releases without an installable package expose the download page without an install button',async()=>{
  const ui=surface({status:'available',version:'2.13.0',canInstall:false,releaseUrl:'https://github.com/test/project/releases/tag/v2.13.0'});
  ui.find(ui.render(),'agy-check-update').props.onClick();await tick();const tree=ui.render();assert.equal(ui.find(tree,'agy-install-update'),null);assert.ok(ui.find(tree,'agy-update-download'));assert.equal(ui.calls.some(call=>call.method==='update.install'),false);
});
