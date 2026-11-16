import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { estimateCost } from './pricing.mjs';
export function createQuotaTracker(directory) {
  const path=join(directory,'quota-samples.json');
  let samples=[];try{samples=JSON.parse(readFileSync(path,'utf8'));}catch{}
  return {observe(groups,requests,rates,now=Date.now()){
    if(!Array.isArray(groups)||groups.length>10)throw Error('额度数据无效');
    const result=[];
    for(const group of groups)for(const bucket of group.buckets||[]){
      const fraction=bucket.remainingFraction;
      if(typeof fraction!=='number'||fraction<0||fraction>1||typeof bucket.bucketId!=='string')continue;
      const first=samples.find(s=>s.id===bucket.bucketId&&s.resetTimeMs===bucket.resetTimeMs&&s.fraction>=fraction);
      const sample={id:bucket.bucketId,resetTimeMs:bucket.resetTimeMs,fraction,at:now};
      if(!first)samples.push(sample);
      let estimateUsd=null,estimateTokens=null,observedCost=0,observedTokens=0,count=0;
      if(first){
        const delta=first.fraction-fraction;
        for(const request of requests){
          const gemini=/gemini/i.test(request.model),isGemini=/gemini/i.test(bucket.bucketId);
          if(gemini!==isGemini||request.timestampMs<=first.at||request.timestampMs>now)continue;
          const cost=estimateCost(request,rates);if(cost==null)continue;observedCost+=cost;observedTokens+=(request.inputTokens||0)+(request.cacheReadTokens||0)+(request.outputTokens||0);count++;
        }
        if(delta>=.01&&count>=3&&observedCost>0){estimateUsd=observedCost/delta;estimateTokens=observedTokens/delta;}
      }
      result.push({bucketId:bucket.bucketId,estimateUsd,estimateTokens,remainingTokens:estimateTokens==null?null:estimateTokens*fraction,remainingUsd:estimateUsd==null?null:estimateUsd*fraction,confidence:estimateUsd==null?'unknown':'low',observedRequests:count,observedCostUsd:observedCost});
    }
    samples=samples.filter(s=>!s.resetTimeMs||s.resetTimeMs>now).slice(-100);
    mkdirSync(directory,{recursive:true});writeFileSync(path,JSON.stringify(samples,null,2));return{estimates:result};
  }};
}
