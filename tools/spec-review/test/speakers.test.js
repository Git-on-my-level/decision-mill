import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {loadTask,normalizeTask} from '../lib/task.js';
import {foldRows,buildRow} from '../lib/labelstore.js';
import {suggestions,cosine,segmentLabel,score,speakerResults,auditSample} from '../lib/speakers.js';
import {copyExamples,startServer,REPO,TOOL} from './helpers.js';
const fixture=path.join(REPO,'examples/labels/speaker-demo');
test('speaker task defaults and fixture validation',()=>{
  const t=loadTask(fixture);assert.deepEqual(t.errors,[]);assert.deepEqual(t.warnings,[]);
  assert.equal(t.task.blind,true);assert.equal(t.task.labels[0].id,'You');assert.equal(t.items.length,3);
  assert.ok(normalizeTask({kind:'speakers',suggest_threshold:3},'bad').errors.length);
  const root=copyExamples(),dir=path.join(root,'labels/speaker-demo');
  const c=JSON.parse(fs.readFileSync(path.join(dir,'conversations.json')));c[0].segments[0].w1=100;
  fs.writeFileSync(path.join(dir,'conversations.json'),JSON.stringify(c));assert.ok(loadTask(dir).errors.length);fs.rmSync(root,{recursive:true});
});
test('group + segment folding; audit is independent; undo falls back to group',()=>{
  const t=loadTask(fixture),s=t.conversations[0].segments[0];
  const rows=[{item_id:s.group,label:'You',scope:'group'},{item_id:s.id,label:'Alex',scope:'segment'},{item_id:s.id,label:'Other',scope:'audit'}];
  assert.equal(segmentLabel(s,foldRows(rows)),'Alex');assert.equal(foldRows(rows).get(`audit:${s.id}`).label,'Other');
  rows.push({item_id:s.id,label:null,scope:'segment'});assert.equal(segmentLabel(s,foldRows(rows)),'You');
  assert.equal(buildRow({item_id:s.id,label:'Alex',scope:'segment'},{task:t.task,reviewer:'rev'}).row.scope,'segment');
});
test('duration weighted embeddings, same conversation only, skips abstentions',()=>{
  const item=(id,v,d,conv='c')=>({id,centroid:v,meta:{duration_s:d},content:{conversation:conv}});
  const items=[item('a',[1,0],9),item('b',[0,1],1),item('c',[.9,.1],1),item('d',[.9,.1],1,'other'),item('e',[0,0],1)];
  const states=foldRows([{item_id:'a',label:'Alex'},{item_id:'b',label:'Alex'}]);
  assert.equal(suggestions(items,states,.001).c.label,'Alex');assert.equal(suggestions(items,states).d,undefined);assert.equal(suggestions(items,states).e,undefined);
  assert.equal(cosine([1,0],[0,1]),1);assert.equal(cosine([1],[1,2]),Infinity);
  assert.deepEqual(suggestions(items,foldRows([{item_id:'a',label:'mixed'}])),{});
});
test('optimal 1:1 penalizes over-splitting; many-to-one does not; missing words count',()=>{
  const r=score(['You','You','Alex','Alex'],['a','b','c','c']);assert.equal(r.one_to_one,.75);assert.equal(r.many_to_one,1);assert.equal(r.speakers_found,3);assert.equal(r.speakers_true,2);
  assert.equal(score(['You','Alex'],['b','a']).one_to_one,1);
  assert.equal(score(['You','Alex'],['a',null]).one_to_one,.5);
  assert.equal(score([null,'unsure'],['a','b']).words,0);
});
test('truth excludes special labels, segment overrides, purity snapshots and stable sample',()=>{
  const t={...loadTask(fixture),dir:fixture};const s=t.conversations[0].segments[0];
  const states=foldRows([{item_id:s.group,label:'You'},{item_id:s.id,label:'Alex',scope:'segment'},{item_id:s.id,label:'You',scope:'audit',audit_group_label:'You'}]);
  const r=speakerResults(t,{reviewers:{rev:{states}}},'rev');assert.deepEqual(r.truth.fiction,['Alex','You',null,null,null,null]);assert.equal(r.conversations[0].purity.rate,1);
  assert.deepEqual(auditSample(t.conversations[0],3),auditSample(t.conversations[0],3));
});
test('HTTP speaker flow: hidden gating, new people, overrides, suggestions, audit, CLI export',async()=>{
  const root=copyExamples(),dir=path.join(root,'labels/speaker-demo');const srv=await startServer({LABELS_ROOT:path.join(root,'labels'),REVIEWER:'rev'});
  try {
    let r=await srv.get('/api/task/speaker-demo/speakers');assert.equal(r.status,200);assert.equal(r.body.queue[0].hidden,undefined);assert.equal(r.body.conversations[0].systems,undefined);
    assert.equal((await srv.post('/api/task/speaker-demo/label',{item_id:'fiction:g1',label:'Alex',scope:'group'})).status,200);
    r=await srv.get('/api/task/speaker-demo/speakers');assert.ok(r.body.roster.includes('Alex'));assert.equal(r.body.suggestions['fiction:g3'].label,'Alex');
    assert.equal((await srv.get('/api/task/speaker-demo/item/fiction%3Ag1')).body.item.hidden,undefined);
    r=await srv.post('/api/task/speaker-demo/suggestions',{ids:['fiction:g3']});assert.equal(r.body.rows[0].source,'suggested-accepted');
    assert.equal((await srv.post('/api/task/speaker-demo/suggestions',{ids:['fiction:g3']})).status,409);
    assert.equal((await srv.post('/api/task/speaker-demo/label',{item_id:'fiction:s0',label:'You',scope:'segment'})).status,200);
    assert.equal((await srv.post('/api/task/speaker-demo/label',{item_id:'fiction:s0',label:'Alex',scope:'group'})).status,400);
    r=await srv.post('/api/task/speaker-demo/label',{item_id:'fiction:s0',label:'Alex',scope:'audit',audit_group_label:'Forged'});assert.equal(r.body.row.audit_group_label,'Alex');
    r=await srv.get('/api/task/speaker-demo/results');assert.equal(r.body.conversations[0].systems.length,4);assert.equal(r.body.truth.fiction[0],'You');assert.ok(fs.existsSync(path.join(dir,'build/truth.json')));
    const cli=spawnSync(process.execPath,['labels.js','stats',dir,'--reviewer','rev','--json'],{cwd:TOOL,encoding:'utf8'});assert.equal(cli.status,0,cli.stderr);assert.deepEqual(JSON.parse(cli.stdout).truth,r.body.truth);
  }finally{await srv.stop();fs.rmSync(root,{recursive:true});}
});
test('media range edges stream correct bytes on a 30 MB file',async()=>{
  const root=copyExamples(),dir=path.join(root,'labels/speaker-demo/media'),file=path.join(dir,'large.m4a');
  const fd=fs.openSync(file,'w');fs.ftruncateSync(fd,30*1024*1024);fs.writeSync(fd,Buffer.from('abcdef'),0,6,0);fs.closeSync(fd);
  const size=fs.statSync(file).size,srv=await startServer({LABELS_ROOT:path.join(root,'labels')});
  try {
    const url=srv.base+'/api/task/speaker-demo/media?src=media/large.m4a';
    for(const [range,status,length,content] of [['bytes=0-1',206,2,'ab'],['bytes=2-5',206,4,'cdef'],[`bytes=${size-3}-`,206,3,null],['bytes=-3',206,3,null],['bytes=-0',416,0,null],[`bytes=${size}-`,416,0,null],['bytes=5-2',416,0,null],['bytes=999999999999999999999-',416,0,null]]){
      const start=performance.now(),r=await fetch(url,{headers:{range}}),b=Buffer.from(await r.arrayBuffer());assert.equal(r.status,status,range);assert.equal(b.length,length);if(content)assert.equal(b.toString(),content);
      if(status===206){assert.equal(r.headers.get('content-type'),'audio/mp4');assert.equal(r.headers.get('accept-ranges'),'bytes');assert.match(r.headers.get('content-range'),/^bytes \d+-\d+\/31457280$/);assert.ok(performance.now()-start<1000);}
      else assert.equal(r.headers.get('content-range'),`bytes */${size}`);
    }
    fs.symlinkSync(path.join(root,'labels/speaker-demo/hidden/systems.json'),path.join(dir,'leak.m4a'));
    assert.equal((await fetch(srv.base+'/api/task/speaker-demo/media?src=media/leak.m4a')).status,400);
  }finally{await srv.stop();fs.rmSync(root,{recursive:true});}
});

test('ordinary embedding tasks suggest vocabulary labels including noise',()=>{
  const items=[{id:'a',centroid:[1,0]},{id:'b',centroid:[1,0]}];
  assert.equal(suggestions(items,foldRows([{item_id:'a',label:'noise'}]),.45,false).b.label,'noise');
});
