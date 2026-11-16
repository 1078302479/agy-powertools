import test from 'node:test';import assert from 'node:assert/strict';import {contextSnapshot} from '../lib/context.mjs';
const categories=[{key:'messages',label:'Chat Messages',tokens:293170},{key:'tools',label:'Tools',tokens:7336},{key:'system',label:'System Prompt',tokens:12380,children:[{label:'skills',tokens:3678}]}];
test('provider usage replaces the inflated local estimate from the same generation',()=>{
 const c=contextSnapshot({providerInputTokens:248366,context:{usedTokens:312886,maxTokens:256000,categories}});
 assert.equal(c.usedTokens,248366);assert.equal(c.estimatedUsedTokens,312886);assert.equal(c.usedPercent,97);assert.equal(c.source,'provider-usage');
 assert.equal(c.categories.reduce((n,g)=>n+g.tokens,0),256000);assert.equal(c.categories.filter(g=>g.key!=='free').reduce((n,g)=>n+g.tokens,0),248366);
 assert.ok(c.categories.every(g=>g.percent<=100));assert.ok(c.categories.filter(g=>g.key!=='free').every(g=>g.estimated));
});
test('inconsistent or missing capacity stays unknown instead of displaying a fabricated percentage',()=>{
 const estimated=contextSnapshot({context:{usedTokens:312886,maxTokens:256000,categories}});
 assert.equal(estimated.maxTokens,null);assert.equal(estimated.usedPercent,null);assert.equal(estimated.reportedMaxTokens,256000);
 const mismatch=contextSnapshot({providerInputTokens:300000,context:{usedTokens:312886,maxTokens:256000,categories}});
 assert.equal(mismatch.usedTokens,300000);assert.equal(mismatch.usedPercent,null);
 assert.equal(contextSnapshot({providerInputTokens:100}).usedPercent,null);const zero=contextSnapshot({providerInputTokens:100,context:{maxTokens:1000,categories:[{tokens:0}]}});assert.equal(zero.categories[0].tokens,100);assert.equal(zero.categories[0].estimated,false);
 const fallback=contextSnapshot(null,1000);assert.equal(fallback.usedTokens,1000);assert.equal(fallback.source,'transcript');
});
