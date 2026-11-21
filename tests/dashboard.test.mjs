import test from 'node:test';
import assert from 'node:assert/strict';
import { annotateCacheAnomalies, dateRange,modelIdentity,summarizeRequests,subscriptionIdentity,distributionModels } from '../lib/dashboard.mjs';
test('calendar ranges use local midnight and a Monday week boundary',()=>{
 const now=+new Date(2026,10,13,12,30),midnight=+new Date(2026,10,13);
 assert.deepEqual(dateRange('today',now),{start:midnight,end:now});
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
 assert.deepEqual(modelIdentity('Orchestrator (Neon)'),{id:'gemini-pro-orchestrator-neon',effort:''});
 assert.deepEqual(modelIdentity('Orchestrator (Carbon)'),{id:'gemini-pro-orchestrator',effort:''});
 assert.deepEqual(modelIdentity('Orchestrator (Argon)'),{id:'gemini-pro-orchestrator-argon',effort:''});
 assert.deepEqual(modelIdentity('Orchestrator Gemini 4 Neon Extra High'),{id:'gemini-pro-orchestrator-neon',effort:'xhigh'});
 assert.deepEqual(modelIdentity('Orchestrator (Claude Opus 5.5)'),{id:'orchestrator-claude-opus-5-5',effort:''});
 assert.deepEqual(modelIdentity('Orchestrator Claude Opus 5.5 (Medium)'),{id:'orchestrator-claude-opus-5-5',effort:'medium'});
 assert.deepEqual(modelIdentity('Claude Opus 5.5 (Orchestrator)'),{id:'claude-opus-5-5',effort:''});
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

test('summarizeRequests computes overall and per-model cache hit rates and annotateCacheAnomalies avoids false positives',()=>{
  const base=1_700_000_000_000;
  const reqs=[
    // First cold request -> NOT an anomaly
    {id:'r1',conversationId:'c1',model:'Gemini 4 Neon (High)',timestampMs:base,inputTokens:20000,cacheReadTokens:0,outputTokens:500,status:'success',costUsd:0.1},
    // Warm cached request 30s later (90% hit) -> NOT an anomaly
    {id:'r2',conversationId:'c1',model:'Gemini 4 Neon (High)',timestampMs:base+30_000,inputTokens:2000,cacheReadTokens:18000,outputTokens:400,status:'success',costUsd:0.02},
    // Sudden full cache wipeout 45s later -> CLEARED anomaly
    {id:'r3',conversationId:'c1',model:'Gemini 4 Neon (High)',timestampMs:base+75_000,inputTokens:22000,cacheReadTokens:0,outputTokens:500,status:'success',costUsd:0.12},
    // Consecutive 0% miss 20s after wipeout -> MISSED anomaly
    {id:'r3b',conversationId:'c1',model:'Gemini 4 Neon (High)',timestampMs:base+95_000,inputTokens:24000,cacheReadTokens:0,outputTokens:400,status:'success',costUsd:0.13},
    // Re-warmed cache 20s later (92% hit)
    {id:'r4',conversationId:'c1',model:'Gemini 4 Neon (High)',timestampMs:base+115_000,inputTokens:2000,cacheReadTokens:23000,outputTokens:300,status:'success',costUsd:0.02},
    // Large new file pasted (cacheRead still 22000 >= 50% of 23000) -> dilution, NOT anomaly
    {id:'r5',conversationId:'c1',model:'Gemini 4 Neon (High)',timestampMs:base+140_000,inputTokens:150000,cacheReadTokens:22000,outputTokens:300,status:'success',costUsd:0.5},
    // Warm again then cliff drop 50s later (cacheRead dropped from 150000 to 5000, hit 3.2%) -> DROPPED anomaly
    {id:'r6',conversationId:'c1',model:'Gemini 4 Neon (High)',timestampMs:base+170_000,inputTokens:5000,cacheReadTokens:150000,outputTokens:300,status:'success',costUsd:0.05},
    {id:'r7',conversationId:'c1',model:'Gemini 4 Neon (High)',timestampMs:base+220_000,inputTokens:150000,cacheReadTokens:5000,outputTokens:300,status:'success',costUsd:0.5},
    // Context compaction / rewind (155k -> 15k) 40s later -> NOT an anomaly
    {id:'r7b',conversationId:'c1',model:'Gemini 4 Neon (High)',timestampMs:base+260_000,inputTokens:15000,cacheReadTokens:0,outputTokens:200,status:'success',costUsd:0.05},
    // Non-caching model consecutive 0% misses -> NOT an anomaly (model has never returned cacheRead > 0)
    {id:'r8',conversationId:'c1',model:'Gemini 4 Hydrogen (High)',timestampMs:base+180_000,inputTokens:20000,cacheReadTokens:0,outputTokens:200,status:'success',costUsd:0.01},
    {id:'r8b',conversationId:'c1',model:'Gemini 4 Hydrogen (High)',timestampMs:base+210_000,inputTokens:22000,cacheReadTokens:0,outputTokens:200,status:'success',costUsd:0.01},
    // Same cache-capable model after > 5 min TTL expiry -> cold start NOT anomaly, but 30s follow-up 0% IS MISSED
    {id:'r9',conversationId:'c1',model:'Gemini 4 Neon (High)',timestampMs:base+260_000+400_000,inputTokens:160000,cacheReadTokens:0,outputTokens:300,status:'success',costUsd:0.5},
    {id:'r10',conversationId:'c1',model:'Gemini 4 Neon (High)',timestampMs:base+260_000+430_000,inputTokens:165000,cacheReadTokens:0,outputTokens:300,status:'success',costUsd:0.5}
  ];
  const summary=summarizeRequests(reqs,{start:base-1000,end:base+1_000_000});
  assert.equal(summary.cacheReadTokens,218000);
  assert.equal(summary.inputTokens,757000);
  assert.equal(summary.cacheHitPercent,22.4);
  const neon=summary.models.find(m=>m.id==='gemini-4-neon');
  assert.equal(neon.cacheReadTokens,218000);
  assert.equal(neon.cacheHitPercent,23.4);
  const hydrogen=summary.models.find(m=>m.id==='gemini-4-hydrogen');
  assert.equal(hydrogen.cacheHitPercent,0);

  const anomalies=annotateCacheAnomalies(reqs);
  assert.equal(anomalies.size,4);
  assert.equal(anomalies.get('r3')?.kind,'cleared');
  assert.equal(anomalies.get('r3')?.gapMs,45000);
  assert.equal(anomalies.get('r3b')?.kind,'missed');
  assert.equal(anomalies.get('r7')?.kind,'dropped');
  assert.equal(anomalies.get('r10')?.kind,'missed');
  assert.equal(anomalies.has('r1'),false);
  assert.equal(anomalies.has('r5'),false);
  assert.equal(anomalies.has('r7b'),false);
  assert.equal(anomalies.has('r8'),false);
  assert.equal(anomalies.has('r8b'),false);
  assert.equal(anomalies.has('r9'),false);
});
