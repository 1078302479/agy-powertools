import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseChecklist } from '../lib/progress.mjs';
import { estimateCost, parseOfficialPricing } from '../lib/pricing.mjs';
import { createQuotaTracker } from '../lib/quota.mjs';
import { requestEvents } from '../lib/analytics.mjs';
test('buffered provider responses use whole-request timing instead of a millisecond streaming tail',()=>{
 const events=requestEvents({generations:[{requestId:'same-id',stepIndices:[8],modelName:'model',inputTokens:100,cacheReadTokens:0,outputTokens:1000,thinkingTokens:800,responseTokens:200,ttftMs:9990,streamingMs:10}],times:new Map([[8,{createdMs:1000}]])},'source');
 assert.equal(events[0].tps,100);assert.equal(events[0].durationMs,10000);assert.equal(events[0].timestampMs,1000);assert.equal(events[0].id,'same-id');
});
test('progress counts leaf tasks without counting headings twice',()=>{
 const tasks=parseChecklist('- [ ] Parent\n  - [x] First\n  - [/] Active\n- [ ] Later');
 assert.deepEqual(tasks,[{title:'First',status:'complete'},{title:'Active',status:'running'},{title:'Later',status:'pending'}]);
 assert.deepEqual(parseChecklist('No plan recorded'),[]);
});
test('official price parsing selects standard rates and applies dated prices without pricing unknown models',()=>{
 const rates=parseOfficialPricing('## Gemini 4 Argon {% id="gemini-4-argon" %}\n{% tab title="Standard" %}\n* Input price\n* Not available\n* $2.00 through November 30, 2026.\n$4.00 starting December 1, 2026.\n---\n* Output price (including thinking tokens)\n* Not available\n* $10.00\n$20.00 starting December 1, 2026.\n---\n* Context caching price\n* Not available\n* $0.10\n$0.20 starting December 1, 2026.\n---\n{% /tab %}\n{% tab title="Batch" %}\n* Input price\n* $1.00');
 assert.equal(rates.length,1);const request={model:'Gemini 4 Argon (High)',inputTokens:1e6,cacheReadTokens:1e6,outputTokens:1e6,timestampMs:Date.parse('2026-11-11')};
 assert.equal(estimateCost(request,rates),12.1);assert.equal(estimateCost({...request,timestampMs:Date.parse('2026-12-02')},rates),24.2);
 assert.equal(estimateCost({...request,model:'unpriced-model'},rates),null);
});
test('quota estimates require quota consumption and local priced requests in the same reset window',()=>{
 const dir=mkdtempSync(join(tmpdir(),'agy-quota-'));try{
 const tracker=createQuotaTracker(dir),rates=[{model:'gemini-4-argon',input:2,cache:.1,output:10}];
 const groups=fraction=>[{buckets:[{bucketId:'gemini-5h',remainingFraction:fraction,resetTimeMs:100000}]}];
 assert.equal(tracker.observe(groups(1),[],rates,1000).estimates[0].estimateUsd,null);
 const requests=[2000,3000,4000].map(timestampMs=>({model:'Gemini 4 Argon',timestampMs,inputTokens:10000,cacheReadTokens:0,outputTokens:0}));
 const result=tracker.observe(groups(.98),requests,rates,5000).estimates[0];assert.ok(Math.abs(result.estimateUsd-3)<1e-9);assert.equal(result.confidence,'low');assert.ok(Math.abs(result.estimateTokens-1500000)<1e-6);assert.ok(Math.abs(result.remainingTokens-1470000)<1e-6);
 assert.equal(tracker.observe([{buckets:[{bucketId:'gemini-5h',remainingFraction:.97,resetTimeMs:200000}]}],requests,rates,6000).estimates[0].estimateUsd,null);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('request cache hit rate counts cached tokens within total input, not output',()=>{
 const events=requestEvents({generations:[{stepIndices:[],modelName:'Gemini',inputTokens:25,cacheReadTokens:75,outputTokens:1000},{stepIndices:[],modelName:'Gemini',inputTokens:0,cacheReadTokens:0,outputTokens:0}],times:new Map()},'source');
 assert.equal(events[0].cacheHitPercent,75);assert.equal(events[1].cacheHitPercent,null);
});
