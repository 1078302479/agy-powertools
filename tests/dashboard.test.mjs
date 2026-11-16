import test from 'node:test';
import assert from 'node:assert/strict';
import { dateRange,modelIdentity,summarizeRequests,subscriptionIdentity,distributionModels } from '../lib/dashboard.mjs';
test('calendar ranges use local midnight and a Monday week boundary',()=>{
 const now=+new Date(2026,10,13,12,30),midnight=+new Date(2026,10,13);
 assert.deepEqual(dateRange('yesterday',now),{start:+new Date(2026,10,12),end:midnight});
 assert.equal(dateRange('week',now).start,+new Date(2026,10,9));
 assert.equal(dateRange('month',now).start,+new Date(2026,10,1));
 assert.deepEqual(dateRange('custom',now,{start:'2026-11-10',end:'2026-11-12'}),{start:+new Date(2026,10,10),end:midnight});
 assert.equal(dateRange('24h',now).end-dateRange('24h',now).start,86400000);
});

test('paired distribution groups share model order and preserve unknown expenses',()=>{
  assert.deepEqual(distributionModels([]),[]);
  const models=Array.from({length:7},(_,i)=>({id:'model-'+i,tokens:100-i,cost:i===5?null:i/10}));
  const entries=distributionModels(models);assert.equal(entries.length,6);assert.equal(entries[5].id,'__other__');
  assert.equal(entries.reduce((sum,m)=>sum+m.tokens,0),models.reduce((sum,m)=>sum+m.tokens,0));
  assert.equal(entries[5].cost,.6);assert.equal(distributionModels([{id:'unknown',tokens:10,cost:null}])[0].cost,null);
});
test('model effort variants aggregate with catalog entries and preserve unpriced costs',()=>{
 assert.deepEqual(modelIdentity('Gemini 4 Hydrogen (XHigh)'),{id:'gemini-4-hydrogen',effort:'xhigh'});
 assert.deepEqual(modelIdentity('claude-opus-5-5-high'),{id:'claude-opus-5-5',effort:'high'});
 const summary=summarizeRequests([
 {model:'Gemini 4 Hydrogen (High)',timestampMs:1000,inputTokens:100,cacheReadTokens:20,outputTokens:100,durationMs:1000,tps:100,costUsd:.2,status:'success'},
 {model:'gemini-4-hydrogen-low',timestampMs:2000,inputTokens:100,outputTokens:300,durationMs:6000,tps:50,costUsd:.3,status:'success'},
 {model:'unknown',timestampMs:3000,inputTokens:1,status:'error',costUsd:null},
 {model:'excluded',timestampMs:4000,inputTokens:9999,costUsd:10},
 ],{start:1000,end:4000},[{modelId:'gemini-4-hydrogen-medium'},{modelId:'zero-usage'}]);
 assert.equal(summary.requests.length,3);assert.equal(summary.tokens,621);assert.equal(summary.cost,.5);
 const model=summary.models.find(m=>m.id==='gemini-4-hydrogen');assert.equal(model.requests,2);assert.equal(model.peakTps,100);assert.ok(Math.abs(model.avgTps-400000/7000)<1e-9);
 assert.equal(summary.models.find(m=>m.id==='unknown').cost,null);assert.equal(summary.models.find(m=>m.id==='zero-usage').requests,0);
 assert.equal(summary.points.reduce((sum,p)=>sum+p.requests,0),3);
 assert.equal(summarizeRequests([{model:'x',timestampMs:1,inputTokens:1}],{start:0,end:2}).cost,null);
});

test('membership style uses explicit native tier identity and never guesses Ultra multipliers',()=>{
 assert.deepEqual(subscriptionIdentity({name:'Google AI Ultra',id:'g1-ultra-tier'}),{family:'ultra',multiplier:null,style:'ultra',label:'Google AI Ultra',id:'g1-ultra-tier'});
 assert.equal(subscriptionIdentity({name:'Google AI Pro'}).family,'pro');
 assert.equal(subscriptionIdentity({name:'Google AI Ultra 5x'}).style,'ultra5');
 assert.equal(subscriptionIdentity({id:'g1-ultra-20x-tier'}).label,'Google AI Ultra 20x');
 assert.equal(subscriptionIdentity({name:'Google AI Ultra',description:'20 TB storage'}).multiplier,null);
 assert.equal(subscriptionIdentity({name:'Google AI Ultra (20x)'}).multiplier,20);assert.equal(subscriptionIdentity({}).family,'unknown');
});

test('empty custom dates do not start at the Unix epoch and reversed dates are inclusive',()=>{
 const now=+new Date(2026,10,13,12);
 assert.deepEqual(dateRange('custom',now),{start:now-86400000,end:now});
 assert.deepEqual(dateRange('custom',now,{start:'2026-11-13',end:'2026-11-10'}),{start:+new Date(2026,10,10),end:+new Date(2026,10,14)});
 assert.equal(dateRange('all',now,{oldestTimestamp:1000}).start,1000);
});
