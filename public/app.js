const supported = ['txt','md','csv','json','eml','sql','pdf','docx','xlsx','xls','doc','epub'];
const $ = (id) => document.getElementById(id);

function ext(name=''){ const p=name.split('.'); return p.length>1 ? p.pop().toLowerCase() : ''; }
function bytes(n=0){ if(n<1024) return `${n} B`; if(n<1048576) return `${(n/1024).toFixed(1)} KB`; if(n<1073741824) return `${(n/1048576).toFixed(1)} MB`; return `${(n/1073741824).toFixed(2)} GB`; }
function selectedCacheId(){ return $('cache-select').value; }

let activeChatId = '';

function setProgress(v=0){ $('index-progress').style.width = `${Math.max(0, Math.min(100, v))}%`; }

function loadOpenRouter(){
  $('or-key').value=localStorage.getItem('openrouter.key')||'';
  $('or-model').value=localStorage.getItem('openrouter.model')||'openai/gpt-4o-mini';
}

function updateQuestionPlaceholder(){
  const mode = $('query-mode').value;
  $('question').placeholder = mode === 'surreal'
    ? 'Search term(s), e.g. bright lantern transfer'
    : 'Ask a question with context, e.g. who coordinated payment routing?';
}

$('query-mode').onchange = updateQuestionPlaceholder;

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
  const prior = selectedCacheId();
  $('cache-select').innerHTML=list.map(c=>`<option value="${c.id}">${c.label}</option>`).join('');
  if (prior && list.some(c=>c.id===prior)) $('cache-select').value = prior;
  const active=list.find(c=>c.id===selectedCacheId()) || list[0];
  $('ready-state').textContent=active?.readyForQuestions ? 'Ready for questions ✅' : 'Not ready for questions';
  await fetchChats();
}

$('cache-select').onchange = async ()=> { await fetchChats(); await checkSurreal(); };

async function fetchChats(){
  const cacheId = selectedCacheId();
  if (!cacheId) { $('chat-select').innerHTML=''; activeChatId=''; return; }
  const r = await fetch(`/api/chats/${cacheId}`); const j = await r.json();
  const chats = j.chats || [];
  if (!chats.length) {
    const created = await fetch(`/api/chats/${cacheId}`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ title: 'Session 1' }) });
    const cj = await created.json();
    activeChatId = cj.chatId;
    $('chat-select').innerHTML = `<option value="${cj.chatId}">${cj.title}</option>`;
    return;
  }
  activeChatId = chats[0].chatId;
  $('chat-select').innerHTML = chats.map(c=>`<option value="${c.chatId}">${c.title || c.chatId} · ${c.messageCount} msgs</option>`).join('');
}

$('chat-select').onchange = ()=> { activeChatId = $('chat-select').value; };

$('new-chat').onclick = async ()=>{
  const cacheId = selectedCacheId(); if(!cacheId) return;
  const title = `Session ${new Date().toLocaleString()}`;
  const r = await fetch(`/api/chats/${cacheId}`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ title }) });
  const j = await r.json();
  await fetchChats();
  $('chat-select').value = j.chatId;
  activeChatId = j.chatId;
  $('query-status').textContent = `Created ${title}`;
};

$('create-cache').onclick=async()=>{
  const label=$('cache-label').value.trim(); if(!label) return;
  await fetch('/api/caches',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({label})});
  $('cache-label').value=''; await fetchCaches();
};

$('file-input').onchange=()=>{
  const files=[...$('file-input').files];
  $('file-preview').innerHTML=files.map(f=>{ const e=ext(f.name); const ok=supported.includes(e); const supportLabel = ok ? '✅' : '⚠️ raw-fallback'; return `<tr><td>${f.name}</td><td>${e||'unknown'}</td><td>${bytes(f.size)}</td><td>${supportLabel}</td></tr>`; }).join('');
};

async function uploadSelectedFilesIfAny(){
  const cacheId=selectedCacheId(); const files=[...$('file-input').files];
  if(!cacheId || !files.length) return { uploaded: 0, skipped: true };
  $('upload-status').textContent = `Uploading ${files.length} file(s)...`;
  const fd=new FormData(); fd.append('cacheId',cacheId); files.forEach(f=>fd.append('files',f));
  const r=await fetch('/api/upload',{method:'POST',body:fd}); const j=await r.json();
  if(!r.ok){ $('upload-status').textContent = `Upload failed: ${j.error||'unknown'}`; throw new Error(j.error||'upload failed'); }
  $('file-input').value=''; $('file-preview').innerHTML='';
  $('upload-status').textContent = `Uploaded ${j.files?.length||0} file(s) to cache.`;
  await fetchCaches();
  return { uploaded: j.files?.length || 0, skipped: false };
}

$('upload-btn').onclick=async()=>{
  try { await uploadSelectedFilesIfAny(); } catch {}
};

$('load-sample').onclick=async()=>{
  const cacheId=selectedCacheId(); if(!cacheId) return;
  $('upload-status').textContent = 'Uploading sample fixture...';
  const r=await fetch('/fixtures/sample-case-500w.txt');
  const txt=await r.text();
  const f=new File([txt],'sample-case-500w.txt',{type:'text/plain'});
  const fd=new FormData(); fd.append('cacheId',cacheId); fd.append('files',f);
  const up=await fetch('/api/upload',{method:'POST',body:fd}); const j=await up.json();
  if(!up.ok){ $('upload-status').textContent = `Sample upload failed: ${j.error||'unknown'}`; return; }
  $('upload-status').textContent = 'Sample uploaded.';
  await fetchCaches();
};

async function checkSurreal(){
  const r=await fetch('/api/surreal/health');
  const j=await r.json();
  if(r.ok&&j.ok){ $('surreal-dot').className='dot green'; $('surreal-status').textContent='Reachable'; return true; }
  $('surreal-dot').className='dot red'; $('surreal-status').textContent=`Unreachable: ${j.error||'unknown'}`;
  return false;
}

$('suggest-strategy').onclick = async ()=>{
  const cacheId = selectedCacheId(); if(!cacheId) return;
  $('index-log').textContent = 'Requesting strategy suggestion...';
  const mode = $('or-key').value.trim() ? 'ai' : 'heuristic';
  const r = await fetch(`/api/index/strategy-suggest/${cacheId}`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ mode, openRouterKey: $('or-key').value.trim(), model: $('or-model').value.trim() })
  });
  const j = await r.json();
  if (!r.ok || !j.ok) { $('index-log').textContent = `Strategy suggestion failed: ${j.error||'unknown'}`; return; }
  $('index-strategy-notes').value = `${j.strategy || ''} — ${j.rationale || ''}`.trim();
  $('index-log').textContent = `Suggested strategy (${j.source}):\n- ${j.strategy}\n- ${j.rationale}\nFocus: ${(j.focus||[]).join(', ')}`;
};

$('index-btn').onclick=async()=>{
  const cacheId=selectedCacheId(); if(!cacheId) return;

  try {
    const up = await uploadSelectedFilesIfAny();
    if (!up.skipped) {
      $('index-log').textContent = `Auto-upload complete (${up.uploaded} file(s)). Starting index...`;
    }
  } catch (error) {
    $('index-log').textContent = `Cannot index: upload step failed (${error.message}).`;
    return;
  }

  const cacheRes = await fetch('/api/caches');
  const cacheJson = await cacheRes.json();
  const active = (cacheJson.caches || []).find((c) => c.id === cacheId);
  if (!active || !(active.files || []).length) {
    $('index-log').textContent = 'Cannot index: this cache has 0 uploaded files. Select files and click Upload (or click Index with files selected to auto-upload).';
    setProgress(0);
    return;
  }

  const ok = await checkSurreal();
  if(!ok){ $('index-log').textContent='Cannot index: SurrealDB is unreachable. Start SurrealDB first.'; return; }

  setProgress(5);
  $('index-log').textContent='Indexing started...';
  let p = 8;
  const ticker = setInterval(()=>{ p=Math.min(92,p+4); setProgress(p); }, 700);

  const r=await fetch(`/api/index/${cacheId}`,{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({
      indexStrategy: $('index-strategy').value,
      indexStrategyNotes: $('index-strategy-notes').value.trim()
    })
  });
  const j=await r.json();
  clearInterval(ticker);
  if(!r.ok){ setProgress(0); $('index-log').textContent=(j.logs||[]).map(x=>`- ${x.message}`).join('\n') + `\nERROR: ${j.error}`; await fetchCaches(); return; }
  setProgress(100);
  $('index-log').textContent=(j.manifest.logs||[]).map(x=>`- ${x.message}`).join('\n') + `\n\nHow indexing works:\n${(j.manifest.indexingExplanation||[]).map(s=>`- ${s}`).join('\n')}\n\nDONE: ${j.manifest.stats.documentCount} docs, ${j.manifest.stats.chunkCount} chunks`;
  await fetchCaches();
};

$('ask-btn').onclick=async()=>{
  const cacheId=selectedCacheId(); const q=$('question').value.trim(); if(!cacheId||!q) return;
  const mode=$('query-mode').value;
  activeChatId = $('chat-select').value || activeChatId;

  $('query-status').textContent='Querying...';
  $('answer').textContent='Querying...';
  const payload = {
    question:q,
    mode,
    chatId: activeChatId,
    queryStrategy: $('query-strategy').value,
    queryStrategyNotes: $('query-strategy-notes').value.trim(),
    openRouterKey: $('or-key').value.trim(),
    model: $('or-model').value.trim()
  };

  const r=await fetch(`/api/query/${cacheId}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  const j=await r.json();
  if(!r.ok){ $('query-status').textContent='Query failed'; $('answer').textContent=`ERROR: ${j.error||'query failed'}`; return; }
  if (j.chatId) activeChatId = j.chatId;
  $('query-status').textContent=`Done. mode=${j.mode} evidence=${(j.evidence||[]).length}`;
  $('answer').textContent = `Mode: ${j.mode}\nChat: ${j.chatId || activeChatId}\nStrategy: ${payload.queryStrategy}${payload.queryStrategyNotes?` (${payload.queryStrategyNotes})`:''}\n\n${j.answer}\n\nEvidence:\n${(j.evidence||[]).map((e,i)=>`#${i+1} ${e.filename} [${e.chunkIndex}] score=${(e.score||0).toFixed?.(3) ?? e.score}\n${String(e.text||'').slice(0,240)}...`).join('\n\n')}`;
  await fetchChats();
};

(async()=>{
  loadOpenRouter();
  updateQuestionPlaceholder();
  await fetchCaches();
  await checkSurreal();
})();
