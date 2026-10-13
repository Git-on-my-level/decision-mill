// Speaker truth and embedding suggestions. No model outputs enter the labeling view.
import fs from 'node:fs';
import path from 'node:path';
export const isPerson = label => Boolean(label && !['mixed', 'noise', 'unsure'].includes(label));
export function speakerStates(labels, reviewer) {
  const out = new Map();
  for (const [name, r] of Object.entries(labels.reviewers)) {
    if (reviewer && name !== reviewer) continue;
    for (const [id, s] of r.states) if (s.source !== 'model-standin' && (!out.has(id) || (s.at || '') >= (out.get(id).at || ''))) out.set(id, s);
  }
  return out;
}
export const segmentLabel = (s, states) => states.get(s.id)?.label ?? states.get(s.group)?.label ?? null;
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; aa += a[i]*a[i]; bb += b[i]*b[i]; }
  return aa && bb ? Math.max(0, 1-dot/Math.sqrt(aa*bb)) : Infinity;
}
export function suggestions(items, states, threshold = .45, personOnly = true) {
  const centers = new Map();
  for (const it of items) {
    const s = states.get(it.id);
    if (!(personOnly ? isPerson(s?.label) : s?.label != null && s.label !== 'unsure') || !it.centroid || s.scope === 'segment' || s.scope === 'audit') continue;
    const key = JSON.stringify([it.content?.conversation ?? it.meta?.conversation ?? '', s.label]);
    const w = Number(it.meta?.duration_s) > 0 ? Number(it.meta.duration_s) : 1;
    const c = centers.get(key) || { label: s.label, sum: it.centroid.map(() => 0), weight: 0 };
    if (c.sum.length !== it.centroid.length) continue;
    c.sum = c.sum.map((x,i) => x+it.centroid[i]*w); c.weight += w; centers.set(key,c);
  }
  const out = {};
  for (const it of items) {
    if (states.get(it.id)?.label != null || !it.centroid) continue;
    const conv = it.content?.conversation ?? it.meta?.conversation ?? '';
    let best;
    for (const [key,c] of centers) {
      if (JSON.parse(key)[0] !== conv) continue;
      const distance = cosine(it.centroid, c.sum.map(x => x/c.weight));
      if (distance < threshold && (!best || distance < best.distance)) best = { label: c.label, distance };
    }
    if (best) out[it.id] = best;
  }
  return out;
}
export function progress(c, states) {
  const total = c.segments.reduce((n,s) => n+s.end-s.start,0);
  const labeled = c.segments.filter(s => isPerson(segmentLabel(s,states))).reduce((n,s) => n+s.end-s.start,0);
  return { total, labeled, rate: total ? labeled/total : 0 };
}
export function auditSample(c, n = 15) {
  // Stable pseudorandom sample: reload cannot cherry-pick a different audit.
  const hash = id => { let h=2166136261; for (const x of id) h=Math.imul(h^x.charCodeAt(0),16777619); return h>>>0; };
  return [...c.segments].sort((a,b) => hash(c.id+a.id)-hash(c.id+b.id)).slice(0,n);
}
export function interval(k,n) {
  if (!n) return [0,1];
  const z=1.96, p=k/n, d=1+z*z/n, center=(p+z*z/(2*n))/d, half=z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n))/d;
  return [center-half,center+half];
}
// Maximum-weight bipartite matching (Hungarian); padded square handles extra speakers.
function assignment(matrix) {
  const n=Math.max(matrix.length, ...matrix.map(r=>r.length),0);
  const u=Array(n+1).fill(0),v=[...u],p=[...u],way=[...u];
  for(let i=1;i<=n;i++) {
    p[0]=i; let j0=0; const min=Array(n+1).fill(Infinity),used=Array(n+1).fill(false);
    do { used[j0]=true; const i0=p[j0]; let delta=Infinity,j1=0;
      for(let j=1;j<=n;j++) if(!used[j]) { const cur=-(matrix[i0-1]?.[j-1]||0)-u[i0]-v[j]; if(cur<min[j]) {min[j]=cur;way[j]=j0;} if(min[j]<delta){delta=min[j];j1=j;} }
      for(let j=0;j<=n;j++) if(used[j]){u[p[j]]+=delta;v[j]-=delta;}else min[j]-=delta;
      j0=j1;
    } while(p[j0]);
    do { const j1=way[j0];p[j0]=p[j1];j0=j1; }while(j0);
  }
  return p.slice(1).reduce((sum,i,j)=>sum+(matrix[i-1]?.[j]||0),0);
}
export function score(truth, predicted) {
  const people=[...new Set(truth.filter(isPerson))];
  const found=[...new Set(predicted.filter(x=>x!=null).map(String))];
  const matrix=found.map(()=>people.map(()=>0)); let n=0;
  truth.forEach((t,i)=>{if(!isPerson(t))return;n++;const a=found.indexOf(String(predicted[i])),b=people.indexOf(t);if(predicted[i]!=null && a>=0)matrix[a][b]++;});
  const one=assignment(matrix),many=matrix.reduce((s,r)=>s+Math.max(0,...r),0);
  return { words:n, one_to_one:n?one/n:null, many_to_one:n?many/n:null, speakers_found:found.length, speakers_true:people.length };
}
export function speakerResults(t, labels, reviewer) {
  const states=speakerStates(labels,reviewer), truth={}, conversations=[];
  let systems={};
  try { systems=JSON.parse(fs.readFileSync(path.join(t.dir,'hidden/systems.json'),'utf8')); } catch(e) { if(e.code!=='ENOENT')throw e; }
  for(const c of t.conversations) {
    const words=c.words.map(()=>null);
    for(const s of c.segments){const label=segmentLabel(s,states);if(isPerson(label))for(let w=s.w0;w<s.w1;w++)words[w]=label;}
    truth[c.id]=words;
    const audits=auditSample(c,t.task.audit?.per_conversation ?? 15).map(s=>states.get(`audit:${s.id}`)).filter(s=>isPerson(s?.label)&&isPerson(s.audit_group_label));
    const agree=audits.filter(s=>s.label===s.audit_group_label).length;
    conversations.push({ id:c.id, progress:progress(c,states), systems:Object.entries(systems[c.id]||{}).map(([id,p])=>({id,...score(words,p)})), baseline:score(words,words.map(()=> 'single speaker')), purity:{compared:audits.length,agree,rate:audits.length?agree/audits.length:null,ci:interval(agree,audits.length)} });
  }
  return { kind:'speakers', conversations, truth };
}
export function exportTruth(dir, result) {
  fs.mkdirSync(path.join(dir,'build'),{recursive:true});
  const file=path.join(dir,'build/truth.json'),tmp=file+'.tmp';
  fs.writeFileSync(tmp,JSON.stringify(result.truth,null,2)+'\n');fs.renameSync(tmp,file);
}
