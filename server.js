import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT = process.cwd();
const APP_DIR = path.join(ROOT, '.app');
const UPLOADS_DIR = path.join(ROOT, 'uploads');
const INDEXES_DIR = path.join(ROOT, 'indexes');
const DATA_DIR = path.join(ROOT, 'data');
const CACHES_JSON = path.join(APP_DIR, 'caches.json');

for (const p of [APP_DIR, UPLOADS_DIR, INDEXES_DIR, DATA_DIR]) fs.mkdirSync(p, { recursive: true });
if (!fs.existsSync(CACHES_JSON)) fs.writeFileSync(CACHES_JSON, JSON.stringify({ caches: [] }, null, 2));

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const cacheId = String(req.body.cacheId || '').trim() || `cache-${Date.now()}`;
    const dest = path.join(UPLOADS_DIR, cacheId);
    fs.mkdirSync(dest, { recursive: true });
    cb(null, dest);
  },
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`)
});
const upload = multer({ storage, limits: { fileSize: 2 * 1024 * 1024 * 1024 } });

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(ROOT, 'public')));

function readCaches() {
  try { return JSON.parse(fs.readFileSync(CACHES_JSON, 'utf8')); } catch { return { caches: [] }; }
}
function writeCaches(data) { fs.writeFileSync(CACHES_JSON, JSON.stringify(data, null, 2)); }

app.get('/api/health', (_req, res) => res.json({ ok: true, app: 'surreal-investigate', port: PORT }));

app.get('/api/caches', (_req, res) => {
  const data = readCaches();
  return res.json({ ok: true, caches: data.caches || [] });
});

app.post('/api/caches', (req, res) => {
  const label = String(req.body?.label || '').trim();
  if (!label) return res.status(400).json({ ok: false, error: 'label required' });
  const data = readCaches();
  const cache = { id: `cache-${Date.now()}`, label, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), files: [] };
  data.caches.unshift(cache);
  writeCaches(data);
  fs.mkdirSync(path.join(UPLOADS_DIR, cache.id), { recursive: true });
  fs.mkdirSync(path.join(INDEXES_DIR, cache.id), { recursive: true });
  return res.json({ ok: true, cache });
});

app.post('/api/upload', upload.array('files', 200), (req, res) => {
  const cacheId = String(req.body?.cacheId || '').trim();
  if (!cacheId) return res.status(400).json({ ok: false, error: 'cacheId required' });
  const data = readCaches();
  const cache = (data.caches || []).find((c) => c.id === cacheId);
  if (!cache) return res.status(404).json({ ok: false, error: 'cache not found' });

  const files = (req.files || []).map((f) => ({
    id: `file-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    originalName: f.originalname,
    storedName: path.basename(f.path),
    path: path.relative(ROOT, f.path),
    size: f.size,
    mimeType: f.mimetype,
    uploadedAt: new Date().toISOString()
  }));
  cache.files = [...(cache.files || []), ...files];
  cache.updatedAt = new Date().toISOString();
  writeCaches(data);
  res.json({ ok: true, files, cache });
});

app.get('*', (_req, res) => res.sendFile(path.join(ROOT, 'public/index.html')));

app.listen(PORT, () => {
  console.log(`Surreal Investigate listening on http://localhost:${PORT}`);
});
