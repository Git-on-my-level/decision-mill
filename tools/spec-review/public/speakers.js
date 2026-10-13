/* Speaker mode uses the shared shell and append-only label API. */
window.Speakers = (() => {
  const enc=encodeURIComponent;
  let taskId, task, data, tab='label', pos=0, clip=0, convId, target, audio, stopAt=null, busy=false;
  const base=()=>`api/task/${enc(taskId)}`;
  const choices=()=>[...data.roster.map(x=>({id:x,label:x})),{id:'mixed',label:'Mixed'},{id:'noise',label:'Not speech / noise'},{id:'unsure',label:'Unsure'}];
  const color=label=>!label||['mixed','unsure','noise'].includes(label)?'var(--faint)':['var(--unify)','var(--keep)','var(--team)','var(--metric)','var(--toss)','var(--abstain)'][Math.max(0,data.roster.indexOf(label))%6];
  const conversation=()=>data.conversations.find(c=>c.id===convId)||data.conversations[0];
  const active=()=>data.queue[pos];
  const undoRows=()=>JSON.parse(sessionStorage.getItem(`speaker-undo:${taskId}`)||'[]');
  const remember=rows=>sessionStorage.setItem(`speaker-undo:${taskId}`,JSON.stringify([...undoRows(),...rows.map(r=>({item_id:r.item_id,scope:r.scope}))]));
  async function reload(){data=await api(`${base()}/speakers`);}
  function button(text,fn,attrs={}) {const b=el('button',{type:'button',...attrs},text);b.addEventListener('click',()=>Promise.resolve(fn()).catch(e=>toast(e.message,'err')));return b;}
  function play(c,start,end=null) {
    if (!audio) return;
    const src=`${base()}/media?src=${enc(c.media)}`;
    if(audio.getAttribute('src')!==src)audio.src=src;
    stopAt=end;audio.currentTime=start;
    audio.play().catch(e=>toast(`Audio: ${e.message}`,'err'));
  }
  function player(c) {
    audio=el('audio',{controls:true,preload:'metadata',src:`${base()}/media?src=${enc(c.media)}`});
    audio.addEventListener('timeupdate',()=>{
      if(stopAt!=null&&audio.currentTime>=stopAt){audio.pause();stopAt=null;}
      let current;
      for(const w of document.querySelectorAll('[data-word-start]')) {
        const on=audio.currentTime>=Number(w.dataset.wordStart)&&audio.currentTime<Number(w.dataset.wordEnd);
        w.classList.toggle('speaking',on); if(on)current=w;
      }
      if(current&&document.querySelector('#speaker-follow')?.checked)current.scrollIntoView({block:'nearest'});
    });
    const speed=el('select',{'aria-label':'Playback speed'},[.75,1,1.25,1.5,2].map(x=>el('option',{value:String(x),selected:x===1},`${x}×`)));
    speed.addEventListener('change',()=>audio.playbackRate=Number(speed.value));
    return el('div',{class:'speaker-player'},audio,speed,el('label',{},el('input',{type:'checkbox',id:'speaker-follow',checked:true}),' Follow along'));
  }
  function picker(id,scope='group') {
    target={item_id:id,scope};
    const suggest=scope==='group'?data.suggestions[id]:null;
    const bar=el('div',{class:'speaker-choices'});
    choices().forEach((l,i)=>bar.append(button(`${i<9?`${i+1} · `:''}${l.label}`,()=>write(l.id,id,scope),{class:suggest?.label===l.id?'suggested':''})));
    const name=el('input',{placeholder:'Add a person…',list:'speaker-roster','aria-label':'Person name',maxlength:120});
    const names=el('datalist',{id:'speaker-roster'},data.roster.map(x=>el('option',{value:x})));
    const add=()=>{const v=name.value.trim();if(v&&!['mixed','noise','unsure'].includes(v))return write(v,id,scope);};
    name.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();add().catch(e=>toast(e.message,'err'));}});
    bar.append(name,names,button('Label with name',add));
    if(suggest)bar.append(button(`Accept ${suggest.label} · Enter`,()=>write(suggest.label,id,scope,'suggested-accepted')));
    return bar;
  }
  async function write(label,id=target?.item_id,scope=target?.scope,source='human') {
    if(busy||!id)return;
    busy=true;
    try {
      const r=await postJSON(`${base()}/label`,{item_id:id,label,scope,source});remember([r.row]);
      await reload();
      if(scope==='group'&&label!=='mixed')pos=0;
      else if(scope==='group')pos=data.queue.findIndex(x=>x.id===id);
      clip=0;render();Shell.refreshNav();
    } finally {busy=false;}
  }
  async function undo(){const rows=undoRows(),r=rows.pop();if(!r)return;await postJSON(`${base()}/undo`,r);sessionStorage.setItem(`speaker-undo:${taskId}`,JSON.stringify(rows));await reload();pos=0;render();Shell.refreshNav();}
  function clipButton(c,s){return button(`▶ ${s.start.toFixed(1)}s · ${s.text||c.words.slice(s.w0,s.w1).map(w=>w[2]).join(' ')}${s.short?' · short clip':''}`,()=>play(c,s.start,s.end),{class:'speaker-clip'});}
  function render() {
    audio?.pause();audio=null;stopAt=null;target=null;
    const body=el('div',{class:'lv-body speaker-body'}),v=document.querySelector('#label-view');
    const tabs=el('nav',{class:'tabs'},['label','transcript','audit','results'].map(x=>el('a',{class:`tab${tab===x?' on':''}`,href:`#/task/${enc(taskId)}${x==='label'?'':`/${x}`}`},x[0].toUpperCase()+x.slice(1))));
    v.replaceChildren(el('div',{class:'lv'},el('header',{class:'lv-head'},el('h2',{},task.title),tabs),body));
    body.append(button('Undo · u',undo));
    if(tab==='results'){results(body);return;}
    if(tab==='transcript'||tab==='audit'){review(body);return;}
    const it=active();if(!it){body.append(el('p',{},'No groups.'));return;}
    const c=data.conversations.find(c=>c.id===it.content.conversation);
    const count=data.queue.filter(x=>x.label!=null).length;
    body.append(el('p',{},`${count}/${data.queue.length} groups labeled · ${it.content.segments.length} clips · ${Number(it.meta?.duration_s||0).toFixed(1)}s`));
    if(task.instructions)body.append(el('details',{},el('summary',{},'Instructions'),el('div',{class:'prose',html:md(task.instructions)})));
    const ids=Object.keys(data.suggestions);
    if(ids.length)body.append(button(`Accept all confident suggestions (${ids.length})`,async()=>{const r=await postJSON(`${base()}/suggestions`,{ids});remember(r.rows);await reload();pos=0;render();Shell.refreshNav();}));
    body.append(el('h3',{},it.title||it.id));
    if(it.label) body.append(el('p',{},`Current label: ${choices().find(l=>l.id===it.label)?.label||it.label}`));
    body.append(player(c));
    const reps=(it.content.representatives?.length?it.content.representatives:it.content.segments).slice(0,4);
    body.append(el('div',{class:'speaker-reps'},reps.map(id=>clipButton(c,c.segments.find(s=>s.id===id)))),picker(it.id));
    body.append(button('Previous · k',()=>{pos=Math.max(0,pos-1);clip=0;render();}),button('Next · j',()=>{pos=Math.min(data.queue.length-1,pos+1);clip=0;render();}));
    if(it.label==='mixed') {
      body.append(el('h3',{},'Mixed group — label each clip'));
      for(const s of c.segments.filter(s=>it.content.segments.includes(s.id)))body.append(el('div',{class:'speaker-turn'},clipButton(c,s),button(s.label||'Label clip',()=>{document.querySelector('#segment-picker')?.remove();body.append(el('div',{id:'segment-picker'},picker(s.id,'segment')));}))); 
      target={item_id:it.id,scope:'group'};
    }
  }
  function review(body) {
    const sel=el('select',{'aria-label':'Conversation'},data.conversations.map(c=>el('option',{value:c.id,selected:c.id===conversation().id},`${c.title||c.id} · ${(c.progress.rate*100).toFixed(0)}% speech labeled`)));
    sel.addEventListener('change',()=>{convId=sel.value;render();});body.append(sel);
    const c=conversation();body.append(player(c));
    if(tab==='audit') {
      const s=c.audit.find(s=>s.label==null);
      body.append(el('p',{},`Blind purity audit · ${c.audit.filter(s=>s.label!=null).length}/${c.audit.length}`));
      if(s)body.append(clipButton(c,s),picker(s.id,'audit'));else body.append(el('p',{},'Audit complete. See Results for agreement and interval.'));
      return;
    }
    const lane=el('div',{class:'speaker-timeline','aria-label':'Your speaker timeline'});
    for(const s of c.segments)lane.append(button(s.label||'',()=>play(c,s.start),{title:`${s.start.toFixed(1)}s · ${s.label||'Unlabeled'}`,style:`left:${100*s.start/c.duration_s}%;width:${Math.max(.1,100*(s.end-s.start)/c.duration_s)}%;background:${color(s.label)}`}));
    body.append(lane);
    for(const s of c.segments) {
      const turn=el('div',{class:'speaker-turn',style:`border-left-color:${color(s.label)}`});
      turn.append(button(s.label||'Unlabeled',()=>{document.querySelector('#segment-picker')?.remove();turn.append(el('div',{id:'segment-picker'},picker(s.id,'segment')));}));
      c.words.slice(s.w0,s.w1).forEach(w=>turn.append(button(w[2],()=>play(c,w[0]),{'data-word-start':String(w[0]),'data-word-end':String(w[1]),class:'speaker-word'})));
      body.append(turn);
    }
  }
  async function results(body) {
    try {
      const r=await api(`${base()}/results`);
      if(tab!=='results')return;
      body.append(el('p',{},'Truth exported to build/truth.json. Scores use labeled speech words only.'));
      const pct=x=>x==null?'—':`${(100*x).toFixed(1)}%`;
      for(const c of r.conversations)body.append(el('section',{class:'speaker-turn'},el('h3',{},c.id),el('p',{},`${pct(c.progress.rate)} speech labeled`),
        el('div',{class:'table-wrap'},el('table',{},el('thead',{},el('tr',{},['System','1:1','Many:1','Found / true','Words'].map(x=>el('th',{},x)))),el('tbody',{},[...c.systems,{id:'Single speaker',...c.baseline}].map(m=>el('tr',{},[m.id,pct(m.one_to_one),pct(m.many_to_one),`${m.speakers_found} / ${m.speakers_true}`,String(m.words)].map(x=>el('td',{},x))))))),
        el('p',{},`Group purity: ${pct(c.purity.rate)} · ${c.purity.agree}/${c.purity.compared} audited · 95% interval ${c.purity.ci.map(pct).join('–')}`)));
    }catch(e){toast(e.message,'err');}
  }
  return {
    async open(id,t,sub,itemId){taskId=id;task=t;tab=sub==='items'?'label':sub||'label';await reload();pos=itemId?Math.max(0,data.queue.findIndex(x=>x.id===itemId)):0;render();},
    key(e){
      const k=e.key;
      if(k==='u'){undo().catch(e=>toast(e.message,'err'));return true;}
      if({L:'label',I:'transcript',R:'results'}[k]){location.hash=`#/task/${enc(taskId)}/${{L:'label',I:'transcript',R:'results'}[k]}`;return true;}
      if(k===' '){if(tab==='label'){const it=active(),c=data.conversations.find(c=>c.id===it.content.conversation),ids=(it.content.representatives?.length?it.content.representatives:it.content.segments).slice(0,4),s=c.segments.find(s=>s.id===ids[clip++%ids.length]);play(c,s.start,s.end);}else if(tab==='audit'){const c=conversation(),s=c.audit.find(s=>s.label==null);if(s)play(c,s.start,s.end);}else if(audio){if(audio.paused)audio.play().catch(()=>{});else audio.pause();}return true;}
      if(k==='j'||k==='k'){if(tab==='label'){pos=Math.max(0,Math.min(data.queue.length-1,pos+(k==='j'?1:-1)));clip=0;render();}return true;}
      if(k==='Enter'&&target?.scope==='group'&&data.suggestions[target.item_id]){write(data.suggestions[target.item_id].label,target.item_id,'group','suggested-accepted').catch(e=>toast(e.message,'err'));return true;}
      if(/^[1-9]$/.test(k)&&target){const l=choices()[Number(k)-1];if(l)write(l.id).catch(e=>toast(e.message,'err'));return true;}
      return false;
    }
  };
})();
