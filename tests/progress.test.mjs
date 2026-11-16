import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readProgress,resolveTurnExecution} from '../lib/progress.mjs';

test('native execution outranks request errors and intermediate text, with conversation and turn guards',()=>{
  const turn={stepIndexStart:10,status:'error',completedAtMs:2000},execution={conversationId:'current',turnStartStepIndex:10,status:2,terminationReason:1};
  for(const status of [2,4]){
    const resolved=resolveTurnExecution(turn,{...execution,status},'current');
    assert.equal(resolved.status,'running');assert.equal(resolved.completedAtMs,null);
  }
  assert.equal(resolveTurnExecution({...turn,status:'complete'},execution,'current').status,'running');
  assert.equal(resolveTurnExecution(turn,{...execution,status:3},'current').status,'canceling');
  assert.equal(resolveTurnExecution(turn,{...execution,status:1,terminationReason:1},'current').status,'error');
  assert.equal(resolveTurnExecution(turn,{...execution,status:1,terminationReason:2},'current').status,'stopped');
  assert.equal(resolveTurnExecution(turn,{...execution,status:1,terminationReason:4},'current').status,'complete');
  assert.equal(resolveTurnExecution(turn,{...execution,conversationId:'other'},'current'),turn);
  assert.equal(resolveTurnExecution(turn,{...execution,turnStartStepIndex:0},'current'),turn);
  assert.equal(resolveTurnExecution(turn,{...execution,status:0},'current'),turn);
  assert.equal(resolveTurnExecution(turn,null,'current'),turn);assert.equal(turn.status,'error');
});

test('progress isolates the current turn and does not call untimed tools running or completed',()=>{
  const dir=mkdtempSync(join(tmpdir(),'agy-progress-'));
  try{
    const latest={stepIndexStart:10,status:'running',startedAtMs:1000,toolCalls:[
      {id:'finished',itemLabel:'Read file',startedAtIso:new Date(1000).toISOString(),completedAtIso:new Date(2000).toISOString(),durationMs:1000},
      {id:'active',itemLabel:'Run build',startedAtIso:new Date(3000).toISOString(),completedAtIso:null},
      {id:'unknown',itemLabel:'Untimed',startedAtIso:null,completedAtIso:null}
    ]};
    const steps=[{step_index:2,tool_calls:[{name:'task_boundary',args:{TaskName:'Previous task',TaskStatus:'Previous step'}}]}];
    const p=readProgress(dir,'test',[latest],steps,6000);
    assert.equal(p.title,'');assert.equal(p.current,'Run build');assert.equal(p.elapsedMs,5000);
    assert.deepEqual(p.recentActivity.map(a=>a.status),['complete','running','recorded']);
    const complete=readProgress(dir,'test',[{...latest,status:'complete',completedAtMs:4500}],steps,9000);
    assert.equal(complete.elapsedMs,3500);assert.equal(complete.current,'');
    assert.deepEqual(complete.recentActivity.map(a=>a.status),['complete','recorded','recorded']);
    assert.equal(readProgress(dir,'test',[],steps).elapsedMs,null);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
