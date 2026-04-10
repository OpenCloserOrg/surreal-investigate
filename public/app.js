const supported = ['txt','md','csv','tsv','json','eml','sql','pdf','docx','xlsx','xls','doc','epub'];
const $ = (id) => document.getElementById(id);
let activeChatId = '';
let initializedNewChatForCache = new Set();
let liveTrace = [];
let recommendedIndexOptions = null;
let featurePlansState = [];
let activeIndexProfile = null;
let selectedPlanIdx = -1;
let currentCache = null;

function ext(name=''){ const p=name.split('.'); return p.length>1 ? p.pop().toLowerCase() : ''; }
function bytes(n=0){ if(n<1024) return `${n} B`; if(n<1048576) return `${(n/1024).toFixed(1)} KB`; if(n<1073741824) return `${(n/1048576).toFixed(1)} MB`; return `${(n/1073741824).toFixed(2)} GB`; }
function duration(sec=0){ const s=Math.max(0, Math.round(Number(sec)||0)); if(s<60) return `${s}s`; const m=Math.floor(s/60); const r=s%60; if(m<60) return `${m}m ${r}s`; const h=Math.floor(m/60); return `${h}h ${m%60}m`; }
function currentIndexOptions(){ return { chunkSize: Number($('chunk-size').value || 1400), parallelWorkers: Number($('parallel-workers').value || 1), analysisEnabled: $('analysis-enabled').checked, preferGpu: $('prefer-gpu').checked }; }
function renderTuningLabels(){ $('chunk-size-value').textContent = $('chunk-size').value; $('workers-value').textContent = $('parallel-workers').value; }
function selectedCacheId(){ return $('cache-select').value; }
function aiCredPayload(){ return isEnvMode() ? { useEnv: true } : { openRouterKey: $('or-key').value.trim(), model: $('or-model').value.trim() }; }
function buildSurrealFormatProfile(profile = null){
  const p = profile || {
    name: $('index-strategy').value,
    strategy: $('index-strategy').value,
    notes: $('index-strategy-notes').value.trim(),
    indexOptions: currentIndexOptions(),
    tableDesign: ['document','chunk','entity','event','activity','intent','relation','anomaly'],
    extractionMapping: [],
    domainLexiconRules: [],
    tableWriteIntents: []
  };
  const opts = p.indexOptions || currentIndexOptions();
  const writes = ['document','chunk'];
  if (opts.analysisEnabled !== false) writes.push('entity','event','activity','intent','relation','anomaly');
  return {
    planName: p.name || p.strategy || 'feature-plan',
    strategy: p.strategy || $('index-strategy').value,
    notes: p.notes || $('index-strategy-notes').value.trim(),
    indexOptions: opts,
    requestPayload: {
      indexStrategy: p.strategy || $('index-strategy').value,
      indexStrategyNotes: p.notes || $('index-strategy-notes').value.trim(),
      indexOptions: opts,
      featurePlanSpec: {
        extractionMapping: p.extractionMapping || [],
        domainLexiconRules: p.domainLexiconRules || [],
        tableWriteIntents: p.tableWriteIntents || [],
        suppressions: p.suppressions || [],
        priorityRelationships: p.priorityRelationships || [],
        tableDesign: p.tableDesign || []
      }
    },
    surrealWriteTables: writes,
    extractionMapping: p.extractionMapping || [],
    domainLexiconRules: p.domainLexiconRules || [],
    tableWriteIntents: p.tableWriteIntents || [],
    examples: p.examples?.length ? p.examples : [
      { table: 'document', data: { cacheId: 'cache-123', filename: 'report.pdf', wordCount: 12800, extractionMethod: 'pdf-pdftotext' } },
      { table: 'chunk', data: { cacheId: 'cache-123', filename: 'report.pdf', chunkIndex: 1, text: '...', charCount: opts.chunkSize || 1400 } }
    ]
  };
}
function setProfileLock(locked){
  ['index-strategy','index-strategy-notes','chunk-size','parallel-workers','analysis-enabled','prefer-gpu'].forEach((id)=>{ if($(id)) $(id).disabled = locked; });
}
function setSelectedPlanUI(idx = -1){
  selectedPlanIdx = idx;
  document.querySelectorAll('#feature-plans .feature-plan').forEach((el, i)=>el.classList.toggle('selected', i===idx));
  const banner = $('feature-plan-selected-banner');
  if (!banner) return;
  banner.style.display = idx >= 0 ? 'block' : 'none';
}

function applyProfile(profile){
  if (!profile) return;
  activeIndexProfile = profile;
  $('index-strategy').value = profile.strategy || 'custom';
  $('index-strategy-notes').value = profile.notes || '';
  $('chunk-size').value = String(profile.indexOptions?.chunkSize || 1400);
  $('parallel-workers').value = String(profile.indexOptions?.parallelWorkers || 1);
  $('analysis-enabled').checked = profile.indexOptions?.analysisEnabled !== false;
  $('prefer-gpu').checked = Boolean(profile.indexOptions?.preferGpu);
  renderTuningLabels();
  setProfileLock(true);
  $('active-profile-status').textContent = `Using feature plan: ${profile.name || profile.strategy} (${profile.strategy || 'custom'}). Exit plan to edit manual controls.`;
  applyGateState();
}
function clearActiveProfileUI(){
  activeIndexProfile = null;
  setProfileLock(false);
  $('active-profile-status').textContent = 'No active feature plan selected.';
  applyGateState();
}
function setProgress(v=0){ $('index-progress').style.width = `${Math.max(0, Math.min(100, v))}%`; }
function relTime(iso=''){ const d=new Date(iso); const s=Math.floor((Date.now()-d.getTime())/1000); if(!iso||Number.isNaN(d.getTime())) return ''; if(s<60) return `${s}s ago`; if(s<3600) return `${Math.floor(s/60)}m ago`; if(s<86400) return `${Math.floor(s/3600)}h ago`; return `${Math.floor(s/86400)}d ago`; }
function scrollToSection(id){ const el=$(id); if(el) el.scrollIntoView({ behavior:'smooth', block:'start' }); }

function evaluateIndexHealth(stats = {}){
  const entities = Number(stats.entityCount || 0);
  const events = Number(stats.eventCount || 0);
  const activities = Number(stats.activityCount || 0);
  const low = entities === 0 && events === 0 && activities === 0;
  $('index-health-warning').style.display = low ? 'block' : 'none';
  return low;
}

function updateAskArtifactInfo(){
  if (!currentCache?.id) { $('ask-index-artifact').textContent = 'No index artifact selected yet.'; return; }
  const ready = currentCache?.readyForQuestions;
  const path = `indexes/${currentCache.id}/manifest.json`;
  $('ask-index-artifact').textContent = ready
    ? `Using index manifest: ${path}`
    : `Index not ready yet. Expected artifact path after indexing: ${path}`;
}

function notifyBlocked(target){
  const tips = {
    index: 'Upload files to the selected cache first, then run Create / Refresh Index.',
    plans: 'Upload files first so feature plans can sample real content.',
    ask: 'Index the cache first. Ask Questions unlocks after indexing is complete.'
  };
  const msg = tips[target] || 'Complete the required previous step first.';
  $('upload-status').textContent = msg;
  $('query-status').textContent = msg;
}

function applyGateState(){
  const hasCacheSelected = Boolean(currentCache?.id);
  const selectedLocalFiles = [...($('file-input')?.files || [])].length;
  const hasUploadedFiles = Boolean((currentCache?.files || []).length);
  const isIndexed = Boolean(currentCache?.readyForQuestions);

  $('upload-btn').disabled = !hasCacheSelected;
  $('load-sample').disabled = !hasCacheSelected;
  $('file-input').disabled = !hasCacheSelected;
  const disabledMsg = 'Select which cache you would like first.';
  $('file-input').title = !hasCacheSelected ? disabledMsg : '';
  $('upload-btn').title = !hasCacheSelected ? disabledMsg : '';
  $('load-sample').title = !hasCacheSelected ? disabledMsg : '';

  $('chunk-size').disabled = !hasCacheSelected || Boolean(activeIndexProfile);
  $('parallel-workers').disabled = !hasCacheSelected || Boolean(activeIndexProfile);
  $('analysis-enabled').disabled = !hasCacheSelected || Boolean(activeIndexProfile);
  $('prefer-gpu').disabled = !hasCacheSelected || Boolean(activeIndexProfile);

  $('index-btn').dataset.locked = (!hasCacheSelected || (!hasUploadedFiles && !selectedLocalFiles)) ? '1' : '0';
  if ($('index-btn-large')) {
    $('index-btn-large').dataset.locked = $('index-btn').dataset.locked;
    $('index-btn-large').disabled = $('index-btn').dataset.locked === '1';
  }
  $('load-existing-index').dataset.locked = (!hasCacheSelected || !hasUploadedFiles) ? '1' : '0';
  $('generate-feature-plans').dataset.locked = (!hasCacheSelected || !hasUploadedFiles) ? '1' : '0';
  $('recommend-index-settings').dataset.locked = (!hasCacheSelected || !hasUploadedFiles) ? '1' : '0';

  $('ask-btn').dataset.locked = (!hasCacheSelected || !isIndexed) ? '1' : '0';
  $('suggest-btn').dataset.locked = (!hasCacheSelected || !isIndexed) ? '1' : '0';
  $('convert-surrealql').disabled = !hasCacheSelected;
  $('view-schema').disabled = !hasCacheSelected;
  $('download-manifest').disabled = !hasCacheSelected;
  $('download-index-data').disabled = !hasCacheSelected;
  $('query-mode').disabled = !hasCacheSelected || !isIndexed;
  $('query-strategy').disabled = !hasCacheSelected || !isIndexed;
  $('query-strategy-notes').disabled = !hasCacheSelected || !isIndexed;
  $('question').disabled = !hasCacheSelected || !isIndexed;

  $('upload-warning').textContent = hasCacheSelected
    ? '⚠ Remember: selecting files is not enough. Click Upload to attach them to this cache.'
    : '⚠ Select a cache first. Upload actions are inactive until a cache is selected.';
  $('index-warning').textContent = hasCacheSelected
    ? (hasUploadedFiles ? '⚠ Feature plans and indexing are available. Tune setup, then run index.' : '⚠ Upload at least one file to unlock feature-plan and index actions.')
    : '⚠ Index and feature-plan controls unlock after selecting a cache with uploaded files.';
  $('ask-warning').textContent = hasCacheSelected
    ? (isIndexed ? '⚠ Ask is ready. Queries now run against indexed Surreal tables.' : '⚠ Ask remains locked until indexing completes for this cache.')
    : '⚠ Ask section unlocks after cache indexing completes.';

  if (!hasUploadedFiles && !selectedLocalFiles) {
    $('index-estimate').textContent = 'Index disabled: upload at least one file to this cache first.';
  }
  if (!isIndexed) {
    $('query-status').textContent = 'Ask Questions disabled until this cache is indexed.';
  }
}

function showTraceModal(title, detail){
  $('trace-modal-title').textContent = title || 'Trace detail';
  $('trace-modal-body').textContent = typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2);
  $('trace-modal').classList.remove('hidden');
}
function hideTraceModal(){ $('trace-modal').classList.add('hidden'); }
function showConfirm(message){
  return new Promise((resolve)=>{
    $('confirm-text').textContent = message || 'Are you sure?';
    $('confirm-modal').classList.remove('hidden');
    const done = (v)=>{ $('confirm-modal').classList.add('hidden'); $('confirm-ok').onclick=null; $('confirm-cancel').onclick=null; resolve(v); };
    $('confirm-ok').onclick = ()=>done(true);
    $('confirm-cancel').onclick = ()=>done(false);
  });
}

function renderLiveTrace(){
  const el = $('live-trace');
  if (!liveTrace.length) { el.innerHTML=''; return; }
  el.innerHTML = liveTrace.map((t, idx)=>`<div class="trace-item ${(t.state||'pending')}" ><div><strong>${t.step}</strong><div class="state">${t.state || 'pending'}</div></div><button class="view" data-idx="${idx}">View</button></div>`).join('');
  el.querySelectorAll('button[data-idx]').forEach((btn)=>{
    btn.onclick = ()=>{
      const i = Number(btn.getAttribute('data-idx'));
      const item = liveTrace[i];
      if (!item) return;
      showTraceModal(item.step, item.detail || item);
    };
  });
}
function setTraceStep(step, state, detail){
  const i = liveTrace.findIndex((t)=>t.step===step);
  if (i === -1) liveTrace.push({ step, state, detail });
  else {
    liveTrace[i].state = state;
    if (detail !== undefined) liveTrace[i].detail = detail;
  }
  renderLiveTrace();
}

function isEnvMode(){ return $('cred-env')?.checked; }
function loadOpenRouter(){
  const mode = localStorage.getItem('creds.mode') || 'local';
  $('cred-local').checked = mode !== 'env';
  $('cred-env').checked = mode === 'env';
  $('or-key').value=localStorage.getItem('openrouter.key')||'';
  $('or-model').value=localStorage.getItem('openrouter.model')||'openai/gpt-4o-mini';
}
function updateQuestionPlaceholder(){ $('question').placeholder = $('query-mode').value === 'surreal' ? 'Search term(s)' : 'Ask a follow-up question'; }
function updateCredModeUI(){
  const env = isEnvMode();
  $('or-key').disabled = env;
  $('cred-local-card').classList.toggle('active', !env);
  $('cred-env-card').classList.toggle('active', env);
  if (env) $('or-status').textContent = '.env mode active. Click "Load from .env" then Retest env.';
}
$('query-mode').onchange = updateQuestionPlaceholder;
$('chunk-size').oninput = renderTuningLabels;
$('parallel-workers').oninput = renderTuningLabels;
$('cred-local').onchange = ()=>{ localStorage.setItem('creds.mode','local'); updateCredModeUI(); };
$('cred-env').onchange = ()=>{ localStorage.setItem('creds.mode','env'); updateCredModeUI(); };

$('recommend-index-settings').onclick = async ()=>{
  if ($('recommend-index-settings').dataset.locked === '1') return notifyBlocked('index');
  const cacheId = selectedCacheId(); if(!cacheId) return;
  $('index-recommendation').textContent = 'Calculating recommendation...';
  const r = await fetch(`/api/index-recommendation/${cacheId}`);
  const j = await r.json();
  if (!r.ok || !j.ok) { $('index-recommendation').textContent = `Recommendation failed: ${j.error||'unknown'}`; return; }
  recommendedIndexOptions = j.recommended;
  $('use-recommended').disabled = false;
  $('index-recommendation').textContent = `Recommended: chunk ${j.recommended.chunkSize}, workers ${j.recommended.parallelWorkers}. Estimated improvement ~${j.estimate.savedPct}% (${duration(j.estimate.currentEtaSec)} → ${duration(j.estimate.predictedEtaSec)}).`;
  $('index-log').textContent = `Recommendation rationale:\n- ${j.rationale.join('\n- ')}\n\nSystem: ${j.system.cpuCount} CPU threads, ${j.system.availableMemGb} GB free RAM.`;
};

$('use-recommended').onclick = ()=>{
  if (!recommendedIndexOptions) return;
  $('chunk-size').value = String(recommendedIndexOptions.chunkSize || 1400);
  $('parallel-workers').value = String(recommendedIndexOptions.parallelWorkers || 1);
  $('analysis-enabled').checked = recommendedIndexOptions.analysisEnabled !== false;
  $('prefer-gpu').checked = Boolean(recommendedIndexOptions.preferGpu);
  renderTuningLabels();
};
$('view-surreal-format').onclick = ()=> showTraceModal('Surreal Format Preview', buildSurrealFormatProfile(activeIndexProfile));
$('view-active-profile-format').onclick = ()=> showTraceModal('Active Profile — Surreal Format', buildSurrealFormatProfile(activeIndexProfile));
$('exit-active-profile').onclick = async ()=>{
  const cacheId = selectedCacheId();
  clearActiveProfileUI();
  setSelectedPlanUI(-1);
  if (cacheId) await fetch(`/api/index-profile/${cacheId}`, { method:'DELETE' });
  renderFeaturePlans(featurePlansState);
};
$('reset-feature-plan').onclick = async ()=>{
  const cacheId = selectedCacheId();
  clearActiveProfileUI();
  setSelectedPlanUI(-1);
  if (cacheId) await fetch(`/api/index-profile/${cacheId}`, { method:'DELETE' });
  $('index-strategy').value = 'investigation-default';
  $('index-strategy-notes').value = '';
  $('chunk-size').value = '1400';
  $('parallel-workers').value = '1';
  $('analysis-enabled').checked = true;
  $('prefer-gpu').checked = false;
  renderTuningLabels();
  renderFeaturePlans(featurePlansState);
};
$('edit-active-profile').onclick = ()=>{
  const profile = activeIndexProfile || { name:'Custom profile', strategy:$('index-strategy').value, notes:$('index-strategy-notes').value.trim(), tableDesign:['document','chunk'], indexOptions:currentIndexOptions(), examples:[] };
  $('profile-json-editor').classList.remove('hidden');
  $('profile-editor-actions').classList.remove('hidden');
  $('profile-json-editor').value = JSON.stringify(profile, null, 2);
};
$('cancel-profile-json').onclick = ()=>{
  $('profile-json-editor').classList.add('hidden');
  $('profile-editor-actions').classList.add('hidden');
};
$('save-profile-json').onclick = async ()=>{
  const cacheId = selectedCacheId(); if(!cacheId) return;
  let parsed;
  try { parsed = JSON.parse($('profile-json-editor').value || '{}'); } catch (e) { $('active-profile-status').textContent = `Invalid JSON: ${e.message}`; return; }
  const r = await fetch(`/api/index-profile/${cacheId}`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ profile: parsed, persist:true }) });
  const j = await r.json();
  if (!r.ok || !j.ok) { $('active-profile-status').textContent = `Save failed: ${j.error||'unknown'}`; return; }
  applyProfile(j.activeProfile);
  $('profile-json-editor').classList.add('hidden');
  $('profile-editor-actions').classList.add('hidden');
};

$('generate-feature-plans').onclick = async ()=>{
  if ($('generate-feature-plans').dataset.locked === '1') return notifyBlocked('plans');
  const cacheId = selectedCacheId(); if(!cacheId) return;
  $('feature-plan-status').innerHTML = '<span class="spinner"></span>Generating feature plans (can take up to 1–2 minutes)...';
  const goal = $('feature-goal').value.trim();
  const reqBody = { goal, applyDetectedRecipe: $('use-detected-recipe')?.checked !== false, mainIntent: $('main-intent')?.value || 'auto', ...aiCredPayload() };
  const safeBody = { ...reqBody, openRouterKey: reqBody.openRouterKey ? `${String(reqBody.openRouterKey).slice(0,6)}***${String(reqBody.openRouterKey).slice(-4)}` : undefined };
  const reqPreview = {
    request: {
      method: 'POST',
      url: `/api/index/feature-plans/${cacheId}`,
      headers: { 'Content-Type': 'application/json' },
      body: safeBody
    },
    note: 'Request dispatched. Waiting for server response...'
  };
  if ($('feature-ai-preview')) $('feature-ai-preview').textContent = JSON.stringify(reqPreview, null, 2);

  const r = await fetch(`/api/index/feature-plans/${cacheId}`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify(reqBody)
  });
  const j = await r.json();

  if ($('feature-ai-preview')) {
    $('feature-ai-preview').textContent = JSON.stringify({
      ...reqPreview,
      serverPreview: j?.requestPreview || null,
      responseMeta: { ok: r.ok, status: r.status, source: j?.source || null }
    }, null, 2);
  }

  if (!r.ok || !j.ok) { $('feature-plan-status').textContent = `Feature planning failed: ${j.error||'unknown'}`; return; }
  renderFeaturePlans(j.plans || []);
  if (j.sampleSummary) $('quick-file-summary').textContent = j.sampleSummary;
  if (!j.plans?.length) {
    $('feature-plan-status').textContent = j.warning || `No plans generated (${j.source}).`;
    return;
  }
  $('feature-plan-status').textContent = `Generated ${j.plans?.length||0} plans (${j.source}). Sampled ${j.sampleWordCount||0} words.`;
};

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

function renderFeaturePlans(plans = []) {
  const el = $('feature-plans');
  featurePlansState = Array.isArray(plans) ? plans : [];
  if (!featurePlansState.length) { el.innerHTML = ''; setSelectedPlanUI(-1); return; }
  el.innerHTML = featurePlansState.map((p, idx)=>`<details class="feature-plan" ${idx===0?'open':''}><summary>${(p.tier||'Plan').replace(/</g,'&lt;')} — ${(p.name||'').replace(/</g,'&lt;')} ${selectedPlanIdx===idx?'✅':''}</summary><p class="muted">${String(p.explanation||'').replace(/</g,'&lt;')}</p><p><strong>Estimated indexing scope:</strong> ${p.estimatedTime || 'n/a'}</p><p><strong>Example question:</strong> ${String(p.exampleQuestion||'').replace(/</g,'&lt;')}</p><p><strong>Extraction mapping:</strong> ${(p.extractionMapping||[]).slice(0,3).map((x)=>String(x).replace(/</g,'&lt;')).join(' • ') || 'n/a'}</p><p><strong>Domain lexicon:</strong> ${(p.domainLexiconRules||[]).slice(0,8).map((x)=>String(x).replace(/</g,'&lt;')).join(', ') || 'n/a'}</p><p><strong>Suppressions:</strong> ${(p.suppressions||[]).slice(0,6).map((x)=>String(x).replace(/</g,'&lt;')).join(', ') || 'none'}</p><p><strong>Priority relationships:</strong> ${(p.priorityRelationships||[]).slice(0,4).map((x)=>String(x).replace(/</g,'&lt;')).join(' • ') || 'n/a'}</p><ul>${(p.tableWriteIntents||p.tableDesign||[]).map((t)=>`<li>${String(t).replace(/</g,'&lt;')}</li>`).join('')}</ul><div class="row"><button class="use-plan" data-plan-idx="${idx}">${selectedPlanIdx===idx?'Selected ✅':'Use This Feature Plan'}</button><button class="view-plan" data-plan-idx="${idx}">See Surreal Format</button></div></details>`).join('');
  setSelectedPlanUI(selectedPlanIdx);
  el.querySelectorAll('.view-plan').forEach((btn)=>btn.onclick=()=>{ const p=featurePlansState[Number(btn.getAttribute('data-plan-idx'))]; showTraceModal('Surreal Format Preview', buildSurrealFormatProfile(p)); });
  el.querySelectorAll('.use-plan').forEach((btn)=>btn.onclick=async()=>{
    const idx = Number(btn.getAttribute('data-plan-idx'));
    const p=featurePlansState[idx];
    if(!p) return;
    const profile = { id:`plan-${Date.now()}`, name:p.name||p.tier||'Feature Plan', strategy:p.strategy||'custom', notes:p.explanation||'', tableDesign:p.tableDesign||[], extractionMapping:p.extractionMapping||[], domainLexiconRules:p.domainLexiconRules||[], tableWriteIntents:p.tableWriteIntents||[], suppressions:p.suppressions||[], priorityRelationships:p.priorityRelationships||[], indexOptions:p.indexOptions||currentIndexOptions(), examples:[{table:'entity',data:{type:'example',value:'...'}},{table:'relation',data:{type:'cooccurrence',sourceValue:'A',targetValue:'B'}}] };
    applyProfile(profile);
    setSelectedPlanUI(idx);
    const cacheId = selectedCacheId();
    if (cacheId) await fetch(`/api/index-profile/${cacheId}`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ profile, persist:false }) });
    renderFeaturePlans(featurePlansState);
  });
}

function renderUploadedFilePreview(files = []) {
  const cacheId = selectedCacheId();
  $('file-preview').innerHTML = (files || []).slice(-12).map((f)=>{
    const e = ext(f.originalName || f.name || '');
    const ok = f.supported !== false;
    const sample = String(f.samplePreview || '').trim();
    const btn = sample ? `<button class="sugg-btn view-sample" data-sample="${sample.replace(/"/g,'&quot;')}" data-method="${String(f.extractionMethod||'unknown').replace(/"/g,'&quot;')}" data-path="${String(f.path||'').replace(/"/g,'&quot;')}">View</button>` : '<span class="muted">No text</span>';
    const trash = f.id ? `<button class="sugg-btn del-file" data-file-id="${String(f.id)}" style="border-color:#7a2e2e;color:#ffb3b3">🗑</button>` : '<span class="muted">—</span>';
    const chars = Number(f.extractedChars || sample.length || 0);
    return `<tr><td>${(f.originalName||f.name||'').replace(/</g,'&lt;')}</td><td>${e||'unknown'}</td><td>${bytes(Number(f.size||0))}</td><td>${ok?'✅':'⚠️ raw-fallback'}</td><td>${chars}</td><td>${btn}</td><td>${trash}</td></tr>`;
  }).join('');
  document.querySelectorAll('.view-sample').forEach((btn)=>{ btn.onclick=()=>showTraceModal('Sample text preview (first 200 chars)', { extractionMethod: btn.getAttribute('data-method') || 'unknown', storedPath: btn.getAttribute('data-path') || '', sample: btn.getAttribute('data-sample') || '' }); });
  document.querySelectorAll('.del-file').forEach((btn)=>{
    btn.onclick = async ()=>{
      if (!cacheId) return;
      const fileId = btn.getAttribute('data-file-id');
      const ok = await showConfirm('Remove this file from the cache? This deletes the uploaded file and requires re-indexing.');
      if (!ok) return;
      const r = await fetch(`/api/cache-file/${cacheId}/${fileId}`, { method:'DELETE' });
      const j = await r.json();
      if (!r.ok || !j.ok) { $('upload-status').textContent = `Delete failed: ${j.error||'unknown'}`; return; }
      $('upload-status').textContent = 'File removed.';
      await fetchCaches();
      await runQuickSummary(cacheId);
    };
  });
}

async function runQuickSummary(cacheId, force=false){
  if(!cacheId) return;
  $('quick-file-summary').innerHTML = `<span class="spinner"></span>${force?'Regenerating':'Loading'} summary...`;
  const r = await fetch(`/api/cache-quick-summary/${cacheId}`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ force, ...aiCredPayload() })
  });
  const j = await r.json();
  if (!r.ok || !j.ok) { $('quick-file-summary').textContent = `Summary failed: ${j.error||'unknown'}`; return; }
  $('quick-file-summary').textContent = j.summary || 'No summary.';
  if ($('detected-recipe')) $('detected-recipe').textContent = `Detected recipe: ${j.detectedRecipe || 'n/a'}`;
  if (Array.isArray(j.snippets)) {
    const activeRows = j.snippets.map((s)=>({ originalName: s.filename, size: 0, supported: true, samplePreview: s.sample, extractedChars: s.extractedChars || 0, extractionMethod: s.extractionMethod || 'unknown', path: s.storedPath || '' }));
    const existing = [...$('file-preview').querySelectorAll('tr')];
    if (!existing.length) renderUploadedFilePreview(activeRows);
  }
}

async function loadActiveProfile(cacheId){
  if (!cacheId) return clearActiveProfileUI();
  try {
    const r = await fetch(`/api/index-profile/${cacheId}`);
    const j = await r.json();
    if (r.ok && j.ok && j.activeProfile) applyProfile(j.activeProfile);
    else clearActiveProfileUI();
  } catch { clearActiveProfileUI(); }
}

async function loadChatMessages(){
  const cacheId = selectedCacheId();
  if(!cacheId || !activeChatId) return renderThread([]);
  const r = await fetch(`/api/chats/${cacheId}/${activeChatId}`); const j = await r.json();
  renderThread(j?.chat?.messages || []);
}

$('save-or').onclick=()=>{
  localStorage.setItem('creds.mode', isEnvMode() ? 'env' : 'local');
  localStorage.setItem('openrouter.key',$('or-key').value.trim());
  localStorage.setItem('openrouter.model',$('or-model').value.trim());
  $('or-dot').className='dot green';
  $('or-status').textContent = isEnvMode() ? 'Mode saved: .env' : 'Saved locally (testing mode)';
};
$('trace-modal-close').onclick = hideTraceModal;
$('trace-modal').onclick = (e)=>{ if(e.target.id==='trace-modal') hideTraceModal(); };
$('confirm-modal').onclick = (e)=>{ if(e.target.id==='confirm-modal') $('confirm-modal').classList.add('hidden'); };
$('ping-or').onclick=async()=>{ $('or-status').textContent='Pinging local credentials...'; const r=await fetch('/api/openrouter/ping',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({useEnv:false,key:$('or-key').value.trim(),model:$('or-model').value.trim()})}); const j=await r.json(); if(r.ok&&j.ok){ $('or-dot').className='dot green'; $('or-status').textContent='Local credentials reachable'; } else { $('or-dot').className='dot red'; $('or-status').textContent=`Ping failed: ${j.error||'unknown'}`; }};
$('ping-or-env').onclick=async()=>{ $('or-status').textContent='Testing env credentials...'; const r=await fetch('/api/openrouter/ping',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({useEnv:true})}); const j=await r.json(); if(r.ok&&j.ok){ $('or-dot').className='dot green'; $('or-status').textContent='Env credentials reachable'; } else { $('or-dot').className='dot red'; $('or-status').textContent=`Env test failed: ${j.error||'unknown'}`; }};
$('load-env-creds').onclick=async()=>{ $('or-status').textContent='Loading .env credentials...'; const r=await fetch('/api/credentials/env-load'); const j=await r.json(); if(j?.model) $('or-model').value=j.model; $('cred-env').checked=true; $('cred-local').checked=false; localStorage.setItem('creds.mode','env'); updateCredModeUI(); if(j.ok && j.active){ $('or-dot').className='dot green'; $('or-status').textContent='Loaded from .env and ping passed'; } else { $('or-dot').className='dot red'; $('or-status').textContent=`.env load: ${j.message||'not active'}`; } };
$('example-pricing').onclick = ()=>showTraceModal('Financial Market Feature Plan (Case Study)', {
  dataset: 'OHLCV time series in CSV/Excel (timestamp, symbol, open, high, low, close, volume). Optional indicators: RSI, ATR, CORR, rolling beta.',
  extractionMapping: ['symbol -> entity(asset)', 'OHLC row -> event(price_bar)', 'indicator columns -> activity(signal)', 'cross-symbol lag/correlation -> relation(edge)'],
  domainLexiconRules: ['open','high','low','close','volume','rsi','corr','volatility','drawdown','momentum'],
  tableWriteIntents: ['event: bar-level changes', 'anomaly: regime shifts/spikes', 'relation: correlation + lead-lag edges'],
  sampleQuestions: [
    'When two assets are in a downtrend and pairwise correlation drops, which assets recover positive within 5 sessions at >=80% historical frequency?',
    'Which indicator combinations have the highest conditional win-rate after 3-day drawdowns?'
  ]
});
$('download-manifest').onclick = async ()=>{
  const cacheId = selectedCacheId();
  if (!cacheId) return notifyBlocked('ask');
  const r = await fetch(`/api/index-manifest/${cacheId}`);
  const j = await r.json();
  if (!r.ok || !j.ok) { $('query-status').textContent = `Manifest download failed: ${j.error||'unknown'}`; return; }
  const blob = new Blob([JSON.stringify(j.manifest, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${cacheId}-manifest.json`;
  a.click();
  URL.revokeObjectURL(url);
};
$('download-index-data').onclick = async ()=>{
  const cacheId = selectedCacheId();
  if (!cacheId) return notifyBlocked('ask');
  const r = await fetch(`/api/index-data-export/${cacheId}`);
  const j = await r.json();
  if (!r.ok || !j.ok) { $('query-status').textContent = `Index-data download failed: ${j.error||'unknown'}`; return; }
  const blob = new Blob([JSON.stringify(j, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${cacheId}-index-data.json`;
  a.click();
  URL.revokeObjectURL(url);
};
$('redo-index-flow').onclick = ()=> scrollToSection('section-index');

$('regenerate-summary').onclick = async ()=>{ const cacheId = selectedCacheId(); if(!cacheId) return notifyBlocked('index'); await runQuickSummary(cacheId, true); };

$('index-fix-help').onclick = async ()=>{
  const cacheId = selectedCacheId(); if(!cacheId) return notifyBlocked('index');
  $('index-health-warning').innerHTML = '⚠ Diagnosing extraction quality (may take 2–3 minutes)...';
  const r = await fetch(`/api/index-diagnose/${cacheId}`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ ...aiCredPayload() }) });
  const j = await r.json();
  if (!r.ok || !j.ok) { $('index-health-warning').innerHTML = `⚠ Diagnosis failed: ${j.error||'unknown'}`; return; }
  $('index-health-warning').innerHTML = `⚠ ${j.summary || 'Diagnosis complete.'} <button id="index-fix-help" class="sugg-btn" style="margin-left:8px">How can I fix this?</button>`;
  $('index-log').textContent += `\n\nExtraction diagnosis:\n${JSON.stringify(j, null, 2)}`;
  $('index-fix-help').onclick = async ()=>{
    $('index-log').textContent += '\n\nTip: re-run indexing after applying recommended feature-plan suppressions and intent.';
  };
};

$('view-schema').onclick = async ()=>{
  const cacheId = selectedCacheId(); if(!cacheId) return notifyBlocked('ask');
  const r = await fetch(`/api/schema/${cacheId}`);
  const j = await r.json();
  if (!r.ok || !j.ok) { $('query-status').textContent = `Schema load failed: ${j.error||'unknown'}`; return; }
  showTraceModal('Surreal schema (table fields)', j.schema);
};
$('convert-surrealql').onclick = async ()=>{
  const cacheId = selectedCacheId(); if(!cacheId) return notifyBlocked('ask');
  const statement = $('question').value.trim();
  if (!statement) { $('query-status').textContent = 'Enter a statement/question first.'; return; }
  $('convert-surrealql').disabled = true;
  $('convert-status').innerHTML = '<span class="spinner"></span><span class="warn-inline">Converting...</span>';
  $('query-status').textContent = 'Converting to SurrealQL...';
  const r = await fetch(`/api/convert-surrealql/${cacheId}`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ statement, ...aiCredPayload() }) });
  const j = await r.json();
  $('convert-surrealql').disabled = false;
  $('convert-status').textContent = '';
  if (!r.ok || !j.ok) { $('query-status').textContent = `Convert failed: ${j.error||'unknown'}`; return; }
  $('surrealql-output').textContent = j.surrealql || JSON.stringify(j, null, 2);
  if (j.needsRemodel && j.remodelInstructions) {
    $('index-strategy').value = 'custom';
    $('index-strategy-notes').value = String(j.remodelInstructions).slice(0, 1000);
    $('query-status').textContent = 'Schema remodel recommended. Custom index notes were prefilled.';
    scrollToSection('section-index');
  } else {
    $('query-status').textContent = 'SurrealQL conversion ready (shown below input).';
  }
};

$('query-strategy-help').onclick = ()=>showTraceModal('Query Strategy Modes', {
  balanced: 'Default mix of relevant chunk retrieval + structured Surreal tables.',
  'broad-discovery': 'Wider retrieval scope for exploration; may include weaker matches.',
  'high-precision': 'Stricter matching with fewer but more exact candidates.',
  timeline: 'Prioritizes event/activity ordering over broad thematic recall.',
  custom: 'Uses your custom notes to bias retrieval/ranking behavior.'
});

$('example-shipping').onclick = ()=>showTraceModal('Ship Movement Feature Plan (Case Study)', {
  dataset: 'AIS movement CSV (timestamp, vessel_id, vessel_type, latitude, longitude, speed, heading, port_call, cargo status).',
  extractionMapping: ['vessel_id -> entity(ship)', 'lat/lon/time rows -> event(movement_point)', 'port transitions -> activity(route_leg)', 'co-movement windows -> relation(lead-lag/correlation)'],
  domainLexiconRules: ['latitude','longitude','heading','speed','port','arrival','departure','cargo','anchorage','route'],
  tableWriteIntents: ['event: trajectory points', 'activity: route segments', 'relation: ship-to-ship timing influence', 'anomaly: abnormal route deviation'],
  sampleQuestions: [
    'When vessel group A activity decreases, which vessel types show reduced movement in the next 30 days?',
    'Which import route clusters lead to secondary feeder traffic declines with highest probability?'
  ]
});

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
  $('cache-select').innerHTML=`<option value="">Select a cache...</option>` + list.map(c=>`<option value="${c.id}">${c.label}</option>`).join('');
  if (prior && list.some(c=>c.id===prior)) $('cache-select').value = prior;
  const active=list.find(c=>c.id===selectedCacheId()) || null;
  currentCache = active || null;
  $('active-cache-label').textContent = active ? `${active.label} (${active.id})` : 'None';
  $('ready-state').textContent=active?.readyForQuestions ? 'Ready for questions ✅' : 'Not ready for questions';
  renderUploadedFilePreview(active?.files || []);
  applyGateState();
  updateAskArtifactInfo();

  document.querySelectorAll('.cache-jump').forEach((btn) => {
    btn.onclick = async () => {
      const cid = btn.getAttribute('data-cache-id');
      if (!cid) return;
      $('cache-select').value = cid;
      $('cache-select').dispatchEvent(new Event('change'));
      const selected = list.find((c) => c.id === cid);
      if (!selected || !(selected.files || []).length) scrollToSection('section-upload');
      else if (!selected.readyForQuestions) scrollToSection('section-index');
      else scrollToSection('section-ask');
    };
  });

  await fetchChats();
  if (active?.id) await loadActiveProfile(active.id); else clearActiveProfileUI();
}

$('cache-select').onchange = async ()=> { const list=await (await fetch('/api/caches')).json(); const c=(list.caches||[]).find(x=>x.id===selectedCacheId()); currentCache = c || null; $('active-cache-label').textContent = c ? `${c.label} (${c.id})` : 'None'; renderUploadedFilePreview(c?.files || []); applyGateState(); updateAskArtifactInfo(); await fetchChats(); await checkSurreal(); if (c?.id) await loadActiveProfile(c.id); if ((c?.files||[]).length) await runQuickSummary(c.id); };
$('chat-select').onchange = async ()=> { activeChatId = $('chat-select').value; await loadChatMessages(); };
$('new-chat').onclick = async ()=>{ const cacheId = selectedCacheId(); if(!cacheId) return; const j = await createNewChatForCache(cacheId, `Session ${new Date().toLocaleString()}`); activeChatId = j.chatId; await fetchChats(); $('query-status').textContent = 'New chat created.'; };

$('create-cache').onclick=async()=>{ const label=$('cache-label').value.trim(); if(!label) return; await fetch('/api/caches',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({label})}); $('cache-label').value=''; await fetchCaches(); };
$('file-input').onchange=()=>{ const files=[...$('file-input').files]; $('file-preview').innerHTML=files.map(f=>{ const e=ext(f.name); const ok=supported.includes(e); return `<tr><td>${f.name}</td><td>${e||'unknown'}</td><td>${bytes(f.size)}</td><td>${ok?'✅':'⚠️ raw-fallback'}</td><td>pending</td><td><span class="muted">Preview after upload</span></td><td><span class="muted">—</span></td></tr>`; }).join(''); applyGateState(); };

async function uploadSelectedFilesIfAny(){
  const cacheId=selectedCacheId(); const files=[...$('file-input').files]; if(!cacheId || !files.length) return { uploaded: 0, skipped: true };
  $('upload-status').textContent = `Uploading ${files.length} file(s)...`;
  const fd=new FormData(); fd.append('cacheId',cacheId); files.forEach(f=>fd.append('files',f));
  const r=await fetch('/api/upload',{method:'POST',body:fd}); const j=await r.json();
  if(!r.ok){ $('upload-status').textContent = `Upload failed: ${j.error||'unknown'}`; throw new Error(j.error||'upload failed'); }
  $('file-input').value='';
  renderUploadedFilePreview(j.files || []);
  $('upload-status').textContent = `Uploaded ${j.files?.length||0} file(s) to cache.`;
  await fetchCaches();
  await runQuickSummary(cacheId);
  return { uploaded: j.files?.length || 0, skipped: false };
}
$('upload-btn').onclick=async()=>{ try { await uploadSelectedFilesIfAny(); } catch {} };
$('load-sample').onclick=async()=>{ const cacheId=selectedCacheId(); if(!cacheId) return; $('upload-status').textContent = 'Uploading sample fixture...'; const r=await fetch('/fixtures/sample-case-500w.txt'); const txt=await r.text(); const f=new File([txt],'sample-case-500w.txt',{type:'text/plain'}); const fd=new FormData(); fd.append('cacheId',cacheId); fd.append('files',f); const up=await fetch('/api/upload',{method:'POST',body:fd}); const j=await up.json(); if(!up.ok){ $('upload-status').textContent = `Sample upload failed: ${j.error||'unknown'}`; return; } $('upload-status').textContent = 'Sample uploaded.'; renderUploadedFilePreview(j.files || []); await fetchCaches(); await runQuickSummary(cacheId); };

async function checkSurreal(){ const r=await fetch('/api/surreal/health'); const j=await r.json(); if(r.ok&&j.ok){ $('surreal-dot').className='dot green'; $('surreal-status').textContent='Reachable'; return true; } $('surreal-dot').className='dot red'; $('surreal-status').textContent=`Unreachable: ${j.error||'unknown'}`; return false; }

$('load-existing-index').onclick = async ()=>{
  if ($('load-existing-index').dataset.locked === '1') return notifyBlocked('index');
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

if ($('index-btn-large')) $('index-btn-large').onclick = ()=> $('index-btn').click();

$('index-btn').onclick=async()=>{
  if ($('index-btn').dataset.locked === '1') return notifyBlocked('index');
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

  const profilePayload = activeIndexProfile ? {
    indexStrategy: activeIndexProfile.strategy || $('index-strategy').value,
    indexStrategyNotes: activeIndexProfile.notes || $('index-strategy-notes').value.trim(),
    indexOptions: activeIndexProfile.indexOptions || currentIndexOptions()
  } : {
    indexStrategy: $('index-strategy').value,
    indexStrategyNotes: $('index-strategy-notes').value.trim(),
    indexOptions: currentIndexOptions()
  };
  const r=await fetch(`/api/index/${cacheId}`,{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(profilePayload) });
  const j=await r.json();
  stopped = true;
  clearInterval(ticker);

  if(!r.ok){ setProgress(0); $('index-estimate').textContent = 'Index failed.'; $('index-log').textContent=(j.logs||[]).map(x=>`- ${x.message}`).join('\n') + `\nERROR: ${j.error}`; await fetchCaches(); return; }
  setProgress(100);
  $('index-estimate').textContent = j.reusedExisting ? 'Loaded existing index (no re-scan).' : 'Index complete.';
  const usedChunk = j?.manifest?.options?.indexOptions?.chunkSize || profilePayload?.indexOptions?.chunkSize || 1400;
  $('index-log').textContent=(j.manifest.logs||[]).map(x=>`- ${x.message}`).join('\n') + `${j.manifest.summary ? `\n\nSummary:\n${j.manifest.summary}` : ''}` + `\n\nHow indexing works:\n${(j.manifest.indexingExplanation||[]).map(s=>`- ${s}`).join('\n')}\n\nDONE: docs=${j.manifest.stats.documentCount} chunks=${j.manifest.stats.chunkCount} chunkSize=${usedChunk} entities=${j.manifest.stats.entityCount||0} events=${j.manifest.stats.eventCount||0} activities=${j.manifest.stats.activityCount||0} intents=${j.manifest.stats.intentCount||0}${j.reusedExisting ? '\n(Loaded existing index; no re-scan performed.)' : ''}`;
  evaluateIndexHealth(j.manifest.stats || {});
  await fetchCaches();
};

$('suggest-btn').onclick = async ()=>{
  if ($('suggest-btn').dataset.locked === '1') return notifyBlocked('ask');
  const cacheId=selectedCacheId(); if(!cacheId) return;
  $('query-status').textContent = 'Suggesting questions...';
  const r = await fetch(`/api/suggest-questions/${cacheId}`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({
      chatId: activeChatId,
      mode: 'heuristic',
      ...aiCredPayload()
    })
  });
  const j = await r.json();
  if (!r.ok || !j.ok) { $('query-status').textContent = `Suggestion failed: ${j.error||'unknown'}`; return; }
  renderSuggestions(j.suggestions || []);
  $('query-status').textContent = `Suggestions ready (${j.source}).`;
};

$('ask-btn').onclick=async()=>{
  if ($('ask-btn').dataset.locked === '1') return notifyBlocked('ask');
  const cacheId=selectedCacheId(); const q=$('question').value.trim(); if(!cacheId||!q) return;
  const mode=$('query-mode').value; activeChatId = $('chat-select').value || activeChatId;
  const payload = { question:q, mode, chatId: activeChatId, queryStrategy: $('query-strategy').value, queryStrategyNotes: $('query-strategy-notes').value.trim(), ...aiCredPayload() };

  // optimistic user bubble
  const current = $('chat-thread').innerHTML;
  $('chat-thread').innerHTML = current + `<div class="msg user"><div class="meta">user • now</div><div>${q.replace(/</g,'&lt;')}</div></div><div id="assistant-typing" class="msg assistant typing"><div class="meta">assistant • now</div><div><span class="spinner"></span>Thinking...</div></div>`;

  liveTrace = [];
  setTraceStep('parse_query', 'running', {
    explanation: 'Parse user intent + strategy, then build retrieval plan for Surreal tables/chunks and optional AI synthesis.',
    request: { url: `/api/query/${cacheId}`, payload: { ...payload, openRouterKey: payload.openRouterKey ? '***' : '' } }
  });
  setTraceStep('surreal_precheck', 'pending', {
    explanation: 'Surreal pre-check verifies DB connectivity first (RETURN 1) so we fail fast before retrieval/model calls.',
    request: { url: '/api/surreal/health', query: 'RETURN 1;' }
  });
  setTraceStep('surreal_retrieval', 'pending', {
    explanation: 'Retrieve candidate chunks + structured signals (entity/event/activity/intent/relation/anomaly) and rank by query relevance.',
    request: { queryTemplate: 'SELECT fileId, filename, chunkIndex, text FROM chunk WHERE cacheId = $cacheId LIMIT 3000;' }
  });
  if (mode === 'ai') {
    setTraceStep('openrouter_call', 'pending', {
      explanation: 'Send grounded prompt to OpenRouter after retrieval.',
      request: { url: 'https://openrouter.ai/api/v1/chat/completions', model: payload.model || 'openai/gpt-4o-mini' }
    });
  }

  $('query-status').textContent='Running retrieval...';
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 70000);
  let r, j;
  const clearTyping = ()=>{ const t = $('assistant-typing'); if (t) t.remove(); };
  try {
    setTraceStep('surreal_precheck', 'running');
    r=await fetch(`/api/query/${cacheId}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal: ctrl.signal});
    j=await r.json();
  } catch (e) {
    clearTimeout(t);
    $('query-status').textContent='Query failed';
    clearTyping();
    setTraceStep('surreal_precheck', 'error', { error: e.name === 'AbortError' ? 'Request timed out waiting for response' : e.message });
    $('trace').textContent = `ERROR: ${e.name === 'AbortError' ? 'Request timed out waiting for response' : e.message}`;
    return;
  }
  clearTimeout(t);

  if (j?.trace?.length) {
    for (const step of j.trace) {
      if (step.step === 'parse_query') setTraceStep('parse_query', 'done', step);
      if (step.step?.includes('surreal_precheck')) setTraceStep('surreal_precheck', 'done', step);
      if (step.step?.includes('surreal_retrieval')) setTraceStep('surreal_retrieval', 'done', step);
      if (step.step?.includes('build_ai_prompt')) setTraceStep('openrouter_call', 'running', step);
      if (step.step?.includes('openrouter_request_start')) setTraceStep('openrouter_call', 'running', step);
      if (step.step?.includes('openrouter_awaiting_response')) setTraceStep('openrouter_call', 'running', step);
      if (step.step?.includes('openrouter_response_ok')) setTraceStep('openrouter_call', 'done', step);
      if (step.step?.includes('openrouter_error')) setTraceStep('openrouter_call', 'error', step);
    }
  }

  if(!r.ok){ $('query-status').textContent='Query failed'; clearTyping(); $('trace').textContent = (j.trace||[]).map((x)=>JSON.stringify(x,null,2)).join('\n\n') + `\nERROR: ${j.error||'query failed'}`; return; }

  if (j.chatId) activeChatId = j.chatId;
  const struct = j.structured || {};
  const traceLines = (j.trace || []).map((x, idx) => `[${idx+1}] ${x.step}\n${JSON.stringify(x, null, 2)}`);
  $('trace').textContent = `${traceLines.join('\n\n')}\n\nSurreal returned:\n- chunks: ${(j.evidence||[]).length}\n- entities: ${struct.entities?.length||0}\n- events: ${struct.events?.length||0}\n- activities: ${struct.activities?.length||0}\n- intents: ${struct.intents?.length||0}\n- anomalies: ${struct.anomalies?.length||0}\n- relations: ${struct.relations?.length||0}\n${mode==='ai'?'AI synthesized final answer using these findings.':'Surreal-only response returned.'}`;
  $('query-status').textContent=`Done. mode=${j.mode}`;
  clearTyping();
  await fetchChats();
  await loadChatMessages();

  try {
    const sr = await fetch(`/api/suggest-questions/${cacheId}`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ chatId: activeChatId, mode: 'heuristic', ...aiCredPayload() })
    });
    const sj = await sr.json();
    if (sr.ok && sj.ok) renderSuggestions(sj.suggestions || []);
  } catch {}

  $('question').value='';
};

(async()=>{ loadOpenRouter(); updateCredModeUI(); updateQuestionPlaceholder(); renderTuningLabels(); await fetchCaches(); await checkSurreal(); })();
