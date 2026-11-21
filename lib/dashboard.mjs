export function modelIdentity(label='') {
  const raw=String(label||'').trim();
  const orch=raw.match(/^orchestrator(?:\s*\(([^)]+)\))?$/i);
  if(orch){
    const variant=(orch[1]||'').trim().toLowerCase();
    const id=!variant||variant==='carbon'?'gemini-pro-orchestrator':`gemini-pro-orchestrator-${variant.replace(/\s+/g,'-')}`;
    return {id,effort:''};
  }
  const effort=raw.match(/\((low|medium|high|xhigh|max|minimal|thinking)\)|[-_](low|medium|high|xhigh|max|minimal)$/i);
  const depth=(effort?.[1]||effort?.[2]||'').toLowerCase();
  let id=raw.toLowerCase().replace(/\([^)]*\)/g,'').trim().replace(/\s+/g,'-').replace(/-(low|medium|high|xhigh|max|minimal)$/,'');
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
  for(const model of catalog){const {id}=modelIdentity(model.modelId||model.label);if(!models.has(id))models.set(id,{id,requests:0,success:0,errors:0,tokens:0,cost:0,priced:0,output:0,duration:0,peakTps:null});}
  let tokens=0,cost=0,priced=0,success=0,errors=0;
  const points=Array.from({length:32},()=>({tokens:0,requests:0,cost:0}));
  const width=Math.max(1,range.end-range.start);
  for(const r of selected){
    const {id}=modelIdentity(r.model);if(!models.has(id))models.set(id,{id,requests:0,success:0,errors:0,tokens:0,cost:0,priced:0,output:0,duration:0,peakTps:null});
    const m=models.get(id),count=(r.inputTokens||0)+(r.cacheReadTokens||0)+(r.outputTokens||0);m.requests++;m.tokens+=count;tokens+=count;
    if(r.status==='success'){success++;m.success++;}if(r.status==='error'){errors++;m.errors++;}
    if(r.costUsd!=null){cost+=r.costUsd;priced++;m.cost+=r.costUsd;m.priced++;}
    if(r.durationMs>0&&r.outputTokens>0){m.output+=r.outputTokens;m.duration+=r.durationMs;m.peakTps=Math.max(m.peakTps||0,r.tps??r.outputTokens*1000/r.durationMs);}
    const p=points[Math.min(31,Math.max(0,Math.floor((r.timestampMs-range.start)/width*32)))];p.tokens+=count;p.requests++;p.cost+=r.costUsd||0;
  }
  return{requests:selected,tokens,cost:priced?cost:selected.length?null:0,priced,success,errors,points,models:[...models.values()].map(m=>({...m,cost:m.priced?m.cost:null,avgTps:m.duration?m.output*1000/m.duration:null})).sort((a,b)=>b.tokens-a.tokens||a.id.localeCompare(b.id))};
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
