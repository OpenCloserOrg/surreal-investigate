const supported = ['txt','md','csv','json','eml'];
const $ = (id) => document.getElementById(id);

function ext(name=''){ const p=name.split('.'); return p.length>1 ? p.pop().toLowerCase() : ''; }
function bytes(n=0){ if(n<1024) return `${n} B`; if(n<1048576) return `${(n/1024).toFixed(1)} KB`; if(n<1073741824) return `${(n/1048576).toFixed(1)} MB`; return `${(n/1073741824).toFixed(2)} GB`; }
function selectedCacheId(){ return $('cache-select').value; }

function loadOpenRouter(){ $('or-key').value=localStorage.getItem('openrouter.key')||''; $('or-model').value=localStorage.getItem('openrouter.model')||'openai/gpt-4o-mini'; }
$('save-or').onclick=()=>{
  localStorage.setItem('openrouter.key',$('or-key').value.trim());
  localStorage.setItem('openrouter.model',$('or-model').value.trim());
  $('or-dot').className='dot green'; $('or-status').textContent='Saved locally';
};
$('ping-or').onclick=async()=>{
  $('or-status').textContent='Pinging...';
  const r=await fetch('/api/openrouter/ping',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:$('or-key').value.trim(),model:$('or-model').value.trim()})});
  const j=await r.json();
  if(r.ok&&j.ok){ $('or-dot').className='dot green'; $('or-status').textContent='OpenRouter reachable'; }
  else { $('or-dot').className='dot red'; $('or-status').textContent=`Ping failed: ${j.error||'unknown'}`; }
};

async function fetchCaches(){
  const r=await fetch('/api/caches'); const j=await r.json(); const list=j.caches||[];
  $('cache-list').innerHTML=list.map(c=>`<li><strong>${c.label}</strong> <span class="muted">(${c.id}) · ${c.files?.length||0} files · ${c.readyForQuestions?'ready':'not-ready'}</span></li>`).join('') || '<li class="muted">No caches yet</li>';
  $('cache-select').innerHTML=list.map(c=>`<option value="${c.id}">${c.label}</option>`).join('');
  const active=list.find(c=>c.id===selectedCacheId()) || list[0];
  $('ready-state').textContent=active?.readyForQuestions ? 'Ready for questions ✅' : 'Not ready for questions';
}

$('create-cache').onclick=async()=>{
  const label=$('cache-label').value.trim(); if(!label) return;
  await fetch('/api/caches',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({label})});
  $('cache-label').value=''; await fetchCaches();
};

$('file-input').onchange=()=>{
  const files=[...$('file-input').files];
  $('file-preview').innerHTML=files.map(f=>{ const e=ext(f.name); const ok=supported.includes(e); return `<tr><td>${f.name}</td><td>${e||'unknown'}</td><td>${bytes(f.size)}</td><td>${ok?'✅':'❌'}</td></tr>`; }).join('');
};

$('upload-btn').onclick=async()=>{
  const cacheId=selectedCacheId(); const files=[...$('file-input').files]; if(!cacheId||!files.length) return;
  const fd=new FormData(); fd.append('cacheId',cacheId); files.forEach(f=>fd.append('files',f));
  const r=await fetch('/api/upload',{method:'POST',body:fd}); const j=await r.json();
  if(!r.ok) return alert(j.error||'Upload failed');
  $('file-input').value=''; $('file-preview').innerHTML='';
  await fetchCaches();
};

$('load-sample').onclick=async()=>{
  const cacheId=selectedCacheId(); if(!cacheId) return;
  const r=await fetch('/fixtures/sample-case-500w.txt');
  const txt=await r.text();
  const f=new File([txt],'sample-case-500w.txt',{type:'text/plain'});
  const fd=new FormData(); fd.append('cacheId',cacheId); fd.append('files',f);
  const up=await fetch('/api/upload',{method:'POST',body:fd}); const j=await up.json();
  if(!up.ok) return alert(j.error||'sample upload failed');
  await fetchCaches();
};

async function checkSurreal(){
  const r=await fetch('/api/surreal/health');
  const j=await r.json();
  if(r.ok&&j.ok){ $('surreal-dot').className='dot green'; $('surreal-status').textContent='Reachable'; return true; }
  $('surreal-dot').className='dot red'; $('surreal-status').textContent=`Unreachable: ${j.error||'unknown'}`;
  return false;
}

$('index-btn').onclick=async()=>{
  const cacheId=selectedCacheId(); if(!cacheId) return;
  const ok = await checkSurreal();
  if(!ok){ $('index-log').textContent='Cannot index: SurrealDB is unreachable. Start SurrealDB first.'; return; }
  $('index-log').textContent='Indexing started...';
  const r=await fetch(`/api/index/${cacheId}`,{method:'POST'}); const j=await r.json();
  if(!r.ok){ $('index-log').textContent=(j.logs||[]).map(x=>`- ${x.message}`).join('\n') + `\nERROR: ${j.error}`; await fetchCaches(); return; }
  $('index-log').textContent=(j.manifest.logs||[]).map(x=>`- ${x.message}`).join('\n') + `\nDONE: ${j.manifest.stats.documentCount} docs, ${j.manifest.stats.chunkCount} chunks`;
  await fetchCaches();
};

$('ask-btn').onclick=async()=>{
  const cacheId=selectedCacheId(); const q=$('question').value.trim(); if(!cacheId||!q) return;
  const mode=$('query-mode').value;
  $('answer').textContent='Querying...';
  const r=await fetch(`/api/query/${cacheId}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
    question:q,mode,
    openRouterKey: $('or-key').value.trim(),
    model: $('or-model').value.trim()
  })});
  const j=await r.json();
  if(!r.ok){ $('answer').textContent=`ERROR: ${j.error||'query failed'}`; return; }
  $('answer').textContent = `Mode: ${j.mode}\n\n${j.answer}\n\nEvidence:\n${(j.evidence||[]).map((e,i)=>`#${i+1} ${e.filename} [${e.chunkIndex}] score=${(e.score||0).toFixed?.(3) ?? e.score}\n${String(e.text||'').slice(0,240)}...`).join('\n\n')}`;
};

(async()=>{ loadOpenRouter(); await fetchCaches(); await checkSurreal(); })();
