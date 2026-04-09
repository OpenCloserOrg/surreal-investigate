const supported = ['txt','md','csv','json','eml','pdf','docx','xlsx'];
const $ = (id) => document.getElementById(id);

function ext(name=''){ const p=name.split('.'); return p.length>1 ? p.pop().toLowerCase() : ''; }
function bytes(n=0){ if(n<1024) return `${n} B`; if(n<1048576) return `${(n/1024).toFixed(1)} KB`; if(n<1073741824) return `${(n/1048576).toFixed(1)} MB`; return `${(n/1073741824).toFixed(2)} GB`; }

function loadOpenRouter(){ $('or-key').value=localStorage.getItem('openrouter.key')||''; $('or-model').value=localStorage.getItem('openrouter.model')||''; }
$('save-or').onclick=async()=>{
  localStorage.setItem('openrouter.key',$('or-key').value.trim());
  localStorage.setItem('openrouter.model',$('or-model').value.trim());
  const ok=Boolean($('or-key').value.trim());
  $('or-dot').className=`dot ${ok?'green':'red'}`;
  $('or-status').textContent=ok?'Saved locally':'Missing key';
};

async function fetchCaches(){
  const r=await fetch('/api/caches'); const j=await r.json();
  const list=j.caches||[];
  $('cache-list').innerHTML=list.map(c=>`<li><strong>${c.label}</strong> <span class="muted">(${c.id}) · ${c.files?.length||0} files</span></li>`).join('') || '<li class="muted">No caches yet</li>';
  $('cache-select').innerHTML=list.map(c=>`<option value="${c.id}">${c.label}</option>`).join('');
}

$('create-cache').onclick=async()=>{
  const label=$('cache-label').value.trim(); if(!label) return;
  await fetch('/api/caches',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({label})});
  $('cache-label').value=''; await fetchCaches();
};

$('file-input').onchange=()=>{
  const files=[...$('file-input').files];
  $('file-preview').innerHTML=files.map(f=>{
    const e=ext(f.name); const ok=supported.includes(e);
    return `<tr><td>${f.name}</td><td>${e||'unknown'}</td><td>${bytes(f.size)}</td><td>${ok?'✅':'❌'}</td></tr>`;
  }).join('');
};

$('upload-btn').onclick=async()=>{
  const cacheId=$('cache-select').value; const files=[...$('file-input').files];
  if(!cacheId || !files.length) return;
  const fd=new FormData(); fd.append('cacheId',cacheId); files.forEach(f=>fd.append('files',f));
  await fetch('/api/upload',{method:'POST',body:fd});
  $('file-input').value=''; $('file-preview').innerHTML='';
  await fetchCaches();
};

(async()=>{ loadOpenRouter(); await fetchCaches(); })();
