export function modelIdentity(label='') {
  const raw=String(label||'').trim();
  const effort=raw.match(/\((low|medium|high|xhigh|extra\s+high|max|minimal|thinking)\)|[-_\s](low|medium|high|xhigh|extra\s+high|max|minimal)$/i);
  const depth=(effort?.[1]||effort?.[2]||'').toLowerCase().replace(/^extra\s+high$/,'xhigh');
  const orch=raw.match(/^orchestrator(?:\s*\(([^)]+)\)|\s+(.+))?$/i);
  if(orch){
    const tail=(orch[1]||orch[2]||'').replace(/\([^)]*\)/g,'').replace(/\s+(low|medium|high|xhigh|extra\s+high|max|minimal|thinking)$/i,'').trim().toLowerCase();
    if(/claude/i.test(tail)){
      const norm=tail.replace(/\s+/g,'-').replace(/(claude-(?:opus|sonnet|haiku)-\d+)\.(\d+)/,'$1-$2');
      return {id:`orchestrator-${norm}`,effort:depth};
    }
    const g4=tail.match(/(?:gemini[\s-]*4[\s-]*)?(neon|carbon|argon|hydrogen)$/);
    const variant=g4?g4[1]:tail.replace(/\s+/g,'-');
    const id=!variant||variant==='carbon'?'gemini-pro-orchestrator':`gemini-pro-orchestrator-${variant}`;
    return {id,effort:depth};
  }
  let id=raw.toLowerCase().replace(/\([^)]*\)/g,'').trim().replace(/\s+/g,'-').replace(/-(low|medium|high|xhigh|extra-high|max|minimal)$/,'');
  id=id.replace(/(claude-(?:opus|sonnet|haiku)-\d+)\.(\d+)/,'$1-$2');
  return {id,effort:depth};
}
export function dateRange(preset,now=Date.now(),custom={}) {
  const end=new Date(now),start=new Date(now);start.setHours(0,0,0,0);
  if(preset==='today')return{start:+start,end:now};
  if(preset==='24h')return{start:now-864e5,end:now};
  if(preset==='yesterday'){const until=+start;start.setDate(start.getDate()-1);return{start:+start,end:until};}
  if(preset==='week')start.setDate(start.getDate()-(start.getDay()+6)%7);
  else if(preset==='month')start.setDate(1);
  else if(preset==='30d')start.setDate(start.getDate()-29);
  else if(preset==='custom'){const a=Date.parse(custom.start+'T00:00:00'),b=new Date(custom.end+'T00:00:00');b.setDate(b.getDate()+1);if(!Number.isFinite(a)||!Number.isFinite(+b))return{start:now-864e5,end:now};if(a<+b)return{start:a,end:+b};const until=new Date(a);until.setDate(until.getDate()+1);return{start:+new Date(custom.end+'T00:00:00'),end:+until};}
  else if(preset==='all')return{start:Number.isFinite(custom.oldestTimestamp)?custom.oldestTimestamp:0,end:now};
  return{start:+start,end:+end};
}
export function summarizeRequests(requests,range,catalog=[]) {
  const selected=requests.filter(r=>Number.isFinite(r.timestampMs)&&r.timestampMs>=range.start&&r.timestampMs<range.end);
  const models=new Map();
  const emptyModel=id=>({id,requests:0,success:0,errors:0,tokens:0,inputTokens:0,cacheReadTokens:0,outputTokens:0,cost:0,priced:0,output:0,duration:0,peakTps:null});
  for(const model of catalog){const {id}=modelIdentity(model.modelId||model.label);if(!models.has(id))models.set(id,emptyModel(id));}
  let tokens=0,inputTokens=0,cacheReadTokens=0,outputTokens=0,cost=0,priced=0,success=0,errors=0;
  const points=Array.from({length:32},()=>({tokens:0,requests:0,cost:0}));
  const width=Math.max(1,range.end-range.start);
  for(const r of selected){
    const {id}=modelIdentity(r.model);if(!models.has(id))models.set(id,emptyModel(id));
    const m=models.get(id),inTok=r.inputTokens||0,cacheTok=r.cacheReadTokens||0,outTok=r.outputTokens||0,count=inTok+cacheTok+outTok;
    m.requests++;m.tokens+=count;m.inputTokens+=inTok;m.cacheReadTokens+=cacheTok;m.outputTokens+=outTok;
    tokens+=count;inputTokens+=inTok;cacheReadTokens+=cacheTok;outputTokens+=outTok;
    if(r.status==='success'){success++;m.success++;}if(r.status==='error'){errors++;m.errors++;}
    if(r.costUsd!=null){cost+=r.costUsd;priced++;m.cost+=r.costUsd;m.priced++;}
    if(r.durationMs>0&&outTok>0){m.output+=outTok;m.duration+=r.durationMs;m.peakTps=Math.max(m.peakTps||0,r.tps??outTok*1000/r.durationMs);}
    const p=points[Math.min(31,Math.max(0,Math.floor((r.timestampMs-range.start)/width*32)))];p.tokens+=count;p.requests++;p.cost+=r.costUsd||0;
  }
  const totalIn=inputTokens+cacheReadTokens;
  const cacheHitPercent=totalIn>0?Number((cacheReadTokens/totalIn*100).toFixed(1)):null;
  return{
    requests:selected,tokens,inputTokens,cacheReadTokens,outputTokens,cacheHitPercent,
    cost:priced?cost:selected.length?null:0,priced,success,errors,points,
    models:[...models.values()].map(m=>{
      const mIn=m.inputTokens+m.cacheReadTokens;
      return{...m,cacheHitPercent:mIn>0?Number((m.cacheReadTokens/mIn*100).toFixed(1)):null,cost:m.priced?m.cost:null,avgTps:m.duration?m.output*1000/m.duration:null};
    }).sort((a,b)=>b.tokens-a.tokens||a.id.localeCompare(b.id))
  };
}

export function annotateCacheAnomalies(requests=[],{maxGapMs=180000,minPrevCache=4000,minPrevHit=50,minCurInput=4000,minMissedInput=16000,minKeepRatio=0.6}={}) {
  const anomalies=new Map();
  if(!Array.isArray(requests)||!requests.length)return anomalies;
  const ordered=requests
    .filter(r=>r&&r.conversationId&&Number.isFinite(r.timestampMs)&&r.status!=='error')
    .slice()
    .sort((a,b)=>a.timestampMs-b.timestampMs||String(a.id||'').localeCompare(String(b.id||'')));
  const cachedModels=new Set();
  for(const r of ordered){if((r.cacheReadTokens||0)>0)cachedModels.add(modelIdentity(r.model).id);}
  const lastByKey=new Map();
  for(const r of ordered){
    const modelId=modelIdentity(r.model).id;
    const key=`${r.conversationId}::${modelId}`;
    const curIn=r.inputTokens||0,curCache=r.cacheReadTokens||0,curTotalIn=curIn+curCache;
    const curHit=curTotalIn>0?Number((curCache/curTotalIn*100).toFixed(1)):null;
    const prev=lastByKey.get(key);
    let anomalous=false;
    if(prev&&curHit!=null&&curTotalIn>=minCurInput&&curTotalIn>=prev.totalIn*minKeepRatio){
      const gapMs=r.timestampMs-prev.timestampMs;
      if(gapMs>=0&&gapMs<=maxGapMs){
        if(prev.cache>=minPrevCache&&prev.hit>=minPrevHit){
          if(curCache===0){
            anomalies.set(r.id,{kind:'cleared',gapMs,prevHit:prev.hit,curHit:0,prevCache:prev.cache,curCache:0,prevTotalIn:prev.totalIn});
            anomalous=true;
          }else if(prev.hit-curHit>=40&&curHit<20&&curCache<prev.cache*0.5){
            anomalies.set(r.id,{kind:'dropped',gapMs,prevHit:prev.hit,curHit,prevCache:prev.cache,curCache,prevTotalIn:prev.totalIn});
            anomalous=true;
          }
        }else if(curCache===0&&cachedModels.has(modelId)&&(prev.anomalous||prev.totalIn>=minMissedInput)){
          anomalies.set(r.id,{kind:'missed',gapMs,prevHit:prev.hit,curHit:0,prevCache:prev.cache,curCache:0,prevTotalIn:prev.totalIn});
          anomalous=true;
        }
      }
    }
    if(curTotalIn>=2000&&curHit!=null){
      lastByKey.set(key,{timestampMs:r.timestampMs,cache:curCache,hit:curHit,totalIn:curTotalIn,anomalous});
    }
  }
  return anomalies;
}

export function subscriptionIdentity(tier={}) {
  const name=tier?.name||'',id=tier?.id||'',values=[name,id,tier?.description||''].join(' ');
  const family=/ultra/i.test(values)?'ultra':/\bpro\b/i.test(values)?'pro':/plus/i.test(values)?'plus':/team|business|enterprise/i.test(values)?'team':/free|standard|default/i.test(values)?'free':'unknown';
  const multiplier=family==='ultra'?(values.match(/(?:\bultra[\s_-]*|\b)(20|5)\s*[x×](?=$|[\W_])/i)?.[1]||null):null;
  return {family,multiplier:multiplier?Number(multiplier):null,style:family==='ultra'&&multiplier?`ultra${multiplier}`:family,label:family==='ultra'&&multiplier?`Google AI Ultra ${multiplier}x`:name||'-',id};
}

export function distributionModels(models,limit=5) {
  const active=models.filter(model=>model.tokens>0||model.cost>0);
  const entries=active.slice(0,limit).map(model=>({id:model.id,tokens:model.tokens,cost:model.cost}));
  const rest=active.slice(limit),priced=rest.filter(model=>Number.isFinite(model.cost));
  if(rest.length)entries.push({id:'__other__',tokens:rest.reduce((sum,model)=>sum+model.tokens,0),cost:priced.length?priced.reduce((sum,model)=>sum+model.cost,0):null});
  return entries;
}
