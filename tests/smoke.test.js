import http from 'http';
const req = (path) => new Promise((resolve, reject) => {
  http.get({ host: 'localhost', port: 3000, path }, (res) => {
    let d=''; res.on('data', (c)=>d+=c); res.on('end',()=>resolve({status:res.statusCode, body:d}));
  }).on('error', reject);
});
(async()=>{
  const h = await req('/api/health');
  if (h.status !== 200) throw new Error('health failed');
  const j = JSON.parse(h.body);
  if (!j.ok) throw new Error('health not ok');
  console.log('smoke ok');
})();
