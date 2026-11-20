import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const SOURCE = 'https://aistudio.google.com/docs/pricing';
const verifiedAt = '2026-11-19';
// Official Standard API prices, USD per million tokens. Output includes thinking.
const baseline = [
  { model: 'gemini-4-carbon', input:2, cache:.1, output:10, until:'2026-12-01', next:{input:4,cache:.2,output:20} },
  { model: 'gemini-4-argon', input:2, cache:.1, output:10, until:'2026-12-01', next:{input:4,cache:.2,output:20} },
  { model: 'gemini-4-neon', input:3, cache:.15, output:15 },
  { model: 'gemini-4-hydrogen', input:1.5, cache:.075, output:7.5 }
].map(r=>({...r,source:SOURCE,verifiedAt}));
const PARTNER_SOURCE='https://cloud.google.com/model-garden/partner-models/pricing';
const partnerBaseline=[{model:'claude-opus-5-5',input:4,output:20,cache:.2,cacheWrite:5,cacheWriteTtl:'5m'},{model:'claude-sonnet-5-5',input:2,output:10,cache:.1,cacheWrite:2.5,cacheWriteTtl:'5m'}].map(r=>({...r,source:PARTNER_SOURCE,verifiedAt}));
export function modelKey(label) { return String(label||'').toLowerCase().replace(/\([^)]*\)/g,'').trim().replace(/\s+/g,'-').replace(/(claude-(?:opus|sonnet|haiku)-\d+)\.(\d+)/,'$1-$2'); }
function pricingKey(request) {
  const raw = String(request?.model || '').trim();
  if (/orchestrator/i.test(raw)) {
    if (request?.role === 'execution') return 'gemini-4-hydrogen';
    if (/neon/i.test(raw)) return 'gemini-4-neon';
    if (/argon/i.test(raw)) return 'gemini-4-argon';
    if (/hydrogen/i.test(raw)) return 'gemini-4-hydrogen';
    return 'gemini-4-carbon';
  }
  return modelKey(raw);
}
export function estimateCost(request, rates) {
  const key=pricingKey(request);
  const rate=rates.find(r=>key===r.model||key.startsWith(r.model+'-'));
  if (!rate) return null;
  const date=request.timestampMs ? new Date(request.timestampMs).toISOString().slice(0,10) : new Date().toISOString().slice(0,10);
  const active=rate.until&&date>=rate.until ? rate.next : rate;
  if (!active) return null;
  return (request.inputTokens*active.input+request.cacheReadTokens*active.cache+request.outputTokens*active.output)/1e6;
}
export function parseOfficialPricing(markdown, date=new Date().toISOString().slice(0,10)) {
  const rates=[];
  for (const section of markdown.split(/^## /m).slice(1)) {
    const id=section.match(/id="(gemini-[^"]+)"/i)?.[1];
    if (!id || /image|live|tts|embedding|robotics/.test(id)) continue;
    const standard=section.split(/tab title="Standard"/)[1]?.split(/\{% \/tab %\}/)[0];
    if (!standard) continue;
    const price=label=>{const chunk=standard.split(new RegExp(`\\* ${label}[^\\n]*\\n`,'i'))[1]?.split(/\n\s*---/)[0];return chunk?.match(/\$([\d.]+)/g)?.map(s=>Number(s.slice(1)))||[];};
    const input=price('Input price'), output=price('Output price'), cache=price('Context caching price');
    if (!input.length||!output.length||!cache.length) continue;
    const r={model:id,input:input[0],output:output[0],cache:cache[0],source:SOURCE,verifiedAt:date};
    const future=standard.match(/starting ([A-Z][a-z]+ \d{1,2}, \d{4})/i);
    if(future&&input[1]!=null&&output[1]!=null&&cache[1]!=null){r.until=new Date(future[1]+' 00:00:00 UTC').toISOString().slice(0,10);r.next={input:input[1],output:output[1],cache:cache[1]};}
    // Multi-tier and modality prices need a richer usage breakdown. Leave them unpriced.
    if(!r.until&&[input,output,cache].some(values=>values.length>1))continue;
    rates.push(r);
  }
  return rates;
}
export function createPricingStore(directory) {
  const path=join(directory,'pricing.json');
  const defaults=[...baseline,...partnerBaseline];
  const get=()=>{try{const data=JSON.parse(readFileSync(path,'utf8'));if(Array.isArray(data.rates))return {...data,rates:[...data.rates,...defaults.filter(r=>!data.rates.some(p=>p.model===r.model))]};}catch{}return{rates:defaults,checkedAt:verifiedAt,source:SOURCE,status:'snapshot'};};
  return {get,async refresh(){
    const [mainRes,partnerRes]=await Promise.allSettled([
      fetch(SOURCE,{headers:{Accept:'text/markdown'},signal:AbortSignal.timeout(10000)}),
      fetch(PARTNER_SOURCE,{signal:AbortSignal.timeout(8000)})
    ]);
    if(mainRes.status!=='fulfilled'||!mainRes.value.ok)throw Error(`价格查询失败 (${mainRes.status==='fulfilled'?mainRes.value.status:'network'})`);
    const rates=parseOfficialPricing(await mainRes.value.text());
    if(!rates.length)throw Error('官方价格页面格式已变化');
    let partnerRates=[];
    try{
      if(partnerRes.status==='fulfilled'&&partnerRes.value.ok){
        const html=await partnerRes.value.text();
        for(const [name,id]of [['Opus 5.5','claude-opus-5-5'],['Sonnet 5.5','claude-sonnet-5-5']]){
          const index=html.indexOf('>'+name+'<');if(index<0)continue;
          const text=html.slice(index,index+6500).replace(/<[^>]+>/g,' ').replace(/\s+/g,' ');
          const cacheWrite=Number(text.match(/\b5m Cache Write \$([\d.]+)/)?.[1]);
          const input=Number(text.match(/\bInput \$([\d.]+)/)?.[1]),output=Number(text.match(/\bOutput \$([\d.]+)/)?.[1]),cache=Number(text.match(/\bCache Hit \$([\d.]+)/)?.[1]);
          if([input,output,cache].every(Number.isFinite))partnerRates.push({model:id,input,output,cache,...(Number.isFinite(cacheWrite)?{cacheWrite,cacheWriteTtl:'5m'}:{}),source:PARTNER_SOURCE,verifiedAt:new Date().toISOString().slice(0,10)});
        }
      }
    }catch{}
    const merged=[...rates,...(partnerRates.length?partnerRates:get().rates.filter(r=>r.model.startsWith('claude-')))];
    const data={rates:[...merged,...defaults.filter(r=>!merged.some(p=>p.model===r.model))],checkedAt:new Date().toISOString(),source:SOURCE,status:'live'};
    mkdirSync(directory,{recursive:true});writeFileSync(path,JSON.stringify(data,null,2));return data;
  }};
}
