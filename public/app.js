const supported = ['txt','md','csv','tsv','json','eml','sql','pdf','docx','xlsx','xls','doc','epub'];
const $ = (id) => document.getElementById(id);
let activeChatId = '';
let initializedNewChatForCache = new Set();

function ext(name=''){ const p=name.split('.'); return p.length>1 ? p.pop().toLowerCase() : ''; }
function bytes(n=0){ if(n<1024) return `${n} B`; if(n<1048576) return `${(n/1024).toFixed(1)} KB`; if(n<1073741824) return `${(n/1048576).toFixed(1)} MB`; return `${(n/1073741824).toFixed(2)} GB`; }
function selectedCacheId(){ return $('cache-select').value; }
function setProgress(v=0){ $('index-progress').style.width = `${Math.max(0, Math.min(100, v))}%`; }
function relTime(iso=''){ const d=new Date(iso); const s=Math.floor((Date.now()-d.getTime())/1000); if(!iso||Number.isNaN(d.getTime())) return ''; if(s<60) return `${s}s ago`; if(s<3600) return `${Math.floor(s/60)}m ago`; if(s<86400) return `${Math.floor(s/3600)}h ago`; return `${Math.floor(s/86400)}d ago`; }
function scrollToSection(id){ const el=$(id); if(el) el.scrollIntoView({ behavior:'smooth', block:'start' }); }

function loadOpenRouter(){ $('or-key').value=localStorage.getItem('openrouter.key')||''; $('or-model').value=localStorage.getItem('openrouter.model')||'openai/gpt-4o-mini'; }
function updateQuestionPlaceholder(){ $('question').placeholder = $('query-mode').value === 'surreal' ? 'Search term(s)' : 'Ask a follow-up question'; }
$('query-mode').onchange = updateQuestionPlaceholder;

function renderThread(messages=[]){
  const el = $('chat-thread');
  el.innerHTML = messages.map((m)=>`<div class="msg ${m.role==='user'?'user':'assistant'}"><div class="meta">${m.role||'msg'} • ${relTime(m.at||'')}</div><div>${String(m.content||'').replace(/</g,'&lt;')}</div></div>`).join('') || '<p class="muted">No messages yet in this chat.</p>';
  el.scrollTop = el.scrollHeight;
}

function renderSuggestions(list = []) {
  const el = $('suggestions');
  if (!Array.isArray(list) || !list.length) { el.innerHTML = ''; return; }
  el.innerHTML = list.slice(0, 8).map((q) => `<button class="sugg-btn" data-q="${String(q).replace(/"/g,'&quot;')}">${String(q).replace(/</g,'&lt;')}</button>`).join('');
  el.querySelectorAll('button[data-q]').forEach((btn) => {
    btn.onclick = () => { $('question').value = btn.getAttribute('data-q') || ''; $('question').focus(); };
  });
}

async function loadChatMessages(){
  const cacheId = selectedCacheId();
  if(!cacheId || !activeChatId) return renderThread([]);
  const r = await fetch(`/api/chats/${cacheId}/${activeChatId}`); const j = await r.json();
  renderThread(j?.chat?.messages || []);
}

$('save-or').onclick=()=>{ localStorage.setItem('openrouter.key',$('or-key').value.trim()); localStorage.setItem('openrouter.model',$('or-model').value.trim()); $('or-dot').className='dot green'; $('or-status').textContent='Saved locally'; };
$('ping-or').onclick=async()=>{ $('or-status').textContent='Pinging...'; const r=await fetch('/api/openrouter/ping',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:$('or-key').value.trim(),model:$('or-model').value.trim()})}); const j=await r.json(); if(r.ok&&j.ok){ $('or-dot').className='dot green'; $('or-status').textContent='OpenRouter reachable'; } else { $('or-dot').className='dot red'; $('or-status').textContent=`Ping failed: ${j.error||'unknown'}`; }};

async function createNewChatForCache(cacheId, title='New session'){ const r = await fetch(`/api/chats/${cacheId}`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ title }) }); return r.json(); }

async function fetchChats(){
  const cacheId = selectedCacheId();
  if (!cacheId) { $('chat-select').innerHTML=''; activeChatId=''; renderThread([]); renderSuggestions([]); return; }

  if (!initializedNewChatForCache.has(cacheId)) {
    await createNewChatForCache(cacheId, `Session ${new Date().toLocaleString()}`);
    initializedNewChatForCache.add(cacheId);
  }

  const r = await fetch(`/api/chats/${cacheId}`); const j = await r.json(); const chats = j.chats || [];
  $('chat-select').innerHTML = chats.map(c=>`<option value="${c.chatId}">${c.title || c.chatId} • ${c.messageCount} msgs • ${relTime(c.updatedAt)}</option>`).join('');
  activeChatId = chats[0]?.chatId || '';
  if (activeChatId) $('chat-select').value = activeChatId;
  await loadChatMessages();
}

async function fetchCaches(){
  const prior = selectedCacheId();
  const r=await fetch('/api/caches'); const j=await r.json(); const list=j.caches||[];
  $('cache-list').innerHTML=list.map(c=>`<li><button class="sugg-btn cache-jump" data-cache-id="${c.id}"><strong>${c.label}</strong> <span class="muted">(${c.id}) · ${c.files?.length||0} files · ${c.readyForQuestions?'ready':'not-ready'}</span></button></li>`).join('') || '<li class="muted">No caches yet</li>';
  $('cache-select').innerHTML=list.map(c=>`<option value="${c.id}">${c.label}</option>`).join('');
  if (prior && list.some(c=>c.id===prior)) $('cache-select').value = prior;
  const active=list.find(c=>c.id===selectedCacheId()) || list[0];
  $('active-cache-label').textContent = active ? `${active.label} (${active.id})` : 'None';
  $('ready-state').textContent=active?.readyForQuestions ? 'Ready for questions ✅' : 'Not ready for questions';

  document.querySelectorAll('.cache-jump').forEach((btn) => {
    btn.onclick = async () => {
      const cid = btn.getAttribute('data-cache-id');
      if (!cid) return;
      $('cache-select').value = cid;
      const selected = list.find((c) => c.id === cid);
      $('active-cache-label').textContent = selected ? `${selected.label} (${selected.id})` : 'None';
      await fetchChats();
      if (!selected || !(selected.files || []).length) scrollToSection('section-upload');
      else if (!selected.readyForQuestions) scrollToSection('section-index');
      else scrollToSection('section-ask');
    };
  });

  await fetchChats();
}

$('cache-select').onchange = async ()=> { const list=await (await fetch('/api/caches')).json(); const c=(list.caches||[]).find(x=>x.id===selectedCacheId()); $('active-cache-label').textContent = c ? `${c.label} (${c.id})` : 'None'; await fetchChats(); await checkSurreal(); };
$('chat-select').onchange = async ()=> { activeChatId = $('chat-select').value; await loadChatMessages(); };
$('new-chat').onclick = async ()=>{ const cacheId = selectedCacheId(); if(!cacheId) return; const j = await createNewChatForCache(cacheId, `Session ${new Date().toLocaleString()}`); activeChatId = j.chatId; await fetchChats(); $('query-status').textContent = 'New chat created.'; };

$('create-cache').onclick=async()=>{ const label=$('cache-label').value.trim(); if(!label) return; await fetch('/api/caches',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({label})}); $('cache-label').value=''; await fetchCaches(); };
$('file-input').onchange=()=>{ const files=[...$('file-input').files]; $('file-preview').innerHTML=files.map(f=>{ const e=ext(f.name); const ok=supported.includes(e); return `<tr><td>${f.name}</td><td>${e||'unknown'}</td><td>${bytes(f.size)}</td><td>${ok?'✅':'⚠️ raw-fallback'}</td></tr>`; }).join(''); };

async function uploadSelectedFilesIfAny(){
  const cacheId=selectedCacheId(); const files=[...$('file-input').files]; if(!cacheId || !files.length) return { uploaded: 0, skipped: true };
  $('upload-status').textContent = `Uploading ${files.length} file(s)...`;
  const fd=new FormData(); fd.append('cacheId',cacheId); files.forEach(f=>fd.append('files',f));
  const r=await fetch('/api/upload',{method:'POST',body:fd}); const j=await r.json();
  if(!r.ok){ $('upload-status').textContent = `Upload failed: ${j.error||'unknown'}`; throw new Error(j.error||'upload failed'); }
  $('file-input').value=''; $('file-preview').innerHTML='';
  $('upload-status').textContent = `Uploaded ${j.files?.length||0} file(s) to cache.`;
  await fetchCaches();
  return { uploaded: j.files?.length || 0, skipped: false };
}
$('upload-btn').onclick=async()=>{ try { await uploadSelectedFilesIfAny(); } catch {} };
$('load-sample').onclick=async()=>{ const cacheId=selectedCacheId(); if(!cacheId) return; $('upload-status').textContent = 'Uploading sample fixture...'; const r=await fetch('/fixtures/sample-case-500w.txt'); const txt=await r.text(); const f=new File([txt],'sample-case-500w.txt',{type:'text/plain'}); const fd=new FormData(); fd.append('cacheId',cacheId); fd.append('files',f); const up=await fetch('/api/upload',{method:'POST',body:fd}); const j=await up.json(); if(!up.ok){ $('upload-status').textContent = `Sample upload failed: ${j.error||'unknown'}`; return; } $('upload-status').textContent = 'Sample uploaded.'; await fetchCaches(); };

async function checkSurreal(){ const r=await fetch('/api/surreal/health'); const j=await r.json(); if(r.ok&&j.ok){ $('surreal-dot').className='dot green'; $('surreal-status').textContent='Reachable'; return true; } $('surreal-dot').className='dot red'; $('surreal-status').textContent=`Unreachable: ${j.error||'unknown'}`; return false; }

$('suggest-strategy').onclick = async ()=>{ const cacheId = selectedCacheId(); if(!cacheId) return; $('index-log').textContent = 'Requesting strategy suggestion...'; const mode = $('or-key').value.trim() ? 'ai' : 'heuristic'; const r = await fetch(`/api/index/strategy-suggest/${cacheId}`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ mode, openRouterKey: $('or-key').value.trim(), model: $('or-model').value.trim() }) }); const j = await r.json(); if (!r.ok || !j.ok) { $('index-log').textContent = `Strategy suggestion failed: ${j.error||'unknown'}`; return; } $('index-strategy-notes').value = `${j.strategy || ''} — ${j.rationale || ''}`.trim(); $('index-log').textContent = `Suggested strategy (${j.source}):\n- ${j.strategy}\n- ${j.rationale}\nFocus: ${(j.focus||[]).join(', ')}`; };

$('load-existing-index').onclick = async ()=>{
  const cacheId=selectedCacheId(); if(!cacheId) return;
  const r=await fetch(`/api/index/${cacheId}`,{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ forceReindex: false }) });
  const j=await r.json();
  if(!r.ok){ $('index-log').textContent=`Load existing index failed: ${j.error||'unknown'}`; return; }
  setProgress(100);
  $('index-estimate').textContent='Existing index loaded instantly.';
  $('index-log').textContent=(j.manifest.logs||[]).map(x=>`- ${x.message}`).join('\n') + `${j.manifest.summary ? `\n\nSummary:\n${j.manifest.summary}` : ''}`;
  await fetchCaches();
  scrollToSection('section-ask');
};

$('index-btn').onclick=async()=>{
  const cacheId=selectedCacheId(); if(!cacheId) return;
  try { const up = await uploadSelectedFilesIfAny(); if (!up.skipped) $('index-log').textContent = `Auto-upload complete (${up.uploaded} file(s)). Starting index...`; } catch (error) { $('index-log').textContent = `Cannot index: upload step failed (${error.message}).`; return; }
  const cacheRes = await fetch('/api/caches'); const cacheJson = await cacheRes.json(); const active = (cacheJson.caches || []).find((c) => c.id === cacheId);
  if (!active || !(active.files || []).length) { $('index-log').textContent = 'Cannot index: this cache has 0 uploaded files.'; setProgress(0); return; }
  const ok = await checkSurreal(); if(!ok){ $('index-log').textContent='Cannot index: SurrealDB is unreachable.'; return; }

  setProgress(2);
  $('index-estimate').textContent = 'Estimating indexing time...';
  $('index-log').textContent='Indexing started...';

  let stopped = false;
  const pollProgress = async () => {
    if (stopped) return;
    try {
      const pr = await fetch(`/api/index-progress/${cacheId}`);
      const pj = await pr.json();
      if (pj?.ok && (pj.active || pj.status === 'done')) {
        const mbDone = (Number(pj.processedBytes || 0) / (1024*1024)).toFixed(2);
        const mbTotal = (Number(pj.totalBytes || 0) / (1024*1024)).toFixed(2);
        setProgress(Number.isFinite(pj.pct) ? pj.pct : 0);
        $('index-estimate').textContent = `Stage: ${pj.stage || 'running'} • Progress: ${pj.pct || 0}% • files ${pj.processedFiles||0}/${pj.totalFiles||0} • ${mbDone}/${mbTotal} MB • ETA ~${pj.etaSec||0}s${pj.currentFile?` • current: ${pj.currentFile}`:''}`;
      }
    } catch {}
  };
  await pollProgress();
  const ticker = setInterval(pollProgress, 1200);

  const r=await fetch(`/api/index/${cacheId}`,{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ indexStrategy: $('index-strategy').value, indexStrategyNotes: $('index-strategy-notes').value.trim() }) });
  const j=await r.json();
  stopped = true;
  clearInterval(ticker);

  if(!r.ok){ setProgress(0); $('index-estimate').textContent = 'Index failed.'; $('index-log').textContent=(j.logs||[]).map(x=>`- ${x.message}`).join('\n') + `\nERROR: ${j.error}`; await fetchCaches(); return; }
  setProgress(100);
  $('index-estimate').textContent = j.reusedExisting ? 'Loaded existing index (no re-scan).' : 'Index complete.';
  $('index-log').textContent=(j.manifest.logs||[]).map(x=>`- ${x.message}`).join('\n') + `${j.manifest.summary ? `\n\nSummary:\n${j.manifest.summary}` : ''}` + `\n\nHow indexing works:\n${(j.manifest.indexingExplanation||[]).map(s=>`- ${s}`).join('\n')}\n\nDONE: docs=${j.manifest.stats.documentCount} chunks=${j.manifest.stats.chunkCount} entities=${j.manifest.stats.entityCount||0} events=${j.manifest.stats.eventCount||0} activities=${j.manifest.stats.activityCount||0} intents=${j.manifest.stats.intentCount||0}${j.reusedExisting ? '\n(Loaded existing index; no re-scan performed.)' : ''}`;
  await fetchCaches();
};

$('suggest-btn').onclick = async ()=>{
  const cacheId=selectedCacheId(); if(!cacheId) return;
  $('query-status').textContent = 'Suggesting questions...';
  const r = await fetch(`/api/suggest-questions/${cacheId}`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({
      chatId: activeChatId,
      mode: 'heuristic',
      openRouterKey: $('or-key').value.trim(),
      model: $('or-model').value.trim()
    })
  });
  const j = await r.json();
  if (!r.ok || !j.ok) { $('query-status').textContent = `Suggestion failed: ${j.error||'unknown'}`; return; }
  renderSuggestions(j.suggestions || []);
  $('query-status').textContent = `Suggestions ready (${j.source}).`;
};

$('ask-btn').onclick=async()=>{
  const cacheId=selectedCacheId(); const q=$('question').value.trim(); if(!cacheId||!q) return;
  const mode=$('query-mode').value; activeChatId = $('chat-select').value || activeChatId;
  // optimistic user bubble
  const current = $('chat-thread').innerHTML;
  $('chat-thread').innerHTML = current + `<div class="msg user"><div class="meta">user • now</div><div>${q.replace(/</g,'&lt;')}</div></div>`;
  $('query-status').textContent='Running retrieval...';
  $('trace').textContent='Step 1: Parse query\nStep 2: Query Surreal chunks + structured tables\nStep 3: Build response';

  const payload = { question:q, mode, chatId: activeChatId, queryStrategy: $('query-strategy').value, queryStrategyNotes: $('query-strategy-notes').value.trim(), openRouterKey: $('or-key').value.trim(), model: $('or-model').value.trim() };
  const r=await fetch(`/api/query/${cacheId}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  const j=await r.json();
  if(!r.ok){ $('query-status').textContent='Query failed'; $('trace').textContent += `\nERROR: ${j.error||'query failed'}`; return; }
  if (j.chatId) activeChatId = j.chatId;
  const struct = j.structured || {};
  $('trace').textContent = `Surreal returned:\n- chunks: ${(j.evidence||[]).length}\n- entities: ${struct.entities?.length||0}\n- events: ${struct.events?.length||0}\n- activities: ${struct.activities?.length||0}\n- intents: ${struct.intents?.length||0}\n- anomalies: ${struct.anomalies?.length||0}\n- relations: ${struct.relations?.length||0}\n${mode==='ai'?'AI synthesized final answer using these findings.':'Surreal-only response returned.'}`;
  $('query-status').textContent=`Done. mode=${j.mode}`;
  await fetchChats();
  await loadChatMessages();

  try {
    const sr = await fetch(`/api/suggest-questions/${cacheId}`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        chatId: activeChatId,
        mode: 'heuristic',
        openRouterKey: $('or-key').value.trim(),
        model: $('or-model').value.trim()
      })
    });
    const sj = await sr.json();
    if (sr.ok && sj.ok) renderSuggestions(sj.suggestions || []);
  } catch {}

  $('question').value='';
};

(async()=>{ loadOpenRouter(); updateQuestionPlaceholder(); await fetchCaches(); await checkSurreal(); })();
